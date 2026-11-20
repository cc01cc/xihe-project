// lane: 真栈回归（profile=all，经 scripts/e2e-real-stack.mjs --stack <n> 直跑，需真栈登录态）—— 容器页签持久化 + 30 次 reload 矩阵，耗时与 IO 重，不进 host 车道（T-2318 分类表）。
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

/**
 * task-126（O3 / task-85 定因：**持久片被两个 writer 覆盖**，不是渲染落后）的三条回归。
 *
 * <p>缺陷形态：工作台挂载时把整份 `xihe-layout-ws:&lt;ws&gt;` 快照读进内存（`initialLayout`），
 * 之后任何**几何**变更（开合右栏、拖宽、折叠树）都会把这份**挂载时刻的** openTabs 连同几何一起
 * 写回；而页签栏另有一个 writer（`writeWorkspaceOpenTabs`）只写 openTabs 分片。
 * ⇒ 两个 writer 各持一份，几何一写就把页签集合回滚到挂载那一刻：
 * 关掉的页签重新出现（本文件用例 1），首次装载的页签被清空（用例 2，A 支 `[A,B]→[]`）。</p>
 *
 * <p>修法在 `composables/useWorkspaceLayout.ts`：整份写不再拥有 openTabs —— 它落盘前重读分片。
 * 单测（`src/stores/__tests__/containerPersistence.spec.ts`）钉的是函数级契约，本文件钉的是
 * **真实浏览器 + 真实 reload** 的行为：jsdom 里没有真实装载时序与 250ms 合批写，测得再绿也不能
 * 证明「reload 后仍不漂移」。</p>
 *
 * <p>登录态只在内存（`xihe-token`），整页 reload 会丢 ⇒ 全程复用同一个 context/page：
 * 先走一次真实登录表单，再用 CP 只读 API 取 workspaceId + 两个会话 id（会话不够时按 UI 同一接口补）。</p>
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/ui/e2e/real → A03-xihe */
const PROJECT_ROOT = path.resolve(HERE, "../../../..");
const PASSWORD_FILE = path.join(PROJECT_ROOT, ".local", "dev", "admin-password");
const ADMIN_IDENTIFIER = process.env.XIHE_E2E_ADMIN_IDENTIFIER ?? "admin@xihe.local";
/** 与 e2e/playwright.config.ts 的默认端口对齐；用 127.0.0.1 而非 localhost（Windows 可能先解析 ::1）。 */
const UI_ORIGIN =
    process.env.XIHE_E2E_UI_ORIGIN ?? "http://127.0.0.1:" + (process.env.XIHE_UI_PORT || "12750");
const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "local";

/** 持久键：几何与 openTabs **同一个键**（openTabs 是整份状态里的一个分片）。 */
const LAYOUT_KEY_PREFIX = "xihe-layout-ws:";
const layoutKeyOf = (workspaceId: string): string => LAYOUT_KEY_PREFIX + workspaceId;

/**
 * task-85 取证用的两个读数时刻（相对 reload 起点）：早读 700ms、晚读 3300ms。
 * 两者不一致 = 装载期还有写落在持久片上 = 本卡要防的漂移。
 * 慢机上 workbench 可能 700ms 还没挂载 ⇒ `sleepTo` 只会**睡到该时刻**，
 * 若装载本身已超过该时刻就立刻读（不额外等待、也不跳过这次读数）。
 */
const EARLY_READ_OFFSET_MS = 700;
const SETTLED_READ_OFFSET_MS = 3_300;
/** 30 次 reload 拆成 6 段 × 5 次：单条用例留在 30s 默认预算内（段预算见各用例注释）。 */
const MATRIX_RELOADS = 30;
const MATRIX_CHUNKS = 6;
const MATRIX_RELOADS_PER_CHUNK = MATRIX_RELOADS / MATRIX_CHUNKS;

const readAdminPassword = (): string => {
    const fromEnv = process.env.XIHE_E2E_ADMIN_PASSWORD;
    if (fromEnv) return fromEnv;
    // 口令只在运行时读，不进断言、不进日志（AGENTS.md 凭据卫生）。
    return readFileSync(PASSWORD_FILE, "utf8").trim();
};

interface LayoutReading {
    /** 主容器行当前渲染的页签 id（`session:<id>` 形态）。 */
    tabIds: string[];
    /** 持久片的逐字内容：判「有没有写」比判结构更严（多一个键也算漂移）。 */
    raw: string | null;
    /** 本次装载里对持久键的 setItem 次数（init script 计数，每次导航归零）。 */
    layoutWrites: number;
}

