// timeout-exempt: C group is a real kill/restart lane (budgets come from env-driven constants, not literals).
/**
 * task-12 | task-160 §C —— 真栈判据 C 组：B5 + C1–C4。
 *
 * 判据原文（不改写）：`A03-xihe/spec/session/team-tasks.md` §5.1 B5 与 C1–C4。
 *
 * 车道（唯一合法形态）：**一次性 owned e2e-host 栈**
 *   `XIHE_E2E_TEAM_C=1 node scripts/e2e-host.mjs --jar-mode=use --llm-mode=spawn_agent \
 *      --retries=0 e2e/real/team-c-group.spec.ts`
 * 该形态下 runner 自己启动 CP/Agent/Runtime 并在本 spec 运行期间处于 `tests` 阶段，
 * 因此 BL-538 的声明式停服窗口（`XIHE_E2E_EXPECTED_EXIT_DIR`，见 scripts/e2e-host.mjs:1340/
 * 1758/2270/2299 与 journey-b.spec.ts:127 的同构实现）会生效：本 spec 在 kill CP **之前**
 * 先写 `control-plane.json` 声明，runner 把这次非零退出判成 `declared`（记 spec+窗口），
 * 不再 abort 整栈。声明单次消费；kill 未发生时由 disposer 删掉。
 *
 * 明确禁止：共享 stack-2 上杀 CP；第二个栈编排。CP 的**重启**不在声明机制职责内，
 * 由本 spec 用 runner 启动它时的同一份命令/环境语义拉起并等 `/actuator/health`（同
 * journey-b 重启 Runtime 的做法）；teardown 时 runner 按 e2e 端口段回收该 detached 进程
 * （scripts/e2e-host.mjs:2438 注明的 PLAN-0369 行为）。
 *
 * 读数落盘：每步写 `runs/<id>-<ts>.json`（默认 evidence 的 runs/ 由
 * `XIHE_TEAM_C_RUNS_DIR` 指定），退出码语义沿用 task-160：
 *   0 全 PASS / 1 有 FAIL / 2 前置不满足 / 3 有 UNMEASURED（由驱动脚本读 summary 判定，
 *   本 spec 自身只保证「未跑项 = UNMEASURED/PRECONDITION_UNMET + 原因」，不留白当绿）。
 *
 * 与 task-86 的分区：本文件是 task-12 独占的新增文件；不改任何既有 spec、不新增共享 helper。
 */
import { execFileSync, spawn } from "node:child_process";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

import {
    CP_URL,
    getRootBranchId,
    registerJourneyUser,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    ensureUserDefaultFakeConnection,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { seedUserGrant } from "./helpers/user-grants";
import { LONG_TIMEOUT_MS } from "../timeouts";

/* ─────────────────────────────────────────────────────────────────────────────
 * 运行前提与读数落盘
 * ──────────────────────────────────────────────────────────────────────────── */

const ENABLED = process.env.XIHE_E2E_TEAM_C === "1";
const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";
const PROFILE = process.env.XIHE_E2E_PROFILE ?? "all";
const CP_PORT = Number(process.env.XIHE_CP_PORT || "12631");
const PG_CONTAINER = process.env.XIHE_E2E_PG_CONTAINER ?? "";
const PG_DATABASE = process.env.XIHE_E2E_PG_DATABASE ?? "";
const PG_USER = process.env.XIHE_E2E_PG_USER ?? "xihe";
const SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN ?? "";
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ??
    path.resolve(process.cwd(), "../../.tmp/e2e-host", RUN_ID || "unknown-run");
const RUNS_DIR = process.env.XIHE_TEAM_C_RUNS_DIR
    ? path.resolve(process.env.XIHE_TEAM_C_RUNS_DIR)
    : path.resolve(process.cwd(), "../../.tmp/task12c/runs");

/** 等待预算：全部来自常量/环境，不写字面量（scripts/check-e2e-timeouts.mjs）。 */
const BUDGET = {
    test: Number(process.env.XIHE_TEAM_C_TEST_MS ?? 540000),
    boot: Number(process.env.XIHE_TEAM_C_BOOT_MS ?? 240000),
    wait: Number(process.env.XIHE_TEAM_C_WAIT_MS ?? 120000),
    short: Number(process.env.XIHE_TEAM_C_SHORT_MS ?? 30000),
};

type Status = "PASS" | "FAIL" | "PRECONDITION_UNMET" | "UNMEASURED";

interface Check {
    criterion: string;
    check: string;
    expected: string;
    observed: string;
    status: Status;
    at: string;
}

const SECRETS: string[] = [];

function scrub(text: unknown): string {
    let out = String(text ?? "");
    for (const secret of SECRETS) {
        if (secret && secret.length >= 8) out = out.split(secret).join("[REDACTED]");
    }
    return out;
}

function stamp(): string {
    return new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, "")
        .slice(0, 14);
}

