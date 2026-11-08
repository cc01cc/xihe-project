// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import {
    CP_URL,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { workspaceChatPath } from "../../src/lib/routes";
import { LONG_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0670 M2d —— **中间位置 prepend 锚定** e2e（Lead 2026-11-05 要求补的诚实边界）。
 *
 * 顶部加载 / 新消息贴底 / 搜索定位已由 `plan0670-m2d-smoke.spec.ts` 覆盖；这条只钉最难的：
 *   滚到列表 ~50% → 触发“加载更早” → **当前可见行视觉位置不变（±2px）**，
 *   且**不跳到顶部、不贴底**；scrollTop 的增量 ≈ scrollHeight 的增量（prepend 补偿）。
 *
 * 稳定性设计（这类测试最易 flaky 的地方）：
 * 1. “50%” 不是绝对像素：先滚到底拿到真实 maxScroll，再用**真实 wheel** 逐步逼近 50%
 *    （每步受 Chromium 单次 wheel 上限约束），最后断言 scrollTop 落在 maxScroll 的 30%–70%
 *    且距顶/距底都 ≥200px——条件不满足直接 fail-fast，不靠 sleep 赌；
 * 2. 锚点选“**完整可见**的第一行”（top≥viewportTop 且 bottom≤viewportBottom），避免半截行
 *    在 prepend 前后测量基准不同；
 * 3. “加载更早”入口在列表顶部，中间位置不可见——本 spec 用 `el.click()` **程序化点击 DOM 中
 *    已存在的入口**，刻意不把“滚回顶部再点”混进锚定测量（那会改变被测状态）；
 * 4. 点击后用 `expect.poll` 等消息数增加 + 等待锚点行重新进入 DOM，再取 rAF 两帧后的稳定值。
 */
const EVIDENCE_DIR = (() => {
    const hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT;
    if (hostRoot) {
        return path.join(path.resolve(hostRoot, "../../../.."), ".local", "evidence", "plan-0670");
    }
    const threeUp = path.resolve(process.cwd(), "../../..");
    const oneRoot = path.basename(threeUp) === ".worktrees" ? path.resolve(threeUp, "..") : threeUp;
    return path.join(oneRoot, ".local", "evidence", "plan-0670");
})();

const HISTORY_COUNT = 120;
const MIDDLE_BAND = { min: 0.3, max: 0.7, edgePx: 200 };

function psql(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "middle-anchor spec needs the isolated e2e-host PostgreSQL fixture metadata",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: LONG_TIMEOUT_MS, windowsHide: true },
    ).trim();
}

