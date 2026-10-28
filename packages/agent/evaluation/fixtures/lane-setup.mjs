#!/usr/bin/env node
// PLAN-0540 T3.0: deterministic evaluation lane lifecycle (setup / teardown / status / run).
//
// The lane is local and deterministic, not offline: it still needs a live CP,
// Agent and Runtime. It swaps the instance LLM profile to a loopback fake LLM,
// registers the PLAN-0532 MCP fixture through the CP OAuth broker, and restores
// every mutation on teardown.
//
// Safety:
//   - admin password only from XIHE_DEV_ADMIN_PASSWORD; no token/password is
//     written to state, stdout, argv or logs.
//   - fixtures are stopped only when the health-reported pid matches the pid
//     recorded by this lane; a foreign process on a fixture port aborts setup.
//   - teardown restores the instance profile before deleting the connection
//     (delete runs cleanupProfiles), deletes eval sessions before it, and leaves
//     a tornDown state file for the next setup.
//
// Env (all optional except the password):
//   XIHE_EVAL_CP_URL             default http://127.0.0.1:12651 (stack-3)
//   XIHE_DEV_ADMIN_PASSWORD      required for setup/teardown/run
//   XIHE_EVAL_ADMIN_EMAIL        default admin@xihe.local
//   XIHE_STACK_ID                default stack-3 (labels the state file only)
//   XIHE_EVAL_PG_CONTAINER       default xihe-stack-3-postgres-1
//   XIHE_EVAL_PG_USER            default xihe
//   XIHE_EVAL_PG_DB              default xihe_3
//   XIHE_EVAL_LLM_PORT           default 12762
//   XIHE_EVAL_OAUTH_PORT         default 12763
//   XIHE_EVAL_MCP_PORT           default 12761
//   XIHE_EVAL_LLM_MODEL          default eval-fake-model
//   XIHE_EVAL_CONNECTION_KEY     default eval-fake-llm
//   XIHE_EVAL_PRINCIPAL_NAME     default eval0540-agent
//   XIHE_EVAL_RUN_MAX_TURNS      default 2
//   XIHE_EVAL_STATE_FILE         default <repo>/.local/evaluation/lane-state.json
//   XIHE_EVAL_REAL_PROVIDER      default xiaomi (behavior lane)
//   XIHE_EVAL_REAL_CONNECTION_KEY default default
//   XIHE_EVAL_REAL_MODEL         default mimo-v2.6-flash
//   XIHE_EVAL_REAL_BASE_URL      default https://api.xiaomimimo.com/v1
//   XIHE_XIAOMI_API_KEY          required when behavior-setup creates the connection
//
// Usage:
//   node packages/agent/evaluation/fixtures/lane-setup.mjs setup
//   node packages/agent/evaluation/fixtures/lane-setup.mjs behavior-setup
//   node packages/agent/evaluation/fixtures/lane-setup.mjs status
//   node packages/agent/evaluation/fixtures/lane-setup.mjs run --lane invariant --rounds 3
//   node packages/agent/evaluation/fixtures/lane-setup.mjs teardown

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(FIXTURES_DIR, "../../../..");
const LOG_DIR = join(REPO_ROOT, ".local", "evaluation", "logs");
const DEFAULT_STATE_FILE = join(REPO_ROOT, ".local", "evaluation", "lane-state.json");

const envValue = (name, fallback) => {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
};

const CFG = {
    cpUrl: envValue("XIHE_EVAL_CP_URL", "http://127.0.0.1:12651").replace(/\/$/, ""),
    adminEmail: envValue("XIHE_EVAL_ADMIN_EMAIL", "admin@xihe.local"),
    stackId: envValue("XIHE_STACK_ID", "stack-3"),
    pgContainer: envValue("XIHE_EVAL_PG_CONTAINER", "xihe-stack-3-postgres-1"),
    pgUser: envValue("XIHE_EVAL_PG_USER", "xihe"),
    pgDb: envValue("XIHE_EVAL_PG_DB", "xihe_3"),
    llmPort: Number(envValue("XIHE_EVAL_LLM_PORT", "12762")),
    oauthPort: Number(envValue("XIHE_EVAL_OAUTH_PORT", "12763")),
    mcpPort: Number(envValue("XIHE_EVAL_MCP_PORT", "12761")),
    model: envValue("XIHE_EVAL_LLM_MODEL", "eval-fake-model"),
    llmBaseUrl: `http://127.0.0.1:${Number(envValue("XIHE_EVAL_LLM_PORT", "12762"))}/v1`,
    connectionKey: envValue("XIHE_EVAL_CONNECTION_KEY", "eval-fake-llm"),
    principalName: envValue("XIHE_EVAL_PRINCIPAL_NAME", "eval0540-agent"),
    runMaxTurns: Number(envValue("XIHE_EVAL_RUN_MAX_TURNS", "2")),
    stateFile: envValue("XIHE_EVAL_STATE_FILE", DEFAULT_STATE_FILE),
    providerId: "custom-openai-compatible",
    apiTypeId: "openai-chat-completions",
    apiTypeVersion: 1,
    mcpServerId: "11111111-1111-4111-8111-111111111111",
    mcpClientId: "xihe-eval-client",
    mcpScope: "mcp:tools",
    runMaxTurnsDefault: "25",
};

// The behavior lane needs a live model; the invariant lane never does. Both
// profiles are instance-level, so only one lane can be armed at a time.
const REAL = {
    providerId: envValue("XIHE_EVAL_REAL_PROVIDER", "xiaomi"),
    connectionKey: envValue("XIHE_EVAL_REAL_CONNECTION_KEY", "default"),
    model: envValue("XIHE_EVAL_REAL_MODEL", "mimo-v2.6-flash"),
    apiTypeId: envValue("XIHE_EVAL_REAL_API_TYPE", "mimo-responses"),
    apiTypeVersion: Number(envValue("XIHE_EVAL_REAL_API_TYPE_VERSION", "1")),
    baseUrl: envValue("XIHE_EVAL_REAL_BASE_URL", "https://api.xiaomimimo.com/v1"),
    apiKeyEnv: "XIHE_XIAOMI_API_KEY",
};

const EVAL_PROFILE_JSON = JSON.stringify({
    providerId: CFG.providerId,
    connectionKey: CFG.connectionKey,
    model: CFG.model,
});