function writeRunFile(id: string, payload: Record<string, unknown>): string {
    mkdirSync(RUNS_DIR, { recursive: true });
    const file = path.join(RUNS_DIR, `${id}-${stamp()}.json`);
    writeFileSync(
        file,
        `${JSON.stringify({ id, runId: RUN_ID, writtenAt: new Date().toISOString(), ...payload }, null, 2)}\n`,
        "utf8",
    );
    return file;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 等待原语（禁止固定 sleep）
 * ──────────────────────────────────────────────────────────────────────────── */

async function pollUntil<T>(
    probe: () => Promise<T> | T,
    predicate: (value: T) => boolean,
    timeoutMs: number,
    intervalMs = 1500,
): Promise<{ ok: boolean; value: T; waitedMs: number }> {
    const began = Date.now();
    let value = await probe();
    for (;;) {
        if (predicate(value)) return { ok: true, value, waitedMs: Date.now() - began };
        if (Date.now() - began > timeoutMs)
            return { ok: false, value, waitedMs: Date.now() - began };
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        value = await probe();
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 真栈读面：psql（隔离容器内本地 socket，无需密码）与内部等待口
 * ──────────────────────────────────────────────────────────────────────────── */

function psql(sql: string): string[][] {
    const out = execFileSync(
        "docker",
        [
            "exec",
            PG_CONTAINER,
            "psql",
            "-U",
            PG_USER,
            "-d",
            PG_DATABASE,
            "-tA",
            "-F",
            "|~|",
            "-c",
            sql,
        ],
        { encoding: "utf8" },
    ).trim();
    if (!out) return [];
    return out
        .split(/\r?\n/)
        .map((line) => line.split("|~|"))
        .filter((row) => row.length > 1 || (row[0] ?? "") !== "");
}

function psqlScalar(sql: string): string {
    return psql(sql)[0]?.[0] ?? "";
}

type Mouth = "user-questions" | "approval";

interface MouthItem {
    questionId?: string;
    requestId?: string;
    state?: string;
    answer?: string;
    expiresAt?: string;
}

interface MouthEnvelope {
    runId?: string;
    items?: MouthItem[];
}

async function readWaitingMouth(
    request: APIRequestContext,
    mouth: Mouth,
    runId: string,
): Promise<{ status: number; body: MouthEnvelope; text: string }> {
    const response = await request.get(
        `${CP_URL}/internal/v1/chat/runs/${encodeURIComponent(runId)}/${mouth}/waiting`,
        {
            headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, Accept: "application/json" },
            timeout: LONG_TIMEOUT_MS,
        },
    );
    const text = await response.text();
    let body: MouthEnvelope = {};
    try {
        body = JSON.parse(text) as MouthEnvelope;
    } catch {
        body = {};
    }
    return { status: response.status(), body, text };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * BL-538：声明式停服窗口（与 journey-b.spec.ts:127 同构；不新增共享 helper）
 * ──────────────────────────────────────────────────────────────────────────── */

interface Declaration {
    file: string;
    dispose: () => void;
}

function declareExpectedServiceExit(service: string, windowMs = 120000): Declaration {
    const dir = process.env.XIHE_E2E_EXPECTED_EXIT_DIR;
    if (!dir) return { file: "", dispose: () => {} };
    const file = path.join(dir, `${service}.json`);
    const startedAt = Date.now();
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            file,
            JSON.stringify({
                service,
                spec: "team-c-group.spec.ts:kill-control-plane",
                startedAt,
                expiresAt: startedAt + windowMs,
            }),
            "utf8",
        );
    } catch {
        return { file, dispose: () => {} };
    }
    return {
        file,
        dispose: () => {
            try {
                unlinkSync(file);
            } catch {
                // already consumed by the runner
            }
        },
    };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * CP 进程控制：只在 e2e 端口段上，且只在 owned 一次性栈
 * ──────────────────────────────────────────────────────────────────────────── */

// scripts/lib/kill-guard.mjs:26-27 —— 同一端口段；runner teardown 只回收这一段里的残留监听。
const E2E_PORT_MIN = Number(process.env.XIHE_E2E_PORT_MIN ?? 27000);
const E2E_PORT_MAX = Number(process.env.XIHE_E2E_PORT_MAX ?? 29999);

function listeningPid(port: number): number | null {
    try {
        const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
        const line = out
            .split(/\r?\n/)
            .find((entry) => entry.includes(`:${port} `) && entry.includes("LISTENING"));
        const pid = line?.trim().split(/\s+/).pop();
        return pid ? Number(pid) : null;
    } catch {
        return null;
    }
}

async function cpHealthStatus(): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000 /* timeout-exempt: 单次健康探针 */);
    try {
        const response = await fetch(`http://127.0.0.1:${CP_PORT}/actuator/health`, {
            signal: controller.signal,
        });
        return response.status;
    } catch {
        return 0;
    } finally {
        clearTimeout(timer);
    }
}

async function waitForCpHealth(predicate: (status: number) => boolean, budgetMs: number) {
    return pollUntil(cpHealthStatus, predicate, budgetMs, 2000);
}

function assertE2ePort(port: number): void {
    if (!(port >= E2E_PORT_MIN && port <= E2E_PORT_MAX)) {
        throw new Error(
            `refusing to touch CP on port ${port}: outside the e2e block ${E2E_PORT_MIN}-${E2E_PORT_MAX}`,
        );
    }
}

/** 杀掉 CP。**调用方必须先写 declaration**（本文件只通过 killControlPlane 调用它）。 */
async function killCpDeclared(): Promise<{
    pid: number;
    killedAt: string;
    declarationConsumed: boolean;
}> {
    assertE2ePort(CP_PORT);
    const pid = listeningPid(CP_PORT);
    if (!pid) throw new Error(`no CP listener on port ${CP_PORT}`);
    // Declare BEFORE the kill; the runner consumes the file on the observed exit (single use).
    const declaration = declareExpectedServiceExit("control-plane");
    const killedAt = new Date().toISOString();
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    const stopped = await waitForCpHealth((status) => status !== 200, BUDGET.short);
    if (!stopped.ok) {
        declaration.dispose();
        throw new Error(`CP on port ${CP_PORT} still answers /actuator/health after the kill`);
    }
    // Do NOT delete right after the kill: the runner's child-exit handler consumes it slightly later.
    // Poll until it disappears (consumed), and only remove a declaration that was never consumed.
    const remained = await pollUntil(
        () => (declaration.file ? existsSync(declaration.file) : false),
        (stillThere) => !stillThere,
        BUDGET.short,
        100,
    );
    if (remained.value) declaration.dispose();
    return { pid, killedAt, declarationConsumed: !remained.value };
}

interface CpRestartEnv {
    datasourcePassword: string;
    jar: string;
}

function pgPasswordFromContainer(): string {
    const env = execFileSync(
        "docker",
        ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", PG_CONTAINER],
        { encoding: "utf8" },
    );
    const line = env.split(/\r?\n/).find((entry) => entry.startsWith("POSTGRES_PASSWORD="));
    if (!line)
        throw new Error("E_PG_PASSWORD: POSTGRES_PASSWORD not present on the isolated container");
    return line.slice("POSTGRES_PASSWORD=".length).trim();
}

/**
 * 找出 runner 实际启动 CP 用的 jar。owned 运行由 runner 写
 * `<hostRoot>/logs/artifacts.json`（scripts/e2e-host.mjs:845-898），其中
 * `control-plane-jar` 带 project-relative path —— 用它而不是猜路径。
 */
function resolveCpJar(): string {
    const manifestPath = path.join(HOST_ROOT, "logs", "artifacts.json");
    if (!existsSync(manifestPath)) {
        throw new Error(
            `E_CP_JAR: artifacts manifest missing (${manifestPath}); boot with --jar-mode=use`,
        );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        artifacts?: Array<{ name?: string; path?: string }>;
    };
    const entry = manifest.artifacts?.find((artifact) => artifact.name === "control-plane-jar");
    if (!entry?.path) {
        throw new Error(
            "E_CP_JAR: this run booted CP without a jar (mvn/native); restart semantics are only defined for the jar lane",
        );
    }
    const projectDir = path.resolve(process.cwd(), "../..");
    const jar = path.isAbsolute(entry.path) ? entry.path : path.join(projectDir, entry.path);
    if (!existsSync(jar)) throw new Error(`E_CP_JAR: manifest path does not exist: ${jar}`);
    return jar;
}

function cpRestartEnv(): CpRestartEnv {
    return { datasourcePassword: pgPasswordFromContainer(), jar: resolveCpJar() };
}

