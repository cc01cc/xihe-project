// Shared helpers for journey-* Host specs (PLAN-294 ②3 extraction).
// The journey specs previously duplicated registration, page seeding, chat
// send, and terminal-state polling; this module is their single source.
import { execSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateE2EPassword } from "./password";
import { expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

export const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

export function evidenceDir(name: string): string {
    return path.resolve(process.cwd(), "../../.local/evidence", name);
}

export interface JourneyContext {
    authToken: string;
    workspaceId: string;
    headers: Record<string, string>;
}

/** Wait for CP's cached Agent health, which gates chat admission, after an Agent rebind. */
export async function waitForControlPlaneAgentReady(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<void> {
    let lastObserved = "unobserved";
    await expect
        .poll(
            async () => {
                try {
                    const response = await request.get(`${CP_URL}/api/v1/status`, { headers });
                    if (!response.ok()) {
                        lastObserved = `HTTP ${response.status()}`;
                        return "unavailable";
                    }
                    const body = (await response.json()) as {
                        services?: Array<{
                            key: string;
                            status?: string;
                            liveness?: string;
                            llmReady?: string;
                        }>;
                    };
                    const agent = body.services?.find((service) => service.key === "agent");
                    lastObserved = agent
                        ? `${agent.status}/${agent.liveness}/${agent.llmReady}`
                        : "Agent entry missing";
                    return lastObserved;
                } catch (cause) {
                    lastObserved = cause instanceof Error ? cause.message : String(cause);
                    return "unavailable";
                }
            },
            {
                timeout: 45_000,
                intervals: [250, 500, 1000, 2000],
                message: `CP Agent readiness did not reach up/up/ready; last observation: ${lastObserved}`,
            },
        )
        .toBe("up/up/ready");
}

/** Register a fresh user (one per spec — the Agent binds one workspace per process). */
export async function registerJourneyUser(
    request: APIRequestContext,
    name: string,
): Promise<JourneyContext> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email: `${name}-${Date.now()}@test.com`, password, name },
    });
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(
        reg.status(),
    );
    const auth = (await reg.json()) as { accessToken: string; workspaceId: string };
    return {
        authToken: auth.accessToken,
        workspaceId: auth.workspaceId,
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
        },
    };
}

/** Resolve the server-created root path for API assertions; tests do not synthesize branch IDs. */
export async function getRootBranchId(
    request: APIRequestContext,
    sessionId: string,
    headers: Record<string, string>,
): Promise<string> {
    const response = await request.get(
        `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/branches`,
        { headers },
    );
    expect(
        response.ok(),
        `branch list ${response.status()}: ${await response.text()}`,
    ).toBeTruthy();
    const body = (await response.json()) as {
        items?: Array<{ branchId: string; parentBranchId: string | null }>;
    };
    const root = body.items?.find((branch) => branch.parentBranchId === null);
    if (!root?.branchId) throw new Error("Server did not return a root branch");
    return root.branchId;
}

// ── PLAN-0369: Agent workspace binding ──────────────────────────────────────
// The Agent process owns exactly ONE MCP workspace context (`main.py`
// `_get_mcp_tools`: a different workspace raises "MCP workspace context cannot
// be reused across workspaces"). That is product design (LIF-2 single
// binding) — switching workspaces requires restarting the Agent process, as
// documented in A03-xihe/AGENTS.md. Specs that chat from a workspace page
// call `ensureAgentWorkspaceBinding(<their workspace>)` before the first send
// so a full @host run can move between spec-local workspaces.
const AGENT_PORT = Number(process.env.XIHE_AGENT_PORT || "12632");
const CP_PORT = Number(process.env.XIHE_CP_PORT || "12631");
const HOST_ROOT = path.resolve(
    process.cwd(),
    "../../.tmp/e2e-host",
    process.env.XIHE_E2E_RUN_ID ?? "unknown-run",
);
const AGENT_DIR = path.resolve(process.cwd(), "../agent");
const BINDING_STATE_FILE = path.join(HOST_ROOT, "agent-binding.json");
// BL-143: agent rebind readiness budget. Measured spawn -> llmReady=ready is
// ~8.7s (6.8-8.9s across 8 rebind logs, 2026-10-29) plus the 0.5s poll grain, so
// 30s keeps ~3x headroom. Terminal LLM states fail fast instead of burning the
// budget: waiting 180s for a state that will never turn ready was the single
// largest time sink of the first mock-full baseline run.
const AGENT_READY_TIMEOUT_MS = Number(process.env.XIHE_E2E_AGENT_READY_TIMEOUT_MS ?? 30000);
const AGENT_READY_POLL_INTERVAL_MS = 500;
const TERMINAL_LLM_READY_STATES = new Set([
    "missing_credentials",
    "invalid_credentials",
    "model_unavailable",
]);