const REAL_PROFILE_JSON = JSON.stringify({
    providerId: REAL.providerId,
    connectionKey: REAL.connectionKey,
    model: REAL.model,
});

const FIXTURE_SCRIPTS = {
    llm: "fake-llm-server.mjs",
    oauth: "oauth-fixture-server.mjs",
    mcp: "mcp-fixture-server.mjs",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const log = (message) => console.error(`[lane] ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function assertUuid(value, what) {
    if (!UUID_PATTERN.test(String(value ?? ""))) {
        throw new Error(`${what} is not a UUID: ${JSON.stringify(value)}`);
    }
    return String(value);
}

function sqlLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

// ── state ────────────────────────────────────────────────────────────────

function freshState() {
    return {
        schemaVersion: 1,
        stackId: CFG.stackId,
        cpUrl: CFG.cpUrl,
        workspaceId: null,
        adminUserId: null,
        principalId: null,
        fixtureSecret: null,
        fixtures: {},
        connection: null,
        realProvider: null,
        oauth: null,
        original: { profile: null, runMaxTurns: null },
        grants: { admin: null, principal: null },
        setupAt: null,
        tornDown: true,
    };
}

function loadState() {
    try {
        const parsed = JSON.parse(readFileSync(CFG.stateFile, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
        if (error && error.code === "ENOENT") return null;
        throw new Error(`cannot read state file ${CFG.stateFile}: ${error.message}`);
    }
}

function saveState(state) {
    mkdirSync(dirname(CFG.stateFile), { recursive: true });
    const temp = `${CFG.stateFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temp, CFG.stateFile);
}

// ── HTTP ─────────────────────────────────────────────────────────────────

async function http(method, path, { token, body, timeoutMs = 20000, redirect = "follow" } = {}) {
    const url = path.startsWith("http") ? path : `${CFG.cpUrl}${path}`;
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { status: response.status, headers: response.headers, json, text, url };
}

function check(response, what) {
    if (response.status >= 200 && response.status < 300) return response;
    const detail = response.json?.detail ?? response.json?.title ?? response.text.slice(0, 240);
    const code = response.json?.code ? ` ${response.json.code}` : "";
    throw new Error(`${what} failed: HTTP ${response.status}${code} ${detail}`.trim());
}

async function login({ retries = 45, delayMs = 2000 } = {}) {
    const password = process.env.XIHE_DEV_ADMIN_PASSWORD;
    if (!password) {
        throw new Error("XIHE_DEV_ADMIN_PASSWORD is required (read from env only)");
    }
    let last = "";
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            const response = await http("POST", "/api/v1/auth/login", {
                body: { identifier: CFG.adminEmail, password },
                timeoutMs: 5000,
            });
            if (response.status === 200 && response.json?.accessToken) {
                return {
                    token: response.json.accessToken,
                    userId: response.json.user?.id,
                    workspaceId: response.json.workspaceId,
                };
            }
            last = `HTTP ${response.status}${response.json?.code ? ` ${response.json.code}` : ""}`;
            if (response.status === 400 || response.status === 401) {
                throw new Error(`admin login rejected (${last}); check XIHE_EVAL_ADMIN_EMAIL / XIHE_DEV_ADMIN_PASSWORD`);
            }
        } catch (error) {
            if (error.message.startsWith("admin login rejected")) throw error;
            last = error.name === "TimeoutError" ? "timeout" : error.message;
        }
        if (attempt < retries) await sleep(delayMs);
    }
    throw new Error(`CP ${CFG.cpUrl} not reachable for login after ${retries * delayMs}ms (last: ${last})`);
}

const cp = (session, method, path, options = {}) => http(method, path, { ...options, token: session.token });

// ── fixtures ─────────────────────────────────────────────────────────────

async function probeHealth(port, timeoutMs = 800) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        const body = await response.json().catch(() => null);
        return body && typeof body === "object" ? body : null;
    } catch {
        return null;
    }
}

function fixtureSpecs(secret) {
    // CP accepts plain http for a remote MCP endpoint only when the host is
    // `host.docker.internal` (OAuthCredentialService.validateEndpoint). On a
    // native Windows host that name resolves to the machine's LAN address via
    // the hosts file, so the fixture must listen beyond loopback. The endpoint
    // still requires the lane's Bearer secret.
    const remoteBind = process.env.XIHE_EVAL_MCP_BIND ?? "0.0.0.0";
    return [
        {
            name: "llm",
            port: CFG.llmPort,
            env: { XIHE_EVAL_LLM_PORT: String(CFG.llmPort), XIHE_EVAL_LLM_BIND: "127.0.0.1" },
        },
        {
            name: "oauth",
            port: CFG.oauthPort,
            env: {
                XIHE_EVAL_OAUTH_PORT: String(CFG.oauthPort),
                XIHE_EVAL_OAUTH_BIND: "127.0.0.1",
                XIHE_EVAL_MCP_ACCESS_TOKEN: secret,
            },
        },
        {
            name: "mcp",
            port: CFG.mcpPort,
            env: {
                XIHE_EVAL_MCP_PORT: String(CFG.mcpPort),
                XIHE_EVAL_MCP_BIND: remoteBind,
                XIHE_EVAL_MCP_ACCESS_TOKEN: secret,
            },
        },
    ];
}

async function waitForHealth(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const health = await probeHealth(port);
        if (health) return health;
        await sleep(250);
    }
    throw new Error(`fixture on port ${port} did not become healthy within ${timeoutMs}ms`);
}

function startFixtureProcess(spec) {
    mkdirSync(LOG_DIR, { recursive: true });
    const logPath = join(LOG_DIR, `${spec.name}.log`);
    const fd = openSync(logPath, "a");
    const child = spawn(process.execPath, [join(FIXTURES_DIR, FIXTURE_SCRIPTS[spec.name])], {
        env: { ...process.env, ...spec.env },
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
    });
    child.unref();
    closeSync(fd);
    return logPath;
}

async function startFixture(state, spec) {
    const logPath = startFixtureProcess(spec);
    const health = await waitForHealth(spec.port, 15000);
    if (!health.pid) throw new Error(`fixture ${spec.name} health has no pid`);
    state.fixtures[spec.name] = {
        pid: health.pid,
        port: spec.port,
        startedAt: new Date().toISOString(),
    };
    saveState(state);
    log(`fixture ${spec.name} ready pid=${health.pid} port=${spec.port} log=${logPath}`);
}

