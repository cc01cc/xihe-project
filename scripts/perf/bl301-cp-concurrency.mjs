#!/usr/bin/env node
/**
 * BL-301 — CP 侧并发大会话读：10 个会话 × 1000 条，10 并发 GET /messages（旧全量契约，≤2000 走兼容路径）。
 *
 * 前提：e2e-host `--persistent` 已启动（`.tmp/e2e-host/persistent-stack.json`）。
 * 用法：node scripts/perf/bl301-cp-concurrency.mjs [--out <json>]
 *
 * 指标：jcmd GC.heap_info 的 used 基线 / 采样峰值 / 收尾 GC 后 retained；
 *      每请求状态/字节/耗时（p50/p95）；错误数。
 * 参照：PLAN-0670 M2b 的 10 并发 20k 全量读 = 873 MB（旧全量路径，仅作量级参照）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const A03 = 'H:/zeogit/one/A03-xihe';
const state = JSON.parse(readFileSync(`${A03}/.tmp/e2e-host/persistent-stack.json`, 'utf8'));
const CP = `http://127.0.0.1:${state.ports.cp}`;
const ADMIN_EMAIL = 'admin@xihe.local';
const ADMIN_PASSWORD = state.adminPassword;
const CP_PID = state.pids['control-plane'];
const pgContainer = `${state.pgProjectName}-postgres-1`;
const pgDb = `xihe_e2e_host_${state.runId.replace(/^host-/, '').replace(/-/g, '_')}`;
const CONCURRENCY = 10;
const MESSAGES_PER_SESSION = 1000;

const argValue = (name, fallback = null) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
};
const OUT = resolve(argValue('out', 'H:/zeotmp/bl301/bl301-cp-concurrency.json'));
mkdirSync(dirname(OUT), { recursive: true });

function psql(sql) {
    return execFileSync('docker', ['exec', pgContainer, 'psql', '-U', 'xihe', '-d', pgDb, '-tAc', sql],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
function heapUsedKb() {
    try {
        const text = execFileSync('jcmd', [String(CP_PID), 'GC.heap_info'], { encoding: 'utf8' });
        const matches = [...text.matchAll(/used\s+(\d+)K/g)];
        if (matches.length === 0) return null;
        return matches.reduce((sum, match) => sum + Number(match[1]), 0);
    } catch { return null; }
}
function forceGc() {
    try { execFileSync('jcmd', [String(CP_PID), 'GC.run'], { encoding: 'utf8' }); } catch { /* ignore */ }
}