const mainTabTestId = (sessionId: string): string =>
    "workspace-container-tab-main-session:" + sessionId;
const mainTabCloseTestId = (sessionId: string): string =>
    "workspace-container-tab-close-main-session:" + sessionId;

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

/** 取「工作区 + 两个会话」：不够两个就用 UI 同一个建会话接口补（页签判据至少要两个对象）。 */
async function discoverWorkspaceSessions(
    page: Page,
): Promise<{ workspaceId: string; sessionIds: string[] }> {
    const picked = (await page.evaluate(async (runId: string) => {
        const token = localStorage.getItem("xihe-token") ?? "";
        const auth: Record<string, string> = { authorization: "Bearer " + token };
        const wsResponse = await fetch("/api/v1/workspaces", { headers: auth });
        if (!wsResponse.ok) return { error: "workspaces " + wsResponse.status };
        const wsBody = (await wsResponse.json()) as
            | { id?: string }[]
            | { workspaces?: { id?: string }[] };
        const workspaces = Array.isArray(wsBody) ? wsBody : (wsBody.workspaces ?? []);
        const workspaceId = workspaces[0]?.id;
        if (!workspaceId) return { error: "no workspace" };
        const headers: Record<string, string> = { ...auth, "X-Workspace-Id": workspaceId };
        const listSessions = async (): Promise<string[]> => {
            const response = await fetch("/api/v1/sessions", { headers });
            if (!response.ok) return [];
            const body = (await response.json()) as { sessions?: { id?: string }[] };
            return (body.sessions ?? []).map((item) => item.id ?? "").filter(Boolean);
        };
        const known = await listSessions();
        if (known.length >= 2) return { workspaceId, sessionIds: known.slice(0, 2) };
        // 真栈的 admin 工作区可能一个会话都没有：用与 UI 相同的接口补，标题带 run id 便于清理。
        const agentResponse = await fetch("/api/v1/workspaces/" + workspaceId + "/agents", {
            headers,
        });
        const agentBody = agentResponse.ok
            ? ((await agentResponse.json()) as {
                  agents?: { principalId?: string; bound?: boolean; disabled?: boolean }[];
              })
            : {};
        const agentPrincipalId =
            (agentBody.agents ?? []).find(
                (agent) => agent.bound === true && agent.disabled !== true,
            )?.principalId ?? "";
        if (!agentPrincipalId) return { workspaceId, sessionIds: known };
        const created = [...known];
        while (created.length < 2) {
            const response = await fetch("/api/v1/sessions", {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({
                    title: "container-persistence " + runId + " #" + created.length,
                    agentPrincipalId,
                }),
            });
            if (!response.ok) break;
            const body = (await response.json()) as { id?: string };
            if (!body.id) break;
            created.push(body.id);
        }
        return { workspaceId, sessionIds: created.slice(0, 2) };
    }, RUN_ID)) as { workspaceId?: string; sessionIds?: string[]; error?: string };
    expect(picked.error ?? "", "应先能列出工作区").toBe("");
    const workspaceId = picked.workspaceId ?? "";
    expect(workspaceId, "真栈里应至少有一个工作区").not.toBe("");
    const sessionIds = picked.sessionIds ?? [];
    expect(sessionIds.length, "真栈里至少要能凑出两个会话（否则页签判据没有对象）").toBe(2);
    return { workspaceId, sessionIds };
}

/** 种持久片：`null` = 清键（无几何、无页签），数组 = 只种 openTabs 分片（**不种几何**）。 */
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

async function openChat(page: Page, workspaceId: string, sessionId: string): Promise<void> {
    await page.goto("/workspace/" + workspaceId + "/session/" + sessionId, {
        waitUntil: "domcontentloaded",
    });
    await page
        .getByTestId("workspace-workbench")
        .first()
        .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
}

async function readLayout(page: Page, workspaceId: string): Promise<LayoutReading> {
    return page.evaluate(
        ({ key }: { key: string }) => {
            const scope = window as unknown as { __xhLayoutWrites?: number };
            const tabIds = Array.from(
                document.querySelectorAll(
                    '[data-container="main"] [data-testid^="workspace-container-tab-main-"]',
                ),
            ).map((element) => element.getAttribute("data-tab-id") ?? "");
            return {
                tabIds,
                raw: localStorage.getItem(key),
                layoutWrites: scope.__xhLayoutWrites ?? 0,
            };
        },
        { key: layoutKeyOf(workspaceId) },
    );
}