async function stopFixture(state, spec) {
    const health = await probeHealth(spec.port);
    const record = state.fixtures[spec.name];
    if (!health) {
        delete state.fixtures[spec.name];
        saveState(state);
        return;
    }
    if (!record || record.pid !== health.pid) {
        throw new Error(
            `refusing to stop ${spec.name} on port ${spec.port}: health pid ${health.pid} is not owned by this lane`,
        );
    }
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(health.pid), "/T", "/F"], { timeout: 15000 });
    } else {
        try {
            process.kill(health.pid, "SIGTERM");
        } catch {
            // already gone
        }
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && (await probeHealth(spec.port))) await sleep(250);
    if (await probeHealth(spec.port)) {
        throw new Error(`fixture ${spec.name} on port ${spec.port} did not stop`);
    }
    delete state.fixtures[spec.name];
    saveState(state);
    log(`fixture ${spec.name} stopped`);
}

async function ensureFixtures(state) {
    if (!state.fixtureSecret) {
        state.fixtureSecret = randomBytes(24).toString("hex");
        saveState(state);
    }
    const specs = fixtureSpecs(state.fixtureSecret);
    const health = {};
    for (const spec of specs) health[spec.name] = await probeHealth(spec.port);

    for (const spec of specs) {
        if (!health[spec.name]) continue;
        const record = state.fixtures[spec.name];
        if (!record || record.pid !== health[spec.name].pid) {
            throw new Error(
                `port ${spec.port} (${spec.name} fixture) is already used by pid ${health[spec.name].pid}; ` +
                    "stop that process or point this lane at other ports",
            );
        }
    }

    // oauth and mcp must share one access token, so a half-alive pair is restarted whole.
    if (Boolean(health.oauth) !== Boolean(health.mcp)) {
        for (const name of ["oauth", "mcp"]) {
            if (!health[name]) continue;
            await stopFixture(state, specs.find((spec) => spec.name === name));
            health[name] = null;
        }
    }

    for (const spec of specs) {
        if (health[spec.name]) {
            log(`fixture ${spec.name} adopted pid=${health[spec.name].pid} port=${spec.port}`);
            continue;
        }
        await startFixture(state, spec);
    }
}

// ── CP seeding ───────────────────────────────────────────────────────────

function psql(sql) {
    const result = spawnSync(
        "docker",
        ["exec", CFG.pgContainer, "psql", "-U", CFG.pgUser, "-d", CFG.pgDb, "-tAc", sql],
        { encoding: "utf8", timeout: 30000 },
    );
    if (result.error) throw new Error(`psql failed: ${result.error.message}`);
    if (result.status !== 0) {
        throw new Error(`psql failed: ${(result.stderr || "").trim().slice(0, 300)}`);
    }
    return result.stdout.trim();
}

/** psql prints the command tag (`INSERT 0 1`) after RETURNING rows; keep the id line. */
function firstUuid(output, label) {
    const id = output.split(/\r?\n/).map((line) => line.trim()).find((line) => UUID_PATTERN.test(line));
    if (!id) throw new Error(`${label}: psql returned no UUID (${output.slice(0, 120)})`);
    return id;
}

const ADMIN_TOOL_ATOMS = [
    { actionClass: "CREATE_ACCOUNT", resource: "*" },
    { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: "*" },
];

const PRINCIPAL_TOOL_ATOMS = [
    { actionClass: "read", resource: "*" },
    { actionClass: "write", resource: "*" },
];

