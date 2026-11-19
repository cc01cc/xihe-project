#!/usr/bin/env node
/**
 * task-31（task-29 的 M2 窗内读数 kit）：**只读**取 R1–R4 四条读数并给出 PASS/FAIL。
 *
 * 为什么要一个脚本：M1（`d445f8d12`，唤醒提示词点名被指派方）修的是"提示词里没说你是谁"，
 * 它只有在**真栈**上产生一条 wake run 之后才能被观测到；而判据（谁拥有 run、提示词里是否点名、
 * 回复是否用自己的口吻、无正文 wake 是否不撒谎）全都在 `chat_runs` / `messages` /
 * `context_events` 三张表里。手敲 SQL 每次都会漂，所以把四条判据连同"什么必须判 FAIL"
 * 一起写进脚本，窗内一条命令出表。
 *
 * ── 四条读数的口径（与卡面 R1–R4 的差异已报 Lead，见
 *    `internal/A03-xihe/evidence/2026-11-19-to-m2-readings/README.md` §口径更正）───────────
 *  R1 提交 run 归属：TO 里第一个 AGENT 目标拥有该次提交的 run（`ChatController`:793-804 +
 *     `firstAgentTarget`:2656-2663），因此 `chat_runs.agent_principal_id` 必须是本会话里
 *     那个 AGENT 参与者的 principal，且该 run 的 `messages(role='USER')` 是**人类原文**、
 *     不带 `[<trigger> wake …]` 标记。TO 关系本身不在库里，用同 round 的
 *     `wake_dispatch / outcome=notify` 事件佐证（缺则 WARN，不判 FAIL）。
 *  R2 被唤醒 run 的提示词点名：wake run 的 `messages(role='USER', visibility='internal')`
 *     必须以 `[<trigger> wake <round>]` 开头并含 `You are <displayName>.`，
 *     displayName 必须等于名册（`agent_principals.name` / `users.username`，与
 *     `SessionParticipantService.displayNameOf` 同源）。
 *  R3 被指派方用自己的口吻回答：该 wake run 的 ASSISTANT 行存在、`messages.participant_id`
 *     等于被唤醒的 participant，且正文里**没有**"我（另一个参与者）"这类冒名自我指称。
 *     语义口吻本身仍需人工复核，脚本只给可机判的代理判据 + 回复摘录。
 *  R4 无正文 wake 不撒谎：空正文的 schedule/guard wake 提示词必须是
 *     `… Respond to the conversation in your own voice.`，**不得**出现
 *     `Triggering message` 或 `addressed to you by another participant`。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────────
 *  · **只读**：本脚本发出的每条 SQL 都必须是 `select`/`with`，psql helper 会先断言再执行；
 *    不写库、不改栈、不启停任何进程。
 *  · **不许假绿**：栈不在（容器/CP/库任一缺失）⇒ 一律 exit 2 并列出阻塞项，
 *    绝不输出 PASS。`--dry-run` 只做前置探测 + 打印将要执行的 SQL，同样 exit 2。
 *  · 退出码：0 = 四条全 PASS｜1 = 至少一条 FAIL/PENDING/NOT-COVERED｜2 = 前置阻塞或用法错误。
 *
 * 用法（详见 `--help`）：
 *   node scripts/xh-to-m2-readings.mjs --session <sessionId> --stack 2
 *   node scripts/xh-to-m2-readings.mjs --session <sessionId> --dry-run
 *   node scripts/xh-to-m2-readings.mjs --wake-run <runId> --r4-run <runId> --json
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_STACK_ID, deriveStack, normalizeStackArg } from "./lib/stack-ports.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

/** smoke 用的健康口径：CP 两个入口都要认（`/api/v1/health` 是服务自述，`/actuator/health` 是既有探针）。 */
const CP_HEALTH_PATHS = ["/api/v1/health", "/actuator/health"];

const WAKE_MARKER = /^\[([a-z]+) wake ([^\]]+)\] session=([0-9a-fA-F-]{36})/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const USAGE = `task-31 / task-29 M2 —— TO=指派 四条窗内读数（只读）

Usage:
  node scripts/xh-to-m2-readings.mjs --session <sessionId> [--stack N] [options]
  node scripts/xh-to-m2-readings.mjs --session <sessionId> --dry-run

Readings:
  R1  提交 run 归属      TO 里第一个 AGENT 目标拥有该次提交的 run（不是派发方）
  R2  唤醒提示词点名     wake run 的 internal prompt 含 "You are <displayName>."
  R3  被指派方口吻       该 run 的 ASSISTANT 行归属正确且无冒名自我指称（+摘录供人工复核）
  R4  无正文 wake 不撒谎 schedule/guard wake 不含 "Triggering message"/"addressed to you"

Options:
  --session <uuid>    会话 id；R1/R2/R3 都从它定位（R4 可在别的会话里）
  --stack <N|stack-N> 栈号（默认 XIHE_STACK_ID 或 stack-1）；决定 postgres/CP 端口与库名
  --root-run <uuid>   直接指定提交 run（默认按 session 自动找最新一条非 wake 的 user run）
  --wake-run <uuid>   直接指定被唤醒的 run（默认按 wake_dispatch 事件自动找）
  --r4-session <uuid> R4 的候选范围（默认全库扫最近的 schedule/guard wake）
  --r4-run <uuid>     直接指定 R4 的 run
  --only <list>       只跑指定读数，逗号分隔，例如 --only R1,R2
  --wait <seconds>    R3 等回复的轮询上限（默认 0 = 不等待，直接按当前库状态判定）
  --timeout <seconds> 单条 psql/health 探测超时（默认 30）
  --out <file>        把完整读数写成 JSON
  --json              只输出 JSON（给下游/存档用）
  --dry-run           只做前置探测 + 打印将执行的 SQL；栈不在则 exit 2
  --selftest          无栈自检：用固定 fixture 走同一套判据，验证 PASS/FAIL 逻辑（不需要会话/栈）
  --help              这份说明

Exit codes:
  0  四条全 PASS
  1  至少一条 FAIL / PENDING / NOT-COVERED
  2  前置阻塞（栈不在、容器/库缺失、CP 不通）或用法错误

只读保证：脚本只发 select/with 语句（psql helper 前置断言），不写库、不启停栈。
`;

// ---------------------------------------------------------------- 参数

/** 参数错误的统一出口：用法错误与前置阻塞同为 exit 2（墙内不许把"用错了"读成"读数 FAIL"）。 */
function usageFail(message) {
    console.error("[M2] ERROR: " + message);
    console.error("[M2] run with --help for usage");
    process.exit(2);
}

