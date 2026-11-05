/**
 * BL-328 建会话段探针（临时文件，跑完即删）：先用 mock 车道证明"UI 建会话"这段可靠，
 * 再**同一段**切 approval 车道，抓 `POST /api/v1/sessions` 的真实状态码/响应体。
 *
 * 目的（Lead A′ 窗口）：把"无 2xx"变成"具体哪个码/哪一步不发"。
 */
import { expect, test } from "@playwright/test";

import { provisionWorkspaceAgentPrincipal } from "./helpers/agent-principal";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { registerJourneyUser } from "./helpers/journey";

test.describe.configure({ retries: 0 });

test("@host BL-328 探针：UI 建会话（mock/approval 同段）", async ({ page, request }) => {
    test.setTimeout(180_000);
    const owner = await registerJourneyUser(request, "bl328-probe");
    await ensureFakeUserProvider(request, {
        accessToken: owner.authToken,
        workspaceId: owner.workspaceId,
    });
    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: owner.authToken, workspaceId: owner.workspaceId },
        { name: `ProbeSession${Date.now().toString(36)}`, actions: ["read"] },
    );

    const sessionCalls: string[] = [];
    page.on("response", (res) => {
        const url = new URL(res.url());
        // 会话创建走**路径形式** `POST /api/v1/workspaces/{id}/sessions`（也可能有 instance 形式）
        const isSessionCreate =
            res.request().method() === "POST" &&
            (url.pathname.endsWith("/api/v1/sessions") ||
                /^\/api\/v1\/workspaces\/[^/]+\/sessions$/u.test(url.pathname));
        if (!isSessionCreate) return;
        void res
            .text()
            .then((body) => sessionCalls.push(`HTTP ${res.status()} ${body.slice(0, 400)}`))
            .catch(() => sessionCalls.push(`HTTP ${res.status()} <body unreadable>`));
    });
    page.on("requestfailed", (req) => {
        const url = new URL(req.url());
        if (url.pathname.endsWith("/api/v1/sessions") || url.pathname.includes("/sessions"))
            sessionCalls.push(`FAILED ${url.pathname} ${req.failure()?.errorText ?? "?"}`);
    });

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
    await page.getByTestId("workspace-create-session").click();
    const agentSelect = page.getByTestId("workspace-agent-principal-select");
    await expect(agentSelect).toBeVisible({ timeout: 30_000 });
    await agentSelect.selectOption(principalId);
    await page.getByTestId("workspace-create-agent-session").click();

    let chatInput = "ok";
    try {
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 25_000 });
    } catch {
        chatInput = "missing";
    }
    console.log(
        `[bl328-probe] mode=${process.env.XIHE_E2E_LLM_MODE ?? "mock"} chatInput=${chatInput} ` +
            `sessionCalls=${JSON.stringify(sessionCalls)}`,
    );
    // 探针不判红：它的产出就是上面那行日志
});
