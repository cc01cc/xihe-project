// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
    CP_URL,
    awaitLatestChatRunCompleted,
    ensureAgentWorkspaceBinding,
    ensureChatReady,
    evidenceDir,
    registerJourneyUser,
    seedPage,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { seedUserGrant } from "./helpers/user-grants";
import { LONG_TIMEOUT_MS } from "../timeouts";

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const MODEL_ID = process.env.XIHE_E2E_FAKE_MODEL ?? "fake-openai";
const EVIDENCE_DIR = evidenceDir("plan-0572");

/** PLAN-0572: a persisted tool card must come back after a full page reload. */
test.describe("@host PLAN-0572 tool card refresh", () => {
    test("read_file tool card survives refresh on desktop and mobile", async ({
        page,
        request,
    }) => {
        test.skip(
            LLM_MODE !== "read_file",
            "requires XIHE_E2E_LLM_MODE=read_file fake LLM marker mode",
        );
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const ctx = await registerJourneyUser(request, "plan0572-toolcalls"),
            wsId = ctx.workspaceId,
            headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await ensureAgentWorkspaceBinding(wsId);
        await waitForControlPlaneAgentReady(request, headers);

        // PLAN-0374 session gates: Session creation requires a workspace-bound
        // agent principal, so create template → principal → binding → session.
        const meRes = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
        expect(meRes.ok(), await meRes.text()).toBeTruthy();
        const userId = ((await meRes.json()) as { id: string }).id;
        seedUserGrant(userId, wsId, [{ actionClass: "write", resource: "*" }]);
        const roleId = randomUUID(),
            templateId = randomUUID();
        const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers,
            data: {
                roles: JSON.stringify([
                    {
                        id: roleId,
                        name: "PLAN-0572 Role",
                        permissions: [{ actionClass: "write", resource: "*" }],
                    },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "PLAN0572Agent",
                        description: "Workspace-bound fixture for the tool card refresh case",
                        systemPrompt: "Use only the Workspace tools provided by CP.",
                        toolMode: "workspace",
                        provider: "openai",
                        model: MODEL_ID,
                        roleId,
                    },
                ]),
            },
        });
        expect(templateWrite.status(), await templateWrite.text()).toBe(200);
        const principalRes = await request.post(`${CP_URL}/api/v1/agent-principals`, {
            headers,
            data: { name: "PLAN0572Agent", templateId },
        });
        expect(principalRes.status(), await principalRes.text()).toBe(201);
        const principalId = ((await principalRes.json()) as { principalId: string }).principalId;
        const bindRes = await request.put(
            `${CP_URL}/api/v1/workspaces/${wsId}/agents/${principalId}`,
            {
                headers,
                data: { permissions: [{ actionClass: "write", resource: "*" }] },
            },
        );
        expect(bindRes.status(), await bindRes.text()).toBe(200);
        const sessionRes = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers,
            data: { title: "PLAN-0572 tool card refresh", agentPrincipalId: principalId },
        });
        expect(sessionRes.status(), await sessionRes.text()).toBe(201);
        const sessionId = ((await sessionRes.json()) as { id: string }).id;

        seedPage(page, ctx);
        await page.goto(`/workspace/${wsId}/chat/${sessionId}`, { waitUntil: "load" });
        await ensureChatReady(page);

        await sendChat(page, "XIHE-E2E-READ README.md");
        const liveCard = page
            .locator('[data-testid="tool-card-toggle"]')
            .filter({ hasText: "read_file" })
            .last();
        await expect(liveCard, "live tool card").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(
            page.getByText("Read completed.").last(),
            "assistant terminal text",
        ).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await awaitLatestChatRunCompleted(request, headers, wsId);

        await liveCard.click();
        const liveDetails = liveCard.locator("xpath=..");
        await expect(liveDetails.locator('[data-testid="raw-arguments"]')).toContainText(
            "README.md",
            { timeout: LONG_TIMEOUT_MS },
        );
        await expect(liveDetails.locator('[data-testid="raw-result"]')).toContainText(
            "Tool result withheld",
            { timeout: LONG_TIMEOUT_MS },
        );
        await page.screenshot({
            scale: "css",
            path: path.join(EVIDENCE_DIR, "tool-card-live.png"),
            fullPage: false,
        });

        await page.reload({ waitUntil: "load" });
        const reloadedCard = page
            .locator('[data-testid="tool-card-toggle"]')
            .filter({ hasText: "read_file" })
            .last();
        await expect(reloadedCard, "tool card after refresh").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await reloadedCard.click();
        const reloadedDetails = reloadedCard.locator("xpath=..");
        await expect(reloadedDetails.locator('[data-testid="raw-arguments"]')).toContainText(
            "README.md",
            { timeout: LONG_TIMEOUT_MS },
        );
        await expect(reloadedDetails.locator('[data-testid="raw-result"]')).toContainText(
            "Tool result withheld",
            { timeout: LONG_TIMEOUT_MS },
        );
        await page.screenshot({
            scale: "css",
            path: path.join(EVIDENCE_DIR, "tool-card-refreshed.png"),
            fullPage: false,
        });

        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload({ waitUntil: "load" });
        const openChat = page.getByTestId("mobile-chat-open");
        const mobileSheet = page.getByTestId("mobile-chat-sheet");
        await expect(openChat, "mobile chat FAB").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        for (let attempt = 0; attempt < 5; attempt++) {
            await openChat.click({ force: true }).catch(() => {});
            if (await mobileSheet.isVisible().catch(() => false)) break;
            await page.waitForTimeout(500);
        }
        await expect(mobileSheet, "mobile chat sheet").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        const mobileCard = page
            .locator('[data-testid="tool-card-toggle"]')
            .filter({ hasText: "read_file" })
            .last();
        await expect(mobileCard, "tool card after mobile refresh").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await mobileCard.click();
        await expect(
            mobileCard.locator("xpath=..").locator('[data-testid="raw-arguments"]'),
        ).toContainText("README.md", { timeout: LONG_TIMEOUT_MS });
        await page.screenshot({
            scale: "css",
            path: path.join(EVIDENCE_DIR, "tool-card-refreshed-mobile.png"),
            fullPage: false,
        });
    });
});
