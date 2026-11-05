/**
 * BL-328 真栈复核（`@host` + **approval 车道**）：`Escape` 本地关闭审批卡后，
 * 焦点必须落到 `pending-approval-reopen-pill`；点 pill 重开 ⇒ 卡恢复。
 *
 * 产品依据：`ChatPanel.vue:312-322`（Escape/遮罩关闭后 `nextTick` 把焦点交给 `reopenPillRef`）、
 * `:1505-1517`（pill 本体）；组件层单测 `ChatPanel.spec.ts:514/600/626`。
 *
 * **夹具来源（照搬，不重写）**：`e2e/real/chat-follow-up-queue.spec.ts` 的
 * `createBoundAgent()` + `bootstrapSession()` 原文——那是本仓唯一在 approval 车道拿到过真审批卡的
 * 建会话路径（`ensureAgentWorkspaceBinding` → init script 三键 → `workspace-create-session` →
 * `selectOption` → `create-agent-session`，且**等 `agentSelect` 可见**而不是等 `chat-input`）。
 * 前两次自建版本失败的原因就是"照抄一半"（等错了元素），故本文件以照搬为准。
 *
 * 车道：`--llm-mode=approval`（其它 mode 自动 skip）。
 * 焦点判据：headless 下 `document.activeElement` 可用，但报告须标注"未经 headed 复核"。
 */
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspace } from "./helpers/workspace";
import { seedUserGrant } from "./helpers/user-grants";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";

test.describe.configure({ mode: "serial", retries: 0 });

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";

function requireApprovalMode() {
    test.skip(
        LLM_MODE !== "approval",
        `需要 approval 车道（XIHE_E2E_LLM_MODE=approval），当前 ${LLM_MODE}`,
    );
}

// ── 以下两段照搬 `chat-follow-up-queue.spec.ts`（同车道唯一验证过的夹具）────────────────────

async function createBoundAgent(
    request: APIRequestContext,
    userId: string,
    workspaceId: string,
    headers: Record<string, string>,
): Promise<string> {
    seedUserGrant(userId, workspaceId, [{ actionClass: "delete", resource: "*" }]);
    const roleId = randomUUID(),
        templateId = randomUUID();
    const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers,
        data: {
            roles: JSON.stringify([
                {
                    id: roleId,
                    name: "Follow-up Approval Role",
                    permissions: [{ actionClass: "delete", resource: "*" }],
                },
            ]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name: "FollowUpApprovalAgent",
                    description: "Bounded Agent for real Follow-up queue verification",
                    systemPrompt: "Use only the Workspace tools provided by CP.",
                    toolMode: "workspace",
                    provider: "openai",
                    model: "fake-openai",
                    roleId,
                },
            ]),
        },
    });
    expect(templateWrite.status(), await templateWrite.text()).toBe(200);

    const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name: "FollowUpApprovalAgent", templateId },
    });
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const principalId = ((await principalResponse.json()) as { principalId: string }).principalId;
    const bindResponse = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        { headers, data: { permissions: [{ actionClass: "delete", resource: "*" }] } },
    );
    expect(bindResponse.status(), await bindResponse.text()).toBe(200);
    return principalId;
}

interface BootstrapSession {
    headers: Record<string, string>;
    sessionId: string;
    branchId: string;
    principalId: string;
    workspaceId: string;
}

