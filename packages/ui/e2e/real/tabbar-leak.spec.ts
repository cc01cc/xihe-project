// lane: 真栈回归（profile=all，经 scripts/e2e-real-stack.mjs --stack <n> 直跑，需真栈登录态）—— 全局页签行归属的路由矩阵，不进 host 车道（T-2318 分类表）。
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * task-110：顶部全局页签行（workspace-tab-bar）**只属于工作台页**。
 *
 * <p>缺陷形态（task-104 取证）：localStorage 里 xihe-layout-ws:&lt;ws&gt; 的 openTabs 非空时，
 * 五个「工作区壳内、工作台未挂载」的页面多渲染一条 32px 全局页签行，把正文整体下推 32px，
 * 且点它会把用户带离当前页。根因是两道门都不判「当前路由是不是工作台」：
 * AppLayout.vue:206-211 只看路径前缀，WorkspaceTabBar.vue:268 只看容器有没有认领 ——
 * 而 claim 只有 WorkspaceWorkbench 发，它只在 workspace / workspace-session 两页挂载。</p>
 *
 * <p>判据是**自校准**的：同一页先在「无页签」下量基线，再种上 openTabs 重量，两条读数必须
 * 一致（容差 1px）。这样「该页本来就有别的顶部元素」不会变成假红/假绿，而「多出一条 32px
 * 行」一定会红。</p>
 *
 * <p>登录态只在内存（xihe-token），整页 goto 会丢 ⇒ 全程复用同一个 context/page：先走一次
 * 真实登录表单，再用 CP 只读 API 取 workspaceId + 一个会话 id。</p>
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/ui/e2e/real → A03-xihe */
const PROJECT_ROOT = path.resolve(HERE, "../../../..");
const PASSWORD_FILE = path.join(PROJECT_ROOT, ".local", "dev", "admin-password");
const ADMIN_IDENTIFIER = process.env.XIHE_E2E_ADMIN_IDENTIFIER ?? "admin@xihe.local";

/** 工作台页签持久片：只写 openTabs 一片，**不写几何**（task-85：几何缺失会被工作台默认值覆盖）。 */
const layoutKeyOf = (workspaceId: string): string => "xihe-layout-ws:" + workspaceId;

/**
 * 手动 `browser.newContext()` **不继承** config 的 `use.{baseURL,viewport,deviceScaleFactor}`
 * （Playwright 只对内置 page/context fixture 应用 use 选项）⇒ 相对 URL 会报
 * `Cannot navigate to invalid URL`（首跑实测）。这里显式补齐，并与 e2e/playwright.config.ts
 * 的默认端口 12750 对齐。用 127.0.0.1 而非 localhost：后者在 Windows 上可能先解析到 ::1。
 */
const UI_ORIGIN =
    process.env.XIHE_E2E_UI_ORIGIN ?? "http://127.0.0.1:" + (process.env.XIHE_UI_PORT || "12750");

const readAdminPassword = (): string => {
    const fromEnv = process.env.XIHE_E2E_ADMIN_PASSWORD;
    if (fromEnv) return fromEnv;
    // 口令只在运行时读，不进断言、不进日志（AGENTS.md 凭据卫生）。
    return readFileSync(PASSWORD_FILE, "utf8").trim();
};

/** 真实登录表单：与 UI 基线同一范式（e2e/real/ui-baseline.spec.ts 的 loginViaForm）。 */
async function loginViaForm(page: Page): Promise<void> {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.locator("#identifier").fill(ADMIN_IDENTIFIER);
    await page.locator("#password").fill(readAdminPassword());
    const loginResponse = page.waitForResponse(
        (response) =>
            response.url().includes("/api/v1/auth/login") && response.request().method() === "POST",
        { timeout: ACTION_TIMEOUT_MS },
    );
    await page.locator('button[type="submit"]').first().click();
    const response = await loginResponse;
    expect(response.status(), "登录接口应 200").toBe(200);
    await expect
        .poll(() => page.evaluate(() => Boolean(localStorage.getItem("xihe-token"))), {
            timeout: EXPECT_TIMEOUT_MS,
        })
        .toBe(true);
}

/** 从 CP 只读 API 取「工作区 + 一个会话」（不点侧栏：点侧栏会开多个容器页签，改变 openTabs）。 */
async function discoverWorkspaceSession(
    page: Page,
): Promise<{ workspaceId: string; sessionId: string }> {
    const picked = (await page.evaluate(async () => {
        const token = localStorage.getItem("xihe-token") ?? "";
        const headers: Record<string, string> = { authorization: "Bearer " + token };
        const wsResponse = await fetch("/api/v1/workspaces", { headers });
        if (!wsResponse.ok) return { error: "workspaces " + wsResponse.status };
        const body = (await wsResponse.json()) as
            | { id?: string }[]
            | { workspaces?: { id?: string }[] };
        const workspaces = Array.isArray(body) ? body : (body.workspaces ?? []);
        const workspaceId = workspaces[0]?.id;
        if (!workspaceId) return { error: "no workspace" };
        const sessionResponse = await fetch("/api/v1/sessions", {
            headers: { ...headers, "X-Workspace-Id": workspaceId },
        });
        const sessions = sessionResponse.ok
            ? (((await sessionResponse.json()) as { sessions?: { id?: string }[] }).sessions ?? [])
            : [];
        return { workspaceId, sessionId: sessions[0]?.id ?? "" };
    })) as { workspaceId?: string; sessionId?: string; error?: string };
    expect(picked.error ?? "", "应先能列出工作区").toBe("");
    const workspaceId = picked.workspaceId ?? "";
    expect(workspaceId, "真栈里应至少有一个工作区").not.toBe("");
    // 没有会话也可以：聊天页路由对「不存在的会话」容错（Workbench 照样挂载），
    // 本 spec 只看工作台容器与全局行的渲染，不看会话内容。
    const sessionId = picked.sessionId || "00000000-0000-4000-8000-000000000000";
    return { workspaceId, sessionId };
}