async function rootBranchId(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
): Promise<string> {
    const response = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}/branches`, {
        headers,
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as {
        items?: Array<{ branchId: string; parentBranchId?: string | null }>;
    };
    const root = (body.items ?? []).find((branch) => !branch.parentBranchId);
    expect(root?.branchId, "root branch must exist").toBeTruthy();
    return root!.branchId;
}

function seedHistory(sessionId: string, branchId: string): void {
    const values = Array.from({ length: HISTORY_COUNT }, (_, index) => {
        const role = index % 2 === 0 ? "USER" : "ASSISTANT";
        const content =
            index % 10 === 0
                ? `middle-anchor long ${index} ${"x".repeat(600)}`
                : `middle-anchor message ${index}`;
        return `('${crypto.randomUUID()}', '${sessionId}', '${branchId}', '${role}', '${content}', now() - interval '${HISTORY_COUNT - index} minutes')`;
    }).join(",\n");
    psql(
        `INSERT INTO messages (id, session_id, branch_id, role, content, created_at) VALUES ${values}`,
    );
}

interface ScrollMetrics {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    maxScroll: number;
}

async function metrics(page: Page): Promise<ScrollMetrics> {
    return await page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>(
            '[data-testid="message-scroller-viewport"]',
        );
        if (!viewport) throw new Error("message-scroller-viewport missing");
        const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        return {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            maxScroll,
        };
    });
}

async function wheelToMiddle(page: Page): Promise<ScrollMetrics> {
    const viewport = page.getByTestId("message-scroller-viewport");
    await viewport.hover();
    // 先到底，拿到真实 maxScroll（首屏 50 条时也保证是“用户滚到底”的用户意图）。
    await page.mouse.wheel(0, 200_000);
    await expect
        .poll(async () => (await metrics(page)).maxScroll - (await metrics(page)).scrollTop, {
            timeout: LONG_TIMEOUT_MS,
            intervals: [100, 200, 500],
        })
        .toBeLessThan(8);

    for (let attempt = 0; attempt < 40; attempt += 1) {
        const current = await metrics(page);
        const target = current.maxScroll * 0.5;
        if (Math.abs(current.scrollTop - target) <= 8) return current;
        const delta = Math.max(-1200, Math.min(1200, target - current.scrollTop));
        await page.mouse.wheel(0, delta);
        // 每次 wheel 后等一帧，让 scroll 事件与模式同步落地（不 sleep）。
        await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
    }
    return await metrics(page);
}

async function waitScrollStable(page: Page): Promise<ScrollMetrics> {
    let previous = await metrics(page);
    for (let attempt = 0; attempt < 30; attempt += 1) {
        await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        const current = await metrics(page);
        if (Math.abs(current.scrollTop - previous.scrollTop) <= 0.5) return current;
        previous = current;
    }
    return previous;
}

async function visibleAnchor(page: Page) {
    return await page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>(
            '[data-testid="message-scroller-viewport"]',
        );
        if (!viewport) return null;
        const viewportRect = viewport.getBoundingClientRect();
        for (const wrapper of viewport.querySelectorAll<HTMLElement>("[data-message-id]")) {
            const row = wrapper.querySelector<HTMLElement>("[data-message-role]");
            if (!row) continue;
            const rect = row.getBoundingClientRect();
            // 完整可见：不选被视口上下边缘裁掉的行，前后测量才是同一基准。
            if (rect.top >= viewportRect.top + 1 && rect.bottom <= viewportRect.bottom - 1) {
                return { id: wrapper.dataset.messageId ?? "", top: rect.top };
            }
        }
        return null;
    });
}

async function anchorTop(page: Page, id: string): Promise<number | null> {
    return await page.evaluate((messageId) => {
        const wrapper = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
        const row = wrapper?.querySelector<HTMLElement>("[data-message-role]");
        return row ? row.getBoundingClientRect().top : null;
    }, id);
}

test.describe("@host PLAN-0670 M2d middle-anchor prepend", () => {
    test.describe.configure({ mode: "serial", retries: 0 });

    test("loading older at ~50% keeps the visible row pinned (±2px), not top/bottom", async ({
        page,
        request,
    }) => {
        test.skip(!process.env.XIHE_E2E_PG_CONTAINER, "requires the isolated e2e-host stack");
        mkdirSync(EVIDENCE_DIR, { recursive: true });

        const ctx = await registerJourneyUser(request, "plan0670-middle-anchor");
        const wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await waitForControlPlaneAgentReady(request, headers);
        const auth = { accessToken: ctx.authToken, workspaceId: wsId };
        await ensureFakeUserProvider(request, auth);
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: agentName("MiddleAnchor", Date.now()),
            actions: ["read"],
            systemPrompt: "Reply briefly.",
        });
        const sessionId = await createSessionWithPrincipal(request, auth, {
            principalId,
            title: "M2d middle anchor",
            workspaceId: wsId,
        });
        const branchId = await rootBranchId(request, headers, sessionId);
        seedHistory(sessionId, branchId);

        await seedPage(page, ctx);
        await page.goto(workspaceChatPath(wsId, sessionId));
        await expect(page.getByTestId("message-list")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect
            .poll(async () => await page.locator("[data-message-role]").count(), {
                timeout: LONG_TIMEOUT_MS,
                intervals: [500, 1000, 2000],
            })
            .toBeGreaterThan(0);
        const firstPage = await page.locator("[data-message-role]").count();
        expect(firstPage, "首屏应只加载一页").toBeLessThan(HISTORY_COUNT);

        // ① 真实 wheel 滚到 ~50%（稳定条件：落在 maxScroll 的 30%–70%，且距顶/距底 ≥200px）。
        await wheelToMiddle(page);
        const settled = await waitScrollStable(page);
        const ratio = settled.maxScroll > 0 ? settled.scrollTop / settled.maxScroll : 0;
        expect(ratio, `middle band ratio=${ratio.toFixed(3)}`).toBeGreaterThanOrEqual(
            MIDDLE_BAND.min,
        );
        expect(ratio).toBeLessThanOrEqual(MIDDLE_BAND.max);
        expect(settled.scrollTop, "not near top").toBeGreaterThan(MIDDLE_BAND.edgePx);
        expect(settled.maxScroll - settled.scrollTop, "not near bottom").toBeGreaterThan(
            MIDDLE_BAND.edgePx,
        );

        const before = await visibleAnchor(page);
        expect(before, "middle scroll must have a fully visible anchor row").toBeTruthy();

        // ② 触发加载更早：入口在顶部不可见，程序化点击 DOM 中已有按钮（不滚回顶部污染测量）。
        const loadOlder = page.getByTestId("load-older-messages");
        await expect(loadOlder).toHaveCount(1);
        await page.evaluate(() => {
            document.querySelector<HTMLElement>('[data-testid="load-older-messages"]')?.click();
        });
        await expect
            .poll(async () => await page.locator("[data-message-role]").count(), {
                timeout: LONG_TIMEOUT_MS,
                intervals: [500, 1000, 2000],
            })
            .toBeGreaterThan(firstPage);
        await expect
            .poll(async () => await anchorTop(page, before!.id), {
                timeout: LONG_TIMEOUT_MS,
                intervals: [100, 200, 500],
            })
            .not.toBeNull();
        await page.evaluate(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                ),
        );

        const afterMetrics = await waitScrollStable(page);
        const afterTop = await anchorTop(page, before!.id);
        expect(afterTop, "anchor row must remain rendered after prepend").not.toBeNull();

        const heightDelta = afterMetrics.scrollHeight - settled.scrollHeight;
        const scrollDelta = afterMetrics.scrollTop - settled.scrollTop;
        const observed = {
            plan: "PLAN-0670",
            task: "M2d middle-anchor prepend",
            sessionId,
            firstPage,
            afterLoad: await page.locator("[data-message-role]").count(),
            before: { ...settled, ratio, anchorId: before!.id, anchorTop: before!.top },
            after: {
                ...afterMetrics,
                anchorTop: afterTop,
                heightDelta,
                scrollDelta,
            },
            anchorShiftPx: Math.abs((afterTop ?? 0) - before!.top),
        };
        writeFileSync(
            path.join(EVIDENCE_DIR, "m2d-middle-anchor.json"),
            JSON.stringify({ ...observed, observedAt: new Date().toISOString() }, null, 2),
        );
        await page.screenshot({ path: path.join(EVIDENCE_DIR, "m2d-middle-anchor.png") });

        // ③ 判据：可见行视觉位置不变（±2px）。
        expect(
            Math.abs((afterTop ?? 0) - before!.top),
            `middle anchor shift: before=${before!.top.toFixed(2)} after=${(afterTop ?? 0).toFixed(2)}`,
        ).toBeLessThanOrEqual(2);

        // ④ 判据：prepend 后 scrollTop 按 scrollHeight 增量补偿（内容加在上方，视觉位置不变）。
        expect(heightDelta, "prepend must grow scrollHeight").toBeGreaterThan(0);
        expect(
            Math.abs(scrollDelta - heightDelta),
            `scrollTop delta=${scrollDelta.toFixed(2)} height delta=${heightDelta.toFixed(2)}`,
        ).toBeLessThanOrEqual(16);

        // ⑤ 判据：不跳到顶部、不贴底。
        expect(afterMetrics.scrollTop, "must not jump to top").toBeGreaterThan(MIDDLE_BAND.edgePx);
        expect(
            afterMetrics.maxScroll - afterMetrics.scrollTop,
            "must not jump to bottom",
        ).toBeGreaterThan(MIDDLE_BAND.edgePx);
    });
});