async function bootstrapSession(request: APIRequestContext, page: Page): Promise<BootstrapSession> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const register = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `bl328-${Date.now()}-${randomUUID().slice(0, 8)}@test.com`,
            password,
            name: "BL328 Approval E2E",
        },
    });
    expect([200, 201], `register failed: ${register.status()} ${await register.text()}`).toContain(
        register.status(),
    );
    const auth = (await register.json()) as { accessToken: string; workspaceId: string };
    // PLAN-0614: registration no longer creates a workspace; create one explicitly.
    auth.workspaceId = await ensureWorkspace(request, auth.accessToken);
    // 与照搬版唯一的差异（Lead 要求显式写清）：**加 `X-Workspace-Id`**。
    // 照搬版没有它，实测 `POST /agent-principals` 直接 409 WORKSPACE_CONTEXT_REQUIRED
    //（runId host-1793912025131-e8a4）—— 说明那条 spec 的 approval 路径久未跑过。
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": auth.workspaceId,
    };
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    expect(me.ok(), await me.text()).toBeTruthy();
    const userId = ((await me.json()) as { id: string }).id;
    const principalId = await createBoundAgent(request, userId, auth.workspaceId, headers);

    await ensureAgentWorkspaceBinding(auth.workspaceId);
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
        { id: auth.workspaceId, name: "Default Workspace" },
    );

    await page.goto(`/workspace/${auth.workspaceId}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workspace-create-session").click();
    const agentSelect = page.getByTestId("workspace-agent-principal-select");
    await expect(agentSelect).toBeVisible();
    await agentSelect.selectOption(principalId);
    await page.getByTestId("workspace-create-agent-session").click();
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20_000 });

    const sessionResponse = await request.get(`${CP_URL}/api/v1/sessions`, { headers });
    expect(sessionResponse.ok(), await sessionResponse.text()).toBeTruthy();
    const sessions = ((await sessionResponse.json()) as { sessions: Array<{ id: string }> })
        .sessions;
    expect(sessions.length).toBeGreaterThan(0);
    const sessionId = sessions[0]!.id,
        branchId = await getRootBranchId(request, sessionId, headers);
    return { headers, sessionId, branchId, principalId, workspaceId: auth.workspaceId };
}

// ── BL-328 ────────────────────────────────────────────────────────────────────────────────

test("@host BL-328 Escape 关闭审批卡 ⇒ 焦点回到重开 pill；点 pill 重开", async ({
    page,
    request,
}) => {
    requireApprovalMode();
    // 2026-11-06 第三次尝试（照搬 chat-follow-up-queue 的 createBoundAgent + bootstrapSession 原文，
    // runId host-1793912280382-ef55）：**同样卡在建会话段** —— 点「创建 agent 会话」后
    // `chat-input` 20 s 内不出现；且照搬版本身已失效（缺 `X-Workspace-Id`，直接 409
    // WORKSPACE_CONTEXT_REQUIRED，见上一轮 runId host-1793912025131-e8a4）。
    // ⇒ 结论修正：**needs "approval 车道 + 建会话段" 两条都跑通的夹具**，而该 spec 的 approval
    //    路径已长期未跑（`requireApprovalMode` 默认 skip），照搬不能解决。
    // 下一步（15–20 min）：用 `--llm-mode=mock` 下已验证的建会话（`ensureFakeUserProvider` +
    //    UI create-session，见 plan0678-skills-positive）先打通会话，再切 approval 车道跑同一段；
    //    或查 CP 侧 POST /sessions 在该车道的失败码（本轮日志无 2xx）。
    test.fixme(true, "approval 车道建会话段未打通（照搬版同红；详情见上方注释与 BL-328 台账）");
    test.setTimeout(240_000);
    const session = await bootstrapSession(request, page);

    const approval = page.getByTestId("approval-modal-content");
    await page.getByTestId("chat-input").fill("please delete README.md");
    await page.getByTestId("chat-send-button").click();
    await expect(approval).toBeVisible({ timeout: 90_000 });

    // Escape ⇒ 本地关闭（不提交任何决定）
    await page.keyboard.press("Escape");
    await expect(approval).toBeHidden({ timeout: 10_000 });

    const pill = page.getByTestId("pending-approval-reopen-pill");
    await expect(pill).toBeVisible({ timeout: 10_000 });
    // 判据 1：焦点落在 pill 上（BL-328 的正题）
    await expect
        .poll(
            () =>
                page.evaluate(
                    () => (document.activeElement as HTMLElement | null)?.dataset.testid ?? "none",
                ),
            { timeout: 10_000, intervals: [100, 250, 500] },
        )
        .toBe("pending-approval-reopen-pill");

    // 判据 2：点 pill 重开，卡恢复且焦点回到卡内
    await pill.click();
    await expect(approval).toBeVisible({ timeout: 10_000 });
    const focusInsideCard = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const card = document.querySelector('[data-testid="approval-modal-content"]');
        return !!active && !!card && card.contains(active);
    });
    expect(
        focusInsideCard,
        "重开后焦点应位于审批卡内（headless 下此判据可信度下降，报告需标注）",
    ).toBe(true);

    console.log(
        `[bl328] OK workspace=${session.workspaceId} session=${session.sessionId} ` +
            `principal=${session.principalId} pillFocus=ok reopened=true focusInsideCard=true`,
    );
});