function parseArgs(argv) {
    const out = {
        session: null,
        stack: process.env.XIHE_STACK_ID ?? DEFAULT_STACK_ID,
        rootRun: null,
        wakeRun: null,
        r4Session: null,
        r4Run: null,
        only: null,
        waitSeconds: 0,
        timeoutSeconds: 30,
        out: null,
        json: false,
        dryRun: false,
        selftest: false,
        help: false,
    };
    const valueOf = (i, arg) => (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : String(argv[i + 1] ?? ""));
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
        switch (name) {
            case "--help":
            case "-h":
                out.help = true;
                break;
            case "--session":
                out.session = valueOf(i, arg);
                if (!arg.includes("=")) i += 1;
                break;
            case "--stack":
                out.stack = valueOf(i, arg) || DEFAULT_STACK_ID;
                if (!arg.includes("=")) i += 1;
                break;
            case "--root-run":
                out.rootRun = valueOf(i, arg);
                if (!arg.includes("=")) i += 1;
                break;
            case "--wake-run":
                out.wakeRun = valueOf(i, arg);
                if (!arg.includes("=")) i += 1;
                break;
            case "--r4-session":
                out.r4Session = valueOf(i, arg);
                if (!arg.includes("=")) i += 1;
                break;
            case "--r4-run":
                out.r4Run = valueOf(i, arg);
                if (!arg.includes("=")) i += 1;
                break;
            case "--only":
                out.only = valueOf(i, arg);
                if (!arg.includes("=")) i += 1;
                break;
            case "--wait":
                out.waitSeconds = Number(valueOf(i, arg));
                if (!arg.includes("=")) i += 1;
                break;
            case "--timeout":
                out.timeoutSeconds = Number(valueOf(i, arg));
                if (!arg.includes("=")) i += 1;
                break;
            case "--out":
                out.out = valueOf(i, arg);
                if (!arg.includes("=")) i += 1;
                break;
            case "--json":
                out.json = true;
                break;
            case "--dry-run":
                out.dryRun = true;
                break;
            case "--selftest":
                out.selftest = true;
                break;
            default:
                usageFail("unknown argument " + JSON.stringify(arg));
        }
    }
    if (out.help) return out;
    if (!Number.isFinite(out.waitSeconds) || out.waitSeconds < 0) usageFail("--wait must be a non-negative number of seconds");
    if (!Number.isFinite(out.timeoutSeconds) || out.timeoutSeconds <= 0) usageFail("--timeout must be a positive number of seconds");
    if (!out.selftest && !out.session && !out.wakeRun && !out.r4Run) usageFail("--session (or --wake-run / --r4-run) is required");
    for (const [flag, value] of [["--session", out.session], ["--root-run", out.rootRun], ["--wake-run", out.wakeRun], ["--r4-session", out.r4Session], ["--r4-run", out.r4Run]]) {
        if (value != null && !UUID_RE.test(String(value).trim())) usageFail(flag + " is not a UUID: " + JSON.stringify(value));
        if (value != null) out[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value).trim().toLowerCase();
    }
    if (out.only) {
        const wanted = out.only.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
        const unknown = wanted.filter((w) => !["R1", "R2", "R3", "R4"].includes(w));
        if (unknown.length) usageFail("--only accepts R1,R2,R3,R4; unknown: " + unknown.join(","));
        out.only = wanted;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    console.log(USAGE);
    process.exit(0);
}

const PG_USER = "xihe";

let derived;
try {
    derived = deriveStack(normalizeStackArg(args.stack));
} catch (error) {
    usageFail(String(error.message ?? error));
}

/** 每条读数实际发出的 SQL（dry-run 打印、JSON 存档、README 对账三处共用一份）。 */
const SQL_LOG = [];
/** 读侧状态：容器 id 只有在 preflight 探测到之后才可用。 */
const state = { container: null };
/** dry-run 模式：只记录 SQL，不真正执行（也不假装取到读数）。 */
let PREVIEW = false;
/** selftest 模式：SQL 边界换成固定 fixture 行，让四条判据本身可以无栈自检。 */
let SELFTEST = false;
let FIXTURES = {};

const SQL_READONLY = /^\s*(select|with)\b/i;

function dockerCapture(argv, options = {}) {
    const proc = spawnSync("docker", argv, {
        encoding: "utf8",
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 30000,
    });
    return {
        ok: proc.status === 0,
        code: proc.status,
        stdout: String(proc.stdout ?? "").trim(),
        stderr: String(proc.stderr ?? "").trim(),
        error: proc.error ? String(proc.error.message) : null,
    };
}

/**
 * 只读 SQL 的唯一出口：先断言语句是 select/with，再把结果包成单行 JSON 数组返回。
 * 这样内容里出现换行/竖线也不会破坏解析，且"脚本永不写库"是代码级的，不靠自觉。
 */
function psqlJson(sql, label) {
    if (!SQL_READONLY.test(sql)) {
        throw new Error("refusing to run a non-read statement (" + label + "): " + sql.slice(0, 80));
    }
    if (label) SQL_LOG.push({ label, sql: sql.replace(/\s+/g, " ").trim() });
    if (PREVIEW) return [];
    if (SELFTEST) return FIXTURES[label] ?? [];
    if (!state.container) throw new Error("psqlJson called before preflight (" + label + ")");
    const wrapped = "select coalesce(json_agg(t), '[]'::json)::text from (" + sql + ") t";
    const result = dockerCapture(
        ["exec", state.container, "psql", "-U", PG_USER, "-d", derived.database, "-v", "ON_ERROR_STOP=1", "-tA", "-c", wrapped],
        { timeoutMs: args.timeoutSeconds * 1000 },
    );
    if (!result.ok) {
        throw new Error("psql failed (exit=" + result.code + ") for " + (label ?? "sql") + ": " + (result.stderr || result.error || "").slice(0, 500));
    }
    const text = result.stdout.replace(/^\s+/, "");
    if (!text) return [];
    return JSON.parse(text);
}

async function probeHealth(port, healthPath) {
    try {
        const response = await fetch("http://127.0.0.1:" + port + healthPath, { signal: AbortSignal.timeout(5000) });
        return { path: healthPath, status: response.status, ok: response.ok };
    } catch (error) {
        return { path: healthPath, status: null, ok: false, error: String(error.message ?? error) };
    }
}