function listeningPid(port: number): number | null {
    try {
        if (process.platform === "win32") {
            const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
            const line = out
                .split(/\r?\n/)
                .find((entry) => entry.includes(`:${port} `) && entry.includes("LISTENING"));
            const pid = line?.trim().split(/\s+/).pop();
            return pid ? Number(pid) : null;
        }
        const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" });
        return out.trim() ? Number(out.trim().split(/\s+/)[0]) : null;
    } catch {
        return null;
    }
}

function killPidTree(pid: number): void {
    if (process.platform === "win32") {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } else {
        process.kill(pid, "SIGTERM");
    }
}

async function agentHealthOk(): Promise<{ ok: boolean; llmReady: string }> {
    const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 2000);
    try {
        const response = await fetch(`http://127.0.0.1:${AGENT_PORT}/internal/v1/agent/health`, {
            signal: controller.signal,
        });
        if (!response.ok) return { ok: false, llmReady: "unknown" };
        const body = (await response.json()) as { llmReady?: string };
        return { ok: true, llmReady: body.llmReady ?? "unknown" };
    } catch {
        return { ok: false, llmReady: "unknown" };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * PLAN-0525: assert the isolated Agent's own health endpoint reports
 * `llmReady=ready`. Readiness is a per-layer fact: this checks the Agent
 * directly, not the CP cache and not any Provider Connection.
 */
export async function assertAgentLlmReady(): Promise<void> {
    const health = await agentHealthOk();
    expect(
        health.ok && health.llmReady === "ready",
        `agent direct health llmReady=${health.llmReady} (ok=${health.ok})`,
    ).toBe(true);
}

function readBindingWorkspace(): string | null {
    try {
        return (
            (JSON.parse(readFileSync(BINDING_STATE_FILE, "utf8")) as { workspaceId?: string })
                .workspaceId ?? null
        );
    } catch {
        return null;
    }
}

function isDatabaseConnectionEnvKey(key: string): boolean {
    const databaseSegments =
        /^(?:PG[A-Z0-9]*|POSTGRES(?:QL)?[A-Z0-9]*|DATABASE[A-Z0-9]*|DATASOURCE[A-Z0-9]*|JDBC[A-Z0-9]*|DB[A-Z0-9]*|SQLALCHEMY[A-Z0-9]*|MYSQL[A-Z0-9]*|MARIADB[A-Z0-9]*|MONGO(?:DB)?[A-Z0-9]*|REDIS[A-Z0-9]*|ORACLE[A-Z0-9]*|MSSQL[A-Z0-9]*|SQLSERVER[A-Z0-9]*)$/i;
    return key.split("_").some((segment) => databaseSegments.test(segment));
}

function isRunnerHostControlEnvKey(key: string): boolean {
    return key.startsWith("XIHE_E2E_HOST_CONTROL_");
}

/**
 * Restart the isolated Agent so its MCP context belongs to `workspaceId`.
 * No-op when the recorded binding already matches, or when the runner did not
 * inject `XIHE_E2E_AGENT_RESTART_ENV` (compose/dev stacks: one dedicated
 * workspace per process is then the caller's responsibility).
 */
export async function ensureAgentWorkspaceBinding(workspaceId: string): Promise<void> {
    if (!workspaceId) return;
    const rawContract = process.env.XIHE_E2E_AGENT_RESTART_ENV;
    if (!rawContract) {
        console.warn(
            "[journey] ensureAgentWorkspaceBinding skipped: no XIHE_E2E_AGENT_RESTART_ENV (not launched via scripts/e2e-host.mjs); the Agent must stay bound to one workspace",
        );
        return;
    }
    const contract = JSON.parse(rawContract) as Record<string, string> & { disabled?: string };
    if (contract.disabled) {
        console.warn(
            `[journey] ensureAgentWorkspaceBinding disabled (${contract.disabled}); single-workspace behavior unchanged`,
        );
        return;
    }
    if (readBindingWorkspace() === workspaceId) return;

    const previousPid = listeningPid(AGENT_PORT);
    if (previousPid !== null) {
        killPidTree(previousPid);
        await expect
            .poll(async () => (await agentHealthOk()).ok, {
                message: "Agent must stop answering before the workspace rebind restart",
                timeout: 20000,
                intervals: [500, 1000, 2000],
            })
            .toBe(false);
    }

    const restartEnv = Object.fromEntries(
        Object.entries({
            ...process.env,
            XIHE_ENV: "dev",
            XIHE_AGENT_PORT: String(AGENT_PORT),
            XIHE_CP_URL: `http://127.0.0.1:${CP_PORT}`,
            XIHE_CP_API_TOKEN: process.env.XIHE_CP_API_TOKEN ?? "",
            XIHE_AGENT_API_TOKEN: process.env.XIHE_CP_API_TOKEN ?? "",
            XIHE_E2E_RUN_ID: process.env.XIHE_E2E_RUN_ID ?? "",
            XIHE_LOG_DIR: path.join(HOST_ROOT, "logs"),
            XIHE_LOAD_DOTENV: "0",
            ...contract,
        }).filter(
            ([key, value]) =>
                value !== undefined &&
                !isDatabaseConnectionEnvKey(key) &&
                !isRunnerHostControlEnvKey(key),
        ),
    ) as Record<string, string>;
    if (Object.keys(restartEnv).some(isDatabaseConnectionEnvKey)) {
        throw new Error("Agent restart environment contains database connection configuration");
    }
    const hasRunnerHostControlEnv = Object.keys(restartEnv).some(isRunnerHostControlEnvKey);
    if (hasRunnerHostControlEnv) {
        throw new Error("Agent restart environment contains runner host-control configuration");
    }
    console.log(
        "[journey] Agent restart database connection env present=false; runner host-control env present=false",
    );

    const logFile = path.join(HOST_ROOT, "logs", `agent-rebind-${Date.now()}.log`);
    mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    try {
        const child = spawn(
            process.platform === "win32" ? "uv.exe" : "uv",
            ["run", "python", "-m", "xihe_agent.main"],
            {
                cwd: AGENT_DIR,
                detached: true,
                windowsHide: true,
                stdio: ["ignore", fd, fd],
                env: restartEnv,
            },
        );
        child.unref();
    } finally {
        closeSync(fd);
    }
    console.log(`[journey] Agent restarted for workspace ${workspaceId} (log: ${logFile})`);

    const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
    const readyStartedAt = Date.now();
    let lastState = "not ready";
    while (Date.now() < deadline) {
        const health = await agentHealthOk();
        if (health.ok && health.llmReady === "ready") {
            const waitedMs = Date.now() - readyStartedAt;
            if (waitedMs > 3000) {
                // PLAN-0586: expose the real agent-ready budget under batch load so the
                // timeout can be tuned from measurements instead of guesses.
                console.log(
                    `[journey] agent-ready waited ${waitedMs}ms (workspace ${workspaceId}, log ${logFile})`,
                );
            }
            writeFileSync(
                BINDING_STATE_FILE,
                JSON.stringify({ workspaceId, restartedAt: new Date().toISOString() }, null, 2),
            );
            return;
        }
        if (health.ok && TERMINAL_LLM_READY_STATES.has(health.llmReady)) {
            // BL-143 fail-fast: a terminal LLM readiness state never turns ready
            // by waiting. Surface the cause (provider connection / credential
            // resolution) immediately instead of burning the whole budget.
            throw new Error(
                `Agent LLM readiness is terminal after rebind: llmReady=${health.llmReady}. ` +
                    "Check the bound provider connection and credential resolution for this " +
                    "workspace before rerunning the E2E lane (BL-143 fail-fast).",
            );
        }
        lastState = health.ok ? `llmReady=${health.llmReady}` : "health unreachable";
        await new Promise((resolve) => setTimeout(resolve, AGENT_READY_POLL_INTERVAL_MS));
    }
    throw new Error(
        `Agent did not become ready within ${AGENT_READY_TIMEOUT_MS}ms ` +
            `(waited ${Date.now() - readyStartedAt}ms, last state: ${lastState}, agent log: ${logFile}); ` +
            "override with XIHE_E2E_AGENT_READY_TIMEOUT_MS for cold starts",
    );
}

/** Seed localStorage with auth/workspace so the SPA boots straight into the workspace. */
export function seedPage(page: Page, ctx: JourneyContext): void {
    page.addInitScript((t) => localStorage.setItem("xihe-token", t), ctx.authToken);
    page.addInitScript(
        (raw) => localStorage.setItem("xihe-user", raw),
        JSON.stringify({ workspaceId: ctx.workspaceId }),
    );
    page.addInitScript((ws) => localStorage.setItem("xihe-workspace", JSON.stringify(ws)), {
        id: ctx.workspaceId,
        name: "Default Workspace",
    });
}

/**
 * PLAN-0439: chat admission requires an explicit Session binding — a visible
 * READY chat connection at the pinned revision plus the template pin triple.
 * Specs written before the API-native runtime created raw Sessions, so the
 * send path binds the active session first. Idempotent: a bound session is
 * left untouched, and the fixture connection is created once per workspace.
 */
export async function ensureChatBinding(page: Page, sessionId: string): Promise<void> {
    // PLAN-0439: bound sessions dispatch through the connection, so the
    // fixture connection must point at a reachable OpenAI-compatible endpoint.
    // The host runner serves one for every mode (fake-llm fixture).
    const fakeLlmPort = process.env.XIHE_FAKE_LLM_PORT;
    const baseUrl = fakeLlmPort
        ? `http://127.0.0.1:${fakeLlmPort}/openai/v1`
        : "https://provider.invalid/v1";
    const outcome = await page.evaluate(
        async ({ sid, baseUrl: chatBaseUrl }) => {
            const token = localStorage.getItem("xihe-token") ?? "";
            const headers: Record<string, string> = {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            };
            const session = await (await fetch(`/api/v1/sessions/${sid}`, { headers })).json();
            if (session?.providerConnectionId) {
                // PLAN-0525: a bound Session is only chat-ready when the connection
                // body itself reports READY. An id, HTTP 200, or an earlier verify
                // response is not readiness evidence (CP has no GET /{id}, so the
                // status comes from the list view).
                const boundList = await (
                    await fetch("/api/v1/provider-connections", { headers })
                ).json();
                const boundConnection = (
                    (boundList?.connections ?? []) as Array<{ id: string; status?: string }>
                ).find((item) => item.id === session.providerConnectionId);
                if (!boundConnection) {
                    return `bound-connection-missing:${String(session.providerConnectionId)}`;
                }
                return boundConnection.status === "READY"
                    ? "bound"
                    : `bound-not-ready:${String(boundConnection.status)}`;
            }
            const list = await (await fetch("/api/v1/provider-connections", { headers })).json();
            type ConnectionView = {
                id: string;
                providerId: string;
                revision: number;
                enabled: boolean;
                status: string;
                operation?: string;
                manualModels?: string[];
            };
            const modelName = session?.modelName || "wire-model";
            let connection: ConnectionView | undefined = (
                (list?.connections ?? []) as ConnectionView[]
            ).find((item) => item.enabled && item.status === "READY" && item.operation === "chat");
            if (!connection) {
                const created = await fetch("/api/v1/provider-connections", {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        providerId: "custom-openai-compatible",
                        apiTypeId: "openai-chat-completions",
                        apiTypeVersion: 1,
                        // PLAN-0497 (2026-10-13): the fake LLM enforces its provider
                        // key (`sk-fake-openai-key`, same source as the Agent env);
                        // any other value makes bound dispatch fail with
                        // LLM_CREDENTIALS_INVALID before the model call.
                        apiKey: "sk-fake-openai-key",
                        connectionKey: "e2e-chat",
                        label: "E2E chat binding",
                        scope: "USER",
                        modelDiscovery: "manual",
                        manualModels: [modelName],
                        baseUrl: chatBaseUrl,
                    }),
                });
                if (!created.ok) return `create ${created.status} ${await created.text()}`;
                const createdConnection = (await created.json()) as ConnectionView;
                const verified = await fetch(
                    `/api/v1/provider-connections/${createdConnection.id}/verify`,
                    { method: "POST", headers },
                );
                if (!verified.ok) return `verify ${verified.status} ${await verified.text()}`;
                connection = ((await verified.json()) as { connection: ConnectionView }).connection;
                // PLAN-0525: verify returns HTTP 200 even for non-READY outcomes, so
                // the body status is the only trustworthy gate before dispatch.
                if (connection.status !== "READY") {
                    return `verify-not-ready:${String(connection.status)}`;
                }
            }
            // Manual discovery gates dispatch on the registered model set.
            if (!(connection.manualModels ?? []).includes(modelName)) {
                const patched = await fetch(`/api/v1/provider-connections/${connection.id}`, {
                    method: "PATCH",
                    headers,
                    body: JSON.stringify({
                        manualModels: [...(connection.manualModels ?? []), modelName],
                        expectedRevision: connection.revision,
                    }),
                });
                if (!patched.ok) return `models ${patched.status} ${await patched.text()}`;
                connection = (await patched.json()) as ConnectionView;
            }
            const bound = await fetch(`/api/v1/sessions/${sid}`, {
                method: "PATCH",
                headers,
                body: JSON.stringify({
                    providerConnectionId: connection.id,
                    modelProvider: connection.providerId,
                    modelName,
                    connectionRevision: connection.revision,
                }),
            });
            if (!bound.ok) return `bind ${bound.status} ${await bound.text()}`;
            return "bound-now";
        },
        { sid: sessionId, baseUrl },
    );
    if (outcome !== "bound" && outcome !== "bound-now") {
        throw new Error(`ensureChatBinding failed: ${outcome}`);
    }
}