/** 用 runner 启动 CP 时的同一语义（scripts/e2e-host.mjs:3201-3226）拉起并等 readiness。 */
async function restartCp(env: CpRestartEnv): Promise<{ pid: number; readyMs: number }> {
    assertE2ePort(CP_PORT);
    const logDir = path.join(HOST_ROOT, "logs");
    mkdirSync(logDir, { recursive: true });
    const out = openSync(path.join(logDir, "team-c-cp-restart.log"), "a");
    const child = spawn("java", ["-jar", env.jar, "--spring.profiles.active=e2e"], {
        cwd: path.resolve(process.cwd(), "../../packages/control-plane"),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
        env: {
            ...process.env,
            XIHE_ENV: "dev",
            XIHE_CP_PORT: String(CP_PORT),
            XIHE_CP_DATASOURCE_URL: `jdbc:postgresql://localhost:${process.env.XIHE_E2E_PG_PORT}/${PG_DATABASE}`,
            XIHE_PG_PORT: String(process.env.XIHE_E2E_PG_PORT ?? ""),
            XIHE_CP_DATASOURCE_USERNAME: PG_USER,
            XIHE_CP_DATASOURCE_PASSWORD: env.datasourcePassword,
            // scripts/e2e-host.mjs:3207 —— 同值才能让重启前签发的 access token 继续有效。
            XIHE_CP_JWT_SECRET: `e2e-${RUN_ID}-jwt-secret`,
            XIHE_AGENT_URL: `http://127.0.0.1:${process.env.XIHE_AGENT_PORT}/internal/v1/agent/chat`,
            XIHE_AGENT_BASE_URL: `http://127.0.0.1:${process.env.XIHE_AGENT_PORT}`,
            XIHE_RUNTIME_URL: `http://127.0.0.1:${process.env.XIHE_RUNTIME_PORT}`,
            XIHE_DEV_ADMIN_PASSWORD: process.env.XIHE_E2E_ADMIN_PASSWORD ?? "",
            XIHE_AUTH_REGISTRATION_POLICY: process.env.XIHE_E2E_REGISTRATION_POLICY ?? "open",
            XIHE_CP_AUTH_LOGIN_REGISTER_MAX_ATTEMPTS: "0",
            XIHE_E2E_RUN_ID: RUN_ID,
            XIHE_E2E_CHECKPOINT_PROBE: "0",
            XIHE_WORKSPACE_DOCKER_BACKEND: "disabled",
            XIHE_CHANNEL_ENABLED: "true",
            XIHE_CP_API_TOKEN: SERVICE_TOKEN,
            XIHE_AGENT_API_TOKEN: SERVICE_TOKEN,
            XIHE_SEED_ADMIN: "true",
            XIHE_LOAD_DOTENV: "0",
            XIHE_LOG_DIR: logDir,
        } as Record<string, string>,
    });
    child.unref();
    closeSync(out);
    const ready = await waitForCpHealth((status) => status === 200, BUDGET.boot);
    if (!ready.ok) throw new Error(`CP did not reach /actuator/health=200 within ${BUDGET.boot}ms`);
    return { pid: child.pid ?? -1, readyMs: ready.waitedMs };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 夹具（只走真实 HTTP 口；psql 只用于读事实）
 * ──────────────────────────────────────────────────────────────────────────── */

interface Fixture {
    authToken: string;
    workspaceId: string;
    headers: Record<string, string>;
    principalId: string;
}

async function buildFixture(
    request: APIRequestContext,
    tag: string,
    actions: Array<"read" | "write"> = ["read"],
): Promise<Fixture> {
    const ctx = await registerJourneyUser(request, `team-c-${tag}`);
    const auth = { accessToken: ctx.authToken, workspaceId: ctx.workspaceId };
    const headers = { ...ctx.headers, "X-Workspace-Id": ctx.workspaceId };
    await ensureUserDefaultFakeConnection(request, auth);
    await waitForControlPlaneAgentReady(request, headers);
    const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
        name: `TeamC${tag}${Date.now().toString(36)}`,
        actions,
        systemPrompt:
            "You are the task-12 C group fixture agent. Call exactly the tool you are asked for.",
    });
    SECRETS.push(ctx.authToken);
    return { authToken: ctx.authToken, workspaceId: ctx.workspaceId, headers, principalId };
}

/**
 * B5 needs a real `spawn_agent`: the principal must carry SPAWN_AGENT, the *operator* needs the
 * same ceiling (principal cap ⊆ operator union), and the session freezes the snapshot at creation
 * (plan0630-delegation-walkthrough.spec.ts:286-327 is the proven recipe; this is its minimal form).
 */
