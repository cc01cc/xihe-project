#!/usr/bin/env node
/**
 * task-95 ② —— 把「建会话 → 发消息 → 等终态」变成**一条命令**，输出 **receipt**（机读）。
 *
 * <h3>为什么需要它</h3>
 * <p>CLI 早就有 `chat send`（POST /api/v1/chat）与 `events tail`（GET /api/v1/events），
 * 但**没有一条「发一条消息并等到终态」的组合**；而这条组合正是两个下游共同的动词：</p>
 * <ul>
 *   <li>webui 自审：把页面推到固定点再截图（需要一个确定存在、确定终态的会话）；</li>
 *   <li>RSI：非交互跑一次 agent，把结果变成可判定的机器读数。</li>
 * </ul>
 * <p>没有它时，两处各自用「curl + 人眼看事件 + 猜多久算完」拼流程 —— 这与 task-93 要消灭的
 * 「靠人读当作判据」是同一种病。</p>
 *
 * <h3>契约：借 receipt 的形状，但**不**进 GATES（Lead 裁定③ 方案 b）</h3>
 * <ul>
 *   <li><b>逐字复用</b> `SCHEMA_VERSION` / `VERDICTS` / `CODES` / `createReceipt`；</li>
 *   <li><b>复用「假绿」语义</b>：`verdict=pass` 但 `executed.events` 不是正数 ⇒ 判 error；
 *       超时同样判 error，不许 pass；</li>
 *   <li><b>不往 `GATES` 加第 8 条</b>，也不让 `gate-receipt-read` 认识 drive 门。</li>
 * </ul>
 *
 * <h3>为什么 `validateDriveReceipt` 不直接调 `validateReceipt` 就完事（必须说清）</h3>
 * <p>`scripts/lib/gate-receipt.mjs#validateReceipt` 会做 `if (!GATES[r.gate]) problems.push('未知门 …')`
 * —— 它的结构判据全都可复用，**唯独这一条成员资格检查对 drive 恒假**。所以本文件的做法是：
 * 先调共享校验器，再按白名单减去一类问题，白名单是「**消息形态 + gate 取值**」双重限制：</p>
 * <pre>
 *   只有当 r.gate === 'drive-chat' 且问题文本命中 /^未知门 / 时才减去 ⇒ 其它任何 problem 一个都不吞
 *   别人塞一个未注册的其它 gate ⇒ 仍报错（用例里有一条负例钉着）
 * </pre>
 * <p>字符串耦合是这条写法的代价；对应的护栏是**用例**：一旦 task-93 那边改了「未知门」的文案，
 * 用例会红（而不是静默放行）。</p>
 *
 * <h3>落盘目录**必须**与 gate receipts 分开</h3>
 * <p>drive receipt 的 `gate` 不在 `GATES` 里。若与门批次同目录，`gate-receipt-read.mjs <dir>`
 * 会读到一条「未知门」⇒ 整批判 ERROR（一行坏数据拖垮一批真门的结论）。故默认写
 * `<repo>/.tmp/xh/receipts/drive/`；**不要把这个目录挪到门批次目录下**（用例钉着）。
 * `.tmp` 已被 `.gitignore` 的 `*.tmp` 覆盖（`git check-ignore` 实测），不会污染工作树。</p>
 *
 * <h3>流程（每一步都是实测过的 CP 前置，不是抄来的顺序）</h3>
 * <ol>
 *   <li>登录（复用 `provider.mjs#login`：XIHE_TOKEN → 缓存 → 环境密码，绝不从 argv 读密码）；</li>
 *   <li>解析会话绑定（复用 `session-binding.mjs`：READY chat 连接 + 已发布 api-request-template，
 *       缺这两项 CP 会 409 API_TYPE_REBIND_REQUIRED）；</li>
 *   <li>建会话 + 取 root branch；</li>
 *   <li><b>先开 SSE 并等到 `connected`</b>：CP `ChatController.java:813` 要求
 *       `sseManager.hasEmitter(sessionId)`，否则 `POST /api/v1/chat` 直接 409
 *       `SSE_SUBSCRIPTION_REQUIRED`（传输前置，不是限流）；开着流的同时统计事件数；</li>
 *   <li>POST /chat → runId；轮询 `GET /api/v1/chat/runs/{runId}` 到终态
 *       （终态集取自 `ChatRunRepository`：succeeded/failed/partial/ambiguous/cancelled）；</li>
 *   <li>关流结算事件数 → 收尾（默认删掉本次建的会话；`--keep-session` 保留给截图用）→ 产 receipt。</li>
 * </ol>
 *
 * <p><b>退出码</b>（沿用 CLI 契约）：0 = pass；1 = fail/error（receipt 的 `verdict` 区分二者）；
 * 2 = 用法错误。`pass` 的唯一路径是「终态成功 **且** 事件数 > 0」。</p>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODES, VERDICTS, createReceipt, validateReceipt } from '../lib/gate-receipt.mjs';
import { CliError, login, parseOptions } from './provider.mjs';
import { bindingRequestBody, resolveSessionBinding } from './session-binding.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

/** drive receipt 的 gate 名。**故意**不在 `GATES` 里 —— 它不是门。 */
export const DRIVE_GATE = 'drive-chat';