async function readStoredOpenTabs(page: Page, workspaceId: string): Promise<string[]> {
    return page.evaluate(
        ({ key }: { key: string }) => {
            const raw = localStorage.getItem(key);
            if (!raw) return [];
            try {
                const parsed = JSON.parse(raw) as { openTabs?: unknown };
                return Array.isArray(parsed.openTabs)
                    ? parsed.openTabs.filter((item): item is string => typeof item === "string")
                    : [];
            } catch {
                return [];
            }
        },
        { key: layoutKeyOf(workspaceId) },
    );
}

/** 睡到「reload 起点 + offset」；装载若已超过该时刻则立刻读（不额外等待）。 */
async function sleepTo(page: Page, startedAt: number, offsetMs: number): Promise<void> {
    const remaining = startedAt + offsetMs - Date.now();
    if (remaining > 0) await page.waitForTimeout(remaining);
}

/**
 * 点一次右栏开合图标并**等到 aria-pressed 真的翻转**（点完立刻 reload 会读到写之前的持久片）。
 * 返回翻转后的状态，便于 reload 后比对。
 */
async function clickDockToggle(page: Page): Promise<string> {
    const toggle = page.getByTestId("workspace-dock-toggle").first();
    await expect(toggle).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    const before = (await toggle.getAttribute("aria-pressed")) ?? "";
    await toggle.click();
    await expect(toggle).not.toHaveAttribute("aria-pressed", before);
    return (await toggle.getAttribute("aria-pressed")) ?? "";
}