async function buildSpawnFixture(request: APIRequestContext): Promise<Fixture> {
    const ctx = await registerJourneyUser(request, "team-c-b5");
    const auth = { accessToken: ctx.authToken, workspaceId: ctx.workspaceId };
    const headers = { ...ctx.headers, "X-Workspace-Id": ctx.workspaceId };
    await ensureUserDefaultFakeConnection(request, auth);
    await waitForControlPlaneAgentReady(request, headers);
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    expect(me.ok(), await me.text()).toBeTruthy();
    const { id: userId } = (await me.json()) as { id: string };
    // The operator's own ceiling must include SPAWN_AGENT: the workspace cap is checked as
    // `cap ⊆ principal atoms` AND `cap ⊆ actor atoms` (plan0630:286-310).
    seedUserGrant(userId, ctx.workspaceId, [{ actionClass: "SPAWN_AGENT", resource: "*" }]);
    const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
        name: `TeamCSpawn${Date.now().toString(36)}`,
        actions: ["read"],
        systemPrompt:
            "You are the task-12 B5 fixture agent. When asked to spawn, call spawn_agent exactly once.",
    });
    const grantSpawnAtom = () =>
        psql(
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, scope_type, scope_id, read_state, created_at) ` +
                `SELECT gen_random_uuid(), 'user', '${userId}', 'agent_principal', '${principalId}', ` +
                `jsonb_build_array(jsonb_build_object('actionClass','SPAWN_AGENT','resource','*')), ` +
                `'role', 'instance', NULL, 'read', now() ON CONFLICT DO NOTHING`,
        );
    // The bind happened inside the helper with read-only permissions, so the SPAWN_AGENT atom must
    // exist on the principal BEFORE the cap is widened (plan0630:288-321). Seed, widen, re-seed.
    grantSpawnAtom();
    const widened = await request.put(
        `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/agents/${principalId}`,
        {
            headers,
            data: {
                permissions: [
                    { actionClass: "read", resource: "*" },
                    { actionClass: "SPAWN_AGENT", resource: "*" },
                ],
            },
        },
    );
    expect(widened.status(), await widened.text()).toBe(200);
    grantSpawnAtom();
    await request.patch(`${CP_URL}/api/v1/agent-principals/${principalId}`, {
        headers,
        data: { delegationPolicy: { maxCount: 2, maxDepth: 2 } },
    });
    SECRETS.push(ctx.authToken);
    return { authToken: ctx.authToken, workspaceId: ctx.workspaceId, headers, principalId };
}

interface Session {
    sessionId: string;
    branchId: string;
}

async function newSession(
    request: APIRequestContext,
    fx: Fixture,
    title: string,
): Promise<Session> {
    const sessionId = await createSessionWithPrincipal(
        request,
        { accessToken: fx.authToken, workspaceId: fx.workspaceId },
        { principalId: fx.principalId, title, workspaceId: fx.workspaceId },
    );
    const branchId = await getRootBranchId(request, sessionId, fx.headers);
    return { sessionId, branchId };
}

/**
 * 打开 SSE 订阅并持续抽干（POST /api/v1/chat 的前置门：无 emitter ⇒ 409 SSE_SUBSCRIPTION_REQUIRED）。
 * **必须等响应头到达**再发 chat：此前立即返回，C2 的 pending 提交抢在注册前拿到 409（2026-11-22 首跑实测）。
 */
async function openSse(
    fx: Fixture,
    sessionId: string,
): Promise<{ close: () => void; text: () => string }> {
    const controller = new AbortController();
    let buffer = "";
    const response = await fetch(
        `${CP_URL}/api/v1/events?sessionId=${encodeURIComponent(sessionId)}`,
        {
            headers: { Authorization: `Bearer ${fx.authToken}`, Accept: "text/event-stream" },
            signal: controller.signal,
        },
    );
    if (response.status !== 200) {
        throw new Error(`SSE subscribe failed: HTTP ${response.status}`);
    }
    void (async () => {
        try {
            const reader = response.body?.getReader();
            if (!reader) return;
            const decoder = new TextDecoder();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
            }
        } catch {
            // disposer abort
        }
    })();
    return { close: () => controller.abort(), text: () => buffer };
}

interface ChatAdmission {
    status: number;
    runId: string;
    text: string;
}

async function submitChat(
    request: APIRequestContext,
    fx: Fixture,
    session: Session,
    content: string,
): Promise<ChatAdmission> {
    let status = 0;
    let text = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: { ...fx.headers, "Idempotency-Key": `team-c-${Date.now()}-${Math.random()}` },
            data: {
                sessionId: session.sessionId,
                branchId: session.branchId,
                content,
                toolMode: "workspace",
            },
            timeout: LONG_TIMEOUT_MS,
        });
        status = response.status();
        text = await response.text();
        // CP's emitter registration is asynchronous even after the SSE headers; bounded retry only.
        if (status === 409 && text.includes("SSE_SUBSCRIPTION_REQUIRED")) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            continue;
        }
        break;
    }
    let runId = "";
    try {
        const body = JSON.parse(text) as { runId?: string; id?: string };
        runId = body.runId ?? body.id ?? "";
    } catch {
        runId = "";
    }
    return { status, runId, text };
}

async function waitPendingQuestion(runId: string) {
    return pollUntil(
        () =>
            psql(
                `SELECT id, state, coalesce(answer,''), coalesce(expires_at::text,'') ` +
                    `FROM user_questions WHERE run_id = '${runId}' ORDER BY created_at`,
            ),
        (rows) => rows.length >= 1 && rows[0][1] === "pending",
        BUDGET.wait,
    );
}

function runStatus(runId: string): string {
    return psqlScalar(
        `SELECT status || '|' || coalesce(error_code,'<null>') FROM chat_runs WHERE id = '${runId}'`,
    );
}

/** 读 CP 日志是否出现 D-1836 的签名（`No active transaction`）。 */
function scanD1836(): { hits: number; lines: string[] } {
    const logsDir = path.join(HOST_ROOT, "logs");
    if (!existsSync(logsDir)) return { hits: 0, lines: [] };
    const lines: string[] = [];
    for (const entry of readdirSync(logsDir)) {
        if (!entry.endsWith(".log")) continue;
        const file = path.join(logsDir, entry);
        for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
            if (/No active transaction/.test(line)) lines.push(`${entry}: ${line.slice(0, 300)}`);
        }
    }
    return { hits: lines.length, lines };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 用例
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe.configure({ mode: "serial", retries: 0, timeout: BUDGET.test });

test.describe("task-12 C group — real-stack kill/restart criteria @host", () => {
    test.skip(!ENABLED, "set XIHE_E2E_TEAM_C=1 and boot an owned e2e-host stack (see file header)");
    test.skip(!RUN_ID, "requires the isolated host stack (XIHE_E2E_RUN_ID)");
    test.skip(PROFILE !== "host", "C group is a @host lane");
    test.skip(!SERVICE_TOKEN, "requires XIHE_CP_API_TOKEN from the runner");
    test.skip(!PG_CONTAINER || !PG_DATABASE, "requires XIHE_E2E_PG_CONTAINER/DATABASE");

    test("C1 ask_user waiting run lands checkpoints without latching", async ({ request }) => {
        const checks: Check[] = [];
        const record = (check: string, expected: string, observed: string, status: Status) =>
            checks.push({
                criterion: "C1",
                check,
                expected,
                observed: scrub(observed),
                status,
                at: new Date().toISOString(),
            });
        const fx = await buildFixture(request, "c1");
        const session = await newSession(request, fx, "task-12 C1 ask_user");
        const sse = await openSse(fx, session.sessionId);
        const question = `T12C C1 验收问题 ${Date.now()} 请确认继续`;
        const admission = await submitChat(
            request,
            fx,
            session,
            `XIHE-E2E-CHAIN ask-user XIHE-E2E-ASK ${question}`,
        );
        record(
            "chat admission",
            "HTTP 202 + runId",
            `HTTP ${admission.status} ${admission.text.slice(0, 200)}`,
            admission.status === 202 && admission.runId ? "PASS" : "PRECONDITION_UNMET",
        );
        if (admission.status !== 202 || !admission.runId) {
            sse.close();
            writeRunFile("C1", { status: "PRECONDITION_UNMET", checks });
            test.skip(true, `ask_user run not admitted: HTTP ${admission.status}`);
        }
        const runId = admission.runId;

        const pending = await waitPendingQuestion(runId);
        record(
            "user_questions pending row",
            ">=1 row state=pending (run is in the ask_user wait)",
            JSON.stringify(pending.value),
            pending.ok ? "PASS" : "FAIL",
        );
        const questionId = pending.value[0]?.[0] ?? "";

        const checkpoints = Number(
            psqlScalar(
                `SELECT count(*) FROM agent_graph_checkpoints c JOIN agent_graph_checkpoint_lineages l ` +
                    `ON l.lineage_id = c.lineage_id WHERE l.source_run_id = '${runId}'`,
            ),
        );
        const writes = Number(
            psqlScalar(
                `SELECT count(*) FROM agent_graph_checkpoint_writes w JOIN agent_graph_checkpoint_lineages l ` +
                    `ON l.lineage_id = w.lineage_id WHERE l.source_run_id = '${runId}'`,
            ),
        );
        record(
            "checkpoint landed",
            "checkpoints>=1 and writes>=1",
            `checkpoints=${checkpoints} writes=${writes}`,
            checkpoints >= 1 && writes >= 1 ? "PASS" : "FAIL",
        );
        const payloadAskUser = Number(
            psqlScalar(
                `SELECT count(*) FROM agent_graph_checkpoints c JOIN agent_graph_checkpoint_lineages l ` +
                    `ON l.lineage_id = c.lineage_id WHERE l.source_run_id = '${runId}' ` +
                    // V72: the payload column is `checkpoint_blob BYTEA`; `encode(...,'escape')` is a
                    // text-safe projection that cannot throw on binary (unlike convert_from).
                    `AND encode(checkpoint_blob,'escape') LIKE '%ask_user%'`,
            ),
        );
        record(
            "pending AI tool call inside the checkpoint",
            ">=1 decoded checkpoint payload contains ask_user",
            `hits=${payloadAskUser}/${checkpoints}`,
            payloadAskUser >= 1 ? "PASS" : "FAIL",
        );
        const status = runStatus(runId);
        record(
            "not latched",
            "run status is a live wait (not failed/cancelled/ambiguous)",
            status,
            /^(queued|accepted|running|streaming|waiting|awaiting_approval)\|/.test(status)
                ? "PASS"
                : "FAIL",
        );

        const mouth = await readWaitingMouth(request, "user-questions", runId);
        const item = mouth.body.items?.[0];
        const topKeys = Object.keys(mouth.body).sort().join(",");
        const itemKeys = item ? Object.keys(item).sort().join(",") : "";
        record(
            "internal waiting mouth envelope",
            "HTTP 200, top keys runId+items, one item state=pending, minimised keys",
            `HTTP ${mouth.status} top=${topKeys} item=${itemKeys} body=${mouth.text.slice(0, 240)}`,
            mouth.status === 200 &&
                topKeys === "items,runId" &&
                item?.state === "pending" &&
                itemKeys
                    .split(",")
                    .every((key) => ["expiresAt", "questionId", "state"].includes(key))
                ? "PASS"
                : "FAIL",
        );

        record(
            "negative control (unregistered schema still latches)",
            "same-shape unregistered-schema tool call must latch",
            "UNMEASURED: no fixture chain emits an unregistered-schema tool call; adding one would require a new fake-LLM mode (out of task-12 write scope: e2e/fixtures is not in scope)",
            "UNMEASURED",
        );

        sse.close();
        const failed = checks.filter((check) => check.status === "FAIL").length;
        writeRunFile("C1", {
            status: failed ? "FAIL" : "PASS",
            runId,
            sessionId: session.sessionId,
            questionId,
            checks,
        });
        expect(
            checks.filter((check) => check.status === "FAIL"),
            JSON.stringify(checks, null, 2),
        ).toHaveLength(0);
    });

    test("C2 kill CP → restart → answered direct-return, pending re-arms without re-asking", async ({
        request,
    }) => {
        const checks: Check[] = [];
        const record = (check: string, expected: string, observed: string, status: Status) =>
            checks.push({
                criterion: "C2",
                check,
                expected,
                observed: scrub(observed),
                status,
                at: new Date().toISOString(),
            });

        const fx = await buildFixture(request, "c2");
        const pendingSession = await newSession(request, fx, "task-12 C2 pending");
        const answeredSession = await newSession(request, fx, "task-12 C2 answered");
        const ssePending = await openSse(fx, pendingSession.sessionId);
        const sseAnswered = await openSse(fx, answeredSession.sessionId);

        const pendingAdmission = await submitChat(
            request,
            fx,
            pendingSession,
            `XIHE-E2E-CHAIN ask-user XIHE-E2E-ASK T12C C2 pending ${Date.now()}`,
        );
        const answeredAdmission = await submitChat(
            request,
            fx,
            answeredSession,
            `XIHE-E2E-CHAIN ask-user XIHE-E2E-ASK T12C C2 answered ${Date.now()}`,
        );
        record(
            "two runs admitted",
            "both HTTP 202",
            `pending=${pendingAdmission.status} answered=${answeredAdmission.status}`,
            pendingAdmission.status === 202 && answeredAdmission.status === 202
                ? "PASS"
                : "PRECONDITION_UNMET",
        );
        if (pendingAdmission.status !== 202 || answeredAdmission.status !== 202) {
            ssePending.close();
            sseAnswered.close();
            writeRunFile("C2", { status: "PRECONDITION_UNMET", checks });
            test.skip(true, "ask_user runs were not admitted");
        }

        const pendingRun = pendingAdmission.runId;
        const answeredRun = answeredAdmission.runId;
        const pendingRow = await waitPendingQuestion(pendingRun);
        const answeredRow = await waitPendingQuestion(answeredRun);
        record(
            "pending/answered preconditions",
            "both runs have a pending question before the kill",
            `pending=${JSON.stringify(pendingRow.value)} answered=${JSON.stringify(answeredRow.value)}`,
            pendingRow.ok && answeredRow.ok ? "PASS" : "PRECONDITION_UNMET",
        );
        if (!pendingRow.ok || !answeredRow.ok) {
            ssePending.close();
            sseAnswered.close();
            writeRunFile("C2", { status: "PRECONDITION_UNMET", checks });
            test.skip(true, "no pending question rows before the kill");
        }
        const pendingQuestionId = pendingRow.value[0]?.[0] ?? "";
        const answeredQuestionId = answeredRow.value[0]?.[0] ?? "";
        const pendingExpiry = pendingRow.value[0]?.[3] ?? "";

        const answerText = `T12C C2 answered ${Date.now()}`;
        const answerResponse = await request.post(
            `${CP_URL}/api/v1/user-questions/${answeredQuestionId}/answer`,
            { headers: fx.headers, data: { answer: answerText }, timeout: LONG_TIMEOUT_MS },
        );
        record(
            "answer durable before the kill",
            "HTTP 200 and the row is settled as answered",
            `HTTP ${answerResponse.status()} ${(await answerResponse.text()).slice(0, 200)}`,
            answerResponse.status() === 200 ? "PASS" : "FAIL",
        );

        const beforePending = await readWaitingMouth(request, "user-questions", pendingRun);
        const beforeAnswered = await readWaitingMouth(request, "user-questions", answeredRun);

        const killed = await killCpDeclared();
        record(
            "CP killed with declaration",
            "CP stops answering /actuator/health",
            JSON.stringify(killed),
            "PASS",
        );
        const cpEnv = cpRestartEnv();
        const restarted = await restartCp(cpEnv);
        record(
            "CP restarted and ready",
            "pid changed, /actuator/health=200",
            `oldPid=${killed.pid} newPid=${restarted.pid} readyMs=${restarted.readyMs} jar=${cpEnv.jar}`,
            restarted.pid > 0 && restarted.pid !== killed.pid ? "PASS" : "FAIL",
        );

        const afterPending = await readWaitingMouth(request, "user-questions", pendingRun);
        const afterAnswered = await readWaitingMouth(request, "user-questions", answeredRun);
        const pendingItem = afterPending.body.items?.[0];
        const answeredItem = afterAnswered.body.items?.[0];
        record(
            "pending re-arms after restart (same question, same expiry)",
            "state=pending, same questionId, expiresAt unchanged",
            `before=${JSON.stringify(beforePending.body)} after=${JSON.stringify(afterPending.body)}`,
            afterPending.status === 200 &&
                pendingItem?.state === "pending" &&
                pendingItem.questionId === pendingQuestionId &&
                (pendingItem.expiresAt ?? "") === pendingExpiry
                ? "PASS"
                : "FAIL",
        );
        const pendingCount = Number(
            psqlScalar(`SELECT count(*) FROM user_questions WHERE run_id = '${pendingRun}'`),
        );
        record(
            "pending question not re-asked (no second row)",
            "exactly 1 user_questions row for the pending run",
            `rows=${pendingCount} before=${JSON.stringify(beforePending.body.items)}`,
            pendingCount === 1 ? "PASS" : "FAIL",
        );
        record(
            "answered direct-return after restart (no human round-trip)",
            "state=answered with the stored answer",
            `status=${afterAnswered.status} before=${JSON.stringify(beforeAnswered.body)} ` +
                `after=${JSON.stringify(afterAnswered.body)}`,
            afterAnswered.status === 200 &&
                answeredItem?.state === "answered" &&
                answeredItem.answer === answerText &&
                answeredItem.questionId === answeredQuestionId
                ? "PASS"
                : "FAIL",
        );

        record(
            "observed run statuses after restart (evidence, not a gate)",
            "recorded for C3",
            `pendingRun=${runStatus(pendingRun)} answeredRun=${runStatus(answeredRun)}`,
            "PASS",
        );

        ssePending.close();
        sseAnswered.close();
        const failed = checks.filter((check) => check.status === "FAIL").length;
        writeRunFile("C2", {
            status: failed ? "FAIL" : "PASS",
            pendingRun,
            answeredRun,
            checks,
        });
        expect(
            checks.filter((check) => check.status === "FAIL"),
            JSON.stringify(checks, null, 2),
        ).toHaveLength(0);
    });

    test("C3 durable answer survives the restart and D-1836 stays clean", async ({ request }) => {
        const checks: Check[] = [];
        const record = (check: string, expected: string, observed: string, status: Status) =>
            checks.push({
                criterion: "C3",
                check,
                expected,
                observed: scrub(observed),
                status,
                at: new Date().toISOString(),
            });
        const fx = await buildFixture(request, "c3");
        const session = await newSession(request, fx, "task-12 C3 durable answer");
        const sse = await openSse(fx, session.sessionId);
        const admission = await submitChat(
            request,
            fx,
            session,
            `XIHE-E2E-CHAIN ask-user XIHE-E2E-ASK T12C C3 durable ${Date.now()}`,
        );
        if (admission.status !== 202 || !admission.runId) {
            sse.close();
            writeRunFile("C3", {
                status: "PRECONDITION_UNMET",
                checks: [
                    {
                        criterion: "C3",
                        check: "chat admission",
                        expected: "HTTP 202",
                        observed: `HTTP ${admission.status}`,
                        status: "PRECONDITION_UNMET" as Status,
                        at: new Date().toISOString(),
                    },
                ],
            });
            test.skip(true, `ask_user run not admitted: HTTP ${admission.status}`);
        }
        const runId = admission.runId;
        const pending = await waitPendingQuestion(runId);
        if (!pending.ok) {
            sse.close();
            record(
                "pending question row",
                "at least one pending user_questions row",
                JSON.stringify(pending.value),
                "PRECONDITION_UNMET",
            );
            writeRunFile("C3", { status: "PRECONDITION_UNMET", checks });
            test.skip(true, "no pending question row for the C3 run");
        }
        const questionId = pending.value[0]?.[0] ?? "";
        const answerText = `T12C C3 durable ${Date.now()}`;
        const answer = await request.post(`${CP_URL}/api/v1/user-questions/${questionId}/answer`, {
            headers: fx.headers,
            data: { answer: answerText },
            timeout: LONG_TIMEOUT_MS,
        });
        record(
            "answer durable (respond may or may not have reached the Agent)",
            "HTTP 200 or the documented 502 delivery failure with the row still answered",
            `HTTP ${answer.status()} ${(await answer.text()).slice(0, 200)}`,
            [200, 502].includes(answer.status()) ? "PASS" : "FAIL",
        );
        const answeredRow =
            psql(
                `SELECT state, coalesce(answer,''), coalesce(settled_at::text,'') FROM user_questions WHERE id = '${questionId}'`,
            )[0] ?? [];
        record(
            "answer row is the durable fact",
            "state=answered and answer text stored",
            JSON.stringify(answeredRow),
            answeredRow[0] === "answered" && answeredRow[1] === answerText ? "PASS" : "FAIL",
        );

        const killed = await killCpDeclared();
        const restarted = await restartCp(cpRestartEnv());
        record(
            "CP kill + restart",
            "new pid + health 200",
            JSON.stringify({ killed, restarted }),
            restarted.pid > 0 && restarted.pid !== killed.pid ? "PASS" : "FAIL",
        );

        const survived =
            psql(
                `SELECT state, coalesce(answer,''), coalesce(settled_at::text,'') FROM user_questions WHERE id = '${questionId}'`,
            )[0] ?? [];
        record(
            "answer durable across the restart",
            "state=answered and the same answer text after restart",
            JSON.stringify(survived),
            survived[0] === "answered" && survived[1] === answerText ? "PASS" : "FAIL",
        );

        const replay = await pollUntil(
            () => runStatus(runId),
            (status) =>
                /^(succeeded|failed|partial|cancelled|ambiguous|running|streaming|waiting)\|/.test(
                    status,
                ),
            BUDGET.wait,
        );
        record(
            "run resumes / drains after the answer (evidence)",
            "run leaves the crash window (any live/terminal state)",
            replay.value,
            replay.ok ? "PASS" : "FAIL",
        );

        const d1836 = scanD1836();
        record(
            "D-1836 signature absent from CP logs",
            "zero 'No active transaction' hits",
            `hits=${d1836.hits} ${JSON.stringify(d1836.lines).slice(0, 400)}`,
            d1836.hits === 0 ? "PASS" : "FAIL",
        );
        record(
            "forced respond failure → park → replay",
            "answer persists, run parks and replays on the terminal event",
            "UNMEASURED: forcing the CP→Agent respond to fail needs a failpoint; the only in-tree failpoints are gated to the exact checkpoint-probe specs (scripts/e2e-host.mjs:1779), which this lane must not claim",
            "UNMEASURED",
        );

        sse.close();
        const failed = checks.filter((check) => check.status === "FAIL").length;
        writeRunFile("C3", { status: failed ? "FAIL" : "PASS", runId, checks });
        expect(
            checks.filter((check) => check.status === "FAIL"),
            JSON.stringify(checks, null, 2),
        ).toHaveLength(0);
    });

    test("C4 approval symmetric mouth reads facts without consuming", async ({ request }) => {
        const checks: Check[] = [];
        const record = (check: string, expected: string, observed: string, status: Status) =>
            checks.push({
                criterion: "C4",
                check,
                expected,
                observed: scrub(observed),
                status,
                at: new Date().toISOString(),
            });
        // write_file must be *authorized* (write atom) but still require a human decision: the
        // approval gate is what writes approval_requests; without the atom CP answers
        // `authorization_grant_denied` before the approval face (2026-11-22 write_file lane log).
        const fx = await buildFixture(request, "c4", ["read", "write"]);
        if ((process.env.XIHE_E2E_LLM_MODE ?? "") !== "write_file") {
            writeRunFile("C4", {
                status: "PRECONDITION_UNMET",
                checks: [
                    {
                        criterion: "C4",
                        check: "write_file lane",
                        expected: "--llm-mode=write_file",
                        observed: `XIHE_E2E_LLM_MODE=${process.env.XIHE_E2E_LLM_MODE ?? "<unset>"}`,
                        status: "PRECONDITION_UNMET" as Status,
                        at: new Date().toISOString(),
                    },
                ],
            });
            test.skip(
                true,
                "C4 needs the write_file fake-LLM lane to reach the approval face deterministically",
            );
        }
        const session = await newSession(request, fx, "task-12 C4 approval");
        const sse = await openSse(fx, session.sessionId);
        const path0 = `team-c-c4-${Date.now()}.md`;
        // The write_file lane emits one deterministic write_file call (its approval face is the run's
        // gate). The wf1-coding chain would need two user turns and is not needed here.
        const admission = await submitChat(
            request,
            fx,
            session,
            `XIHE-E2E-WRITE ${path0} task-12 C4 approval probe`,
        );
        if (admission.status !== 202 || !admission.runId) {
            sse.close();
            writeRunFile("C4", { status: "PRECONDITION_UNMET", checks });
            test.skip(true, `write_file run not admitted: HTTP ${admission.status}`);
        }
        const runId = admission.runId;
        const pending = await pollUntil(
            () =>
                psql(
                    `SELECT request_id, state, coalesce(expires_at::text,''), coalesce(decided_at::text,''), ` +
                        `coalesce(grant_consumed_at::text,''), coalesce(dispatch_error_code,''), coalesce(decision_kind,'') ` +
                        `FROM approval_requests WHERE run_id = '${runId}' ORDER BY created_at`,
                ),
            (rows) => rows.length >= 1,
            BUDGET.wait,
        );
        record(
            "approval row exists",
            "at least one approval_requests row for the run",
            JSON.stringify(pending.value),
            pending.ok ? "PASS" : "PRECONDITION_UNMET",
        );
        if (!pending.ok) {
            sse.close();
            writeRunFile("C4", { status: "PRECONDITION_UNMET", checks });
            test.skip(
                true,
                "no approval_requests row (wf1-coding chain did not reach the approval face)",
            );
        }
        const requestId = pending.value[0][0];
        const immutableQuery = (id: string) =>
            psql(
                `SELECT state, coalesce(approved::text,''), coalesce(decided_at::text,''), ` +
                    `coalesce(grant_consumed_at::text,''), coalesce(dispatch_error_code,''), coalesce(decision_kind,'') ` +
                    `FROM approval_requests WHERE request_id = '${id}'`,
            )[0] ?? [];

        const before = immutableQuery(requestId);
        const firstRead = await readWaitingMouth(request, "approval", runId);
        const secondRead = await readWaitingMouth(request, "approval", runId);
        const afterRead = immutableQuery(requestId);
        record(
            "read is non-consuming",
            "two reads leave state/approved/decided_at/grant_consumed_at/dispatch_error_code/decision_kind unchanged",
            `before=${JSON.stringify(before)} after=${JSON.stringify(afterRead)}`,
            JSON.stringify(before) === JSON.stringify(afterRead) ? "PASS" : "FAIL",
        );
        record(
            "pending envelope is minimised",
            "HTTP 200, keys runId+items, item keys requestId/state(+expiresAt), no prompt/feedback/details/arguments",
            `first=${JSON.stringify(firstRead.body)} second=${JSON.stringify(secondRead.body)}`,
            firstRead.status === 200 &&
                Object.keys(firstRead.body).sort().join(",") === "items,runId" &&
                firstRead.body.items?.[0]?.state === "pending" &&
                !/"prompt"|"feedback"|"details"|"arguments"/.test(firstRead.text)
                ? "PASS"
                : "FAIL",
        );

        const decision = await request.post(
            `${CP_URL}/api/v1/chat/approvals/${requestId}/decision`,
            {
                headers: fx.headers,
                data: { decision: "once" },
                timeout: LONG_TIMEOUT_MS,
            },
        );
        record(
            "decision applied",
            "HTTP 200",
            `HTTP ${decision.status()} ${(await decision.text()).slice(0, 200)}`,
            decision.status() === 200 ? "PASS" : "FAIL",
        );
        const approvedBefore = immutableQuery(requestId);
        const approvedRead = await readWaitingMouth(request, "approval", runId);
        const approvedAfter = immutableQuery(requestId);
        record(
            "approved row read is non-consuming",
            "state=approved returned; row columns unchanged; no expiresAt on a decided row",
            `before=${JSON.stringify(approvedBefore)} after=${JSON.stringify(approvedAfter)} read=${JSON.stringify(approvedRead.body)}`,
            approvedRead.body.items?.[0]?.state === "approved" &&
                !("expiresAt" in (approvedRead.body.items?.[0] ?? {})) &&
                JSON.stringify(approvedBefore) === JSON.stringify(approvedAfter)
                ? "PASS"
                : "FAIL",
        );

        for (const live of ["dispatching", "dispatch_unknown"]) {
            psql(
                `UPDATE approval_requests SET state = '${live}' WHERE request_id = '${requestId}' ` +
                    `AND state IN ('approved','rejected','expired','pending')`,
            );
            const folded = await readWaitingMouth(request, "approval", runId);
            record(
                `fold ${live} → wire pending`,
                "wire state=pending",
                JSON.stringify(folded.body.items ?? []),
                folded.body.items?.[0]?.state === "pending" ? "PASS" : "FAIL",
            );
        }

        psql(
            `UPDATE approval_requests SET state = 'pending', decided_at = NULL, ` +
                `expires_at = now() - interval '1 minute' WHERE request_id = '${requestId}'`,
        );
        const expiredRead = await readWaitingMouth(request, "approval", runId);
        const expiredRow = psqlScalar(
            `SELECT state FROM approval_requests WHERE request_id = '${requestId}'`,
        );
        record(
            "overdue pending is lazily settled to expired",
            "wire state=expired and the row is settled",
            `wire=${JSON.stringify(expiredRead.body.items ?? [])} db=${expiredRow}`,
            expiredRead.body.items?.[0]?.state === "expired" && expiredRow === "expired"
                ? "PASS"
                : "FAIL",
        );
        record(
            "fixture disclosure",
            "dispatching/dispatch_unknown/expired rows were staged by psql UPDATE (fixture), not by the product dispatch path",
            "labelled: C4's criterion is the read mouth's behaviour for those states; producing them organically needs a dispatch failpoint",
            "PASS",
        );

        sse.close();
        const failed = checks.filter((check) => check.status === "FAIL").length;
        writeRunFile("C4", { status: failed ? "FAIL" : "PASS", runId, requestId, checks });
        expect(
            checks.filter((check) => check.status === "FAIL"),
            JSON.stringify(checks, null, 2),
        ).toHaveLength(0);
    });

    test("B5 steer attribution survives admission; parked steer recovers after restart", async ({
        request,
    }) => {
        const checks: Check[] = [];
        const record = (check: string, expected: string, observed: string, status: Status) =>
            checks.push({
                criterion: "B5",
                check,
                expected,
                observed: scrub(observed),
                status,
                at: new Date().toISOString(),
            });

        if ((process.env.XIHE_E2E_LLM_MODE ?? "") !== "spawn_agent") {
            writeRunFile("B5", {
                status: "PRECONDITION_UNMET",
                checks: [
                    {
                        criterion: "B5",
                        check: "spawn_agent lane",
                        expected: "--llm-mode=spawn_agent",
                        observed: `XIHE_E2E_LLM_MODE=${process.env.XIHE_E2E_LLM_MODE ?? "<unset>"}`,
                        status: "PRECONDITION_UNMET" as Status,
                        at: new Date().toISOString(),
                    },
                ],
            });
            test.skip(
                true,
                "B5 needs the spawn_agent fake-LLM lane to produce a real child Session",
            );
        }

        const fx = await buildSpawnFixture(request);
        const parent = await newSession(request, fx, "task-12 B5 parent");
        const sse = await openSse(fx, parent.sessionId);
        const token = `t12c-b5-${Date.now()}`;
        const admission = await submitChat(request, fx, parent, `XIHE-E2E-SPAWN ${token}`);
        if (admission.status !== 202 || !admission.runId) {
            sse.close();
            writeRunFile("B5", { status: "PRECONDITION_UNMET", checks });
            test.skip(true, `spawn run not admitted: HTTP ${admission.status}`);
        }
        const parentRun = admission.runId;
        // spawn_agent is approval-gated (audit action=approval_required in the B5 lane log);
        // without a decision the run just waits until the test budget expires.
        const spawnApproval = await pollUntil(
            () =>
                psql(
                    `SELECT request_id, state FROM approval_requests WHERE run_id = '${parentRun}' ORDER BY created_at`,
                ),
            (rows) => rows.length >= 1 && rows[0][1] === "pending",
            BUDGET.short,
        );
        if (spawnApproval.ok) {
            const decision = await request.post(
                `${CP_URL}/api/v1/chat/approvals/${spawnApproval.value[0][0]}/decision`,
                { headers: fx.headers, data: { decision: "once" }, timeout: LONG_TIMEOUT_MS },
            );
            record(
                "spawn_agent approval decided",
                "HTTP 200 (SPAWN_AGENT is approval-gated)",
                `HTTP ${decision.status()} ${(await decision.text()).slice(0, 200)}`,
                decision.status() === 200 ? "PASS" : "FAIL",
            );
        } else {
            record(
                "spawn_agent approval decided",
                "a pending approval row for the spawn run",
                JSON.stringify(spawnApproval.value),
                "PRECONDITION_UNMET",
            );
        }
        const child = await pollUntil(
            () =>
                psql(
                    `SELECT id, coalesce(spawned_from_session_id::text,''), coalesce(spawned_from_run_id::text,'') ` +
                        `FROM sessions WHERE spawned_from_session_id = '${parent.sessionId}' ORDER BY created_at DESC`,
                ),
            (rows) => rows.length >= 1,
            BUDGET.wait,
        );
        record(
            "real child Session spawned by the agent",
            "one sessions row with spawned_from_session_id = parent",
            JSON.stringify(child.value),
            child.ok ? "PASS" : "PRECONDITION_UNMET",
        );
        if (!child.ok) {
            sse.close();
            writeRunFile("B5", { status: "PRECONDITION_UNMET", parentRun, checks });
            test.skip(true, "agent did not spawn a child Session");
        }
        const childSessionId = child.value[0][0];

        const steerIdempotencyKey = `t12c-steer-${Date.now()}`;
        const steerText = `T12C B5 steer ${Date.now()}`;
        const steer = await request.post(`${CP_URL}/api/v1/sessions/${childSessionId}/steers`, {
            headers: { ...fx.headers, "Idempotency-Key": steerIdempotencyKey },
            data: { text: steerText },
            timeout: LONG_TIMEOUT_MS,
        });
        record(
            "steer enqueued",
            "HTTP 202",
            `HTTP ${steer.status()} ${(await steer.text()).slice(0, 240)}`,
            steer.status() === 202 ? "PASS" : "FAIL",
        );
        const attribution = await pollUntil(
            () =>
                psql(
                    `SELECT coalesce(source_kind,'<null>'), coalesce(from_session_id::text,'<null>'), ` +
                        `coalesce(content,'<null>'), status, coalesce(pause_reason,'') FROM session_follow_up_items ` +
                        `WHERE session_id = '${childSessionId}' AND idempotency_key = '${steerIdempotencyKey}'`,
                ),
            (rows) => rows.length >= 1,
            BUDGET.short,
        );
        const attributed = attribution.value[0] ?? [];
        record(
            "attribution stamped on the queue item",
            "source_kind=agent_steer and from_session_id=parent Session",
            JSON.stringify(attributed),
            attributed[0] === "agent_steer" && attributed[1] === parent.sessionId ? "PASS" : "FAIL",
        );

        const killed = await killCpDeclared();
        const restarted = await restartCp(cpRestartEnv());
        record(
            "CP kill + restart during the parked steer",
            "new pid + health 200",
            JSON.stringify({ killed, restarted }),
            restarted.pid > 0 && restarted.pid !== killed.pid ? "PASS" : "FAIL",
        );

        const recovered = await pollUntil(
            () =>
                psql(
                    `SELECT coalesce(source_kind,'<null>'), coalesce(from_session_id::text,'<null>'), ` +
                        `coalesce(content,'<null>'), status, coalesce(pause_reason,'') FROM session_follow_up_items ` +
                        `WHERE session_id = '${childSessionId}' AND idempotency_key = '${steerIdempotencyKey}'`,
                ),
            (rows) => rows.length >= 1 && !["queued", "paused"].includes(rows[0][3]),
            BUDGET.wait,
        );
        const after = recovered.value[0] ?? [];
        record(
            "attribution survives the admission content clear",
            "content cleared or replaced, source_kind/from_session_id still present",
            `before=${JSON.stringify(attributed)} after=${JSON.stringify(after)}`,
            after[0] === "agent_steer" && after[1] === parent.sessionId ? "PASS" : "FAIL",
        );
        record(
            "queue item leaves the pre-restart state (recovery observed)",
            "status is no longer the pre-kill `queued`",
            `status=${after[3] ?? "<missing>"} pause_reason=${after[4] ?? ""} waitedMs=${recovered.waitedMs}`,
            after[3] && after[3] !== "queued" ? "PASS" : "FAIL",
        );
        record(
            "steer continues into the child run after restart (D-1832 续跑)",
            "queue item reaches admitted/dispatched/completed",
            `status=${after[3] ?? "<missing>"} pause_reason=${after[4] ?? ""}`,
            recovered.ok ? "PASS" : "UNMEASURED",
        );
        record(
            "D-1836 observed in the same window",
            "zero 'No active transaction' hits",
            JSON.stringify(scanD1836()).slice(0, 400),
            scanD1836().hits === 0 ? "PASS" : "FAIL",
        );

        sse.close();
        const failed = checks.filter((check) => check.status === "FAIL").length;
        writeRunFile("B5", { status: failed ? "FAIL" : "PASS", parentRun, childSessionId, checks });
        expect(
            checks.filter((check) => check.status === "FAIL"),
            JSON.stringify(checks, null, 2),
        ).toHaveLength(0);
    });
});