function ensureGrant(state, slot, subjectType, subjectId, atoms) {
    if (state.grants[slot]) {
        const row = psql(
            `SELECT id FROM grants WHERE id=${sqlLiteral(state.grants[slot].id)} AND source='direct' LIMIT 1;`,
        );
        if (row) return;
        state.grants[slot] = null;
        saveState(state);
    }
    assertUuid(subjectId, `${slot} grant subject`);
    assertUuid(state.adminUserId, "admin user id");
    const permissions = JSON.stringify(atoms).replace(/'/g, "''");
    const existing = psql(
        `SELECT id FROM grants WHERE subject_type=${sqlLiteral(subjectType)} ` +
            `AND subject_id=${sqlLiteral(subjectId)} AND source='direct' ` +
            `AND permissions @> '${permissions}'::jsonb LIMIT 1;`,
    );
    if (existing) {
        state.grants[slot] = { id: existing, preExisting: true };
        saveState(state);
        log(`${slot} grant already present (left in place on teardown)`);
        return;
    }
    const id = firstUuid(
        psql(
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source) ` +
                `VALUES (gen_random_uuid(), 'user', ${sqlLiteral(state.adminUserId)}, ` +
                `${sqlLiteral(subjectType)}, ${sqlLiteral(subjectId)}, '${permissions}'::jsonb, 'direct') RETURNING id;`,
        ),
        `${slot} grant insert`,
    );
    state.grants[slot] = { id, preExisting: false };
    saveState(state);
    log(`seeded ${slot} direct grant`);
}

function deleteGrant(state, slot) {
    const grant = state.grants[slot];
    if (!grant || grant.preExisting) return false;
    assertUuid(grant.id, `${slot} grant id`);
    psql(`DELETE FROM grants WHERE id=${sqlLiteral(grant.id)} AND source='direct';`);
    state.grants[slot] = null;
    saveState(state);
    log(`deleted ${slot} direct grant`);
    return true;
}

async function ensureAdminGrant(state) {
    ensureGrant(state, "admin", "user", state.adminUserId, ADMIN_TOOL_ATOMS);
}

/** Agent principals have no delete API; rebind an earlier lane row before creating a new one. */
function findUnboundPrincipalId() {
    const output = psql(
        `SELECT id FROM agent_principals WHERE name=${sqlLiteral(CFG.principalName)} ORDER BY created_at LIMIT 1;`,
    );
    const id = output.split(/\r?\n/).map((line) => line.trim()).find((line) => UUID_PATTERN.test(line));
    return id ?? null;
}

async function ensurePrincipal(state, session) {
    if (state.principalId) return state.principalId;
    const list = check(
        await cp(session, "GET", `/api/v1/workspaces/${state.workspaceId}/agents`),
        "list workspace agents",
    ).json;
    const existing = Array.isArray(list) ? list.find((item) => item.name === CFG.principalName) : null;
    if (existing?.principalId) {
        state.principalId = existing.principalId;
        saveState(state);
        log(`principal adopted ${state.principalId}`);
        return state.principalId;
    }
    const recycled = findUnboundPrincipalId();
    if (recycled) {
        state.principalId = recycled;
        saveState(state);
        log(`principal recycled ${recycled}`);
        return recycled;
    }
    const created = check(
        await cp(session, "POST", "/api/v1/agent-principals", { body: { name: CFG.principalName } }),
        "create principal",
    ).json;
    state.principalId = assertUuid(created.principalId, "created principal");
    saveState(state);
    log(`principal created ${state.principalId}`);
    return state.principalId;
}

async function ensurePrincipalBinding(state, session, principalId) {
    check(
        await cp(session, "PUT", `/api/v1/workspaces/${state.workspaceId}/agents/${principalId}`, {
            body: { permissions: PRINCIPAL_TOOL_ATOMS },
        }),
        "bind principal workspace cap",
    );
    log("principal workspace cap = read+write");
}

async function ensureToolFace(state, session) {
    check(
        await cp(session, "POST", "/api/v1/policy/tool-faces", {
            body: { scope: "workspace", tool: "always_failing", actionClass: "read", shape: "structured" },
        }),
        "upsert always_failing tool face",
    );
    log("tool face always_failing => read/structured");
}

async function listConnections(session) {
    const body = check(await cp(session, "GET", "/api/v1/provider-connections"), "list connections").json;
    return Array.isArray(body?.connections) ? body.connections : [];
}

async function verifyConnection(state, session) {
    const result = check(
        await cp(session, "POST", `/api/v1/provider-connections/${state.connection.id}/verify`),
        "verify connection",
    ).json;
    const status = result?.connection?.status;
    if (status !== "READY") {
        throw new Error(`connection ${state.connection.id} is ${status ?? "unknown"}, expected READY`);
    }
    log(`connection ready ${state.connection.id}`);
}

/** Deleting a connection is blocked while any session still references it. */
async function deleteOwnedConnection(session, id, label) {
    const deadline = Date.now() + 30000;
    let last = "";
    while (Date.now() < deadline) {
        const response = await cp(session, "DELETE", `/api/v1/provider-connections/${id}`);
        if (response.status === 204 || response.status === 404) {
            log(`${label} deleted`);
            return;
        }
        last = `HTTP ${response.status}`;
        if (response.json?.code !== "CONNECTION_IN_USE") {
            throw new Error(`${label} delete failed: ${last} ${response.json?.detail ?? ""}`);
        }
        await sleep(2000);
    }
    throw new Error(`${label} delete still blocked after 30s (${last})`);
}

async function ensureConnection(state, session) {
    const knownId = state.connection?.id;
    const connections = await listConnections(session);
    if (knownId) {
        const found = connections.find((item) => item.id === knownId);
        if (found) {
            if (found.status !== "READY") await verifyConnection(state, session);
            else log(`connection adopted ${knownId}`);
            return;
        }
        state.connection = null;
        saveState(state);
    }

    const existing = connections.find(
        (item) =>
            item.connectionKey === CFG.connectionKey &&
            item.scope === "WORKSPACE" &&
            item.providerId === CFG.providerId,
    );
    if (existing) {
        const matches =
            existing.baseUrl === CFG.llmBaseUrl &&
            existing.modelDiscovery === "manual" &&
            Array.isArray(existing.manualModels) &&
            existing.manualModels.includes(CFG.model);
        if (!matches) {
            throw new Error(
                `connection ${CFG.connectionKey} already exists with a different config ` +
                    `(baseUrl=${existing.baseUrl}); remove it or set XIHE_EVAL_CONNECTION_KEY`,
            );
        }
        state.connection = { id: existing.id, key: CFG.connectionKey, createdBySetup: false };
        saveState(state);
        log(`connection adopted ${existing.id} (pre-existing, kept on teardown)`);
        if (existing.status !== "READY") await verifyConnection(state, session);
        return;
    }

    const created = check(
        await cp(session, "POST", "/api/v1/provider-connections", {
            body: {
                providerId: CFG.providerId,
                label: `PLAN-0540 eval fake LLM (${CFG.stackId})`,
                scope: "WORKSPACE",
                baseUrl: CFG.llmBaseUrl,
                modelDiscovery: "manual",
                manualModels: [CFG.model],
                enabled: true,
                connectionKey: CFG.connectionKey,
                apiTypeId: CFG.apiTypeId,
                apiTypeVersion: CFG.apiTypeVersion,
            },
        }),
        "create connection",
    ).json;
    state.connection = {
        id: assertUuid(created.id, "created connection"),
        key: CFG.connectionKey,
        createdBySetup: true,
    };
    saveState(state);
    log(`connection created ${state.connection.id}`);
    await verifyConnection(state, session);
}

async function verifyRealConnection(state, session) {
    const result = check(
        await cp(session, "POST", `/api/v1/provider-connections/${state.realProvider.id}/verify`),
        "verify real connection",
    ).json;
    const status = result?.connection?.status;
    if (status !== "READY") {
        throw new Error(`real connection ${state.realProvider.id} is ${status ?? "unknown"}, expected READY`);
    }
    log(`real connection ready ${state.realProvider.id}`);
}

/** The behavior lane uses a real provider; 0532's connection was deleted at cleanup. */
async function ensureRealConnection(state, session) {
    const knownId = state.realProvider?.id;
    const connections = await listConnections(session);
    if (knownId) {
        const found = connections.find((item) => item.id === knownId);
        if (found) {
            if (found.status !== "READY") await verifyRealConnection(state, session);
            else log(`real connection adopted ${knownId}`);
            return;
        }
        state.realProvider = null;
        saveState(state);
    }

    const existing = connections.find(
        (item) =>
            item.connectionKey === REAL.connectionKey &&
            item.scope === "WORKSPACE" &&
            item.providerId === REAL.providerId,
    );
    if (existing) {
        state.realProvider = {
            id: existing.id,
            key: REAL.connectionKey,
            providerId: REAL.providerId,
            model: REAL.model,
            createdBySetup: false,
        };
        saveState(state);
        log(`real connection adopted ${existing.id} (pre-existing, kept on teardown)`);
        if (existing.status !== "READY") await verifyRealConnection(state, session);
        return;
    }

    const apiKey = process.env[REAL.apiKeyEnv];
    if (!apiKey) {
        throw new Error(`${REAL.apiKeyEnv} is required to create the ${REAL.providerId} connection (env only)`);
    }
    const created = check(
        await cp(session, "POST", "/api/v1/provider-connections", {
            body: {
                providerId: REAL.providerId,
                label: `PLAN-0540 behavior lane (${CFG.stackId})`,
                scope: "WORKSPACE",
                apiKey,
                baseUrl: REAL.baseUrl,
                modelDiscovery: "manual",
                manualModels: [REAL.model],
                enabled: true,
                connectionKey: REAL.connectionKey,
                apiTypeId: REAL.apiTypeId,
                apiTypeVersion: REAL.apiTypeVersion,
            },
        }),
        "create real connection",
    ).json;
    state.realProvider = {
        id: assertUuid(created.id, "created real connection"),
        key: REAL.connectionKey,
        providerId: REAL.providerId,
        model: REAL.model,
        createdBySetup: true,
    };
    saveState(state);
    log(`real connection created ${state.realProvider.id}`);
    await verifyRealConnection(state, session);
}

// ── config ───────────────────────────────────────────────────────────────

async function readLayer(session, layer, domain) {
    const body = check(
        await cp(session, "GET", `/api/v1/config/${domain}?layer=${layer}`),
        `read ${layer}/${domain}`,
    ).json;
    return body && typeof body === "object" ? body : {};
}

const isEvalProfile = (raw) => {
    try {
        const value = JSON.parse(raw);
        return (
            value?.providerId === CFG.providerId &&
            value?.connectionKey === CFG.connectionKey &&
            value?.model === CFG.model
        );
    } catch {
        return false;
    }
};

const isRealProfile = (raw) => {
    try {
        const value = JSON.parse(raw);
        return (
            value?.providerId === REAL.providerId &&
            value?.connectionKey === REAL.connectionKey &&
            value?.model === REAL.model
        );
    } catch {
        return false;
    }
};

async function captureOriginals(state, session) {
    if (!state.original.profile) {
        const entries = await readLayer(session, "instance", "llm-provider");
        const current = entries.profile;
        state.original.profile =
            current && !isEvalProfile(current) ? { had: true, value: current } : { had: false };
        saveState(state);
        log(
            state.original.profile.had
                ? "captured original instance llm-provider profile"
                : "no original instance llm-provider profile",
        );
    }
    if (!state.original.runMaxTurns) {
        const entries = await readLayer(session, "workspace", "agent-runtime");
        const current = entries.runMaxTurns;
        state.original.runMaxTurns =
            current && current !== String(CFG.runMaxTurns) ? { had: true, value: current } : { had: false };
        saveState(state);
        log(
            state.original.runMaxTurns.had
                ? `captured original workspace runMaxTurns=${state.original.runMaxTurns.value}`
                : "no original workspace runMaxTurns override",
        );
    }
}

async function applyLaneConfig(state, session) {
    check(
        await cp(session, "PUT", "/api/v1/config/instance/llm-provider", {
            body: { profile: EVAL_PROFILE_JSON },
        }),
        "switch instance llm-provider profile",
    );
    log(`instance profile => ${CFG.providerId}/${CFG.connectionKey}/${CFG.model}`);

    check(
        await cp(session, "PUT", "/api/v1/config/workspace/agent-runtime", {
            body: { runMaxTurns: String(CFG.runMaxTurns) },
        }),
        "set workspace runMaxTurns",
    );
    log(`workspace runMaxTurns => ${CFG.runMaxTurns}`);
}

async function applyRealProfile(session) {
    check(
        await cp(session, "PUT", "/api/v1/config/instance/llm-provider", {
            body: { profile: REAL_PROFILE_JSON },
        }),
        "switch instance llm-provider profile to real provider",
    );
    log(`instance profile => ${REAL.providerId}/${REAL.connectionKey}/${REAL.model}`);
}

async function waitForAgentReady(session, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let last = "unknown";
    while (Date.now() < deadline) {
        try {
            const body = check(await cp(session, "GET", "/api/v1/status"), "read status").json;
            const agent = body?.services?.find((service) => service.key === "agent");
            last = agent?.llmReady ?? "missing";
            if (agent?.status === "up" && last === "ready") {
                log(`agent llmReady=${last}`);
                return;
            }
        } catch (error) {
            last = error.message;
        }
        await sleep(2000);
    }
    throw new Error(`agent did not report llmReady=ready within ${timeoutMs}ms (last: ${last})`);
}

// ── remote MCP ───────────────────────────────────────────────────────────

async function authorizeRemoteMcp(state, session) {
    const started = check(
        await cp(session, "POST", "/api/v1/oauth/sessions", {
            body: {
                workspaceId: state.workspaceId,
                serverId: CFG.mcpServerId,
                remoteEndpoint: `http://host.docker.internal:${CFG.mcpPort}/mcp`,
                clientId: CFG.mcpClientId,
                authorizationEndpoint: `http://127.0.0.1:${CFG.oauthPort}/authorize`,
                tokenEndpoint: `http://127.0.0.1:${CFG.oauthPort}/token`,
                redirectUri: `${CFG.cpUrl}/api/v1/oauth/callback`,
                scope: CFG.mcpScope,
            },
        }),
        "start oauth session",
    ).json;
    if (!started?.authorizationUrl) throw new Error("oauth session returned no authorizationUrl");

    const authorize = await http("GET", started.authorizationUrl, { redirect: "manual", timeoutMs: 15000 });
    const location = authorize.headers.get("location");
    if (!location) throw new Error(`oauth authorize did not redirect (HTTP ${authorize.status})`);
    const callback = await http("GET", new URL(location, started.authorizationUrl).toString(), {
        redirect: "manual",
        timeoutMs: 15000,
    });
    if (callback.status >= 400) {
        throw new Error(`oauth callback failed: HTTP ${callback.status} ${callback.text.slice(0, 200)}`);
    }
    state.oauth = { serverId: CFG.mcpServerId, authorizedAt: new Date().toISOString() };
    saveState(state);
    log(`remote MCP authorized serverId=${CFG.mcpServerId}`);
}