test.describe("task-126 容器页签持久化三条回归（O3：整份写覆盖分片）", () => {
    let page: Page;
    let workspaceId = "";
    let sessionA = "";
    let sessionB = "";

    test.beforeAll(async ({ browser }) => {
        // 手写 newContext 不继承 config 的 use.{baseURL,viewport,deviceScaleFactor}（见 tabbar-leak.spec.ts）。
        const context = await browser.newContext({
            baseURL: UI_ORIGIN,
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 2,
        });
        // 逐次装载统计「对持久键的写入次数」：init script 每次导航前跑，先归零再挂计数。
        await context.addInitScript((prefix: string) => {
            const scope = window as unknown as { __xhLayoutWrites?: number };
            scope.__xhLayoutWrites = 0;
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function setItem(
                this: Storage,
                name: string,
                value: string,
            ): void {
                if (name.startsWith(prefix))
                    scope.__xhLayoutWrites = (scope.__xhLayoutWrites ?? 0) + 1;
                original.call(this, name, value);
            };
        }, LAYOUT_KEY_PREFIX);
        page = await context.newPage();
        await loginViaForm(page);
        const discovered = await discoverWorkspaceSessions(page);
        workspaceId = discovered.workspaceId;
        [sessionA, sessionB] = discovered.sessionIds;
    });

    test.afterAll(async () => {
        await page.context().close();
    });

    test("关闭的页签不会被随后一次几何变更复活（reload 后仍不在）", async () => {
        await seedOpenTabs(page, workspaceId, [sessionA, sessionB]);
        await openChat(page, workspaceId, sessionA);
        await expect(page.getByTestId(mainTabTestId(sessionA))).toBeVisible();
        await expect(page.getByTestId(mainTabTestId(sessionB))).toBeVisible();

        await page.getByTestId(mainTabCloseTestId(sessionB)).click();
        await expect(page.getByTestId(mainTabTestId(sessionB))).toHaveCount(0);
        expect(await readStoredOpenTabs(page, workspaceId), "关页签后持久片应立刻只剩 A").toEqual([
            "session:" + sessionA,
        ]);

        // 几何变更两次（回到原状态）：这正是 O3 的触发面 —— 修前两次都会把 B 写回持久片。
        await clickDockToggle(page);
        await clickDockToggle(page);
        expect(
            await readStoredOpenTabs(page, workspaceId),
            "几何写不得把已关闭的页签写回持久片（task-126 / O3）",
        ).toEqual(["session:" + sessionA]);

        await page.reload({ waitUntil: "domcontentloaded" });
        await page
            .getByTestId("workspace-workbench")
            .first()
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        await expect(
            page.getByTestId(mainTabTestId(sessionB)),
            "reload 后不得出现已关闭的页签（不许复活）",
        ).toHaveCount(0);
        await expect(page.getByTestId(mainTabTestId(sessionA))).toBeVisible();
    });

    test("无几何首开：开两个会话页签后开右栏，reload 后两页签仍在", async () => {
        // 「无几何」= 持久片里只有 openTabs 分片（A 支 [A,B]→[] 的复现前置）。
        await seedOpenTabs(page, workspaceId, null);
        await seedOpenTabs(page, workspaceId, [sessionA, sessionB]);
        await openChat(page, workspaceId, sessionA);
        await expect(page.getByTestId(mainTabTestId(sessionA))).toBeVisible();
        await expect(page.getByTestId(mainTabTestId(sessionB))).toBeVisible();

        // 首开右栏 ⇒ 首次几何写入（修前这次写入会把挂载时刻的空 openTabs 落盘）。
        const pressedAfterToggle = await clickDockToggle(page);
        expect(await readStoredOpenTabs(page, workspaceId)).toEqual([
            "session:" + sessionA,
            "session:" + sessionB,
        ]);

        await page.reload({ waitUntil: "domcontentloaded" });
        await page
            .getByTestId("workspace-workbench")
            .first()
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        await expect(
            page.getByTestId(mainTabTestId(sessionA)),
            "几何首开后 reload 不得丢掉页签 A（A 支 [A,B]→[]）",
        ).toBeVisible();
        await expect(
            page.getByTestId(mainTabTestId(sessionB)),
            "几何首开后 reload 不得丢掉页签 B（A 支 [A,B]→[]）",
        ).toBeVisible();
        await expect(page.getByTestId("workspace-dock-toggle").first()).toHaveAttribute(
            "aria-pressed",
            pressedAfterToggle,
        );
    });

    // 30 次 reload 零漂移：拆 6 段 × 5 次，单段 ~17s（5 × 3.3s 读数预算）+ 起跑装载 ~3s。
    // 段预算按 TEST_TIMEOUT_MS × 2 而非字面量：慢机上 5 次 reload 可能挤满 30s。
    for (let chunk = 0; chunk < MATRIX_CHUNKS; chunk += 1) {
        test(`30 次 reload 零漂移 · 第 ${chunk + 1}/${MATRIX_CHUNKS} 段（${MATRIX_RELOADS_PER_CHUNK} 次）`, async () => {
            test.setTimeout(TEST_TIMEOUT_MS * 2);
            await openChat(page, workspaceId, sessionA);
            await page.waitForTimeout(SETTLED_READ_OFFSET_MS);
            const baseline = await readLayout(page, workspaceId);
            expect(
                baseline.tabIds.length,
                "矩阵起点应有两个会话页签（本文件上一条用例的产物）",
            ).toBeGreaterThanOrEqual(2);
            expect(baseline.raw, "矩阵起点应有持久片").not.toBeNull();

            for (let index = 0; index < MATRIX_RELOADS_PER_CHUNK; index += 1) {
                const startedAt = Date.now();
                await page.reload({ waitUntil: "domcontentloaded" });
                await page
                    .getByTestId("workspace-workbench")
                    .first()
                    .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
                await sleepTo(page, startedAt, EARLY_READ_OFFSET_MS);
                const early = await readLayout(page, workspaceId);
                await sleepTo(page, startedAt, SETTLED_READ_OFFSET_MS);
                const settled = await readLayout(page, workspaceId);
                const label = `第 ${chunk * MATRIX_RELOADS_PER_CHUNK + index + 1}/${MATRIX_RELOADS} 次 reload`;
                expect(early.tabIds, `${label}：早读（${EARLY_READ_OFFSET_MS}ms）页签漂移`).toEqual(
                    baseline.tabIds,
                );
                expect(
                    settled.tabIds,
                    `${label}：晚读（${SETTLED_READ_OFFSET_MS}ms）页签漂移`,
                ).toEqual(baseline.tabIds);
                expect(early.raw, `${label}：早读持久片与矩阵起点不一致`).toBe(baseline.raw);
                expect(settled.raw, `${label}：晚读持久片与矩阵起点不一致（装载期发生了写）`).toBe(
                    baseline.raw,
                );
                expect(
                    settled.layoutWrites,
                    `${label}：装载过程对持久键写了 ${settled.layoutWrites} 次，应为 0`,
                ).toBe(0);
            }
        });
    }
});
