/**
 * BL-328 真栈复核（`@host` + **approval 车道**）：`Escape` 本地关闭审批卡后，
 * 焦点必须落到 `pending-approval-reopen-pill`；点 pill 重开 ⇒ 卡恢复。
 *
 * 依据（产品实现）：`ChatPanel.vue:312-322`（Escape/遮罩关闭后 `nextTick` 把焦点交给 pill 的
 * `reopenPillRef`）、`:1505-1517`（pill 本体）。单测 `ChatPanel.spec.ts:514/600/626` 已覆盖组件层。
 *
 * 夹具：复用现有"approval 车道"（`chat-follow-up-queue.spec.ts` 同款）——用户 grant + agent 模板
 * （role 带 `delete` 原子 + `toolMode: workspace`）+ 主体 + 工作区绑定，然后发
 * "please delete README.md"；fake LLM 的 approval 模式会走需要审批的工具调用 ⇒ 真栈出现审批卡。
 * **不新造夹具**（膨胀门：先答"被否决的更简方案" = 自建 approval 夹具，成本 20–30 min 且与既有车道重复）。
 *
 * 车道要求：`--llm-mode=approval`（否则 `test.skip` 并写明当前 mode）。
 * 焦点判据：headless 下 `document.activeElement` 可用，但如果整轮为 headless，报告需标注
 * "焦点判据未经 headed 复核"。
 */
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { CP_URL, registerJourneyUser, waitForControlPlaneAgentReady } from "./helpers/journey";
import { seedUserGrant } from "./helpers/user-grants";

test.describe.configure({ retries: 0 });

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";

function requireApprovalMode() {
    test.skip(
        LLM_MODE !== "approval",
        `需要 approval 车道（XIHE_E2E_LLM_MODE=approval），当前 ${LLM_MODE}`,
    );
}

/** 造一个"会触发审批"的 agent 并首绑到工作区（与 chat-follow-up-queue 同款最小夹具）。 */
async function createApprovalAgent(
    request: APIRequestContext,
    userId: string,
    workspaceId: string,
    headers: Record<string, string>,
): Promise<string> {
    seedUserGrant(userId, workspaceId, [{ actionClass: "delete", resource: "*" }]);
    const roleId = randomUUID();
    const templateId = randomUUID();
    const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers,
        data: {
            roles: JSON.stringify([
                {
                    id: roleId,
                    name: "BL328 Approval Role",
                    permissions: [{ actionClass: "delete", resource: "*" }],
                },
            ]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name: "BL328ApprovalAgent",
                    description: "BL-328 approval fixture",
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
        data: { name: "BL328ApprovalAgent", templateId },
    });
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const { principalId } = (await principalResponse.json()) as { principalId: string };
    const bindResponse = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        { headers, data: { permissions: [{ actionClass: "delete", resource: "*" }] } },
    );
    expect(bindResponse.status(), await bindResponse.text()).toBe(200);
    return principalId;
}

/** 打开工作区 → 用 UI 建一个绑定该主体的会话 → 返回 sessionId。 */
async function createApprovalSession(page: Page, principalId: string) {
    await page.getByTestId("workspace-create-session").click();
    const agentSelect = page.getByTestId("workspace-agent-principal-select");
    await expect(agentSelect).toBeVisible();
    await agentSelect.selectOption(principalId);
    await page.getByTestId("workspace-create-agent-session").click();
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20_000 });
}

test("@host BL-328 Escape 关闭审批卡 ⇒ 焦点回到重开 pill；点 pill 重开", async ({
    page,
    request,
}) => {
    requireApprovalMode();
    test.setTimeout(240_000);

    const owner = await registerJourneyUser(request, "bl328-focus");
    const headers = {
        Authorization: `Bearer ${owner.authToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": owner.workspaceId,
    };
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    expect(me.ok(), await me.text()).toBeTruthy();
    const userId = ((await me.json()) as { id: string }).id;
    const principalId = await createApprovalAgent(request, userId, owner.workspaceId, headers);
    await waitForControlPlaneAgentReady(request, headers);

    await page.addInitScript((token) => localStorage.setItem("xihe-token", token), owner.authToken);
    await page.addInitScript(
        (value) => localStorage.setItem("xihe-user", value),
        JSON.stringify({ workspaceId: owner.workspaceId }),
    );
    await page.addInitScript(
        (workspace) => localStorage.setItem("xihe-workspace", JSON.stringify(workspace)),
        { id: owner.workspaceId, name: "Default Workspace" },
    );
    await page.goto(`/workspace/${owner.workspaceId}`, { waitUntil: "domcontentloaded" });
    await createApprovalSession(page, principalId);

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
        "重开后焦点应位于审批卡内（与组件层单测一致；headless 下此判据可信度下降，报告需标注）",
    ).toBe(true);

    console.log(
        `[bl328] OK workspace=${owner.workspaceId} principal=${principalId} ` +
            `pillFocus=pending-approval-reopen-pill reopened=true focusInsideCard=true`,
    );
});