async function mcpCall(session, method, params, id) {
    return cp(session, "POST", "/api/v1/mcp", {
        body: { jsonrpc: "2.0", id, method, params },
        timeoutMs: 30000,
    });
}

async function assertLogicalTool(state, session) {
    const deadline = Date.now() + 60000;
    let last = "no response";
    while (Date.now() < deadline) {
        try {
            const init = await mcpCall(
                session,
                "initialize",
                {
                    protocolVersion: "2026-07-28",
                    capabilities: {},
                    clientInfo: { name: "plan-0540-lane", version: "1" },
                },
                1,
            );
            if (init.status < 400) {
                const list = await mcpCall(session, "tools/list", {}, 2);
                const names = Array.isArray(list.json?.result?.tools)
                    ? list.json.result.tools.map((tool) => tool.name)
                    : [];
                if (names.includes("always_failing")) {
                    log(`CP logical tools include always_failing (${names.length} tools)`);
                    return names;
                }
                last = `tools: ${names.join(", ") || "(none)"}`;
            } else {
                last = `initialize HTTP ${init.status}`;
            }
        } catch (error) {
            last = error.message;
        }
        await sleep(2000);
    }
    throw new Error(`always_failing not visible through CP logical MCP within 60s (${last})`);
}

// ── setup / teardown / status ────────────────────────────────────────────

