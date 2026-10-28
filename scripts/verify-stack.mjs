#!/usr/bin/env node
// Xihe host 栈验证脚本（v1 API，栈感知）— PLAN-0547 由 verify-stack.sh 平移为 Node。
//
// 用途：验证「CP 公开 API → Agent」链路是否可用，并给出可直接照抄的原因码。
// 用法：
//   node scripts/verify-stack.mjs [--stack N]
//   XIHE_VERIFY_PASSWORD=... node scripts/verify-stack.mjs
//   XIHE_STACK_ID=stack-2 XIHE_VERIFY_PASSWORD=... node scripts/verify-stack.mjs
//   （--stack 参数优先于 XIHE_STACK_ID env；两者皆缺省时 stack-1）
//
// 凭据（脚本内无任何字面密码）：
//   XIHE_VERIFY_EMAIL      默认 admin@xihe.local
//   XIHE_VERIFY_PASSWORD   必填；缺失时回退 XIHE_DEV_ADMIN_PASSWORD，
//                          再回退 .env 文件链（PLAN-0547），仍无则 exit 2
//   XIHE_VERIFY_AGENT_PRINCIPAL_ID  可选；不传时用该账号 workspace 已绑定的第一个，
//                          仍无则自动建一个（并绑定空 cap）
//
// 退出码：
//   0  A 档与 B 档均通过
//   4  A 档通过，B 档前置未满足（预期不可用，末行打印原因码）
//   1  A 档失败，或 B 档意外错误
//   2  缺凭据 / 派生失败
//
// 端口与路径一律取自 stack-run.mjs env-json（端口 SSOT）；--stack 显式传参。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadEnvFileChain } from "./lib/env-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STACK_ID = (() => {
    const i = process.argv.indexOf("--stack");
    if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    const inline = process.argv.find((a) => a.startsWith("--stack="));
    if (inline) return inline.slice("--stack=".length);
    return process.env.XIHE_STACK_ID || "stack-1";
})();

// PLAN-0547: .env chain fills gaps before the password is resolved (OS env wins).
loadEnvFileChain();

const EMAIL = process.env.XIHE_VERIFY_EMAIL || "admin@xihe.local";
const PASSWORD = process.env.XIHE_VERIFY_PASSWORD || process.env.XIHE_DEV_ADMIN_PASSWORD || "";

function failMissingCredentials() {
    console.error("ERROR 缺少 XIHE_VERIFY_PASSWORD");
    console.error("      dev 栈：mise run reset-admin 生成后注入 XIHE_VERIFY_PASSWORD 重跑，");
    console.error("      或在 A03-xihe/.env.local 写入 XIHE_DEV_ADMIN_PASSWORD（PLAN-0547 文件链）。");
    process.exit(2);
}

if (!PASSWORD) failMissingCredentials();

async function deriveStackEnv() {
    const bridge = new Function(
        "d",
        `const e = d.env || {};
         const pick = (k, dflt) => (e[k] === undefined ? dflt : e[k]);
         return { CP_PORT: pick("XIHE_CP_PORT", "12631"), AGENT_PORT: pick("XIHE_AGENT_PORT", "12632"), LOG_DIR: pick("XIHE_LOG_DIR", "logs"), DB_NAME: pick("POSTGRES_DB", "xihe_1") };`,
    );
    let derived;
    try {
        derived = JSON.parse(
            execFileSync(process.execPath, [path.join(ROOT, "scripts", "stack-run.mjs"), "env-json", "--stack", STACK_ID], { encoding: "utf8" }),
        );
    } catch {
        console.error(`ERROR 无法从 stack-run 派生 stack=${STACK_ID} 的环境（非法或未登记栈？）`);
        process.exit(2);
    }
    return bridge(derived);
}

const { CP_PORT, AGENT_PORT, LOG_DIR, DB_NAME } = await deriveStackEnv();
const CP_BASE = `http://localhost:${CP_PORT}`;
const AGENT_HEALTH = `http://127.0.0.1:${AGENT_PORT}/internal/v1/agent/health`;

let TOKEN = "";
let lastBody = null;

function failA(reason) {
    console.log(`RESULT: A=FAIL B=NOT_RUN (${reason})`);
    process.exit(1);
}

async function api(method, apiPath, payload) {
    const headers = {};
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
    try {
        const res = await fetch(`${CP_BASE}${apiPath}`, {
            method,
            headers,
            body: payload,
            signal: AbortSignal.timeout(20_000),
        });
        lastBody = await res.text();
        return String(res.status);
    } catch {
        lastBody = "";
        return "000";
    }
}