/**
 * Send a chat message with the two known robustness hazards handled:
 *  - 新建对话 switches sessions asynchronously and clears the input — retry
 *    the fill until the send button reflects the non-empty input;
 *  - a click before the SSE stream component hydrates returns null from
 *    sendMessage and never POSTs (PLAN-294 M1) — retry until the optimistic
 *    user bubble appears.
 */
export async function sendChat(page: Page, text: string): Promise<void> {
    const bound = page.url().match(/\/chat\/([0-9a-f-]{36})/i);
    if (bound) {
        await ensureChatBinding(page, bound[1]);
    }
    const input = page.locator('[data-testid="chat-input"]'),
        send = page.locator('[data-testid="chat-send-button"]');
    // Each retry re-fills: a stale Vue mount (session switch / remount after
    // ensureChatReady) can drop the earlier input event, leaving the button
    // disabled with DOM value set but no v-model update.
    for (let i = 0; i < 6; i++) {
        await input.click().catch(() => {});
        await input.fill(text);
        if (await send.isEnabled().catch(() => false)) break;
        await page.waitForTimeout(1000);
    }
    await expect(send).toBeEnabled({ timeout: 15000 });
    await page
        .locator("[data-sonner-toast]")
        .first()
        .waitFor({ state: "detached", timeout: 8000 })
        .catch(() => {});
    for (let i = 0; i < 10; i++) {
        // The session may appear only after the first click (UI auto-create),
        // so re-resolve and bind the active session on every attempt.
        const active = page.url().match(/\/chat\/([0-9a-f-]{36})/i);
        if (active) {
            await ensureChatBinding(page, active[1]).catch(() => {});
        }
        await send.click();
        try {
            await expect(
                page.locator('[data-slot="message"][data-align="end"]').first(),
            ).toBeVisible({ timeout: 3000 });
            return;
        } catch {
            await page.waitForTimeout(1000);
        }
    }
    throw new Error("send never produced a user message bubble");
}