async function setup() {
    const password = process.env.XIHE_DEV_ADMIN_PASSWORD;
    if (!password) throw new Error("XIHE_DEV_ADMIN_PASSWORD is required (env only)");

    let state = loadState();
    if (state && !state.tornDown && state.cpUrl !== CFG.cpUrl) {
        throw new Error(
            `lane state belongs to ${state.cpUrl}, but XIHE_EVAL_CP_URL is ${CFG.cpUrl}; tear it down first`,
        );
    }
    if (!state || state.tornDown) {
        state = freshState();
        saveState(state);
        log(`fresh lane state ${CFG.stateFile}`);
    }

    const loginResult = await login();
    state.workspaceId = assertUuid(loginResult.workspaceId, "login workspace");
    state.adminUserId = assertUuid(loginResult.userId, "login user");
    saveState(state);
    const session = { token: loginResult.token };
    log(`logged in workspace=${state.workspaceId}`);

    await ensureFixtures(state);
    await ensureAdminGrant(state);
    const principalId = await ensurePrincipal(state, session);
    ensureGrant(state, "principal", "agent_principal", principalId, PRINCIPAL_TOOL_ATOMS);
    await ensurePrincipalBinding(state, session, principalId);
    await ensureToolFace(state, session);
    await ensureConnection(state, session);
    await captureOriginals(state, session);
    await applyLaneConfig(state, session);
    await waitForAgentReady(session);
    await authorizeRemoteMcp(state, session);
    const tools = await assertLogicalTool(state, session);

    state.setupAt = new Date().toISOString();
    state.tornDown = false;
    saveState(state);

    return {
        status: "ready",
        lane: "deterministic-local",
        stackId: CFG.stackId,
        cpUrl: CFG.cpUrl,
        stateFile: CFG.stateFile,
        workspaceId: state.workspaceId,
        principalId: state.principalId,
        providerId: CFG.providerId,
        model: CFG.model,
        connectionId: state.connection.id,
        llmPort: CFG.llmPort,
        oauthPort: CFG.oauthPort,
        mcpPort: CFG.mcpPort,
        remoteMcpEndpoint: `http://host.docker.internal:${CFG.mcpPort}/mcp`,
        logicalTools: tools,
    };
}

/**
 * Arm the same lane for the behavior baseline: keep the workspace, principal,
 * tool face and MCP fixtures from `setup`, but point the instance profile at a
 * real provider and confirm the Agent picked up its credentials.
 */
async function behaviorSetup() {
    const state = loadState();
    if (!state || state.tornDown) {
        throw new Error("lane is not set up; run `lane-setup.mjs setup` first");
    }
    if (!state.workspaceId || !state.principalId) {
        throw new Error("lane state lacks workspaceId/principalId; run setup again");
    }
    const loginResult = await login({ retries: 15 });
    if (loginResult.workspaceId !== state.workspaceId) {
        throw new Error(
            `login workspace ${loginResult.workspaceId} does not match lane workspace ${state.workspaceId}`,
        );
    }
    const session = { token: loginResult.token };

    await ensureFixtures(state);
    await ensureRealConnection(state, session);
    await applyRealProfile(session);
    await waitForAgentReady(session);
    const tools = await assertLogicalTool(state, session);

    state.behavior = {
        preparedAt: new Date().toISOString(),
        providerId: REAL.providerId,
        connectionKey: REAL.connectionKey,
        model: REAL.model,
        connectionId: state.realProvider.id,
    };
    saveState(state);

    return {
        status: "behavior_ready",
        lane: "behavior-real",
        stackId: CFG.stackId,
        cpUrl: CFG.cpUrl,
        workspaceId: state.workspaceId,
        principalId: state.principalId,
        providerId: REAL.providerId,
        connectionKey: REAL.connectionKey,
        model: REAL.model,
        connectionId: state.realProvider.id,
        connectionCreatedBySetup: state.realProvider.createdBySetup,
        logicalTools: tools,
    };
}

