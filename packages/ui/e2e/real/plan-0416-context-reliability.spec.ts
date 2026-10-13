import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import {
    test,
    expect as playwrightExpect,
    type APIRequestContext,
    type Page,
} from "@playwright/test";
import { provisionWorkspaceAgentPrincipal } from "./helpers/agent-principal";
import { generateE2EPassword } from "./helpers/password";
import {
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";

// Chat is an explicitly deterministic wire fixture; embedding uses the actual
// DashScope service and PostgreSQL. Neither is advertised as a real chat model.
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const MODEL = "tongyi-embedding-vision-flash-2026-03-06";
const WIRE_CREDENTIAL = "fake-context-wire-credential";
const BASELINE_TEXT = "Use only the Workspace tools provided by CP.";
const expect = playwrightExpect.configure({ timeout: 30000 });
type Auth = { accessToken: string; workspaceId: string };
type Fixture = {
    auth: Auth;
    principalId: string;
    connectionId: string;
    observed: Record<string, unknown>[];
    provider: Server;
    headers: Record<string, string>;
};

async function setup(request: APIRequestContext): Promise<Fixture> {
    const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `context-${randomUUID()}@test.local`,
            password: generateE2EPassword(),
            name: "Context Reliability",
        },
    });
    expect(registered.status()).toBe(201);
    const auth: Auth = await registered.json();
    const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
        name: "Context Reliability",
    });
    const observed: Record<string, unknown>[] = [];
    const provider = createServer(async (incoming, response) => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            observed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.write(
                `data: ${JSON.stringify({ choices: [{ delta: { content: "context-wire-confirmed" } }] })}\n\n`,
            );
            response.end("data: [DONE]\n\n");
        } catch (cause) {
            response.writeHead(400);
            response.end(cause instanceof SyntaxError ? "invalid JSON" : "fixture read failed");
        }
    });
    await new Promise<void>((resolve, reject) => {
        provider.once("error", reject);
        provider.listen(0, "127.0.0.1", resolve);
    });
    try {
        const address = provider.address();
        if (!address || typeof address === "string") throw new Error("provider address missing");
        const headers = {
            Authorization: `Bearer ${auth.accessToken}`,
            "X-Workspace-Id": auth.workspaceId,
        };
        const connection = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers,
            data: {
                providerId: "custom-openai-compatible",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: WIRE_CREDENTIAL,
                connectionKey: `context-${randomUUID()}`,
                label: "Context Wire",
                scope: "USER",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                modelDiscovery: "manual",
                manualModels: ["context-wire-model"],
            },
        });
        expect(connection.status()).toBe(201);
        const { id: connectionId } = await connection.json();
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connectionId}/verify`,
            { headers },
        );
        expect(verified.ok()).toBe(true);
        observed.length = 0;
        // WorkspaceView explicitly enables workspace tools; Session creation has
        // no toolMode field. Rebind only the runner-owned isolated Agent before
        // each fixture's first send, using the existing host lifecycle helper.
        if (!process.env.XIHE_E2E_AGENT_RESTART_ENV) {
            throw new Error("isolated Agent restart contract missing; use e2e-host");
        }
        await ensureAgentWorkspaceBinding(auth.workspaceId);
        await waitForControlPlaneAgentReady(request, headers);
        return { auth, principalId, connectionId, observed, provider, headers };
    } catch (cause) {
        await closeProvider(provider);
        throw cause;
    }
}

async function closeProvider(provider: Server): Promise<void> {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
        provider.close((cause) => (cause ? reject(cause) : resolve())),
    );
}

async function publishAndOpen(
    page: Page,
    request: APIRequestContext,
    fixture: Fixture,
    dataSlot: string,
    principalId: string = fixture.principalId,
): Promise<string> {
    await page.addInitScript(({ accessToken, workspaceId }) => {
        localStorage.setItem("xihe-token", accessToken);
        localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
        localStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: workspaceId, name: "Context Reliability" }),
        );
    }, fixture.auth);
    await page.goto("/settings/config");
    await page.getByTestId("config-tab-user").click();
    const panel = page.getByTestId("api-request-templates-panel");
    await panel.getByTestId("api-request-type").selectOption("openai-chat-completions@1");
    await panel.getByTestId("api-request-new").click();
    const name = `Context ${randomUUID()}`;
    await panel.getByTestId("api-request-name").fill(name);
    const bodySource = JSON.stringify({
        model: "${xh.model}",
        messages: [
            { role: "system", content: "${xh.agent_instructions}" },
            { role: "user", content: dataSlot },
            { role: "user", content: "${xh.user_input}" },
        ],
        stream: true,
    });
    await panel.getByTestId("api-request-body-source").fill(bodySource);
    const saved = page.waitForResponse(
        (response) =>
            response.url().includes("/config/user/api-request-templates") &&
            response.request().method() === "PUT",
    );
    await panel.getByTestId("api-request-publish").click();
    expect((await saved).status()).toBe(200);
    const config = await request.get(`${CP_URL}/api/v1/config/api-request-templates?layer=user`, {
        headers: fixture.headers,
    });
    expect(config.status()).toBe(200);
    const template = JSON.parse((await config.json()).templates).find(
        (item: { name: string }) => item.name === name,
    );
    expect(template.bodySource).toBe(bodySource);
    const session = await request.post(`${CP_URL}/api/v1/sessions`, {
        headers: fixture.headers,
        data: {
            title: name,
            agentPrincipalId: principalId,
            modelProvider: "custom-openai-compatible",
            modelName: "context-wire-model",
            providerConnectionId: fixture.connectionId,
            contextTemplateLayer: "user",
            contextTemplateId: template.id,
            contextTemplateVersion: template.version,
        },
    });
    expect(session.status()).toBe(201);
    const { id } = await session.json();
    await page.goto(`/workspace/${fixture.auth.workspaceId}/chat/${id}`);
    await expect(page.getByTestId("chat-input")).toBeVisible();
    return id;
}

async function send(page: Page, text: string): Promise<void> {
    const outgoing = page.waitForRequest(
        (request) => request.url().endsWith("/api/v1/chat") && request.method() === "POST",
    );
    await page.getByTestId("chat-input").fill(text);
    await page.getByTestId("chat-input").press("Enter");
    expect((await outgoing).postDataJSON().content).toBe(text);
}

async function expectPersistedRun(
    request: APIRequestContext,
    fixture: Fixture,
    sessionId: string,
    status: string,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const response = await request.get(
                    `${CP_URL}/api/v1/chat/sessions/${sessionId}/runs?page=0&size=200`,
                    { headers: fixture.headers },
                );
                expect(response.status()).toBe(200);
                const body = await response.json();
                return body.runs?.[0]?.status;
            },
            { timeout: 15000 },
        )
        .toBe(status);
}

async function configureRealEmbedding(
    request: APIRequestContext,
    fixture: Fixture,
    apiKey = process.env.XIHE_E2E_REAL_DASHSCOPE_KEY,
): Promise<void> {
    const connectionKey = `embedding-${randomUUID()}`;
    const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
        headers: fixture.headers,
        data: {
            providerId: "dashscope-qwen",
            apiTypeId: "dashscope-multimodal-embedding",
            apiTypeVersion: 1,
            label: "Context real embedding",
            scope: "USER",
            connectionKey,
            modelDiscovery: "manual",
            manualModels: [MODEL],
            apiKey,
        },
    });
    // Do not dump request/response bodies: the setup request contains a secret.
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    const verified = await request.post(`${CP_URL}/api/v1/provider-connections/${id}/verify`, {
        headers: fixture.headers,
    });
    expect(verified.status()).toBe(200);
    const saved = await request.put(`${CP_URL}/api/v1/config/user/embedding`, {
        headers: fixture.headers,
        data: {
            profile: JSON.stringify({ providerId: "dashscope-qwen", connectionKey, model: MODEL }),
        },
    });
    expect(saved.status()).toBe(200);
}

function psqlScalar(sql: string): number {
    const container = process.env.XIHE_E2E_PG_CONTAINER;
    const database = process.env.XIHE_E2E_PG_DATABASE;
    const user = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !user)
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through e2e-host",
        );
    const output = execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        [
            "exec",
            "-i",
            container,
            "psql",
            "-X",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            user,
            "-d",
            database,
        ],
        { input: sql, encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    const value = Number(output.trim());
    if (!Number.isFinite(value)) throw new Error(`unexpected psql scalar output: ${output.trim()}`);
    return value;
}

function runLogsDir(): string {
    const runId = process.env.XIHE_E2E_RUN_ID;
    if (!runId) throw new Error("XIHE_E2E_RUN_ID is required; run through e2e-host");
    return path.resolve(process.cwd(), "../../.tmp/e2e-host", runId, "logs");
}

function readRunLog(name: string): string {
    try {
        return readFileSync(path.join(runLogsDir(), name), "utf8");
    } catch (error) {
        throw new Error(
            `cannot read ${name} from the isolated run logs: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

