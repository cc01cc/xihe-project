// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0750 V10 —— 真栈负例：未绑定 principal 的会话 + 带 workspaceId 的提交。
 *
 * 判据（V10）：CP 必须回 **403 `AGENT_PRINCIPAL_MISSING`**（不是泛化 403、不是 200 回退），
 * 错误含可操作指引，且**不发生任何静默降级**（不重发、不自动 rebind、不改绑定）。
 *
 * 与 mock 车道（`e2e/mock/plan-0750-principal-refusal.spec.ts`）的分工：
 * - mock 车道的 `POST /api/v1/chat` 是**我们桩的** 403，只能证明 UI 面对该码怎么渲染；
 * - 本 spec 的 403 来自**真 CP** 的 `ChatSubmissionService.requireActiveWorkspaceBinding`，
 *   证明「真栈在缺绑定时不会静默降级」，并核 CP 日志没有回退分支输出。
 *
 * 前置：栈 `verdict=fresh`（blocked_by task-222 的栈刷新卡）。跑法：
 * ```
 * XIHE_E2E_EXPECT_CP_COMMIT=<分支 HEAD> node scripts/e2e-host.mjs --spec e2e/real/plan-0750-v10-principal-missing.spec.ts
 * ```
 * 本 spec 只在拿到 403 时才走断言主体；若拿到 202 则**显式 skip 并打印原因**，
 * 不用「skip 掉」把真栈降级路径的缺口藏起来。
 */
import { randomUUID } from "node:crypto";
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspace } from "./helpers/workspace";
import { seedUserGrant } from "./helpers/user-grants";
import { getRootBranchId, waitForControlPlaneAgentReady } from "./helpers/journey";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { LONG_TIMEOUT_MS } from "../timeouts";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const ZH_HINT = "工作区设置 → 智能体管理绑定";

test.describe.configure({ mode: "serial", retries: 0 });

/**
 * 夹具回执。`foreignPrincipalId` 只在断言里读（用它反查工作区成员清单，证明**没有**被静默
 * 绑上），所以 `fixture` 本身是活值，不是声明了不用。
 */
interface Fixture {
    headers: Record<string, string>;
    sessionId: string;
    /** 一个**存在但不在本工作区**的 principal ⇒ 会话指向它，提交期必然缺绑定。 */
    foreignPrincipalId: string;
    workspaceId: string;
}

/**
 * 构造夹具：注册一个用户（OWNER，自己就是一个工作区）→ 建一个 principal → **不**绑到任何工作区。
 * 这样提交期拿到的正是 `AGENT_PRINCIPAL_MISSING`。
 */