function json(dotPath) {
    let d;
    try {
        d = JSON.parse(lastBody || "{}");
    } catch {
        return "";
    }
    let v = d;
    for (const k of dotPath.split(".")) {
        if (v == null) return "";
        v = v[k];
    }
    return v == null ? "" : String(v);
}

async function waitSseConnected(sessionId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
        const res = await fetch(`${CP_BASE}/api/v1/events?sessionId=${sessionId}`, {
            headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
            signal: controller.signal,
        });
        if (!res.ok || !res.body) return false;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return false;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.includes("connected")) return true;
            if (buffer.length > 64 * 1024) return false;
        }
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
}

function printEnvSnapshot() {
    console.log("--- 容器（按 xihe.stack-id 过滤；无标签视为 stack-1）---");
    try {
        const out = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.Label \"xihe.stack-id\"}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const rows = out.split(/\r?\n/).filter((l) => l.trim());
        const own = rows.filter((l) => {
            const [, , label] = l.split("\t");
            const effective = label === "" ? "stack-1" : label;
            return effective === STACK_ID && /^(xihe|a03-xihe|xihe-stack-)/.test(l.split("\t")[0]);
        });
        if (own.length) for (const l of own) console.log("  " + l);
        else console.log("  （无匹配容器）");
    } catch {
        console.log("  （无 docker 或查询失败，跳过）");
    }
    console.log("");
    console.log(`--- Agent 日志（最近 5 行，来自 ${LOG_DIR}/agent.log）---`);
    const agentLog = path.join(ROOT, LOG_DIR, "agent.log");
    if (fs.existsSync(agentLog)) {
        const lines = fs.readFileSync(agentLog, "utf8").split(/\r?\n/).filter(Boolean);
        for (const l of lines.slice(-5)) console.log(l);
    } else {
        console.log(`  （无 ${LOG_DIR}/agent.log；dev:host 下 Agent 为宿主进程，容器日志不适用）`);
    }
    console.log("");
}

console.log(`=== Xihe 栈验证 (stack=${STACK_ID}) ===`);
console.log(`cp=${CP_BASE} agent=${AGENT_PORT} db=${DB_NAME} log=${LOG_DIR}`);
console.log("");

// ---------------------------------------------------------------- A 档（必过）
console.log("--- A1 CP 健康 ---");
let code = await api("GET", "/api/v1/health");
if (code !== "200") failA(`CP /api/v1/health -> ${code}`);
console.log("✅ CP health 200");

console.log("--- A2 登录 ---");
code = await api("POST", "/api/v1/auth/login", JSON.stringify({ identifier: EMAIL, password: PASSWORD }));
if (code !== "200") failA(`login -> ${code}（凭据错？或 admin 密码已轮换）`);
TOKEN = json("accessToken");
if (!TOKEN) failA("login 200 但无 accessToken");
console.log("✅ 登录成功（token 不回显）");

console.log("--- A3 建 Session / 取分支 ---");
// 新建 workspace 默认没有 agent principal，而 create session 要求 agentPrincipalId。
// 解析顺序：显式注入 → 该账号默认 workspace 已绑定的第一个 → 现建一个并绑定。
// 注意：对**已存在**的 principal 调 PUT 绑定会收窄它的 workspace cap，所以只在现建后绑定。
const WORKSPACE_ID = json("workspaceId");
let PRINCIPAL_ID = process.env.XIHE_VERIFY_AGENT_PRINCIPAL_ID || "";
let PROVISIONED = false;
let principalProvisionCode = "";
if (!PRINCIPAL_ID && WORKSPACE_ID) {
    code = await api("GET", `/api/v1/workspaces/${WORKSPACE_ID}/agents`);
    if (code === "200") PRINCIPAL_ID = json("0.principalId"); // 顶层数组
}
if (!PRINCIPAL_ID) {
    principalProvisionCode = await api("POST", "/api/v1/agent-principals", '{"name":"verify-stack"}');
    if (principalProvisionCode === "200" || principalProvisionCode === "201") {
        PRINCIPAL_ID = json("principalId");
        PROVISIONED = true;
    } else {
        console.log(`  （自动建 agent principal 失败：HTTP ${principalProvisionCode} code=${json("code")} detail=${json("detail")}）`);
    }
}
if (PROVISIONED && PRINCIPAL_ID && WORKSPACE_ID) {
    code = await api("PUT", `/api/v1/workspaces/${WORKSPACE_ID}/agents/${PRINCIPAL_ID}`, '{"permissions":[]}');
    console.log(`  （新 principal 已绑定 workspace，cap 为空 → 仅够建 session，不足以调工具）HTTP ${code}`);
}
if (!PRINCIPAL_ID) failA(`workspace ${WORKSPACE_ID || "?"} 无 agent principal，且自动创建失败（可传 XIHE_VERIFY_AGENT_PRINCIPAL_ID）`);
code = await api("POST", "/api/v1/sessions", JSON.stringify({ title: "verify-stack", agentPrincipalId: PRINCIPAL_ID }));
let SESSION_ID = json("id");
if (!SESSION_ID) SESSION_ID = json("sessionId");
if (code !== "200" && code !== "201") failA(`create session -> ${code} code=${json("code")} detail=${json("detail")}`);
if (!SESSION_ID) failA("create session 无 id");
code = await api("GET", `/api/v1/sessions/${SESSION_ID}/branches`);
if (code !== "200") failA(`branches -> ${code}`);
const BRANCH_ID = json("items.0.branchId");
if (!BRANCH_ID) failA("branches 为空");
console.log(`✅ workspace=${WORKSPACE_ID} principal=${PRINCIPAL_ID} session=${SESSION_ID} branch=${BRANCH_ID}`);