async function teardown() {
    const state = loadState();
    if (!state) throw new Error(`no lane state at ${CFG.stateFile}; nothing to tear down`);

    const problems = [];
    const attempt = async (label, work, { optional = false } = {}) => {
        try {
            return await work();
        } catch (error) {
            const text = `${label}: ${error.message}`;
            if (optional) log(`warning: ${text}`);
            else problems.push(text);
            return null;
        }
    };

    let session = null;
    try {
        const loginResult = await login({ retries: 15 });
        state.workspaceId = state.workspaceId ?? loginResult.workspaceId;
        state.adminUserId = state.adminUserId ?? loginResult.userId;
        saveState(state);
        session = { token: loginResult.token };
    } catch (error) {
        log(`warning: cannot reach CP for restore (${error.message}); stopping fixtures only`);
        problems.push(`cp restore skipped: ${error.message}`);
    }

    if (session) {
        if (state.principalId) {
            await attempt("delete eval sessions", async () => {
                const body = check(await cp(session, "GET", "/api/v1/sessions"), "list sessions").json;
                const owned = (body?.sessions ?? []).filter(
                    (item) => item.title === "eval" && item.agentPrincipalId === state.principalId,
                );
                for (const item of owned) {
                    check(await cp(session, "DELETE", `/api/v1/sessions/${item.id}`), "delete session");
                }
                log(`deleted ${owned.length} eval session(s)`);
            });
        }

        await attempt("restore instance llm-provider profile", async () => {
            const original = state.original.profile;
            const value = original?.had ? original.value : "";
            check(
                await cp(session, "PUT", "/api/v1/config/instance/llm-provider", {
                    body: { profile: value ?? "" },
                }),
                "restore instance profile",
            );
            log(original?.had ? "instance profile restored" : "instance profile cleared");
        });

        await attempt("restore workspace runMaxTurns", async () => {
            const original = state.original.runMaxTurns;
            const value = original?.had ? original.value : CFG.runMaxTurnsDefault;
            check(
                await cp(session, "PUT", "/api/v1/config/workspace/agent-runtime", {
                    body: { runMaxTurns: value },
                }),
                "restore runMaxTurns",
            );
            log(original?.had ? `runMaxTurns restored to ${value}` : `runMaxTurns reset to default ${value}`);
        });

        await attempt(
            "revoke remote MCP oauth",
            async () => {
                check(
                    await cp(session, "POST", "/api/v1/oauth/revoke", {
                        body: {
                            workspaceId: state.workspaceId,
                            serverId: state.oauth?.serverId ?? CFG.mcpServerId,
                        },
                    }),
                    "revoke oauth binding",
                );
                state.oauth = null;
                saveState(state);
                log("remote MCP oauth revoked");
            },
            { optional: true },
        );

        if (state.connection?.createdBySetup) {
            await attempt("delete provider connection", async () => {
                await deleteOwnedConnection(session, state.connection.id, "provider connection");
            });
        } else if (state.connection) {
            log("provider connection was pre-existing; kept");
        }

        if (state.realProvider?.createdBySetup) {
            await attempt("delete real provider connection", async () => {
                await deleteOwnedConnection(session, state.realProvider.id, "real provider connection");
            });
        } else if (state.realProvider) {
            log("real provider connection was pre-existing; kept");
        }

        if (state.principalId) {
            await attempt(
                "unbind principal",
                async () => {
                    const response = await cp(
                        session,
                        "DELETE",
                        `/api/v1/workspaces/${state.workspaceId}/agents/${state.principalId}`,
                    );
                    if (response.status === 204 || response.status === 404) {
                        log("principal workspace binding removed");
                        return;
                    }
                    throw new Error(`unbind failed: HTTP ${response.status}`);
                },
                { optional: true },
            );
        }

        await attempt(
            "delete seeded grants",
            async () => {
                deleteGrant(state, "principal");
                deleteGrant(state, "admin");
            },
            { optional: true },
        );
    }

    for (const spec of fixtureSpecs(state.fixtureSecret ?? "")) {
        await attempt(`stop fixture ${spec.name}`, async () => { await stopFixture(state, spec); });
    }

    if (session) {
        if (state.principalId) {
            await attempt("verify no residual eval sessions", async () => {
                const body = check(await cp(session, "GET", "/api/v1/sessions"), "list sessions").json;
                const left = (body?.sessions ?? []).filter(
                    (item) => item.title === "eval" && item.agentPrincipalId === state.principalId,
                );
                if (left.length) throw new Error(`${left.length} eval session(s) remain`);
            });
        }
        await attempt("verify no residual connection", async () => {
            if (!state.connection?.createdBySetup) return;
            const connections = await listConnections(session);
            if (connections.some((item) => item.id === state.connection.id)) {
                throw new Error(`connection ${state.connection.id} remains`);
            }
        });
        await attempt("verify no residual real connection", async () => {
            if (!state.realProvider?.createdBySetup) return;
            const connections = await listConnections(session);
            if (connections.some((item) => item.id === state.realProvider.id)) {
                throw new Error(`real connection ${state.realProvider.id} remains`);
            }
        });
        await attempt("verify profile restored", async () => {
            const entries = await readLayer(session, "instance", "llm-provider");
            const original = state.original.profile;
            const expected = original?.had ? original.value : null;
            if ((entries.profile ?? null) !== expected) {
                throw new Error(`instance profile is ${JSON.stringify(entries.profile ?? null)}, expected ${JSON.stringify(expected)}`);
            }
        });
        await attempt("verify runMaxTurns restored", async () => {
            const entries = await readLayer(session, "workspace", "agent-runtime");
            const original = state.original.runMaxTurns;
            const expected = original?.had ? original.value : CFG.runMaxTurnsDefault;
            if ((entries.runMaxTurns ?? null) !== expected) {
                throw new Error(`runMaxTurns is ${JSON.stringify(entries.runMaxTurns ?? null)}, expected ${JSON.stringify(expected)}`);
            }
        });
    }

    for (const spec of fixtureSpecs(state.fixtureSecret ?? "")) {
        await attempt(`verify fixture ${spec.name} stopped`, async () => {
            if (await probeHealth(spec.port)) throw new Error(`port ${spec.port} still healthy`);
        });
    }

    const fixturesUp = [];
    for (const spec of fixtureSpecs(state.fixtureSecret ?? "")) {
        if (await probeHealth(spec.port)) fixturesUp.push(spec.name);
    }

    state.tornDown = problems.length === 0;
    saveState(state);

    if (problems.length) {
        throw new Error(`teardown incomplete:\n- ${problems.join("\n- ")}`);
    }
    return {
        status: "torn_down",
        stateFile: CFG.stateFile,
        fixturesUp,
        retained: [
            "agent principal row (no delete API)",
            "workspace tool-face row (no delete API)",
            "OAuth remote MCP server registration (no delete API)",
        ],
    };
}