/**
 * 开窗前探测：栈不在就必须**大声**失败。返回 blockers 列表而不是抛异常，
 * 让 dry-run 与真跑共用同一份"缺什么"的叙述。
 */
async function preflight() {
    const blockers = [];
    const facts = {
        stack: derived.stackId,
        composeProject: derived.composeProject,
        database: derived.database,
        ports: derived.ports,
        repoRoot: REPO_ROOT,
    };

    const version = dockerCapture(["version", "--format", "{{.Server.Version}}"]);
    facts.docker = version.ok ? version.stdout : null;
    if (!version.ok) {
        blockers.push("docker 不可用（" + (version.stderr || version.error || "no output") + "）");
    } else {
        const ps = dockerCapture(["compose", "-p", derived.composeProject, "ps", "-q", "postgres"], { cwd: REPO_ROOT });
        const containerId = ps.ok ? String(ps.stdout.split(/\r?\n/)[0] ?? "") : "";
        facts.container = containerId || null;
        if (!ps.ok) blockers.push("docker compose ps 失败（" + (ps.stderr || ps.error || "") + "）");
        else if (!containerId) blockers.push("栈 " + derived.stackId + " 的 postgres 容器不存在（compose project=" + derived.composeProject + "）");
    }

    if (facts.container) {
        state.container = facts.container;
        const ping = dockerCapture(
            ["exec", facts.container, "psql", "-U", PG_USER, "-d", derived.database, "-v", "ON_ERROR_STOP=1", "-tAc", "select 1"],
            { timeoutMs: args.timeoutSeconds * 1000 },
        );
        facts.databaseReadable = ping.ok;
        if (!ping.ok) blockers.push("库 " + derived.database + " 不可读（" + (ping.stderr || ping.error || "").slice(0, 200) + "）");
    }

    const probes = [];
    for (const healthPath of CP_HEALTH_PATHS) probes.push(await probeHealth(derived.ports.cp, healthPath));
    facts.cpPort = derived.ports.cp;
    facts.cpProbes = probes;
    facts.cp = probes.find((probe) => probe.ok) ?? null;
    if (!facts.cp) blockers.push("CP 未就绪（http://127.0.0.1:" + derived.ports.cp + " 的 " + CP_HEALTH_PATHS.join(" / ") + " 都不通）");

    const head = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    const dirtyCount = spawnSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], { encoding: "utf8" });
    facts.gitHead = head.status === 0 ? head.stdout.trim() : null;
    facts.gitDirtyFiles = dirtyCount.status === 0 ? dirtyCount.stdout.split(/\r?\n/).filter(Boolean).length : null;

    return { ok: blockers.length === 0, blockers, facts };
}

// ---------------------------------------------------------------- 读侧取数（全部只读）

