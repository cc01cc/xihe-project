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

/**
 * PLAN-0670 M2d —— 三项交互 smoke（真栈，e2e-host `--llm-mode=success`）：
 *   ① 滚动到顶能加载更早（分页 + prepend 锚点不跳）；
 *   ② 新消息贴底（auto-scroll 语义不变）；
 *   ③ 搜索定位（搜索态关闭窗口化、过滤 + 回到顶部行为不变）。
 *
 * 种子：120 条历史消息直连 PG（与 perf gate 同一 seed 思路，避免把 API 写吞吐当夹具）。
 * 运行：e2e-host 持久栈 + 本 spec（详见 PLAN-0670 M2d 验收记录）。
 */
const EVIDENCE_DIR = (() => {
    const hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT;
    if (hostRoot)
        return path.join(path.resolve(hostRoot, "../../../.."), ".local", "evidence", "plan-0670");
    const threeUp = path.resolve(process.cwd(), "../../..");
    const oneRoot = path.basename(threeUp) === ".worktrees" ? path.resolve(threeUp, "..") : threeUp;
    return path.join(oneRoot, ".local", "evidence", "plan-0670");
})();

const HISTORY_COUNT = 120;
const SEED_MARKER = "zzz-m2d-smoke-unique-marker";

function psql(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error("smoke needs the isolated e2e-host PostgreSQL fixture metadata");
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 30_000, windowsHide: true },
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
            index === HISTORY_COUNT - 1
                ? SEED_MARKER
                : index % 10 === 0
                  ? `long-form ${index} ${"x".repeat(600)}`
                  : `history message ${index}`;
        return `('${crypto.randomUUID()}', '${sessionId}', '${branchId}', '${role}', '${content.replace(/'/g, "''")}', now() - interval '${HISTORY_COUNT - index} minutes')`;
    }).join(",\n");
    psql(
        `INSERT INTO messages (id, session_id, branch_id, role, content, created_at) VALUES ${values}`,
    );
}

function messageRows(page: Page) {
    return page.locator("[data-message-role]");
}

async function messageCount(page: Page): Promise<number> {
    return await messageRows(page).count();
}

test.describe("@host PLAN-0670 M2d interaction smoke", () => {
    test.describe.configure({ mode: "serial", retries: 0 });

    test("pagination anchor + stick-to-bottom + search still work with virtualization", async ({
        page,
        request,
    }) => {
        test.skip(!process.env.XIHE_E2E_PG_CONTAINER, "requires the isolated e2e-host stack");
        test.setTimeout(600_000);
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const observed: Record<string, unknown> = { plan: "PLAN-0670", task: "M2d smoke" };
        const persist = (): void => {
            writeFileSync(
                path.join(EVIDENCE_DIR, "m2d-smoke-observed.json"),
                JSON.stringify({ ...observed, observedAt: new Date().toISOString() }, null, 2),
            );
        };

        const ctx = await registerJourneyUser(request, "plan0670-smoke");
        const wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await waitForControlPlaneAgentReady(request, headers);
        const auth = { accessToken: ctx.authToken, workspaceId: wsId };
        await ensureFakeUserProvider(request, auth);
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: agentName("M2dSmoke", Date.now()),
            actions: ["read"],
            systemPrompt: "Reply briefly.",
        });
        const sessionId = await createSessionWithPrincipal(request, auth, {
            principalId,
            title: "M2d interaction smoke",
            workspaceId: wsId,
        });
        const branchId = await rootBranchId(request, headers, sessionId);
        seedHistory(sessionId, branchId);
        observed["sessionId"] = sessionId;

        await seedPage(page, ctx);
        await page.goto(workspaceChatPath(wsId, sessionId));
        await expect(page.getByTestId("message-list")).toBeVisible({ timeout: 60_000 });
        await expect
            .poll(async () => await messageCount(page), {
                timeout: 120_000,
                intervals: [500, 1000, 2000],
            })
            .toBeGreaterThan(0);
        const firstPage = await messageCount(page);
        observed["firstPage"] = firstPage;
        // 首屏是 CP 的一页（limit=50），不是全量 120。
        expect(firstPage, "首屏应只加载一页，不是全量").toBeLessThan(HISTORY_COUNT);

        // ① 滚动到顶能加载更早：真实 wheel 意图（userScrollIntent）→ 顶 → 点击入口。
        // 注：像素级"prepend 锚点不跳"由单测 `virtualWindow.spec` 钉住；这里验产品入口链路。
        const viewport = page.getByTestId("message-scroller-viewport");
        await viewport.hover();
        await page.mouse.wheel(0, -100_000);
        await expect
            .poll(async () => await viewport.evaluate((element) => element.scrollTop), {
                timeout: 30_000,
                intervals: [200, 500, 1000],
            })
            .toBe(0);
        const loadOlder = page.getByTestId("load-older-messages");
        await expect(loadOlder).toBeVisible({ timeout: 30_000 });
        await loadOlder.click();
        await expect
            .poll(async () => await messageCount(page), {
                timeout: 120_000,
                intervals: [500, 1000, 2000],
            })
            .toBeGreaterThan(firstPage);
        const afterLoad = await messageCount(page);
        observed["pagination"] = { firstPage, afterLoad };
        expect(afterLoad, "点击加载更早后消息数应增加").toBeGreaterThan(firstPage);
        await page.screenshot({ path: path.join(EVIDENCE_DIR, "smoke-01-load-older-anchor.png") });
        persist();

        // ② 新消息贴底：滚到底部发一条，等回复后视口应在底部附近。
        await page.evaluate(() => {
            const viewportEl = document.querySelector<HTMLElement>(
                '[data-testid="message-scroller-viewport"]',
            );
            if (viewportEl) viewportEl.scrollTop = viewportEl.scrollHeight;
        });
        const beforeSend = await messageCount(page);
        await page.getByTestId("chat-input").fill(`smoke stick-bottom ${Date.now()}`);
        await page.getByTestId("chat-send-button").click();
        await expect
            .poll(async () => await messageCount(page), {
                timeout: 180_000,
                intervals: [500, 1000, 2000],
            })
            .toBeGreaterThan(beforeSend);
        const distanceToBottom = await page.evaluate(() => {
            const viewportEl = document.querySelector<HTMLElement>(
                '[data-testid="message-scroller-viewport"]',
            );
            return viewportEl
                ? viewportEl.scrollHeight - viewportEl.scrollTop - viewportEl.clientHeight
                : Number.POSITIVE_INFINITY;
        });
        observed["stickToBottom"] = { distanceToBottom };
        expect(distanceToBottom, "新消息到达后应贴底（≤60px）").toBeLessThanOrEqual(60);
        await page.screenshot({ path: path.join(EVIDENCE_DIR, "smoke-02-stick-bottom.png") });

        // ③ 搜索定位：搜索态关闭窗口化，过滤 + 回顶行为不变。
        await page.getByTestId("message-search-toggle").click();
        const searchInput = page.getByPlaceholder(/搜索消息/);
        await expect(searchInput).toBeVisible({ timeout: 10_000 });
        await searchInput.fill(SEED_MARKER);
        await expect
            .poll(async () => await messageCount(page), {
                timeout: 30_000,
                intervals: [200, 500, 1000],
            })
            .toBe(1);
        const searchScrollTop = await viewport.evaluate((element) => element.scrollTop);
        observed["search"] = { filtered: await messageCount(page), scrollTop: searchScrollTop };
        expect(searchScrollTop, "搜索后应回到顶部").toBeLessThanOrEqual(1);
        await page.screenshot({ path: path.join(EVIDENCE_DIR, "smoke-03-search.png") });
        persist();
    });
});