async function status() {
    const state = loadState();
    const fixtureHealth = {};
    for (const [name, port] of [
        ["llm", CFG.llmPort],
        ["oauth", CFG.oauthPort],
        ["mcp", CFG.mcpPort],
    ]) {
        const health = await probeHealth(port);
        fixtureHealth[name] = health ? { pid: health.pid, port, status: "up" } : { port, status: "down" };
    }
    const result = {
        stateFile: CFG.stateFile,
        state: state
            ? {
                  stackId: state.stackId,
                  cpUrl: state.cpUrl,
                  workspaceId: state.workspaceId,
                  principalId: state.principalId,
                  connectionId: state.connection?.id ?? null,
                  realConnectionId: state.realProvider?.id ?? null,
                  setupAt: state.setupAt,
                  tornDown: state.tornDown,
              }
            : null,
        fixtures: fixtureHealth,
    };
    if (process.env.XIHE_DEV_ADMIN_PASSWORD && state) {
        try {
            const loginResult = await login({ retries: 2, delayMs: 1000 });
            const session = { token: loginResult.token };
            const statusBody = check(await cp(session, "GET", "/api/v1/status"), "read status").json;
            const agent = statusBody?.services?.find((service) => service.key === "agent");
            const profile = (await readLayer(session, "instance", "llm-provider")).profile ?? null;
            const runMaxTurns = (await readLayer(session, "workspace", "agent-runtime")).runMaxTurns ?? null;
            result.cp = {
                agentStatus: agent?.status ?? "unknown",
                llmReady: agent?.llmReady ?? "unknown",
                profileIsEval: profile ? isEvalProfile(profile) : false,
                profileIsReal: profile ? isRealProfile(profile) : false,
                runMaxTurns,
            };
        } catch (error) {
            result.cp = { error: error.message };
        }
    }
    return result;
}

// ── run ──────────────────────────────────────────────────────────────────

function parseRunArgs(argv) {
    const options = {
        lane: "invariant",
        rounds: 1,
        attempts: null,
        only: null,
        timeout: "180",
        root: join(REPO_ROOT, ".local", "evaluation"),
        toolSurface: null,
        provider: null,
        model: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            index += 1;
            if (index >= argv.length) throw new Error(`${arg} requires a value`);
            return argv[index];
        };
        switch (arg) {
            case "--lane":
                options.lane = next();
                break;
            case "--rounds":
                options.rounds = Number(next());
                break;
            case "--attempts":
                options.attempts = Number(next());
                break;
            case "--only":
                options.only = next();
                break;
            case "--timeout":
                options.timeout = next();
                break;
            case "--root":
                options.root = resolve(next());
                break;
            case "--tool-surface":
                options.toolSurface = true;
                break;
            case "--no-tool-surface":
                options.toolSurface = false;
                break;
            case "--provider":
                options.provider = next();
                break;
            case "--model":
                options.model = next();
                break;
            default:
                throw new Error(`unknown run option: ${arg}`);
        }
    }
    if (!["invariant", "behavior"].includes(options.lane)) {
        throw new Error(`--lane must be invariant or behavior, got ${options.lane}`);
    }
    if (!Number.isInteger(options.rounds) || options.rounds < 1) {
        throw new Error("--rounds must be a positive integer");
    }
    if (options.toolSurface === null) options.toolSurface = options.lane === "invariant";
    return options;
}

function runOne(options, round, token, state) {
    const outputDir = join(
        options.root,
        `${options.lane}-r${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${round}`,
    );
    const args = [
        "run",
        "python",
        "-m",
        "xihe_agent.evaluation",
        "run",
        "--lane",
        options.lane,
        "--cp-url",
        CFG.cpUrl,
        "--output-dir",
        outputDir,
        "--timeout",
        options.timeout,
    ];
    if (options.attempts) args.push("--attempts", String(options.attempts));
    if (options.only) args.push("--only", options.only);
    if (options.toolSurface) args.push("--tool-surface");
    if (options.provider) args.push("--provider", options.provider);
    if (options.model) args.push("--model", options.model);

    const env = {
        ...process.env,
        XIHE_EVAL_TOKEN: token,
        XIHE_EVAL_PROVIDER: options.provider ?? CFG.providerId,
        XIHE_EVAL_MODEL: options.model ?? CFG.model,
        XIHE_EVAL_AGENT_PRINCIPAL: state.principalId,
        XIHE_EVAL_TOOL_SURFACE: options.toolSurface ? "1" : "0",
    };
    log(`round ${round}: ${outputDir}`);
    return new Promise((resolvePromise) => {
        const child = spawn("uv", args, {
            cwd: join(REPO_ROOT, "packages", "agent"),
            env,
            stdio: "inherit",
            windowsHide: true,
        });
        child.on("error", (error) => resolvePromise({ round, exitCode: 1, outputDir, error: error.message }));
        child.on("exit", (code) => resolvePromise({ round, exitCode: code ?? 1, outputDir }));
    });
}

async function run(argv) {
    const options = parseRunArgs(argv);
    const state = loadState();
    if (!state || state.tornDown) {
        throw new Error("lane is not set up; run `lane-setup.mjs setup` first");
    }
    if (!state.principalId) throw new Error("lane state has no principalId; run setup again");
    const loginResult = await login({ retries: 15 });
    if (loginResult.workspaceId !== state.workspaceId) {
        throw new Error(
            `login workspace ${loginResult.workspaceId} does not match lane workspace ${state.workspaceId}`,
        );
    }
    const results = [];
    for (let round = 1; round <= options.rounds; round += 1) {
        results.push(await runOne(options, round, loginResult.token, state));
    }
    return {
        lane: options.lane,
        rounds: results.map((item) => ({
            round: item.round,
            exitCode: item.exitCode,
            report: join(item.outputDir, "report.json"),
            ...(item.error ? { error: item.error } : {}),
        })),
        ok: results.every((item) => item.exitCode === 0),
    };
}

// ── main ─────────────────────────────────────────────────────────────────

function usage() {
    console.error(
        [
            "usage: node lane-setup.mjs <setup|behavior-setup|teardown|status|run> [options]",
            "  run options: --lane invariant|behavior --rounds N --attempts N --only id,id",
            "               --timeout S --root DIR --tool-surface|--no-tool-surface",
            "               --provider ID --model NAME",
        ].join("\n"),
    );
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    let result;
    switch (command) {
        case "setup":
            result = await setup();
            break;
        case "behavior-setup":
            result = await behaviorSetup();
            break;
        case "teardown":
            result = await teardown();
            break;
        case "status":
            result = await status();
            break;
        case "run":
            result = await run(rest);
            break;
        default:
            usage();
            process.exitCode = 2;
            return;
    }
    console.log(JSON.stringify(result, null, 2));
    if (result && result.ok === false) process.exitCode = 1;
}

main().catch((error) => {
    console.error(`[lane] ERROR: ${error.message}`);
    process.exitCode = 1;
});