/** 写/清「页签持久片」。同源写入 ⇒ 下一次整页装载时应用读到的就是它。 */
async function seedOpenTabs(
    page: Page,
    workspaceId: string,
    sessionIds: string[] | null,
): Promise<void> {
    await page.evaluate(
        ({ key, ids }: { key: string; ids: string[] | null }) => {
            if (ids === null) localStorage.removeItem(key);
            else localStorage.setItem(key, JSON.stringify({ openTabs: ids }));
        },
        {
            key: layoutKeyOf(workspaceId),
            ids: sessionIds ? sessionIds.map((id) => "session:" + id) : null,
        },
    );
}

interface SurfaceReadings {
    barRows: number;
    workbench: number;
    containerRows: number;
    /** 全局行里的会话页签个数（testid 前缀 workspace-tab-session-）。 */
    sessionTabRows: number;
}

/** 等路由容器可见 + 过一帧（等首次 patch 落地），然后一次读全量。 */
async function readSurface(page: Page): Promise<SurfaceReadings> {
    await page
        .getByTestId("workspace-route-viewport")
        .first()
        .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
    );
    return page.evaluate(() => {
        return {
            barRows: document.querySelectorAll('[data-testid="workspace-tab-bar"]').length,
            workbench: document.querySelectorAll('[data-testid="workspace-workbench"]').length,
            containerRows: document.querySelectorAll('[data-testid="workspace-container-tabs"]')
                .length,
            sessionTabRows: document.querySelectorAll('[data-testid^="workspace-tab-session-"]')
                .length,
        };
    });
}

// 不用 mode:"serial"：serial 在首条失败后中止其余用例，取证时只能看到一条红
// （2026-11-20 实测）。本文件同 worker 串行执行（文件级并行单位是文件），
// 共享一个 page 也不冲突，失败要**一次看全五页**才叫证据。
test.describe("task-110 全局页签行只属于工作台页", () => {
    let page: Page;
    let workspaceId = "";
    let sessionId = "";

    test.beforeAll(async ({ browser }) => {
        const context = await browser.newContext({
            baseURL: UI_ORIGIN,
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 2,
        });
        page = await context.newPage();
        await loginViaForm(page);
        const discovered = await discoverWorkspaceSession(page);
        workspaceId = discovered.workspaceId;
        sessionId = discovered.sessionId;
    });

    test.afterAll(async () => {
        await page.context().close();
    });

    for (const pathTemplate of [
        "/workspace/:ws/settings?tab=config",
        "/workspace/:ws/members",
        "/workspace/:ws/settings",
        "/workspace/:ws/environment",
        "/workspace/:ws/resources",
    ]) {
        test(pathTemplate + " 不渲染全局页签行（种页签后几何不变）", async () => {
            const url = pathTemplate.replace(":ws", workspaceId);

            // 基线：无页签持久片 ⇒ 该页的天然顶部几何（不受本案影响）
            await seedOpenTabs(page, workspaceId, null);
            await page.goto(url, { waitUntil: "domcontentloaded" });
            const baseline = await readSurface(page);
            expect(baseline.containerRows, "非工作台页不该有容器页签行").toBe(0);
            expect(baseline.barRows, "无页签时本来就没有全局行").toBe(0);

            // 受控前置：只种 openTabs（一条钉住的会话页签）
            await seedOpenTabs(page, workspaceId, [sessionId]);
            await page.goto(url, { waitUntil: "domcontentloaded" });
            const seeded = await readSurface(page);

            expect(seeded.barRows, "非工作台页不得渲染全局页签行（task-110）").toBe(0);
            // 用户能看见的形态：那一条 32px 行（`h-8`）+ 里面的会话页签。两者都得消失。
            // 判据刻意只比「同一次装载内」的 DOM，不做跨装载比较：这些页面的顶部几何由异步内容
            // 决定，2026-11-20 实测同一页两次装载的视图顶边能差 500px 以上（57/357/617px），
            // 跨装载比像素量的是加载阶段而不是本案缺陷；下推 32px 的取证留在
            // one/.tmp/xh/ui-gates/global-tabbar-leak/repro.json（task-104）。
            expect(seeded.sessionTabRows, "非工作台页不得出现钉住的会话页签").toBe(0);
        });
    }

    test("工作台根页保持容器行 2 / 工作台 1 / 全局行 0", async () => {
        await seedOpenTabs(page, workspaceId, [sessionId]);
        await page.goto("/workspace/" + workspaceId, { waitUntil: "domcontentloaded" });
        await page
            .getByTestId("workspace-workbench")
            .first()
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        const readings = await readSurface(page);
        expect(readings.workbench, "工作台应挂载").toBe(1);
        expect(readings.containerRows, "工作台两行容器页签").toBe(2);
        expect(readings.barRows, "工作台页由容器认领 ⇒ 全局行让位").toBe(0);
    });

    test("工作台聊天页保持容器行 2 / 工作台 1 / 全局行 0", async () => {
        await seedOpenTabs(page, workspaceId, [sessionId]);
        await page.goto("/workspace/" + workspaceId + "/session/" + sessionId, {
            waitUntil: "domcontentloaded",
        });
        await page
            .getByTestId("workspace-workbench")
            .first()
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        const readings = await readSurface(page);
        expect(readings.workbench, "工作台应挂载").toBe(1);
        expect(readings.containerRows, "工作台两行容器页签").toBe(2);
        expect(readings.barRows, "工作台页由容器认领 ⇒ 全局行让位").toBe(0);
    });
});