/**
 * Wait until the session's latest non-legacy operation reaches a terminal state.
 *
 * Wait for the newest ChatRun visible in the domain-owned audit projection.
 */
export async function awaitLatestChatRunCompleted(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId?: string,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const res = await request.get(
                    `${CP_URL}/api/v1/audit/entries?type=chat_run&size=5${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
                    { headers },
                );
                if (!res.ok()) return "unavailable";
                const body = (await res.json()) as {
                    entries?: Array<{ status?: string }>;
                };
                const entries = body.entries ?? [];
                if (entries.length === 0) {
                    return "unknown";
                }
                return entries[0]?.status ?? "unknown";
            },
            { timeout: 120000, intervals: [2_000] },
        )
        .toMatch(CHAT_RUN_TERMINAL);
}

const CHAT_RUN_TERMINAL = /^(succeeded|failed|partial|cancelled|ambiguous)$/;

/**
 * Wait until THIS ChatRun reaches a terminal state.
 *
 * Wait for a specific ChatRun by its domain ID.
 */
export async function awaitOperationCompletedForRun(
    request: APIRequestContext,
    headers: Record<string, string>,
    runId: string,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const res = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, {
                    headers,
                });
                if (!res.ok()) return "unavailable";
                const body = (await res.json()) as { status?: string };
                return body.status ?? "unknown";
            },
            { timeout: 120000, intervals: [500, 1000, 2000] },
        )
        .toMatch(CHAT_RUN_TERMINAL);
}

/**
 * Recover from the brand-new-user empty state ("暂无活动会话"): auto session
 * creation can race CP readiness on cold starts, so 新建对话 is the real
 * user path out of it.
 */
export async function ensureChatReady(page: Page): Promise<void> {
    const chatInput = page.locator('[data-testid="chat-input"]');
    if (!(await chatInput.isVisible({ timeout: 10000 }).catch(() => false))) {
        const newChat = page.getByRole("button", { name: "新建对话" }).first();
        if (await newChat.isVisible().catch(() => false)) {
            await newChat.click();
        } else {
            await page.reload({ waitUntil: "load" });
        }
    }
    await expect(chatInput, "chat input visible on workspace page").toBeVisible({ timeout: 30000 });
}
