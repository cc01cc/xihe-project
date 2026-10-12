import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { provisionWorkspaceAgentPrincipal } from "./helpers/agent-principal";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
let auth: { accessToken: string; workspaceId: string };
let principalId: string;
test.beforeAll(async ({ request }) => {
    const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `template-${randomUUID()}@test.local`,
            password: generateE2EPassword(),
            name: "Template Wire",
        },
    });
    expect(registration.status()).toBe(201);
    auth = await registration.json();
    principalId = await provisionWorkspaceAgentPrincipal(request, auth, { name: "Template Wire" });
});
const cases = [
    {
        providerId: "custom-openai-compatible",
        apiTypeId: "openai-chat-completions",
        path: "/v1/chat/completions",
    },
    { providerId: "anthropic", apiTypeId: "anthropic-messages", path: "/v1/messages" },
    { providerId: "xiaomi", apiTypeId: "mimo-responses", path: "/v1/responses" },
];

for (const wire of cases) {
    test.describe(`@host PLAN-0439 ${wire.apiTypeId} API request template`, () => {
        test("published raw source reaches the provider through a pinned browser Session", async ({
            page,
            request,
        }) => {
            test.skip(
                (process.env.XIHE_E2E_LLM_MODE ?? "mock") !== "success",
                "requires XIHE_E2E_LLM_MODE=success (provider wire); current: " +
                    (process.env.XIHE_E2E_LLM_MODE ?? "mock"),
            );
            test.setTimeout(60000);
            const observed: Record<string, unknown>[] = [];
            const paths: string[] = [];
            const provider = createServer(async (incoming, response) => {
                try {
                    const chunks: Buffer[] = [];
                    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
                    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    observed.push(body);
                    paths.push(incoming.url ?? "");
                    response.writeHead(200, { "Content-Type": "text/event-stream" });
                    const event = (name: string, data: unknown) =>
                        response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
                    if (wire.apiTypeId === "anthropic-messages") {
                        event("message_start", {
                            type: "message_start",
                            message: {
                                id: "msg-wire",
                                type: "message",
                                role: "assistant",
                                content: [],
                                usage: { input_tokens: 1, output_tokens: 0 },
                            },
                        });
                        event("content_block_start", {
                            type: "content_block_start",
                            index: 0,
                            content_block: { type: "text", text: "" },
                        });
                        event("content_block_delta", {
                            type: "content_block_delta",
                            index: 0,
                            delta: { type: "text_delta", text: "template-wire-confirmed" },
                        });
                        event("content_block_stop", { type: "content_block_stop", index: 0 });
                        event("message_delta", {
                            type: "message_delta",
                            delta: { stop_reason: "end_turn" },
                            usage: { output_tokens: 1 },
                        });
                        event("message_stop", { type: "message_stop" });
                        response.end();
                    } else if (wire.apiTypeId === "mimo-responses") {
                        event("response.output_text.delta", {
                            type: "response.output_text.delta",
                            output_index: 0,
                            content_index: 0,
                            delta: "template-wire-confirmed",
                        });
                        event("response.completed", {
                            type: "response.completed",
                            response: {
                                id: "resp-wire",
                                status: "completed",
                                output: [
                                    {
                                        type: "message",
                                        role: "assistant",
                                        content: [
                                            {
                                                type: "output_text",
                                                text: "template-wire-confirmed",
                                            },
                                        ],
                                    },
                                ],
                                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                            },
                        });
                        response.end();
                    } else {
                        response.write(
                            `data: ${JSON.stringify({ choices: [{ delta: { content: "template-wire-confirmed" } }] })}\n\n`,
                        );
                        response.end("data: [DONE]\n\n");
                    }
                } catch {
                    response.writeHead(400);
                    response.end();
                }
            });
            await new Promise<void>((resolve, reject) => {
                provider.once("error", reject);
                provider.listen(0, "127.0.0.1", resolve);
            });
            try {
                const address = provider.address();
                if (!address || typeof address === "string")
                    throw new Error("provider address missing");
                const headers = {
                    Authorization: `Bearer ${auth.accessToken}`,
                    "X-Workspace-Id": auth.workspaceId,
                };
                const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
                    headers,
                    data: {
                        providerId: wire.providerId,
                        apiTypeId: wire.apiTypeId,
                        apiTypeVersion: 1,
                        apiKey: "fake-wire-credential",
                        connectionKey: `template-wire-${wire.apiTypeId}`,
                        label: "Template Wire",
                        scope: "USER",
                        baseUrl: `http://127.0.0.1:${address.port}/v1`,
                        modelDiscovery: "manual",
                        manualModels: ["wire-model"],
                    },
                });
                expect(created.status(), await created.text()).toBe(201);
                const connection = await created.json();
                const verified = await request.post(
                    `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
                    { headers },
                );
                expect(verified.ok(), await verified.text()).toBe(true);
                observed.length = 0;
                await page.addInitScript(
                    ({ token, workspaceId }) => {
                        localStorage.setItem("xihe-token", token);
                        localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
                        localStorage.setItem(
                            "xihe-workspace",
                            JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
                        );
                    },
                    { token: auth.accessToken, workspaceId: auth.workspaceId },
                );
                await page.goto("/settings/config");
                await page.getByTestId("config-tab-user").click();
                const panel = page.getByTestId("api-request-templates-panel");
                await expect(panel).toBeVisible();
                await panel.getByTestId("api-request-type").selectOption(wire.apiTypeId + "@1");
                await panel.getByTestId("api-request-new").click();
                const templateName = `Wire authored ${wire.apiTypeId}`;
                await panel.getByTestId("api-request-name").fill(templateName);
                const bodySource = JSON.stringify({
                    model: "${xh.model}",
                    [wire.apiTypeId === "mimo-responses" ? "input" : "messages"]: [
                        { role: "user", content: "prefix:${xh.user_input}" },
                    ],
                    ...(wire.apiTypeId === "anthropic-messages" ? { max_tokens: 256 } : {}),
                    stream: true,
                    temperature: 0.17,
                });
                await panel.getByTestId("api-request-body-source").fill(bodySource);
                const saved = page.waitForResponse(
                    (r) =>
                        r.url().includes("/config/user/api-request-templates") &&
                        r.request().method() === "PUT",
                );
                await panel.getByTestId("api-request-publish").click();
                expect((await saved).status()).toBe(200);
                await page.reload();
                await expect(panel).toContainText(templateName);
                await panel.screenshot({
                    path: test.info().outputPath("template-editor-published.png"),
                    animations: "disabled",
                });
                const config = await request.get(
                    `${CP_URL}/api/v1/config/api-request-templates?layer=user`,
                    { headers },
                );
                expect(config.ok()).toBe(true);
                const template = JSON.parse((await config.json()).templates).find(
                    (item: { name: string }) => item.name === templateName,
                );
                expect(template.bodySource).toBe(bodySource);
                const hub = page.getByTestId("provider-hub");
                await hub.getByTestId(`provider-connection-${wire.providerId}`).click();
                const refKey = `user:${template.id}:${template.version}`;
                const defaultSelect = hub.getByRole("combobox", {
                    name: "连接默认请求模板",
                    exact: true,
                });
                await expect(defaultSelect).toBeEnabled();
                const defaultSaved = page.waitForResponse(
                    (r) =>
                        r.url().includes("/config/user/api-request-templates") &&
                        r.request().method() === "PUT",
                );
                await defaultSelect.selectOption(refKey);
                expect((await defaultSaved).status()).toBe(200);
                const modelSelect = hub.getByRole("combobox", {
                    name: "wire-model 请求模板",
                    exact: true,
                });
                await expect(modelSelect).toBeEnabled();
                const overrideSaved = page.waitForResponse(
                    (r) =>
                        r.url().includes("/config/user/api-request-templates") &&
                        r.request().method() === "PUT",
                );
                await modelSelect.selectOption(refKey);
                expect((await overrideSaved).status()).toBe(200);
                await expect(modelSelect).toBeEnabled();
                const inheritanceSaved = page.waitForResponse(
                    (r) =>
                        r.url().includes("/config/user/api-request-templates") &&
                        r.request().method() === "PUT",
                );
                await modelSelect.selectOption("");
                expect((await inheritanceSaved).status()).toBe(200);
                await page.reload();
                await hub.getByTestId(`provider-connection-${wire.providerId}`).click();
                await expect(defaultSelect).toHaveValue(refKey);
                await expect(modelSelect).toHaveValue("");
                await hub.screenshot({
                    path: test.info().outputPath("template-bindings-persisted.png"),
                    animations: "disabled",
                });
                const sessionResponse = await request.post(`${CP_URL}/api/v1/sessions`, {
                    headers,
                    data: {
                        title: "Template Wire",
                        agentPrincipalId: principalId,
                        modelProvider: wire.providerId,
                        modelName: "wire-model",
                        providerConnectionId: connection.id,
                    },
                });
                expect(sessionResponse.status(), await sessionResponse.text()).toBe(201);
                const session = await sessionResponse.json();
                expect(session.contextTemplateId).toBe(template.id);
                expect(session.contextTemplateVersion).toBe(template.version);
                await page.goto(`/workspace/${auth.workspaceId}/chat/${session.id}`);
                await expect(page.getByTestId("session-context-template-current")).toContainText(
                    templateName,
                );
                const input = page.getByTestId("chat-input");
                await input.fill('quote" newline\nmarker');
                await input.press("Enter");
                await expect(
                    page.getByText("template-wire-confirmed", { exact: true }),
                ).toBeVisible({
                    timeout: 30000,
                });
                expect(observed).toHaveLength(1);
                expect(paths).toEqual([wire.path]);
                expect(observed[0]).toEqual({
                    model: "wire-model",
                    [wire.apiTypeId === "mimo-responses" ? "input" : "messages"]: [
                        { role: "user", content: 'prefix:quote" newline\nmarker' },
                    ],
                    ...(wire.apiTypeId === "anthropic-messages" ? { max_tokens: 256 } : {}),
                    stream: true,
                    temperature: 0.17,
                });
                await page.reload();
                await expect(
                    page.getByText("template-wire-confirmed", { exact: true }),
                ).toBeVisible();
                await page.screenshot({
                    path: test.info().outputPath("template-wire-desktop.png"),
                    fullPage: true,
                    animations: "disabled",
                });
                await page.setViewportSize({ width: 390, height: 844 });
                const openChat = page.getByRole("button", { name: "Open chat" });
                if (await openChat.isVisible()) await openChat.click();
                await expect(
                    page.getByText("template-wire-confirmed", { exact: true }),
                ).toBeVisible();
                await page.screenshot({
                    path: test.info().outputPath("template-wire-mobile.png"),
                    fullPage: true,
                    animations: "disabled",
                });
            } finally {
                provider.closeAllConnections();
                await new Promise<void>((resolve, reject) =>
                    provider.close((error) => (error ? reject(error) : resolve())),
                );
            }
        });
    });
}