// API tracing can retain credential-bearing setup requests.
// Keep screenshots and classified failures without those request bodies.
test.use({ trace: "off" });

test.beforeEach(async ({ page }) => {
    const diagnostics = { pageErrors: 0, consoleErrors: 0, requestFailures: [] as string[] };
    page.on("pageerror", () => diagnostics.pageErrors++);
    page.on("console", (message) => {
        if (message.type() === "error") diagnostics.consoleErrors++;
    });
    page.on("requestfailed", (request) => {
        // Preserve route metadata only, never headers, bodies or query tokens.
        diagnostics.requestFailures.push(new URL(request.url()).pathname);
    });
    await test.info().attach("browser-diagnostics-policy", {
        body: JSON.stringify({
            viewport: page.viewportSize(),
            capture: "counts and route paths only",
        }),
        contentType: "application/json",
    });
    // The reference remains mutable until afterEach writes the final counts.
    browserDiagnostics.set(page, diagnostics);
});

const browserDiagnostics = new WeakMap<
    Page,
    { pageErrors: number; consoleErrors: number; requestFailures: string[] }
>();

test.afterEach(async ({ page }) => {
    await test.info().attach("browser-diagnostics", {
        body: JSON.stringify({ url: page.url(), ...browserDiagnostics.get(page) }),
        contentType: "application/json",
    });
});