console.log("--- A4 SSE 订阅 ---");
const sseOk = await waitSseConnected(SESSION_ID);
if (!sseOk) failA("SSE 10s 内未收到 connected 帧");
console.log("✅ SSE connected");

console.log("--- A5 模型列表 ---");
code = await api("GET", "/api/v1/models");
if (code !== "200") failA(`models -> ${code}`);
let MODEL_COUNT = 0;
try {
    const d = JSON.parse(lastBody || "{}");
    const m = d.models;
    MODEL_COUNT = Array.isArray(m) ? m.length : m && typeof m === "object" ? Object.keys(m).length : 0;
} catch { /* keep 0 */ }
if (String(MODEL_COUNT) === "0") failA("models 为空（provider 未配置？）");
console.log(`✅ models=${MODEL_COUNT} configRevision=${json("configRevision")}`);

console.log("--- A6 Agent 健康 ---");
let agentBody = "";
let AGENT_CODE = "000";
try {
    const res = await fetch(AGENT_HEALTH, { signal: AbortSignal.timeout(10_000) });
    AGENT_CODE = String(res.status);
    agentBody = await res.text();
} catch { /* 000 */ }
if (AGENT_CODE !== "200") failA(`agent health -> ${AGENT_CODE}（端口 ${AGENT_PORT} 上的 Agent 未起？）`);
lastBody = agentBody;
console.log(`✅ agent status=${json("status")} llmReady=${json("llmReady")} configRevision=${json("configRevision")} mcpInitialized=${json("mcpInitialized")}`);
console.log("");

// ---------------------------------------------------------------- B 档（条件过）
console.log("--- B 档 发送消息（需 provider 凭据 + principal 绑定 + LLM ready）---");
code = await api("POST", "/api/v1/chat", JSON.stringify({ sessionId: SESSION_ID, branchId: BRANCH_ID, content: "verify-stack ping" }));
let B_STATE;
let B_DETAIL;
if (code === "200" || code === "202") {
    const RUN_ID = json("runId");
    if (RUN_ID) {
        B_STATE = "PASS";
        B_DETAIL = `runId=${RUN_ID}`;
    } else {
        B_STATE = "FAIL";
        B_DETAIL = `HTTP ${code} 但无 runId`;
    }
} else if (code === "403" || code === "409" || code === "503") {
    // 预期不可用：principal 未绑定 / SSE 门 / LLM 未就绪
    B_STATE = "NOT_AVAILABLE";
    B_DETAIL = `HTTP ${code} code=${json("code")} detail=${json("detail")}`;
} else {
    B_STATE = "FAIL";
    B_DETAIL = `HTTP ${code} code=${json("code")} detail=${json("detail")}`;
}
console.log(`B 档 = ${B_STATE}（${B_DETAIL}）`);
console.log("");

printEnvSnapshot();

if (B_STATE === "PASS") {
    console.log(`RESULT: A=PASS B=PASS (${B_DETAIL})`);
    process.exit(0);
}
if (B_STATE === "NOT_AVAILABLE") {
    console.log(`RESULT: A=PASS B=NOT_AVAILABLE (${B_DETAIL})`);
    process.exit(4);
}
console.log(`RESULT: A=PASS B=FAIL (${B_DETAIL})`);
process.exit(1);