/**
 * gate receipts 之外**唯一**允许的落点。挪动它会 poison 门批次（见文件头）。
 * @returns {string} 绝对路径
 */
export function driveReceiptDir(root = projectRoot) {
    return path.join(root, '.tmp', 'xh', 'receipts', 'drive');
}

const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_TIMEOUT_SECONDS = 3600;
const POLL_INTERVAL_MS = 500;
const SSE_CONNECT_TIMEOUT_MS = 10_000;
const SSE_BUFFER_LIMIT = 256 * 1024;
/** 终态之后再看多久事件（事件可能比 run 状态晚到一帧）。0 事件时用满，有事件立刻退出。 */
const SETTLE_MS = 1_000;
/** 事件名样本上限：receipt 要能读，不能把整条流倒进去。 */
const MAX_EVENT_SAMPLES = 40;

// ChatRunRepository：active = accepted/queued/running/streaming/awaiting_approval/dispatching，
// terminal = 下面这五个（与 xihe-cli/verify.mjs:22 同一口径；那边未导出，故此处重复常量 ——
// 权威定义在 CP 侧，两处都只是读它）。
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'partial', 'ambiguous', 'cancelled']);
const TERMINAL_SUCCESS = 'succeeded';

/** 共享校验器「未知门」那一类问题的文案形态。白名单只减这一种，且只在 gate === DRIVE_GATE 时减。 */
const UNKNOWN_GATE_PROBLEM = /^未知门 /;

function usageError(message) {
    // 4th arg absent: INVALID_ARGUMENT maps to exit 2 (provider.mjs#exitCodeFor).
    return new CliError('INVALID_ARGUMENT', message);
}

function positiveSeconds(raw, fallback) {
    if (raw === undefined) return fallback;
    if (!/^\d{1,4}$/.test(String(raw))) {
        throw usageError('--timeout must be an integer number of seconds.');
    }
    const value = Number(raw);
    if (value < 1 || value > MAX_TIMEOUT_SECONDS) {
        throw usageError(`--timeout must be between 1 and ${MAX_TIMEOUT_SECONDS} seconds.`);
    }
    return value;
}