test.describe.serial("@host PLAN-0416 context reliability", () => {
    test.skip(
        process.env.XIHE_E2E_LLM_MODE !== "success",
        "requires the isolated e2e-host success profile",
    );
    test.setTimeout(180000);

    for (const slot of ["retrieval disabled", "$${xh.rag_context}"]) {
        test(`disabled retrieval preserves literal data: ${slot}`, async ({ page, request }) => {
            const fixture = await setup(request);
            try {
                const sessionId = await publishAndOpen(page, request, fixture, slot);
                await send(page, "disabled query");
                await expect(
                    page.getByText("context-wire-confirmed", { exact: true }),
                ).toBeVisible();
                expect(fixture.observed).toHaveLength(1);
                expect(fixture.observed[0].messages).toEqual([
                    { role: "system", content: "Use only the Workspace tools provided by CP." },
                    { role: "user", content: slot.replace("$${", "${") },
                    { role: "user", content: "disabled query" },
                ]);
                await expectPersistedRun(request, fixture, sessionId, "succeeded");
                await page.reload();
                await expect(
                    page.getByText("context-wire-confirmed", { exact: true }),
                ).toBeVisible();
                await page.screenshot({ path: test.info().outputPath("disabled-persisted.png") });
            } finally {
                await closeProvider(fixture.provider);
            }
        });
    }

    test("missing profile fails visibly before any chat provider dispatch", async ({
        page,
        request,
    }) => {
        const fixture = await setup(request);
        try {
            const sessionId = await publishAndOpen(page, request, fixture, "${xh.rag_context}");
            await send(page, "unavailable query");
            await expect(page.getByText(/RAG_PROFILE_UNAVAILABLE/).first()).toBeVisible();
            await expectPersistedRun(request, fixture, sessionId, "failed");
            expect(fixture.observed).toHaveLength(0);
            await page.screenshot({ path: test.info().outputPath("rag-unavailable.png") });
        } finally {
            await closeProvider(fixture.provider);
        }
    });

    test("embedding provider rejection fails visibly before any chat provider dispatch", async ({
        page,
        request,
    }) => {
        const fixture = await setup(request);
        try {
            await configureRealEmbedding(request, fixture, "deliberately-invalid-e2e-key");
            const sessionId = await publishAndOpen(page, request, fixture, "${xh.rag_context}");
            await send(page, "provider rejection query");
            await expect(page.getByText(/RAG_QUERY_FAILED/).first()).toBeVisible({
                timeout: 45000,
            });
            await expectPersistedRun(request, fixture, sessionId, "failed");
            expect(fixture.observed).toHaveLength(0);
            await page.screenshot({ path: test.info().outputPath("rag-query-failed.png") });
        } finally {
            await closeProvider(fixture.provider);
        }
    });

    test("missing authorized baseline fails visibly before any chat provider dispatch", async ({
        page,
        request,
    }) => {
        const fixture = await setup(request);
        try {
            const sessionId = await publishAndOpen(page, request, fixture, "disabled");
            const container = process.env.XIHE_E2E_PG_CONTAINER;
            const database = process.env.XIHE_E2E_PG_DATABASE;
            const user = process.env.XIHE_E2E_PG_USER;
            if (!container || !database || !user)
                throw new Error("isolated PostgreSQL metadata missing");
            if (!/^[a-f0-9-]{36}$/i.test(fixture.principalId))
                throw new Error("invalid fixture principal UUID");
            execFileSync(
                process.platform === "win32" ? "docker.exe" : "docker",
                [
                    "exec",
                    container,
                    "psql",
                    "-X",
                    "-A",
                    "-t",
                    "-U",
                    user,
                    "-d",
                    database,
                    "-c",
                    `UPDATE agent_principals SET template_snapshot = template_snapshot - 'systemPrompt' WHERE id = '${fixture.principalId}'::uuid`,
                ],
                { timeout: 15000, windowsHide: true, stdio: "pipe" },
            );
            await send(page, "unauthorized baseline query");
            await expect(page.getByText(/BASELINE_UNAUTHORIZED/).first()).toBeVisible();
            await expectPersistedRun(request, fixture, sessionId, "failed");
            expect(fixture.observed).toHaveLength(0);
            await page.screenshot({ path: test.info().outputPath("baseline-unauthorized.png") });
        } finally {
            await closeProvider(fixture.provider);
        }
    });

    test("principal/session resolution and sensitive boundaries stay isolated across principals and workspaces", async ({
        page,
        request,
    }) => {
        const fixture = await setup(request);
        try {
            const firstSession = await publishAndOpen(page, request, fixture, "security-first");
            await send(page, "first principal query");
            await expect(page.getByText("context-wire-confirmed", { exact: true })).toBeVisible();
            await expectPersistedRun(request, fixture, firstSession, "succeeded");
            expect(fixture.observed).toHaveLength(1);
            const firstWireBody = JSON.stringify(fixture.observed[0]);
            expect(firstWireBody).toContain(BASELINE_TEXT);

            // A second principal in the same Workspace carries its own frozen
            // baseline snapshot; each Session must resolve only its principal.
            const secondBaseline = `Second principal baseline ${randomUUID()}`;
            const secondPrincipalId = await provisionWorkspaceAgentPrincipal(
                request,
                fixture.auth,
                {
                    name: "Context Reliability Second",
                    systemPrompt: secondBaseline,
                },
            );

            // A different principalId on an existing Session is rejected before
            // any provider dispatch (the Session's principal is authoritative).
            const rootBranchId = await getRootBranchId(request, firstSession, fixture.headers);
            let mismatchStatus = 0;
            let mismatchCode = "";
            for (let attempt = 0; attempt < 10; attempt += 1) {
                const probe = await request.post(`${CP_URL}/api/v1/chat`, {
                    headers: fixture.headers,
                    data: {
                        sessionId: firstSession,
                        branchId: rootBranchId,
                        content: "mismatched principal probe",
                        agentPrincipalId: secondPrincipalId,
                    },
                });
                mismatchStatus = probe.status();
                mismatchCode = ((await probe.json()) as { code?: string }).code ?? "";
                if (mismatchCode !== "CHAT_IN_PROGRESS") break;
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            expect(mismatchStatus).toBe(409);
            expect(mismatchCode).toBe("SESSION_PRINCIPAL_MISMATCH");
            expect(fixture.observed).toHaveLength(1);

            // The second principal's Session resolves its own baseline only.
            fixture.observed.length = 0;
            const secondSession = await publishAndOpen(
                page,
                request,
                fixture,
                "security-second",
                secondPrincipalId,
            );
            await send(page, "second principal query");
            await expect(page.getByText("context-wire-confirmed", { exact: true })).toBeVisible();
            await expectPersistedRun(request, fixture, secondSession, "succeeded");
            expect(fixture.observed).toHaveLength(1);
            const secondWireBody = JSON.stringify(fixture.observed[0]);
            expect(secondWireBody).toContain(secondBaseline);
            await page.screenshot({
                path: test.info().outputPath("security-second-principal.png"),
            });

            // No cross-principal bleed and no credential material in the
            // provider-visible prompts. Boolean checks keep secrets out of
            // assertion failure messages.
            expect(firstWireBody.includes(secondBaseline)).toBe(false);
            expect(secondWireBody.includes(BASELINE_TEXT)).toBe(false);
            expect(firstWireBody.includes(WIRE_CREDENTIAL)).toBe(false);
            expect(secondWireBody.includes(WIRE_CREDENTIAL)).toBe(false);
            const injectedEmbeddingKey = process.env.XIHE_E2E_REAL_DASHSCOPE_KEY;
            if (injectedEmbeddingKey) {
                expect(firstWireBody.includes(injectedEmbeddingKey)).toBe(false);
                expect(secondWireBody.includes(injectedEmbeddingKey)).toBe(false);
            }

            // Cross-workspace access to the Session is denied without dispatch.
            const otherRegistered = await request.post(`${CP_URL}/api/v1/auth/register`, {
                data: {
                    email: `context-foreign-${randomUUID()}@test.local`,
                    password: generateE2EPassword(),
                    name: "Context Foreign",
                },
            });
            expect(otherRegistered.status()).toBe(201);
            const otherAuth = (await otherRegistered.json()) as Auth;
            const otherHeaders = {
                Authorization: `Bearer ${otherAuth.accessToken}`,
                "X-Workspace-Id": otherAuth.workspaceId,
            };
            const foreignRead = await request.get(`${CP_URL}/api/v1/sessions/${firstSession}`, {
                headers: otherHeaders,
            });
            expect(foreignRead.status()).toBe(404);
            expect(((await foreignRead.json()) as { code?: string }).code).toBe(
                "SESSION_NOT_FOUND",
            );
            const foreignChat = await request.post(`${CP_URL}/api/v1/chat`, {
                headers: otherHeaders,
                data: { sessionId: firstSession, branchId: rootBranchId, content: "foreign probe" },
            });
            expect([404, 409]).toContain(foreignChat.status());
            expect(["SESSION_NOT_FOUND", "SSE_SUBSCRIPTION_REQUIRED"]).toContain(
                ((await foreignChat.json()) as { code?: string }).code,
            );
            const foreignSession = await request.post(`${CP_URL}/api/v1/sessions`, {
                headers: otherHeaders,
                data: { title: "Foreign principal probe", agentPrincipalId: secondPrincipalId },
            });
            expect(foreignSession.status()).toBe(403);
            expect(((await foreignSession.json()) as { code?: string }).code).toBe("FORBIDDEN");
            expect(fixture.observed).toHaveLength(1);

            // Durable payload boundary: the credential never enters durable
            // context payloads, while the fixture Sessions do own durable events.
            expect(
                psqlScalar(
                    `SELECT count(*) FROM context_events WHERE payload::text LIKE '%${WIRE_CREDENTIAL}%'`,
                ),
            ).toBe(0);
            expect(
                psqlScalar(
                    `SELECT count(*) FROM messages WHERE content LIKE '%${WIRE_CREDENTIAL}%'`,
                ),
            ).toBe(0);
            expect(
                psqlScalar(
                    `SELECT count(*) FROM context_events WHERE session_id = '${firstSession}'`,
                ),
            ).toBeGreaterThan(0);
            expect(
                psqlScalar(
                    `SELECT count(*) FROM context_events WHERE session_id = '${secondSession}'`,
                ),
            ).toBeGreaterThan(0);

            // Log boundary: the fixed fake credential is absent while the audit
            // trail and correlated requestIds are retained.
            const cpLog = readRunLog("cp.log");
            const agentLog = readRunLog("agent.log");
            const auditLog = readRunLog("audit.log");
            expect(cpLog.includes(WIRE_CREDENTIAL)).toBe(false);
            expect(agentLog.includes(WIRE_CREDENTIAL)).toBe(false);
            expect(auditLog.includes(WIRE_CREDENTIAL)).toBe(false);
            if (injectedEmbeddingKey) {
                expect(cpLog.includes(injectedEmbeddingKey)).toBe(false);
                expect(agentLog.includes(injectedEmbeddingKey)).toBe(false);
                expect(auditLog.includes(injectedEmbeddingKey)).toBe(false);
            }
            expect(auditLog).toContain(fixture.principalId);
            expect(auditLog).toContain('"requestId"');
            expect(cpLog).toContain(`sessionId=${firstSession}`);
            const scanner = execFileSync(
                process.execPath,
                [path.resolve(process.cwd(), "../../scripts/scan-log-secrets.mjs"), runLogsDir()],
                { encoding: "utf8", timeout: 30000, windowsHide: true },
            );
            expect(scanner).toContain("clean");
        } finally {
            await closeProvider(fixture.provider);
        }
    });

    test("real embedding: empty, ingestion, dynamic injection and connection partition isolation", async ({
        page,
        request,
    }) => {
        test.skip(
            !process.env.XIHE_E2E_REAL_DASHSCOPE_KEY,
            "requires an operator-provided real DashScope key",
        );
        const fixture = await setup(request);
        try {
            await configureRealEmbedding(request, fixture);
            const emptySession = await publishAndOpen(
                page,
                request,
                fixture,
                "rag:${xh.rag_context}",
            );
            await send(page, "empty partition query");
            await expect(page.getByText("context-wire-confirmed", { exact: true })).toBeVisible();
            expect(fixture.observed[0].messages).toContainEqual({ role: "user", content: "rag:" });
            await expectPersistedRun(request, fixture, emptySession, "succeeded");
            await page.screenshot({ path: test.info().outputPath("rag-empty.png") });

            const marker = `context-retrieval-${randomUUID()}`;
            const ingest = await request.post(`${CP_URL}/api/v1/rag/ingest`, {
                headers: fixture.headers,
                multipart: {
                    file: {
                        name: "context.txt",
                        mimeType: "text/plain",
                        buffer: Buffer.from(marker),
                    },
                    chunkSize: "400",
                    chunkOverlap: "40",
                },
            });
            expect(ingest.status()).toBe(200);
            expect((await ingest.json()).chunks).toBeGreaterThan(0);
            const stats = await request.get(`${CP_URL}/api/v1/rag/stats`, {
                headers: fixture.headers,
            });
            expect(stats.status()).toBe(200);
            expect((await stats.json()).totalDocuments).toBe(1);
            const search = await request.post(`${CP_URL}/api/v1/rag/search`, {
                headers: fixture.headers,
                data: { query: marker, topK: 3, minScore: 0.0 },
            });
            expect(search.status()).toBe(200);
            expect(JSON.stringify((await search.json()).results)).toContain(marker);

            fixture.observed.length = 0;
            const populatedSession = await publishAndOpen(
                page,
                request,
                fixture,
                "rag:${xh.rag_context}",
            );
            await send(page, marker);
            await expect(page.getByText("context-wire-confirmed", { exact: true })).toBeVisible();
            const messages = fixture.observed[0].messages as { role: string; content: string }[];
            expect(messages[0]).toEqual({
                role: "system",
                content: "Use only the Workspace tools provided by CP.",
            });
            expect(messages[1].role).toBe("user");
            expect(messages[1].content).toContain(marker);
            await expectPersistedRun(request, fixture, populatedSession, "succeeded");
            await page.screenshot({ path: test.info().outputPath("rag-injected.png") });

            // Same Workspace/owner/model/dimension, different connection: no adoption.
            await configureRealEmbedding(request, fixture);
            const isolatedStats = await request.get(`${CP_URL}/api/v1/rag/stats`, {
                headers: fixture.headers,
            });
            expect(isolatedStats.status()).toBe(200);
            expect((await isolatedStats.json()).totalDocuments).toBe(0);
            fixture.observed.length = 0;
            const isolatedSession = await publishAndOpen(
                page,
                request,
                fixture,
                "rag:${xh.rag_context}",
            );
            await send(page, marker);
            await expect(page.getByText("context-wire-confirmed", { exact: true })).toBeVisible();
            expect(fixture.observed[0].messages).toContainEqual({ role: "user", content: "rag:" });
            await expectPersistedRun(request, fixture, isolatedSession, "succeeded");
            await page.screenshot({ path: test.info().outputPath("rag-isolated-connection.png") });
        } finally {
            await closeProvider(fixture.provider);
        }
    });
});