async function api(method, path, { token, workspaceId, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
    const response = await fetch(`${CP}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: response.status, json, text };
}
function fail(label, result) {
    console.error(`[fail] ${label}: HTTP ${result.status}\n${result.text?.slice(0, 500)}`);
    process.exit(1);
}

const login = await api('POST', '/api/v1/auth/login',
    { body: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
if (login.status !== 200) fail('login', login);
const token = login.json.accessToken;
const workspaces = await api('GET', '/api/v1/workspaces', { token });
if (workspaces.status !== 200) fail('workspaces', workspaces);
const workspaceList = workspaces.json.workspaces ?? workspaces.json ?? [];
const workspaceId = workspaceList[0]?.id;
if (!workspaceId) fail('no workspace', workspaces);
const roles = await api('GET', `/api/v1/roles?workspaceId=${workspaceId}`, { token, workspaceId });
const roleList = Array.isArray(roles.json) ? roles.json : (roles.json.items ?? []);
if (!roleList.some((role) => /WS_EDITOR/i.test(String(role.name ?? role.key ?? '')))) {
    fail('no WS_EDITOR role', roles);
}
const principal = await api('POST', '/api/v1/agent-principals',
    { token, workspaceId, body: { name: 'bl301cpAgent', scope: 'workspace' } });
if (principal.status !== 201 && principal.status !== 200) fail('create principal', principal);
const principalId = principal.json.id ?? principal.json.principalId;
await api('PUT', `/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
    { token, workspaceId, body: { permissions: [] } });
const connections = await api('GET', `/api/v1/provider-connections?workspaceId=${workspaceId}`,
    { token, workspaceId });
const connection = (connections.json?.connections ?? connections.json ?? [])[0];
if (!connection) fail('no provider connection', connections);
const modelName = (connection.manualModels ?? [])[0] ?? 'fake-openai';

async function createSession(title) {
    const response = await api('POST', `/api/v1/workspaces/${workspaceId}/sessions`, {
        token, workspaceId,
        body: {
            title, agentPrincipalId: principalId,
            modelProvider: connection.providerId, modelName,
            providerConnectionId: connection.id,
        },
    });
    if (response.status !== 201 && response.status !== 200) fail(`create session ${title}`, response);
    const sessionId = response.json.id;
    const branches = await api('GET', `/api/v1/sessions/${sessionId}/branches`, { token, workspaceId });
    const branchList = branches.json.items ?? branches.json.branches ?? branches.json;
    const branchId = (branchList.find((branch) => branch.parentBranchId == null) ?? branchList[0]).branchId
        ?? branchList[0].id;
    return { sessionId, branchId };
}
function seedMessages(sessionId, branchId, count) {
    const filler = 'x'.repeat(1024);
    psql(`INSERT INTO messages (id, session_id, run_id, role, content, created_at, branch_id, visibility)
          SELECT gen_random_uuid(), '${sessionId}'::uuid, NULL,
                 CASE WHEN i % 2 = 0 THEN 'USER' ELSE 'ASSISTANT' END,
                 'message #' || i || ' ' || '${filler}',
                 now() - ((interval '1 second') * (${count} - i)),
                 '${branchId}'::uuid, 'user'
          FROM generate_series(1, ${count}) AS i`);
    const actual = Number(psql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}'`));
    if (actual < count) throw new Error(`seeded ${actual} < ${count}`);
}

const sessions = [];
for (let index = 0; index < CONCURRENCY; index += 1) {
    const session = await createSession(`bl301-cp-conc-${index + 1}`);
    seedMessages(session.sessionId, session.branchId, MESSAGES_PER_SESSION);
    sessions.push(session);
    console.log(`[ok] seeded session ${index + 1}/${CONCURRENCY} (${MESSAGES_PER_SESSION} msgs)`);
}

forceGc();
await new Promise((r) => setTimeout(r, 500));
const heapBefore = heapUsedKb();
const samples = [];
let sampling = true;
const sampler = setInterval(() => {
    if (!sampling) return;
    const used = heapUsedKb();
    if (used !== null) samples.push(used);
}, 100);
sampler.unref?.();

const started = Date.now();
const results = await Promise.all(sessions.map(async (session) => {
    const requestStarted = Date.now();
    try {
        const response = await fetch(
            `${CP}/api/v1/sessions/${session.sessionId}/messages?branchId=${encodeURIComponent(session.branchId)}`,
            { headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': workspaceId } });
        const buffer = await response.arrayBuffer();
        return {
            status: response.status, bytes: buffer.byteLength,
            ms: Date.now() - requestStarted, ok: response.ok,
        };
    } catch (error) {
        return { status: 0, bytes: 0, ms: Date.now() - requestStarted, ok: false, error: String(error).slice(0, 200) };
    }
}));
const wallMs = Date.now() - started;
sampling = false;
clearInterval(sampler);
// 请求刚结束时先读一次 used（未 GC，含瞬时分配），再 GC 读 retained。
const heapRightAfter = heapUsedKb();
await new Promise((r) => setTimeout(r, 300));
forceGc();
await new Promise((r) => setTimeout(r, 500));
const heapAfter = heapUsedKb();

const heapPeak = samples.length ? Math.max(...samples) : heapRightAfter;
const heapAllocPeak = heapPeak === null ? null : Math.max(heapPeak, heapRightAfter ?? 0);
const sortedMs = results.map((item) => item.ms).sort((a, b) => a - b);
const pct = (p) => sortedMs.length === 0 ? null
    : sortedMs[Math.min(sortedMs.length - 1, Math.floor((sortedMs.length - 1) * p))];
const toMb = (kb) => kb === null ? null : Number((kb / 1024).toFixed(2));
const output = {
    id: 'BL-301',
    scenario: 'CP concurrent large-session read',
    capturedAt: new Date().toISOString(),
    stack: { runId: state.runId, ports: state.ports },
    fixture: {
        workspaceId, concurrency: CONCURRENCY, messagesPerSession: MESSAGES_PER_SESSION,
        endpoint: 'GET /api/v1/sessions/{id}/messages?branchId=... (legacy full contract; <=2000 rows)',
    },
    method: 'jcmd GC.run 后读 used 基线；请求期间 400ms 采样 GC.heap_info used；结束后 GC.run 再读 used',
    metrics: {
        wallMs,
        requests: results.length,
        failures: results.filter((item) => !item.ok).length,
        bytesTotal: results.reduce((sum, item) => sum + item.bytes, 0),
        latencyMs: { p50: pct(0.5), p95: pct(0.95), min: sortedMs[0] ?? null, max: sortedMs.at(-1) ?? null },
        heapKb: { before: heapBefore, peak: heapPeak, rightAfter: heapRightAfter, after: heapAfter, samples: samples.length },
        heapAllocGrowthMb: heapBefore === null || heapAllocPeak === null ? null : toMb(heapAllocPeak - heapBefore),
        heapRetainedGrowthMb: heapBefore === null || heapAfter === null ? null : toMb(heapAfter - heapBefore),
    },
    results,
    reference: {
        plan0670M2b: '10 并发 × 20k 全量读 = 873 MB（旧全量路径；PLAN-0670 evidence/m2b-baseline.md）',
        note: '本场景 10×1000 行，量级更小；allocΔ 与 retainedΔ 必须分开看（BL-296 教训）',
    },
};
writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`[ok] heap before=${heapBefore}K peak=${heapPeak}K after=${heapAfter}K `
    + `allocΔ=${output.metrics.heapAllocGrowthMb}MB retainedΔ=${output.metrics.heapRetainedGrowthMb}MB`);
console.log(`[ok] latency p50=${output.metrics.latencyMs.p50}ms p95=${output.metrics.latencyMs.p95}ms `
    + `bytes=${(output.metrics.bytesTotal / 1048576).toFixed(1)}MB failures=${output.metrics.failures}`);
console.log(`[ok] written ${OUT}`);
