import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { provisionWorkspaceAgentPrincipal } from "./helpers/agent-principal";
import { ensureAgentWorkspaceBinding } from "./helpers/journey";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

function fakeChatProvider(marker: string, observed: Record<string, unknown>[]) {
    return createServer(async (incoming, response) => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            observed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.write(
                `data: ${JSON.stringify({ choices: [{ delta: { content: marker } }] })}\n\n`,
            );
            response.end("data: [DONE]\n\n");
        } catch {
            response.writeHead(400);
            response.end();
        }
    });
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("provider address missing");
    return address.port;
}

test.describe("@host PLAN-0439 owner-scope connection resolver matrix", () => {
    test("overlay, fallback, union, explicit selection and non-chat filtering hold in the browser", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `resolver-${randomUUID()}@test.local`,
                password: generateE2EPassword(),
                name: "Resolver Matrix",
            },
        });
        expect(registration.status()).toBe(201);
        const auth: { accessToken: string; workspaceId: string } = await registration.json();
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: "Resolver Matrix",
        });
        const headers = {
            Authorization: `Bearer ${auth.accessToken}`,
            "X-Workspace-Id": auth.workspaceId,
        };

        const userObserved: Record<string, unknown>[] = [];
        const wsObserved: Record<string, unknown>[] = [];
        const userServer = fakeChatProvider("user-conn-served", userObserved);
        const wsServer = fakeChatProvider("workspace-conn-served", wsObserved);
        const userPort = await listen(userServer);
        const wsPort = await listen(wsServer);
        try {
            const create = async (data: Record<string, unknown>) => {
                const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
                    headers,
                    data,
                });
                expect(created.status(), await created.text()).toBe(201);
                const connection = await created.json();
                const verified = await request.post(
                    `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
                    { headers },
                );
                expect(verified.ok(), await verified.text()).toBe(true);
                return (await verified.json()).connection;
            };
            const userShared = await create({
                providerId: "custom-openai-compatible",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: "fake-resolver-credential",
                connectionKey: "shared",
                label: "Shared User",
                scope: "USER",
                baseUrl: `http://127.0.0.1:${userPort}/v1`,
                modelDiscovery: "manual",
                manualModels: ["shared-model"],
            });
            const wsShared = await create({
                providerId: "custom-openai-compatible",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: "fake-resolver-credential",
                connectionKey: "shared",
                label: "Shared Workspace",
                scope: "WORKSPACE",
                baseUrl: `http://127.0.0.1:${wsPort}/v1`,
                modelDiscovery: "manual",
                manualModels: ["shared-model"],
            });
            const solo = await create({
                providerId: "custom-openai-compatible",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: "fake-resolver-credential",
                connectionKey: "solo",
                label: "Solo User",
                scope: "USER",
                baseUrl: `http://127.0.0.1:${userPort}/v1`,
                modelDiscovery: "manual",
                manualModels: ["shared-model"],
            });
            const embedding = await create({
                providerId: "dashscope-qwen",
                apiTypeId: "dashscope-multimodal-embedding",
                apiTypeVersion: 1,
                apiKey: "fake-resolver-credential",
                connectionKey: "emb",
                label: "Embedding",
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: ["tongyi-embedding-vision-flash-2026-03-06"],
            });

            const patch = (id: string, data: Record<string, unknown>) =>
                request.patch(`${CP_URL}/api/v1/provider-connections/${id}`, { headers, data });
            const createSession = (data: Record<string, unknown>) =>
                request.post(`${CP_URL}/api/v1/sessions`, {
                    headers,
                    data: { title: "Resolver Matrix", agentPrincipalId: principalId, ...data },
                });

            // (1) union: two distinct keys both occupy custom-openai-compatible slots,
            // so an unqualified selection is ambiguous and must be rejected.
            const ambiguous = await createSession({
                modelProvider: "custom-openai-compatible",
                modelName: "shared-model",
            });
            expect(ambiguous.status()).toBe(400);

            // (2) overlay: the workspace connection wins the shared key slot.
            expect(
                (
                    await patch(solo.id, { enabled: false, expectedRevision: solo.revision })
                ).status(),
            ).toBe(200);
            const overlaySession = await createSession({
                modelProvider: "custom-openai-compatible",
                modelName: "shared-model",
            });
            expect(overlaySession.status(), await overlaySession.text()).toBe(201);
            const overlayBody = await overlaySession.json();
            expect(overlayBody.providerConnectionId).toBe(wsShared.id);

            // (3) browser: the pinned workspace connection serves the wire.
            await ensureAgentWorkspaceBinding(auth.workspaceId);
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
            await page.goto(`/workspace/${auth.workspaceId}/chat/${overlayBody.id}`);
            const input = page.getByTestId("chat-input");
            await expect(input).toBeVisible();
            await input.fill("resolver matrix ping");
            await input.press("Enter");
            await expect(page.getByText("workspace-conn-served", { exact: true })).toBeVisible({
                timeout: 30000,
            });
            expect(wsObserved).toHaveLength(1);
            expect(userObserved).toHaveLength(0);

            // (4) browser: the model picker mirrors the overlay and hides non-chat slots.
            await page.getByTestId("model-popover-trigger").click();
            const chatGroup = page.locator('[data-testid="model-group-custom-openai-compatible"]');
            await expect(chatGroup).toHaveCount(1);
            await expect(chatGroup).toHaveAttribute("data-connection-id", wsShared.id);
            await expect(chatGroup).toContainText("shared");
            await expect(
                page.getByTestId("model-item-custom-openai-compatible/shared-model"),
            ).toBeVisible();
            await expect(page.locator('[data-testid="model-group-dashscope-qwen"]')).toHaveCount(0);
            await page.screenshot({
                path: test.info().outputPath("resolver-model-popover.png"),
                animations: "disabled",
            });
            await page.keyboard.press("Escape");

            // (5) fallback: disabling the workspace connection falls back to the user one.
            expect(
                (
                    await patch(wsShared.id, {
                        enabled: false,
                        expectedRevision: wsShared.revision,
                    })
                ).status(),
            ).toBe(200);
            const fallbackSession = await createSession({
                modelProvider: "custom-openai-compatible",
                modelName: "shared-model",
            });
            expect(fallbackSession.status(), await fallbackSession.text()).toBe(201);
            expect((await fallbackSession.json()).providerConnectionId).toBe(userShared.id);

            // (6) explicit selection wins while both slots are usable again.
            expect(
                (
                    await patch(wsShared.id, {
                        enabled: true,
                        expectedRevision: wsShared.revision + 1,
                    })
                ).status(),
            ).toBe(200);
            const reverified = await request.post(
                `${CP_URL}/api/v1/provider-connections/${wsShared.id}/verify`,
                { headers },
            );
            expect(reverified.ok(), await reverified.text()).toBe(true);
            const explicitSession = await createSession({
                modelProvider: "custom-openai-compatible",
                modelName: "shared-model",
                providerConnectionId: userShared.id,
            });
            expect(explicitSession.status(), await explicitSession.text()).toBe(201);
            expect((await explicitSession.json()).providerConnectionId).toBe(userShared.id);

            // (7) non-chat filtering: embedding connections are never chat candidates.
            const noCandidate = await createSession({
                modelProvider: "dashscope-qwen",
                modelName: "tongyi-embedding-vision-flash-2026-03-06",
            });
            expect(noCandidate.status()).toBe(400);
            const forged = await createSession({
                modelProvider: "dashscope-qwen",
                modelName: "tongyi-embedding-vision-flash-2026-03-06",
                providerConnectionId: embedding.id,
            });
            expect(forged.status()).toBe(400);
            expect((await forged.json()).code).toBe("API_TYPE_OPERATION_MISMATCH");
        } finally {
            for (const server of [userServer, wsServer]) {
                server.closeAllConnections();
                await new Promise<void>((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve())),
                );
            }
        }
    });
});