const q = (value) => "'" + String(value).replace(/'/g, "''") + "'";

function loadParticipants(sessionId) {
    return psqlJson(
        "select sp.id::text as participant_id, sp.principal_kind, sp.principal_id::text as principal_id,"
        + " case when sp.principal_kind = 'AGENT' then ap.name else u.username end as display_name,"
        + " sp.role, sp.order_index, sp.respond_policy, sp.wake_policy"
        + " from session_participants sp"
        + " left join agent_principals ap on sp.principal_kind = 'AGENT' and ap.id = sp.principal_id"
        + " left join users u on sp.principal_kind = 'HUMAN' and u.id = sp.principal_id"
        + " where sp.session_id = " + q(sessionId) + " order by sp.order_index",
        "participants",
    );
}

function loadRuns(sessionId) {
    return psqlJson(
        "select r.id::text as run_id, r.session_id::text as session_id, r.status, r.terminal_outcome,"
        + " r.trigger_source, r.agent_principal_id::text as agent_principal_id, r.user_id::text as user_id,"
        + " r.idempotency_key, r.parent_run_id::text as parent_run_id, r.created_at"
        + " from chat_runs r where r.session_id = " + q(sessionId)
        + " order by r.created_at desc limit 60",
        "runs",
    );
}

function loadRun(runId) {
    const rows = psqlJson(
        "select r.id::text as run_id, r.session_id::text as session_id, r.status, r.terminal_outcome,"
        + " r.trigger_source, r.agent_principal_id::text as agent_principal_id, r.user_id::text as user_id,"
        + " r.idempotency_key, r.parent_run_id::text as parent_run_id, r.created_at"
        + " from chat_runs r where r.id = " + q(runId),
        "run[" + runId + "]",
    );
    return rows[0] ?? null;
}

function loadRunMessages(runId) {
    return psqlJson(
        "select m.id::text as message_id, m.role, m.visibility, m.participant_id::text as participant_id,"
        + " m.created_at, m.content from messages m where m.run_id = " + q(runId) + " order by m.created_at",
        "messages[" + runId + "]",
    );
}

function loadWakeEvents(sessionId) {
    return psqlJson(
        "select ce.id::text as event_id, ce.created_at, ce.payload->>'wakeRoundId' as round,"
        + " ce.payload->>'participantId' as participant_id, ce.payload->>'triggerSource' as trigger,"
        + " ce.payload->>'outcome' as outcome, ce.payload->>'runId' as run_id,"
        + " ce.payload->>'parentRunId' as parent_run_id, ce.payload->>'reason' as reason"
        + " from context_events ce where ce.session_id = " + q(sessionId)
        + " and ce.event_type = 'wake_dispatch' order by ce.created_at desc limit 200",
        "wake_dispatch[" + sessionId + "]",
    );
}

/** 全库最近的 internal wake 提示词（R4 用；给了 --r4-session 就只看那个会话）。 */
function loadWakePrompts(sessionId) {
    return psqlJson(
        "select m.run_id::text as run_id, m.session_id::text as session_id, m.content, m.created_at,"
        + " r.trigger_source, r.status from messages m join chat_runs r on r.id = m.run_id"
        + " where m.role = 'USER' and m.visibility = 'internal' and m.content like '[% wake %'"
        + (sessionId ? " and m.session_id = " + q(sessionId) : "")
        + " order by m.created_at desc limit 40",
        "wake_prompts" + (sessionId ? "[" + sessionId + "]" : ""),
    );
}

const markerOf = (content) => {
    const match = WAKE_MARKER.exec(String(content ?? ""));
    if (!match) return null;
    return { label: match[1], round: match[2], sessionId: match[3].toLowerCase() };
};

const nameOfParticipant = (participants, participantId) => {
    if (!participantId) return null;
    const row = participants.find((item) => item.participant_id === participantId);
    return row ? row.display_name ?? null : null;
};

const promptOf = (messages) => messages.find((message) => message.role === "USER") ?? null;
const replyOf = (messages) => {
    const replies = messages.filter((message) => message.role === "ASSISTANT");
    return replies.length ? replies[replies.length - 1] : null;
};

// ---------------------------------------------------------------- R1

function readingR1(ctx) {
    const result = {
        id: "R1",
        title: "提交 run 归属：TO 里第一个 AGENT 目标拥有该次提交的 run",
        status: "NOT-COVERED",
        checks: [],
        facts: {},
        notes: [],
    };
    const check = (name, ok, detail) => result.checks.push({ name, ok, detail });

    let run = null;
    if (args.rootRun) {
        run = ctx.runs.find((row) => row.run_id === args.rootRun) ?? loadRun(args.rootRun);
    } else {
        run = ctx.runs.find((row) => row.trigger_source === "user"
            && row.agent_principal_id
            && !String(row.idempotency_key ?? "").startsWith("wake:")) ?? null;
    }
    if (!run) {
        result.notes.push("这个会话里没有「非 wake 的 user run」：先让人发一条 TO=[HUMAN, AGENT] 的消息再读。");
        return result;
    }

    result.facts.run = run;
    const messages = loadRunMessages(run.run_id);
    const userMessage = promptOf(messages);
    const owner = ctx.participants.find((row) => row.principal_kind === "AGENT"
        && row.principal_id === run.agent_principal_id) ?? null;

    check("run.trigger_source == 'user'（提交 run，不是 wake run）", run.trigger_source === "user", "trigger_source=" + run.trigger_source);
    check("run.agent_principal_id 属于本会话一个 AGENT 参与者", Boolean(owner),
        owner ? "owner=" + (owner.display_name ?? "(no name)") + " participant=" + owner.participant_id
            : "agent_principal_id=" + (run.agent_principal_id ?? "null"));
    check("该 run 的 USER 消息存在且非空", Boolean(userMessage && String(userMessage.content ?? "").trim()),
        userMessage ? "chars=" + String(userMessage.content).length + " visibility=" + userMessage.visibility : "no USER message");
    const userIsAwake = Boolean(userMessage && markerOf(userMessage.content));
    check("该 run 的 USER 消息是人类原文（不带 [<trigger> wake …] 标记）", Boolean(userMessage) && !userIsAwake,
        userIsAwake ? "USER message carries a wake marker — this run is a wake run, not a submission run" : "no wake marker");

    // TO 关系不在库里；同一 round 的 notify 事件是唯一佐证，缺了只降级成 WARN。
    const round = "wake:to:" + run.run_id;
    const toEvents = ctx.events.filter((event) => event.round === round);
    if (toEvents.length) {
        const notify = toEvents.filter((event) => event.outcome === "notify");
        check("TO 关系由同 round 的 wake_dispatch 事件佐证", true,
            "round=" + round + " events=" + toEvents.length + " notify=" + notify.length
            + " participants=" + toEvents.map((event) => (nameOfParticipant(ctx.participants, event.participant_id) ?? event.participant_id) + ":" + event.outcome).join(","));
        result.facts.toEvents = toEvents;
    } else {
        check("TO 关系由同 round 的 wake_dispatch 事件佐证", "warn",
            "没有 round=" + round + " 的事件：TO 里可能只有这一个 agent（没有人类目标被 notify），或事件早于本次读数窗口");
    }

    // 被指派方不是派发方：run 的发起人是 session owner 的人类账号，owner 是另一个参与者。
    const sender = ctx.participants.find((row) => row.principal_kind === "HUMAN" && row.principal_id === run.user_id) ?? null;
    check("被指派方 != 发起方", !owner || !sender || owner.participant_id !== sender.participant_id,
        "sender=" + (sender ? sender.display_name : run.user_id) + " owner=" + (owner ? owner.display_name : run.agent_principal_id));

    result.facts.userMessage = userMessage;
    result.facts.owner = owner;
    const hardChecks = result.checks.filter((item) => item.ok !== "warn");
    result.status = hardChecks.every((item) => item.ok === true) ? "PASS" : "FAIL";
    return result;
}

// ---------------------------------------------------------------- R2

/**
 * 定位"被唤醒的 run"：优先显式 --wake-run，其次按 wake_dispatch 事件（有 runId 的）
 * 找最新一条提示词确实存在的。返回 {event, run, prompt, messages} 或 null。
 */
function locateWakeTarget(ctx) {
    if (args.wakeRun) {
        const run = ctx.runs.find((row) => row.run_id === args.wakeRun) ?? loadRun(args.wakeRun);
        if (!run) return null;
        const messages = loadRunMessages(run.run_id);
        const event = ctx.events.find((row) => row.run_id === run.run_id) ?? null;
        return { event, run, prompt: promptOf(messages), messages };
    }
    const candidates = ctx.events.filter((event) => event.run_id);
    for (const event of candidates) {
        const run = ctx.runs.find((row) => row.run_id === event.run_id) ?? loadRun(event.run_id);
        if (!run) continue;
        const messages = loadRunMessages(run.run_id);
        const prompt = promptOf(messages);
        if (!prompt) continue;
        return { event, run, prompt, messages };
    }
    return null;
}

function readingR2(ctx) {
    const result = {
        id: "R2",
        title: "被唤醒 run 的提示词点名被指派方（You are <displayName>.）",
        status: "NOT-COVERED",
        checks: [],
        facts: {},
        notes: [],
    };
    const check = (name, ok, detail) => result.checks.push({ name, ok, detail });

    const target = locateWakeTarget(ctx);
    if (!target) {
        result.notes.push("会话里没有可读的 wake run：幕 2 需要 TO=[AGENT A, AGENT B]（A 持提交 run、B 被 wake），或 mention/chain 唤醒。");
        return result;
    }
    ctx.wakeTarget = target;
    const { event, run, prompt } = target;
    result.facts.run = run;
    result.facts.event = event;
    result.facts.prompt = prompt ? { visibility: prompt.visibility, chars: String(prompt.content).length } : null;

    const content = String(prompt.content ?? "");
    result.facts.promptHead = content.split(/\r?\n/).slice(0, 6);
    check("wake run 有 internal USER 提示词", Boolean(content.trim()),
        "visibility=" + prompt.visibility + " chars=" + content.length);
    const marker = markerOf(content);
    check("提示词以 [<trigger> wake <round>] 开头", Boolean(marker), marker ? JSON.stringify(marker) : "no marker");
    if (marker) {
        result.facts.marker = marker;
        check("marker 的 trigger 与 wake_dispatch 事件一致", !event || !event.trigger || marker.label === event.trigger,
            "marker=" + marker.label + " event=" + (event?.trigger ?? "(no event)"));
        check("marker 的 sessionId 是该会话", marker.sessionId === run.session_id,
            "marker=" + marker.sessionId + " run.session=" + run.session_id);
    }

    const addresseeId = event?.participant_id ?? (ctx.participants.find((row) => row.principal_id === run.agent_principal_id)?.participant_id ?? null);
    const addressee = ctx.participants.find((row) => row.participant_id === addresseeId) ?? null;
    const expectedName = addressee?.display_name ?? null;
    result.facts.addressee = addressee;
    result.facts.expectedName = expectedName;
    check("被唤醒的 participant 在名册里且有 displayName", Boolean(addressee && expectedName),
        addressee ? "participant=" + addressee.participant_id + " name=" + (expectedName ?? "(null)") : "participant=" + (addresseeId ?? "null"));

    if (expectedName) {
        const line = "You are " + expectedName + ".";
        check("提示词含 'You are " + expectedName + ".'", content.includes(line), content.includes(line) ? "found" : "missing");
        check("提示词没有落到兜底称呼", !content.includes("You are a participant of this conversation."),
            content.includes("You are a participant of this conversation.") ? "fell back — displayNameOf() returned null at build time" : "ok");
    }

    const hasExcerpt = content.includes("Triggering message");
    if (hasExcerpt) {
        check("提示词声明'是另一个参与者派给你的'", content.includes("addressed to you by another participant"),
            content.includes("addressed to you by another participant") ? "found" : "missing");
        check("提示词要求用被指派方口吻回答", content.includes("answer as the addressee, in your own voice, not in the sender"),
            content.includes("answer as the addressee, in your own voice, not in the sender") ? "found" : "missing");
        const nameAt = content.indexOf("You are ");
        const triggerAt = content.indexOf("Triggering message");
        check("身份句出现在触发消息正文之前", nameAt >= 0 && nameAt < triggerAt, "You-are@" + nameAt + " Triggering@" + triggerAt);
    } else {
        result.notes.push("这条 wake 没有正文（schedule/guard 形态）：身份句与 R4 一起判，R2 的正文段不适用。");
    }

    result.status = result.checks.every((item) => item.ok === true) ? "PASS" : "FAIL";
    return result;
}

// ---------------------------------------------------------------- R3

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 回复里冒名自我指称的机判代理：我（其它参与者）/ 我是其它参与者 / I am 其它参与者。 */
function impersonationHits(reply, otherNames) {
    const hits = [];
    const text = String(reply ?? "");
    for (const name of otherNames) {
        const escaped = escapeRegex(name);
        const patterns = [
            new RegExp("我[（(]\\s*" + escaped + "\\s*[）)]"),
            new RegExp("我是\\s*" + escaped + "(?![A-Za-z0-9_])"),
            new RegExp("I am\\s+" + escaped + "(?![A-Za-z0-9_])", "i"),
        ];
        for (const pattern of patterns) {
            const match = pattern.exec(text);
            if (match) hits.push({ name, match: match[0] });
        }
    }
    return hits;
}

async function readingR3(ctx) {
    const result = {
        id: "R3",
        title: "被指派方用自己的口吻回答（归属正确、无冒名自我指称）",
        status: "NOT-COVERED",
        checks: [],
        facts: {},
        notes: [],
    };
    const check = (name, ok, detail) => result.checks.push({ name, ok, detail });

    const target = ctx.wakeTarget ?? locateWakeTarget(ctx);
    if (!target) {
        result.notes.push("没有可判的 wake run（同 R2）：先造一条被唤醒的 agent run。");
        return result;
    }
    ctx.wakeTarget = target;
    const { event, run } = target;
    const addresseeId = event?.participant_id
        ?? ctx.participants.find((row) => row.principal_id === run.agent_principal_id)?.participant_id
        ?? null;
    const addressee = ctx.participants.find((row) => row.participant_id === addresseeId) ?? null;
    result.facts.run = run;
    result.facts.addressee = addressee;

    let messages = loadRunMessages(run.run_id);
    let reply = replyOf(messages);
    const deadline = Date.now() + args.waitSeconds * 1000;
    while (!reply && Date.now() < deadline) {
        await sleep(3000);
        messages = loadRunMessages(run.run_id);
        reply = replyOf(messages);
    }

    check("wake run 有 ASSISTANT 回复", Boolean(reply), reply ? "message=" + reply.message_id : "none (run.status=" + run.status + ")");
    if (!reply) {
        result.notes.push("run 还没产出回复：窗内用 --wait 60 等它终态，或稍后重跑同一命令。");
        result.status = "PENDING";
        return result;
    }

    const replyAuthor = ctx.participants.find((row) => row.participant_id === reply.participant_id) ?? null;
    result.facts.replyAuthor = replyAuthor;
    result.facts.replyExcerpt = String(reply.content ?? "").slice(0, 400);
    check("回复的 messages.participant_id == 被唤醒的 participant", Boolean(addressee) && reply.participant_id === addressee.participant_id,
        "reply.participant=" + (replyAuthor ? replyAuthor.display_name + "/" + reply.participant_id : reply.participant_id)
        + " addressee=" + (addressee ? addressee.display_name + "/" + addressee.participant_id : addresseeId));

    const selfName = addressee?.display_name ?? null;
    const otherNames = ctx.participants
        .filter((row) => row.display_name && row.participant_id !== addressee?.participant_id)
        .map((row) => row.display_name);
    const hits = impersonationHits(reply.content, otherNames);
    check("回复里没有把别的参与者当成自己（我（X）/我是 X/I am X）", hits.length === 0,
        hits.length ? hits.map((hit) => hit.match).join(" | ") : "no impersonation pattern");
    const selfMentions = selfName ? (String(reply.content).match(new RegExp(escapeRegex(selfName), "g")) ?? []).length : 0;
    result.facts.selfMentions = selfMentions;
    result.notes.push("口吻是否「真用自己的话」仍需人工复核：看 reply excerpt，判据是它讲自己被指派这件事，而不是复述派发方的视角。");

    result.status = result.checks.every((item) => item.ok === true) ? "PASS" : "FAIL";
    return result;
}

// ---------------------------------------------------------------- R4

function readingR4(ctx) {
    const result = {
        id: "R4",
        title: "无正文 wake 不撒谎（schedule/guard 提示词不声称有触发消息）",
        status: "NOT-COVERED",
        checks: [],
        facts: {},
        notes: [],
    };
    const check = (name, ok, detail) => result.checks.push({ name, ok, detail });

    let candidate = null;
    if (args.r4Run) {
        const run = ctx.runs.find((row) => row.run_id === args.r4Run) ?? loadRun(args.r4Run);
        if (run) {
            const prompt = promptOf(loadRunMessages(run.run_id));
            if (prompt) candidate = { run, content: String(prompt.content ?? "") };
        }
        if (!candidate) {
            result.notes.push("--r4-run 指向的 run 没有 internal USER 提示词：确认它是 schedule/guard wake 的 run。");
            return result;
        }
    } else {
        const prompts = loadWakePrompts(args.r4Session ?? null);
        const emptyBody = prompts.filter((row) => {
            const marker = markerOf(row.content);
            return marker && ["schedule", "guard"].includes(marker.label) && !String(row.content).includes("Triggering message");
        });
        const withBody = prompts.filter((row) => {
            const marker = markerOf(row.content);
            return marker && ["schedule", "guard"].includes(marker.label);
        });
        const picked = emptyBody[0] ?? withBody[0] ?? null;
        if (picked) candidate = { run: { run_id: picked.run_id, session_id: picked.session_id, status: picked.status, trigger_source: picked.trigger_source }, content: String(picked.content ?? "") };
        if (picked && !emptyBody.length) {
            result.notes.push("只找到带正文的 schedule/guard wake：R4 判的是空正文形态，请用 --r4-run 指一条空正文的（或等一次无正文的定时唤醒）。");
        }
    }
    if (!candidate) {
        result.notes.push("库内没有 schedule/guard wake 的 internal 提示词：R4 需要一次无正文的定时/守卫唤醒。");
        return result;
    }

    const content = candidate.content;
    result.facts.run = candidate.run;
    result.facts.promptHead = content.split(/\r?\n/).slice(0, 5);
    const marker = markerOf(content);
    result.facts.marker = marker;
    check("提示词属于 schedule/guard wake", Boolean(marker) && ["schedule", "guard"].includes(marker.label), marker ? "label=" + marker.label : "no marker");
    check("无正文形态给出下一步动作（Respond to the conversation in your own voice.）",
        content.includes("Respond to the conversation in your own voice."),
        content.includes("Respond to the conversation in your own voice.") ? "found" : "missing");
    check("不声称有触发消息（无 'Triggering message'）", !content.includes("Triggering message"),
        content.includes("Triggering message") ? "claims a triggering message" : "clean");
    check("不声称'是另一个参与者派给你的'", !content.includes("addressed to you by another participant"),
        content.includes("addressed to you by another participant") ? "false addressee claim" : "clean");

    result.status = result.checks.every((item) => item.ok === true) ? "PASS" : "FAIL";
    return result;
}

// ---------------------------------------------------------------- 输出

const STATUS_MARK = { PASS: "PASS", FAIL: "FAIL", PENDING: "PENDING", "NOT-COVERED": "NOT-COVERED" };

function printFacts(facts) {
    console.log("[M2] 环境: stack=" + facts.stack + " project=" + facts.composeProject + " db=" + facts.database
        + " cp=:" + facts.cpPort + " pg=:" + facts.ports.postgres);
    console.log("[M2] container=" + (facts.container ?? "(none)") + " docker=" + (facts.docker ?? "(unavailable)")
        + " cpHealth=" + (facts.cp ? facts.cp.path + " " + facts.cp.status : "unreachable"));
    console.log("[M2] git=" + (facts.gitHead ?? "(unknown)") + " dirtyFiles=" + (facts.gitDirtyFiles ?? "?"));
}

function printReading(result) {
    console.log("");
    console.log("[" + result.id + "] " + result.title);
    console.log("  status: " + (STATUS_MARK[result.status] ?? result.status));
    for (const item of result.checks) {
        const mark = item.ok === true ? "ok  " : item.ok === "warn" ? "warn" : "FAIL";
        console.log("  - " + mark + " " + item.name + (item.detail ? "  (" + item.detail + ")" : ""));
    }
    for (const note of result.notes) console.log("  note: " + note);
    if (result.facts?.promptHead) {
        console.log("  prompt head:");
        for (const line of result.facts.promptHead) console.log("    | " + line);
    }
    if (result.facts?.replyExcerpt) console.log("  reply excerpt: " + result.facts.replyExcerpt);
}

function printDryRun(pre, placeholder) {
    console.log("[M2] DRY RUN —— 没有发出任何读数查询，也没有写任何东西。");
    printFacts(pre.facts);
    if (pre.ok) {
        console.log("[M2] preflight: OK（栈在，可以真跑）");
    } else {
        console.log("[M2] preflight: BLOCKED（exit 2，不会给出 PASS）");
        for (const blocker of pre.blockers) console.log("  - " + blocker);
        console.log("[M2] 修法: 在 A03-xihe 里起栈（mise run dev:host），或确认栈号 --stack <N> 与实际在跑的栈一致。");
    }
    console.log("[M2] 真跑时会发的只读语句（session 以 " + placeholder + " 代入）：");
    const seen = new Set();
    for (const entry of SQL_LOG) {
        const key = entry.label + "|" + entry.sql;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log("  · [" + entry.label + "] " + entry.sql);
    }
}

// ---------------------------------------------------------------- selftest

/**
 * 无栈自检：SQL 边界换成固定 fixture 行，走**同一条** readingR1..R4 代码路径，
 * 断言四条判据对"该绿的样本"绿、对"该红的反例"红。窗内真栈只负责取数，
 * 判据本身在开窗前就有据可依（不是靠"看起来对"）。
 */
const SELFTEST_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fixtureParticipants() {
    return [
        { participant_id: "11111111-1111-4111-8111-111111111111", principal_kind: "HUMAN", principal_id: "99999999-9999-4999-8999-999999999999", display_name: "admin", role: "MEMBER", order_index: 0, respond_policy: "MUTED", wake_policy: "MENTION" },
        { participant_id: "22222222-2222-4222-8222-222222222222", principal_kind: "AGENT", principal_id: "aaaaaaaa-0000-4000-8000-000000000001", display_name: "xhLead", role: "PRIMARY", order_index: 1, respond_policy: "ALWAYS", wake_policy: "ALL_MESSAGES" },
        { participant_id: "33333333-3333-4333-8333-333333333333", principal_kind: "AGENT", principal_id: "aaaaaaaa-0000-4000-8000-000000000002", display_name: "ewLead", role: "MEMBER", order_index: 2, respond_policy: "WHEN_MENTIONED", wake_policy: "MENTION" },
    ];
}

const SELFTEST_RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const SELFTEST_WAKE_RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

function fixtureRuns(ownerPrincipalId) {
    return [
        { run_id: SELFTEST_WAKE_RUN, session_id: SELFTEST_SESSION, status: "succeeded", terminal_outcome: null, trigger_source: "to", agent_principal_id: "aaaaaaaa-0000-4000-8000-000000000002", user_id: "99999999-9999-4999-8999-999999999999", idempotency_key: "wake:to:agent:" + SELFTEST_RUN, parent_run_id: null, created_at: "2026-11-19T10:00:05Z" },
        { run_id: SELFTEST_RUN, session_id: SELFTEST_SESSION, status: "succeeded", terminal_outcome: null, trigger_source: "user", agent_principal_id: ownerPrincipalId, user_id: "99999999-9999-4999-8999-999999999999", idempotency_key: "selftest-1", parent_run_id: null, created_at: "2026-11-19T10:00:00Z" },
    ];
}

function fixtureEvents() {
    return [
        { event_id: "e2", created_at: "2026-11-19T10:00:05Z", round: "wake:to:agent:" + SELFTEST_RUN, participant_id: "33333333-3333-4333-8333-333333333333", trigger: "to", outcome: "submitted", run_id: SELFTEST_WAKE_RUN, parent_run_id: null, reason: null },
        { event_id: "e1", created_at: "2026-11-19T10:00:01Z", round: "wake:to:" + SELFTEST_RUN, participant_id: "11111111-1111-4111-8111-111111111111", trigger: "to", outcome: "notify", run_id: null, parent_run_id: null, reason: null },
    ];
}

const SELFTEST_ASK = "除了我（xhLead）之外，这三条派给 ewLead。";

function fixturePromptFixed() {
    return "[" + "to wake wake:to:agent:" + SELFTEST_RUN + "] session=" + SELFTEST_SESSION + "\n"
        + "You are ewLead. The message below was addressed to you by another participant: answer as the addressee, in your own voice, not in the sender's.\n\n"
        + "Triggering message:\n\n" + SELFTEST_ASK + "\n\n"
        + "Answer that message as your own turn. Do not describe the wake signal.";
}

function fixturePromptLegacy() {
    return "[" + "to wake wake:to:agent:" + SELFTEST_RUN + "] session=" + SELFTEST_SESSION + "\n\n"
        + "Triggering message:\n\n" + SELFTEST_ASK + "\n\n"
        + "Answer that message as your own turn. Do not describe the wake signal.";
}

function fixtureMessages(prompt, reply, replyParticipantId) {
    const rows = [
        { message_id: "m1", role: "USER", visibility: "user", participant_id: null, created_at: "2026-11-19T10:00:00Z", content: "把这三条派给 ewLead：核对读数、贴结论、回一行。" },
        { message_id: "m2", role: "USER", visibility: "internal", participant_id: null, created_at: "2026-11-19T10:00:05Z", content: prompt },
    ];
    if (reply != null) {
        rows.push({ message_id: "m3", role: "ASSISTANT", visibility: "user", participant_id: replyParticipantId, created_at: "2026-11-19T10:00:20Z", content: reply });
    }
    return rows;
}

function fixtureSchedulePrompts(content) {
    return [{ run_id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", session_id: SELFTEST_SESSION, content, created_at: "2026-11-19T09:00:00Z", trigger_source: "schedule", status: "succeeded" }];
}

const SCHEDULE_GOOD = "[schedule wake wake:schedule:1] session=" + SELFTEST_SESSION + "\n"
    + "You are ewLead. Respond to the conversation in your own voice.";
const SCHEDULE_BAD = "[schedule wake wake:schedule:1] session=" + SELFTEST_SESSION + "\n"
    + "You are ewLead. The message below was addressed to you by another participant: answer as the addressee, in your own voice, not in the sender's.\n\n"
    + "Triggering message:\n\n请复述。";

async function selftest() {
    SELFTEST = true;
    const scenarios = [
        {
            name: "修好之后的样本：四条都该绿",
            runs: fixtureRuns("aaaaaaaa-0000-4000-8000-000000000001"),
            events: fixtureEvents(),
            prompt: fixturePromptFixed(),
            reply: "收到，我来核对这三条读数，先跑 R1 再贴结论。",
            replyParticipant: "33333333-3333-4333-8333-333333333333",
            schedule: SCHEDULE_GOOD,
            expect: { R1: "PASS", R2: "PASS", R3: "PASS", R4: "PASS" },
        },
        {
            name: "修复前的提示词（没有身份句）：R2 必须红",
            runs: fixtureRuns("aaaaaaaa-0000-4000-8000-000000000001"),
            events: fixtureEvents(),
            prompt: fixturePromptLegacy(),
            reply: "收到，我来核对这三条读数。",
            replyParticipant: "33333333-3333-4333-8333-333333333333",
            schedule: SCHEDULE_GOOD,
            expect: { R2: "FAIL" },
        },
        {
            name: "被唤醒方复述派发方口吻（我（xhLead））：R3 必须红",
            runs: fixtureRuns("aaaaaaaa-0000-4000-8000-000000000001"),
            events: fixtureEvents(),
            prompt: fixturePromptFixed(),
            reply: "我（xhLead）已经把这三条派给 ewLead 了，稍后同步结果。",
            replyParticipant: "33333333-3333-4333-8333-333333333333",
            schedule: SCHEDULE_GOOD,
            expect: { R3: "FAIL" },
        },
        {
            name: "无正文 schedule wake 却声称有触发消息：R4 必须红",
            runs: fixtureRuns("aaaaaaaa-0000-4000-8000-000000000001"),
            events: fixtureEvents(),
            prompt: fixturePromptFixed(),
            reply: "收到，我来核对这三条读数。",
            replyParticipant: "33333333-3333-4333-8333-333333333333",
            schedule: SCHEDULE_BAD,
            expect: { R4: "FAIL" },
        },
        {
            name: "提交 run 的 agent_principal 不是本会话参与者：R1 必须红",
            runs: fixtureRuns("aaaaaaaa-0000-4000-8000-0000000000ff"),
            events: fixtureEvents(),
            prompt: fixturePromptFixed(),
            reply: "收到，我来核对这三条读数。",
            replyParticipant: "33333333-3333-4333-8333-333333333333",
            schedule: SCHEDULE_GOOD,
            expect: { R1: "FAIL" },
        },
        {
            name: "回复还没落地：R3 必须是 PENDING 而不是 PASS",
            runs: fixtureRuns("aaaaaaaa-0000-4000-8000-000000000001"),
            events: fixtureEvents(),
            prompt: fixturePromptFixed(),
            reply: null,
            replyParticipant: null,
            schedule: SCHEDULE_GOOD,
            expect: { R3: "PENDING" },
        },
    ];

    let mismatches = 0;
    for (const scenario of scenarios) {
        const messages = fixtureMessages(scenario.prompt, scenario.reply, scenario.replyParticipant);
        FIXTURES = {
            participants: fixtureParticipants(),
            runs: scenario.runs,
            events: scenario.events,
            ["messages[" + SELFTEST_RUN + "]"]: messages.filter((row) => row.role !== "ASSISTANT" || row.message_id === "m3"),
            ["messages[" + SELFTEST_WAKE_RUN + "]"]: messages.filter((row) => row.message_id !== "m1"),
            wake_prompts: fixtureSchedulePrompts(scenario.schedule),
        };
        const ctx = { sessionId: SELFTEST_SESSION, participants: FIXTURES.participants, runs: FIXTURES.runs, events: FIXTURES.events, wakeTarget: null };
        const results = [readingR1(ctx), readingR2(ctx), await readingR3(ctx), readingR4(ctx)];
        const got = Object.fromEntries(results.map((row) => [row.id, row.status]));
        const wrong = Object.entries(scenario.expect).filter(([id, status]) => got[id] !== status);
        console.log("[selftest] " + (wrong.length ? "FAIL" : "ok  ") + " " + scenario.name);
        console.log("           expect " + JSON.stringify(scenario.expect) + " got " + JSON.stringify(got));
        for (const [id, status] of wrong) {
            mismatches += 1;
            const reading = results.find((row) => row.id === id);
            const failing = reading.checks.filter((item) => item.ok !== true && item.ok !== "warn");
            console.log("           " + id + " 应为 " + status + "，实得 " + got[id] + "；失败检查: " + (failing.map((item) => item.name).join(" | ") || "(none)"));
        }
    }
    console.log("[selftest] " + (mismatches ? "FAILED (" + mismatches + " 处判据与预期不符)" : "PASSED（六种样本的判据与预期一致）"));
    process.exit(mismatches ? 1 : 0);
}

// ---------------------------------------------------------------- main

async function main() {
    if (args.selftest) {
        await selftest();
        return;
    }
    const pre = await preflight();

    if (args.dryRun) {
        PREVIEW = true;
        const placeholder = args.session ?? args.wakeRun ?? args.r4Session ?? "00000000-0000-4000-8000-000000000000";
        loadParticipants(placeholder);
        loadRuns(placeholder);
        loadRunMessages(placeholder);
        loadWakeEvents(placeholder);
        loadWakePrompts(args.r4Session ?? null);
        const payload = { mode: "dry-run", preflight: pre, sql: SQL_LOG };
        if (args.json) console.log(JSON.stringify(payload, null, 2));
        else printDryRun(pre, placeholder);
        process.exit(pre.ok ? 0 : 2);
    }

    if (!pre.ok) {
        console.error("[M2] BLOCKED —— 栈不在，读不到任何读数（exit 2，不假绿）。");
        if (args.json) {
            console.log(JSON.stringify({ mode: "blocked", preflight: pre }, null, 2));
        } else {
            printFacts(pre.facts);
            for (const blocker of pre.blockers) console.error("  - " + blocker);
            console.error("[M2] 修法: 在 A03-xihe 里起栈（mise run dev:host），或确认 --stack <N> 与实际在跑的栈一致。");
        }
        process.exit(2);
    }

    let sessionId = args.session ?? null;
    if (!sessionId && (args.wakeRun || args.r4Run)) {
        const anchorRun = loadRun(args.wakeRun ?? args.r4Run);
        sessionId = anchorRun?.session_id ?? null;
    }

    const ctx = {
        sessionId,
        participants: sessionId ? loadParticipants(sessionId) : [],
        runs: sessionId ? loadRuns(sessionId) : [],
        events: sessionId ? loadWakeEvents(sessionId) : [],
        wakeTarget: null,
    };

    const wanted = args.only ?? ["R1", "R2", "R3", "R4"];
    const results = [];
    if (wanted.includes("R1")) results.push(readingR1(ctx));
    if (wanted.includes("R2")) results.push(readingR2(ctx));
    if (wanted.includes("R3")) results.push(await readingR3(ctx));
    if (wanted.includes("R4")) results.push(readingR4(ctx));

    const summary = {
        generatedAt: new Date().toISOString(),
        mode: "read",
        stack: derived.stackId,
        sessionId,
        preflight: pre,
        readings: results,
        sql: SQL_LOG,
        verdict: {
            pass: results.filter((row) => row.status === "PASS").length,
            fail: results.filter((row) => row.status === "FAIL").length,
            pending: results.filter((row) => row.status === "PENDING").length,
            notCovered: results.filter((row) => row.status === "NOT-COVERED").length,
        },
    };
    const allPass = results.length > 0 && results.every((row) => row.status === "PASS");
    summary.verdict.exitCode = allPass ? 0 : 1;

    if (args.json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        printFacts(pre.facts);
        for (const result of results) printReading(result);
        console.log("");
        console.log("[M2] VERDICT: " + summary.verdict.pass + " PASS / " + summary.verdict.fail + " FAIL / "
            + summary.verdict.pending + " PENDING / " + summary.verdict.notCovered + " NOT-COVERED"
            + " ⇒ " + (allPass ? "四条全过（exit 0）" : "未达判据（exit 1）"));
        if (!allPass) {
            console.log("[M2] 窗内顺序: R1 幕 1（TO=[HUMAN, AGENT]）→ R2/R3 幕 2（TO=[AGENT A, AGENT B]）→ R4（无正文 schedule/guard wake）；详见 evidence README。");
        }
    }

    if (args.out) {
        const fs = await import("node:fs");
        fs.writeFileSync(args.out, JSON.stringify(summary, null, 2) + "\n", "utf8");
        if (!args.json) console.log("[M2] 读数已写入 " + args.out);
    }

    process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
    console.error("[M2] ERROR: " + (error?.stack ?? error));
    process.exit(2);
});