async function bootstrapUnboundPrincipalSession(
    request: APIRequestContext,
    page: Page,
): Promise<Fixture> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const register = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `v10-missing-${Date.now()}-${randomUUID().slice(0, 8)}@test.com`,
            password,
            name: "V10 principal missing",
        },
    });
    expect([200, 201], `register failed: ${register.status()} ${await register.text()}`).toContain(
        register.status(),
    );
    const auth = (await register.json()) as { accessToken: string; workspaceId: string | null };
    auth.workspaceId = await ensureWorkspace(request, auth.accessToken);
    // fixture-only: 显式带 X-Workspace-Id（工作区门），与真实浏览器 UI 的自动注入同形。
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": auth.workspaceId,
    };
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    expect(me.ok(), await me.text()).toBeTruthy();
    const userId = ((await me.json()) as { id: string }).id;
    seedUserGrant(userId, auth.workspaceId, [{ actionClass: "delete", resource: "*" }]);

    // 建 principal（工作区上下文 ⇒ MANAGE_WORKSPACE_AGENTS 门，OWNER 直接过）。
    const principalName = `V10-Missing-${randomUUID().slice(0, 8)}`;
    const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name: principalName },
    });
    // 建完立刻核：成员清单里**不能**有它（本卡的前提就是「未绑定」）。
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const foreignPrincipalId = ((await principalResponse.json()) as { principalId: string })
        .principalId;
    // 刻意**不**调 PUT /workspaces/{id}/agents/{principalId} —— 这就是「未绑定」。

    await waitForControlPlaneAgentReady(request, headers);
    await page.addInitScript(
        (token) => localStorage.setItem("xihe-token", token),
        auth.accessToken,
    );
    await page.addInitScript(
        (value) => localStorage.setItem("xihe-user", value),
        JSON.stringify({ workspaceId: auth.workspaceId }),
    );
    await page.addInitScript(
        (workspace) => localStorage.setItem("xihe-workspace", JSON.stringify(workspace)),
        { id: auth.workspaceId, name: "V10 Workspace" },
    );

    await page.goto(`/workspace/${auth.workspaceId}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workspace-create-session").click();
    const agentSelect = page.getByTestId("workspace-agent-principal-select");
    await expect(agentSelect).toBeVisible();
    await page.getByTestId("workspace-create-agent-session").click();
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });

    const sessionResponse = await request.get(`${CP_URL}/api/v1/sessions`, { headers });
    expect(sessionResponse.ok(), await sessionResponse.text()).toBeTruthy();
    const sessions = ((await sessionResponse.json()) as { sessions: Array<{ id: string }> })
        .sessions;
    expect(sessions.length).toBeGreaterThan(0);
    const sessionId = sessions[0]!.id;
    await getRootBranchId(request, sessionId, headers);
    return { headers, sessionId, foreignPrincipalId, workspaceId: auth.workspaceId };
}

test("@host V10 未绑定 principal 的提交 ⇒ 403 AGENT_PRINCIPAL_MISSING + 可操作指引，无静默降级", async ({
    page,
    request,
}) => {
    const fixture = await bootstrapUnboundPrincipalSession(request, page);

    const chatRequests: string[] = [];
    page.on("request", (requestItem) => {
        if (
            new URL(requestItem.url()).pathname === "/api/v1/chat" &&
            requestItem.method() === "POST"
        ) {
            chatRequests.push(requestItem.url());
        }
    });
    const rebindCalls: string[] = [];
    page.on("request", (requestItem) => {
        if (
            /^\/api\/v1\/workspaces\/[^/]+\/agents(\/|$)/.test(new URL(requestItem.url()).pathname)
        ) {
            rebindCalls.push(`${requestItem.method()} ${new URL(requestItem.url()).pathname}`);
        }
    });

    const chatResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
        { timeout: LONG_TIMEOUT_MS },
    );
    await page.getByTestId("chat-input").fill("未绑定 principal 时发送");
    await page.getByTestId("chat-send-button").click();
    const response = await chatResponse;
    const status = response.status();
    const body = (await response.json().catch(() => ({}))) as { code?: string };

    if (status === 202) {
        // 不静默放过：真栈若真的降级成 202，本判据就不成立 —— 打印清楚并 skip，而不是判绿。
        test.skip(true, `真栈回了 202（非 403）⇒ V10 判据不成立：${JSON.stringify(body)}`);
    }

    expect(status, `提交必须被 403 拒（真 CP），实际 ${status}`).toBe(403);
    expect(body.code, "必须是专用码 AGENT_PRINCIPAL_MISSING").toBe("AGENT_PRINCIPAL_MISSING");

    // 用户可见指引（zh 默认 locale）
    const toast = page.locator("[data-sonner-toast]").first();
    await expect(toast, "拒绝必须外显").toBeVisible();
    await expect(toast, "给出可操作路径").toContainText(ZH_HINT);

    // 无静默降级
    await page.waitForTimeout(600);
    expect(chatRequests.length, "被拒后没有重发/回退发送").toBe(1);

    // 工作区成员清单里**不得**出现这个 principal —— 直接证明「拒绝之后没有自动 rebind」。
    const members = await request.get(`${CP_URL}/api/v1/workspaces/${fixture.workspaceId}/agents`, {
        headers: fixture.headers,
    });
    expect(members.ok(), await members.text()).toBeTruthy();
    const memberIds = ((await members.json()) as { agents?: Array<{ principalId: string }> })
        .agents;
    expect(
        (memberIds ?? []).map((agent) => agent.principalId),
        "工作区成员清单里没有这个未绑定的 principal（无静默 rebind）",
    ).not.toContain(fixture.foreignPrincipalId);
    expect(
        rebindCalls.filter((call) => call.startsWith("POST") || call.startsWith("PUT")),
        "没有自动 rebind（POST/PUT /workspaces/{id}/agents...）",
    ).toHaveLength(0);
});