/** 与 run-agent-e2e/verify 同形的瘦客户端：HTTP 失败变成**数据**而不是异常（判据要落进 receipt）。 */
function createClient({ apiBase, fetchImpl, token, workspaceId }) {
    return {
        async call(method, pathname, { body, timeoutMs = 10_000 } = {}) {
            const headers = { Authorization: `Bearer ${token}` };
            if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            let response;
            try {
                response = await fetchImpl(`${apiBase}${pathname}`, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (error) {
                const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
                return { status: 0, body: null, code: aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED' };
            }
            let text = '';
            try { text = await response.text(); } catch { /* 状态码已经带结论 */ }
            let parsed = null;
            if (text.trim() !== '') {
                try { parsed = JSON.parse(text); } catch { parsed = null; }
            }
            return {
                status: response.status,
                body: parsed,
                code: typeof parsed?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(parsed.code) ? parsed.code : null,
            };
        },
    };
}

/**
 * 开一条会话 SSE 并持续计数。
 *
 * <p>必须**持续读**（而不是只读到 `connected` 就撒手）：不读则背压让后续帧堆在 TCP 里，
 * 「事件数」会系统性偏小 —— 而事件数正是本命令的假绿判据。</p>
 *
 * @returns {Promise<{connected: boolean, reason: string|null,
 *                    stop: () => Promise<number>, snapshot: () => {frames: number, names: string[]}}>}
 */
async function openEventStream({
    apiBase, fetchImpl, token, workspaceId, sessionId, sleep,
    connectTimeoutMs = SSE_CONNECT_TIMEOUT_MS, now = Date.now,
}) {
    const controller = new AbortController();
    const headers = { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' };
    if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
    let response;
    try {
        response = await fetchImpl(
            `${apiBase}/api/v1/events?sessionId=${encodeURIComponent(sessionId)}`,
            { headers, signal: controller.signal },
        );
    } catch (error) {
        const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
        return {
            connected: false,
            reason: aborted ? 'SSE_CONNECT_TIMEOUT' : 'SSE_CONNECT_FAILED',
            stop: async () => 0,
            snapshot: () => ({ frames: 0, names: [] }),
        };
    }
    if (!response.ok || !response.body) {
        try { controller.abort(); } catch { /* 已关 */ }
        return {
            connected: false,
            reason: `SSE_HTTP_${response.status}`,
            stop: async () => 0,
            snapshot: () => ({ frames: 0, names: [] }),
        };
    }

    const state = { frames: 0, names: [], connected: false };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = null;
    let dataLines = [];
    const dispatch = () => {
        if (dataLines.length === 0 && eventName === null) return;
        const name = eventName ?? 'message';
        if (name === 'connected') {
            // CP 连上时先发一条合成事件（ChatController.java:506）：它证明「流开了」，
            // 不证明「run 干了活」，故不计入事件数。
            state.connected = true;
        } else {
            state.frames += 1;
            if (state.names.length < MAX_EVENT_SAMPLES) state.names.push(name);
        }
        eventName = null;
        dataLines = [];
    };
    const feed = (line) => {
        if (line.startsWith(':')) return; // heartbeat 注释行
        if (line === '') { dispatch(); return; }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        else if (field === 'data') dataLines.push(value);
    };

    const pump = (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const raw of lines) feed(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
                if (buffer.length > SSE_BUFFER_LIMIT) buffer = '';
            }
            if (buffer !== '') feed(buffer);
            dispatch();
        } catch { /* abort/关闭：设计内退出 */ }
    })();
    pump.catch(() => {});

    // 等 connected（或超时）：判据是「读到 connected 事件」，不是固定 sleep。
    const deadline = now() + connectTimeoutMs;
    while (!state.connected && now() < deadline) {
        await sleep(50);
    }
    return {
        connected: state.connected,
        reason: state.connected ? null : 'SSE_NOT_CONNECTED',
        stop: async () => {
            try { controller.abort(); } catch { /* 已关 */ }
            try { await Promise.race([pump, sleep(1_000)]); } catch { /* 忽略 */ }
            return state.frames;
        },
        snapshot: () => ({ frames: state.frames, names: [...state.names] }),
    };
}

/**
 * 把一次 drive 的读数做成 receipt。**纯函数**（不碰网络/时钟），便于用例直接断言。
 */
export function buildDriveReceipt(input) {
    // 复用共享词表：不许自造第五个 verdict 词（与「不许往 GATES 加第 7 条」同一条纪律）。
    if (!VERDICTS.includes(input.verdict)) {
        throw new Error(`drive receipt 的 verdict 必须是 ${VERDICTS.join('/')} 之一，实为 "${input.verdict}"`);
    }
    const receipt = createReceipt({
        gate: DRIVE_GATE,
        verdict: input.verdict,
        code: input.code,
        numbers: input.numbers ?? {},
        command: input.command,
        durationMs: input.durationMs,
        executed: input.executed ?? {},
        reason: input.reason ?? null,
        at: input.at,
    });
    return { ...receipt, drive: input.drive };
}

/**
 * **假绿判据**（`isFakeGreen` 的语义，drive 的工作计数是事件数）。
 *
 * <p>「0 事件」与「跑了一串事件」在退出码上无法区分 ⇒ 只有这里能区分。</p>
 */
export function isDriveFakeGreen(receipt) {
    if (receipt?.verdict !== 'pass') return false;
    const events = receipt.executed?.events;
    return typeof events !== 'number' || !(events > 0);
}

/**
 * drive receipt 的结构校验：共享校验器 + **白名单减去「未知门」一类** + drive 专有断言。
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateDriveReceipt(receipt, options = {}) {
    const shared = validateReceipt(receipt, options);
    const problems = shared.problems.filter(
        (problem) => !(receipt?.gate === DRIVE_GATE && UNKNOWN_GATE_PROBLEM.test(problem)),
    );
    if (receipt?.gate !== DRIVE_GATE) {
        problems.push(`gate 必须是 "${DRIVE_GATE}"，实为 "${String(receipt?.gate)}"`);
    }
    if (!receipt?.drive || typeof receipt.drive !== 'object') {
        problems.push('drive 缺失：receipt 必须说清「哪个会话、哪个 run、多少个事件」');
    } else {
        if (typeof receipt.drive.sessionId !== 'string' || receipt.drive.sessionId.trim() === '') {
            problems.push('drive.sessionId 为空');
        }
        if (receipt.drive.runId !== null && typeof receipt.drive.runId !== 'string') {
            problems.push('drive.runId 必须是字符串或 null');
        }
    }
    return { ok: problems.length === 0, problems };
}

/**
 * 轮询 run 到终态。
 *
 * @returns {Promise<{outcome: string, status: string|null, terminalOutcome: string|null,
 *                    errorCode: string|null, waitedMs: number, polls: number}>}
 *          outcome ∈ TERMINAL | AWAITING_APPROVAL | TIMEOUT | HTTP_ERROR
 */
export async function pollRunToTerminal({ client, runId, waitMs, sleep, pollIntervalMs = POLL_INTERVAL_MS, now = Date.now }) {
    const started = now();
    let polls = 0;
    for (;;) {
        polls += 1;
        const response = await client.call('GET', `/api/v1/chat/runs/${encodeURIComponent(runId)}`);
        const body = response.body ?? {};
        const status = typeof body.status === 'string' ? body.status : null;
        const snapshot = {
            status,
            terminalOutcome: typeof body.terminalOutcome === 'string' ? body.terminalOutcome : null,
            errorCode: typeof body.errorCode === 'string' ? body.errorCode : null,
            waitedMs: now() - started,
            polls,
        };
        if (status !== null && TERMINAL_STATUSES.has(status)) return { outcome: 'TERMINAL', ...snapshot };
        if (status === 'awaiting_approval') return { outcome: 'AWAITING_APPROVAL', ...snapshot };
        if (response.status === 0 || response.status >= 500 || response.status === 404) {
            return { outcome: 'HTTP_ERROR', ...snapshot, httpStatus: response.status, code: response.code };
        }
        if (now() - started >= waitMs) return { outcome: 'TIMEOUT', ...snapshot };
        await sleep(pollIntervalMs);
    }
}

/** receipt 里要留一条**可复现**的命令（契约要求 command 非空）。正文不落 receipt（可能很长）。 */
export function commandLine({ workspaceId, content, timeoutSeconds, sessionId, keepSession }) {
    return [
        'node scripts/xihe.mjs drive',
        `--workspace ${workspaceId}`,
        `--content <${content.length} chars>`,
        `--timeout ${timeoutSeconds}`,
        sessionId ? `--session ${sessionId}` : '',
        keepSession ? '--keep-session' : '',
    ].filter(Boolean).join(' ');
}

/**
 * 结算 receipt：结构不合格时**不许**当成结论（宁可判 error，e.g. 有人改了 drive 形状）。
 */
export function finalizeDriveReceipt({ verdict, code, reason, drive, command, durationMs, now = Date.now }) {
    const receipt = buildDriveReceipt({
        verdict,
        code,
        numbers: { events: drive.events, waitedMs: drive.waitedMs, polls: drive.polls },
        executed: { events: drive.events },
        command,
        durationMs,
        reason,
        at: new Date(now()).toISOString(),
        // drive.reason 是**机读**的失败原因码（NO_EVENTS / RUN_TIMEOUT / SSE_* …），优先保留它；
        // 只有它为空（非预期异常那条路）时才回落到人读文案。人读文案始终在 receipt.reason。
        drive: { ...drive, reason: drive.reason ?? reason },
    });
    const checked = validateDriveReceipt(receipt);
    if (!checked.ok) {
        return {
            receipt: {
                ...receipt,
                verdict: 'error',
                code: CODES.E_SCHEMA,
                reason: `receipt 结构不合格：${checked.problems.join('; ')}`,
            },
            exitCode: 1,
        };
    }
    return { receipt, exitCode: verdict === 'pass' ? 0 : 1 };
}

/**
 * 驱动一次 chat 到终态。所有外部依赖可注入（用例不需要栈）。
 *
 * <p><b>结构要点</b>：先把判定收成 `[verdict, code, reason]`，收尾（关流 → 删会话）之后再产 receipt。
 * 第一版把收尾写在 `finally` 里、receipt 在 `try` 内提前构造，结果 `drive.events` 恒是 0（假绿判据
 * 与「事件数」都会错），故此处顺序不能倒。</p>
 *
 * @returns {Promise<{receipt: object, exitCode: number}>}
 */
export async function driveChat({
    apiBase, fetchImpl, token, workspaceId, content, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    sessionId = null, branchId = null, keepSession = false,
    now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
    const started = now();
    const client = createClient({ apiBase, fetchImpl, token, workspaceId });
    const drive = {
        sessionId: sessionId ?? '',
        branchId: branchId ?? null,
        runId: null,
        created: false,
        sessionDeleted: false,
        events: 0,
        eventNames: [],
        terminalStatus: null,
        terminalOutcome: null,
        errorCode: null,
        waitedMs: 0,
        polls: 0,
        reason: null,
    };
    let createdSession = false;
    let stream = null;

    const steps = async () => {
        if (sessionId === null) {
            const resolved = await resolveSessionBinding({ client, stack: 'drive' });
            if (resolved.error) {
                drive.reason = resolved.error.code;
                return ['error', CODES.E_UNPARSABLE, `无法解析会话绑定：${resolved.error.message}`];
            }
            const created = await client.call('POST', '/api/v1/sessions', {
                body: bindingRequestBody(resolved.binding, { title: `xihe-drive-${new Date(now()).toISOString()}` }),
            });
            const newId = typeof created.body?.id === 'string' ? created.body.id
                : typeof created.body?.sessionId === 'string' ? created.body.sessionId : null;
            if (![200, 201].includes(created.status) || newId === null) {
                drive.reason = 'SESSION_CREATE_FAILED';
                return ['error', CODES.E_UNPARSABLE,
                    `建会话失败（HTTP ${created.status}${created.code ? ` ${created.code}` : ''}）`];
            }
            drive.sessionId = newId;
            drive.created = true;
            createdSession = true;
        }

        if (drive.branchId === null) {
            const branches = await client.call('GET', `/api/v1/sessions/${encodeURIComponent(drive.sessionId)}/branches`);
            const first = Array.isArray(branches.body?.items) ? branches.body.items[0]?.branchId : null;
            if (branches.status !== 200 || typeof first !== 'string') {
                drive.reason = 'SESSION_BRANCH_MISSING';
                return ['error', CODES.E_UNPARSABLE, '会话没有 root branch，无法发消息'];
            }
            drive.branchId = first;
        }

        // CP 要求先有活跃 SSE 订阅才接受 POST /chat（ChatController.java:813）。
        stream = await openEventStream({ apiBase, fetchImpl, token, workspaceId, sessionId: drive.sessionId, sleep, now });
        if (!stream.connected) {
            drive.reason = stream.reason ?? 'SSE_NOT_CONNECTED';
            return ['error', CODES.E_UNPARSABLE,
                `事件流未连上（${drive.reason}）：没有订阅时 CP 一定 409 SSE_SUBSCRIPTION_REQUIRED，发消息无从谈起`];
        }

        const sent = await client.call('POST', '/api/v1/chat', {
            body: { sessionId: drive.sessionId, branchId: drive.branchId, content },
        });
        const runId = typeof sent.body?.runId === 'string' ? sent.body.runId : null;
        if (![200, 202].includes(sent.status) || runId === null) {
            drive.reason = sent.code ?? `CHAT_HTTP_${sent.status}`;
            return ['error', CODES.E_UNPARSABLE,
                `CP 没有受理这条消息（HTTP ${sent.status}${sent.code ? ` ${sent.code}` : ''}）⇒ 没有 run 可等`];
        }
        drive.runId = runId;

        const outcome = await pollRunToTerminal({ client, runId, waitMs: timeoutSeconds * 1000, sleep, now });
        drive.terminalStatus = outcome.status;
        drive.terminalOutcome = outcome.terminalOutcome ?? null;
        drive.errorCode = outcome.errorCode ?? null;
        drive.waitedMs = outcome.waitedMs;
        drive.polls = outcome.polls;

        // 终态与最后一帧事件之间有竞态：**有界等待**（有事件立刻走，无事件最多 SETTLE_MS）。
        const settleDeadline = now() + SETTLE_MS;
        while (stream.snapshot().frames === 0 && now() < settleDeadline) {
            await sleep(50);
        }

        if (outcome.outcome === 'TIMEOUT') {
            drive.reason = 'RUN_TIMEOUT';
            return ['error', CODES.E_UNPARSABLE,
                `等了 ${timeoutSeconds}s 仍未到终态（最后状态 ${outcome.status ?? 'unknown'}）⇒ 无法判定，不许当绿`];
        }
        if (outcome.outcome === 'AWAITING_APPROVAL') {
            drive.reason = 'AWAITING_APPROVAL';
            return ['error', CODES.E_UNPARSABLE,
                'run 停在 awaiting_approval：审批是人的动作，非交互驱动到此为止（请在 UI 处理或改策略）'];
        }
        if (outcome.outcome === 'HTTP_ERROR') {
            drive.reason = `RUN_POLL_HTTP_${outcome.httpStatus ?? 0}`;
            return ['error', CODES.E_UNPARSABLE,
                `轮询 run 失败（HTTP ${outcome.httpStatus ?? 0}${outcome.code ? ` ${outcome.code}` : ''}）⇒ 无法判定`];
        }
        if (outcome.status !== TERMINAL_SUCCESS) {
            drive.reason = `TERMINAL_${String(outcome.status).toUpperCase()}`;
            return ['fail', CODES.E_GATE_FAILED,
                `run 终态是 ${outcome.status}${outcome.errorCode ? `（${outcome.errorCode}）` : ''}`];
        }
        if (stream.snapshot().frames === 0) {
            drive.reason = 'NO_EVENTS';
            return ['error', CODES.E_FAKE_GREEN,
                'run 报成功但事件流一帧都没有 ⇒ 假绿（0 事件与「跑完了」在退出码上无法区分）'];
        }
        return ['pass', CODES.OK, null];
    };

    let verdict = 'error';
    let code = CODES.E_UNPARSABLE;
    let reason = null;
    try {
        [verdict, code, reason] = await steps();
    } catch (error) {
        // 非预期异常也不许静默：落成 error receipt，并把原因写进去（不吞栈信息，也不外泄 token）。
        reason = `驱动过程抛错：${String(error?.message ?? error)}`;
    } finally {
        if (stream) {
            drive.events = await stream.stop();
            drive.eventNames = stream.snapshot().names;
            stream = null;
        }
        if (createdSession && !keepSession) {
            const deleted = await client.call('DELETE', `/api/v1/sessions/${encodeURIComponent(drive.sessionId)}`);
            drive.sessionDeleted = deleted.status === 200 || deleted.status === 204;
        }
    }

    return finalizeDriveReceipt({
        verdict,
        code,
        reason,
        drive,
        command: commandLine({ workspaceId, content, timeoutSeconds, sessionId, keepSession }),
        durationMs: now() - started,
        now,
    });
}

/** 落盘：`.tmp/xh/receipts/drive/<时间戳>-<会话前缀>.json`；`--out` 可显式指定。 */
export function writeDriveReceipt({ receipt, root = projectRoot, out = null, now = Date.now }) {
    const target = out ?? path.join(
        driveReceiptDir(root),
        `drive-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${String(receipt.drive?.sessionId ?? 'nosession').slice(0, 8)}.json`,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    return target;
}

/** 供 help 与用例断言：本命令的用法行。 */
export const DRIVE_USAGE = 'drive --workspace <wsId> --content <text> [--timeout <seconds>] [--session <id>] [--branch <id>] [--keep-session] [--out <file>] [--email <account>]';

/**
 * CLI 入口：`xihe drive --workspace <ws> --content <text> …`
 *
 * @returns {Promise<{exitCode: number, data: object}>}
 */
export async function runDriveCommand({ rest, env, fetchImpl, apiBase, promptSecret, root = projectRoot, dependencies = {} }) {
    const parsed = parseOptions(
        rest,
        ['--content', '--content-file', '--session', '--branch', '--timeout', '--out', '--email', '--workspace'],
        ['--keep-session'],
    );
    if (parsed.positionals.length !== 0) {
        throw usageError('drive takes no positional arguments; use --content, --workspace and --timeout.');
    }
    let content = typeof parsed.values['--content'] === 'string' ? parsed.values['--content'] : '';
    const contentFile = typeof parsed.values['--content-file'] === 'string' ? parsed.values['--content-file'] : '';
    if (contentFile !== '') {
        if (content !== '') throw usageError('--content and --content-file are mutually exclusive.');
        try {
            content = fs.readFileSync(contentFile, 'utf8');
        } catch (error) {
            throw usageError(`--content-file is unreadable: ${String(error?.message ?? error)}`);
        }
    }
    if (content.trim() === '') {
        throw usageError('drive requires --content <text> (or --content-file <path>).');
    }
    // 工作区两个来源同一化（V12）：命令级 --workspace 与 XIHE_WORKSPACE_ID。全局层只在
    // `--workspace` 出现在**组名之前**时把它剥进 env 并在尾部回填，故这里两者都要看；
    // 两者不一致时 runCommand 已先按 V12 抛 INVALID_ARGUMENT，此处只做「取到值」。
    const fromFlag = typeof parsed.values['--workspace'] === 'string' ? parsed.values['--workspace'].trim() : '';
    const fromEnv = typeof env?.XIHE_WORKSPACE_ID === 'string' ? env.XIHE_WORKSPACE_ID.trim() : '';
    const workspaceId = fromFlag !== '' ? fromFlag : fromEnv;
    if (workspaceId === '') {
        throw usageError('drive requires a workspace: pass --workspace <wsId> or set XIHE_WORKSPACE_ID.');
    }
    const timeoutSeconds = positiveSeconds(parsed.values['--timeout'], DEFAULT_TIMEOUT_SECONDS);
    const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret });
    const result = await driveChat({
        apiBase,
        fetchImpl,
        token,
        workspaceId,
        content,
        timeoutSeconds,
        sessionId: typeof parsed.values['--session'] === 'string' ? parsed.values['--session'].trim() || null : null,
        branchId: typeof parsed.values['--branch'] === 'string' ? parsed.values['--branch'].trim() || null : null,
        keepSession: parsed.values['--keep-session'] === true,
        now: dependencies.nowImpl ?? Date.now,
        sleep: dependencies.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    });
    const outPath = writeDriveReceipt({
        receipt: result.receipt,
        root,
        out: typeof parsed.values['--out'] === 'string' && parsed.values['--out'].trim() !== ''
            ? path.resolve(parsed.values['--out'].trim())
            : null,
    });
    return { exitCode: result.exitCode, data: { ...result.receipt, receiptPath: outPath } };
}
