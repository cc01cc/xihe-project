#!/usr/bin/env node
/**
 * task-25 A（S0 硬停固化，盘点 P0-1）—— task-11/T-2329 开窗前的**硬停门**。
 *
 * <h3>为什么需要它</h3>
 * <p>窗口脚本草稿 `.tmp/ui10/window-task3.sh` 的 preflight() 只打印 verdict/runningCommit/HEAD/dirty
 * 四个读数，**不 exit**；`EXPECT_DIRTY=0` 参数化只写在 T-2329 卡面文字里，全仓无实现。
 * 「可能在树脏 / CP 非 HEAD 时烧窗口」正是盘点 §5 P0-1 定级为「产生错误结论」的原因。
 * 本模块把 S0 三判据变成机器可判的硬停：**缺前置必非零退出并给可读原因**。</p>
 *
 * <h3>S0 三判据（T-2329 卡面原文口径）</h3>
 * <ol>
 *   <li><b>G-S0-1</b> `dev-stack status` 的 `verdict === 'healthy'`（lease cold ≠ 掉线，
 *       healthy 已含服务事实——与 e2e-window-preflight G10 同口径）；</li>
 *   <li><b>G-S0-2</b> `cpBuild.runningCommit === HEAD`（跑的是 HEAD 的 CP；任一读不出 ⇒ fail-closed，
 *       判不了不猜——gate-screenshot-preflight T-2327 同款纪律）；</li>
 *   <li><b>G-S0-3</b> 脏树条数 === EXPECT_DIRTY（**默认 0**）。期望非 0（实验需变脏）时必须显式
 *       `--expect-dirty <n>`（或 env `EXPECT_DIRTY`）**且**带 `--allow-dirty-reason "<文本>"` 留痕
 *       ——D-1074「改门不改结论」：放行是显式改门动作，reason 进 receipt 与日志，不许静默放宽。</li>
 * </ol>
 *
 * <h3>drive 前置（盘点 §4(a)，T-2329 (a) 验收「缺 READY 连接/模板则不烧窗口」）</h3>
 * <p>G-S0-4/G-S0-5：经注入 fetch 只读 GET `/api/v1/provider-connections` 与
 * `/api/v1/config/api-request-templates?layer=…`，复用 session-binding.mjs 的
 * pickChatConnection/publishedTemplates（唯一判定实现，不复刻）。缺任一 ⇒ FAIL + 可读原因。
 * token 只走非交互链（XIHE_TOKEN → 缓存 hit；miss/expired ⇒ fail-closed exit 2，lead 裁定
 * 2026-11-17：窗口门不做 TTY 输密、不做 env 口令登录绕过），**绝不打印 token 值**；
 * `--skip-binding` 允许 (b)/(c) 这类不建会话的子项跳过这两条（跳过必须显式，输出注明）。</p>
 *
 * <h3>dirty overlap（盘点 §5 P0-1「按 parallel lane 重叠判定并打印」）</h3>
 * <p>`--overlap <path...>` 给出本窗口要动的面；交集语义逐字对齐 gate-screenshot-preflight 的
 * overlapOf（等值 / 后缀 / 子串，宁可多报）。脏清单**始终打印**；overlap 命中额外标注
 * `OVERLAP`，供操作者判断脏行归属哪个 lane。overlap 本身不单独构成 FAIL——放行与否由
 * G-S0-3 的 EXPECT_DIRTY 门决定（避免第二套隐式判据）。</p>
 *
 * <h3>形态</h3>
 * <p>判定是纯函数 evaluateS0({facts, options})（单测直接喂夹具，不起栈不联网）；
 * CLI main 负责采集事实（git/dev-stack/fetch 全部可注入）。receipt 借 gate-receipt 的
 * createReceipt 形状但 gate='window-s0' **不进 GATES**（与 drive-chat 同款裁定：驱动面不是门批次成员，
 * 落盘默认 `.tmp/xh/receipts/window-s0/`，与门批次目录隔离）。</p>
 *
 * <p><b>退出码</b>：0 = PASS 开窗；1 = FAIL（原因列在结论行与 receipt）；2 = 用法错 / 事实读不出
 * （fail-closed：判不了不许当绿）。date 格式串教训（草稿 `+%%Y` 双百分号 bug）：本模块时间戳一律
 * `new Date().toISOString()`，不再经 shell date。</p>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CODES, createReceipt } from '../lib/gate-receipt.mjs';
import { parseTemplateCatalog, pickChatConnection, publishedTemplates } from './session-binding.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

/** receipt 的 gate 名。**故意**不在 GATES 里（同 drive-chat 裁定③ 方案 b）。 */
export const WINDOW_S0_GATE = 'window-s0';

/** 共享校验器「未知门」文案形态；白名单只减这一种且只在 gate === WINDOW_S0_GATE 时减。 */
const UNKNOWN_GATE_PROBLEM = /^未知门 /;

const TEMPLATE_LAYERS = ['user', 'workspace', 'instance'];

/** dirty 行解析：porcelain -uall → [{code,path}]（rename 取新路径；剥引号）。与 gate-screenshot-preflight.dirtyRows 同语义。 */
export function parseDirtyRows(porcelain) {
    return (String(porcelain ?? '').split(/\r?\n/).filter(Boolean)).map((line) => {
        const rest = line.slice(2).replace(/^\s+/, '');
        const arrow = rest.lastIndexOf(' -> ');
        const raw = arrow >= 0 ? rest.slice(arrow + 4) : rest;
        return { code: line.slice(0, 2), path: raw.trim().replace(/^"|"$/g, '') };
    });
}

/** 交集判定：等值 / 后缀 / 子串三种写法都算命中（宁可多报）。逐字对齐 gate-screenshot-preflight.overlapOf。 */
export function overlapOf(dirty, pages) {
    const norm = (s) => String(s).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
    const hits = [];
    for (const page of pages) {
        const q = norm(page);
        const matched = dirty.filter((row) => {
            const p = norm(row.path);
            return p === q || p.endsWith('/' + q) || p.includes(q);
        });
        if (matched.length) hits.push({ page, paths: matched.map((m) => m.path) });
    }
    return hits;
}

/** EXPECT_DIRTY 解析：非负整数；非法 ⇒ null（调用方转 exit 2）。env 与 flag 同规。 */
export function parseExpectDirty(raw) {
    if (raw === undefined || raw === null || raw === '') return 0;
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) return null;
    return Number(text);
}

/**
 * S0 判定（纯函数）。facts 全部由调用方采集/注入：
 *   { head: string|null, stackVerdict: string|null, runningCommit: string|null,
 *     dirty: [{code,path}], binding: {skipped:boolean}|{connection:object|null, template:object|null, error:string|null} }
 * options: { expectDirty: number, allowDirtyReason: string|null, overlap: string[] }
 * @returns {{rows: Array, failures: Array, conclusion: string, numbers: object}}
 */
export function evaluateS0({ facts, options }) {
    const rows = [];
    const push = (id, check, value, expect, ok, note = '') => {
        rows.push({ id, check, value, expect, ok, note });
    };
    const expectDirty = options.expectDirty;
    const reason = typeof options.allowDirtyReason === 'string' ? options.allowDirtyReason.trim() : '';

    // G-S0-1 栈 healthy
    const verdict = facts.stackVerdict ?? null;
    push('G-S0-1', 'stack.verdict', String(verdict ?? 'unreadable'), 'healthy', verdict === 'healthy',
        'lease cold ≠ 掉线；healthy 已含服务事实（同 e2e-window-preflight G10）');

    // G-S0-2 跑的是 HEAD 的 CP（fail-closed：任一读不出即 FAIL）
    const head = typeof facts.head === 'string' && facts.head !== '' ? facts.head : null;
    const running = typeof facts.runningCommit === 'string' && facts.runningCommit !== '' ? facts.runningCommit : null;
    const commitOk = head !== null && running !== null && head.toLowerCase() === running.toLowerCase();
    push('G-S0-2', 'cp.runningCommit==HEAD',
        `running=${running ?? 'unreadable'} head=${head ?? 'unreadable'}`, '相等', commitOk,
        head === null || running === null ? '读不出 ⇒ fail-closed，判不了不猜' : '');

    // G-S0-3 EXPECT_DIRTY 门（默认 0；非 0 必须显式 reason 留痕）
    const dirty = Array.isArray(facts.dirty) ? facts.dirty : [];
    const dirtyCount = dirty.length;
    let dirtyOk = dirtyCount === expectDirty;
    let dirtyNote = `EXPECT_DIRTY=${expectDirty}`;
    if (expectDirty !== 0) {
        if (reason === '') {
            dirtyOk = false;
            dirtyNote += '；期望非 0 必须 --allow-dirty-reason 留痕（D-1074 改门不改结论）';
        } else {
            dirtyNote += `；显式放行 reason=${JSON.stringify(reason)}`;
        }
    }
    push('G-S0-3', 'dirty==EXPECT_DIRTY', `${dirtyCount} 条`, String(expectDirty), dirtyOk, dirtyNote);

    // G-S0-4/G-S0-5 drive 前置（可显式 skip；skip 不算 FAIL 但必须可见）
    const binding = facts.binding ?? { skipped: true };
    if (binding.skipped === true) {
        push('G-S0-4', 'READY chat 连接', 'skipped', '显式 --skip-binding', true, '本窗口子项不建会话；跳过是显式动作');
        push('G-S0-5', 'published 模板', 'skipped', '显式 --skip-binding', true, '同上');
    } else {
        const conn = binding.connection ?? null;
        push('G-S0-4', 'READY chat 连接',
            conn ? `id=${conn.id}` : (binding.error ?? 'missing'),
            '存在（enabled≠false + READY + chat）', conn !== null,
            conn === null ? '缺 READY 连接 ⇒ 不烧窗口：先 provider add/verify（T-2329 (a)）' : '');
        const tpl = binding.template ?? null;
        push('G-S0-5', 'published 模板',
            tpl ? `id=${tpl.id}@v${tpl.version}` : (binding.error ?? 'missing'),
            '存在（status=published）', tpl !== null,
            tpl === null ? '缺已发布模板 ⇒ 不烧窗口：CP 会 409 API_TYPE_REBIND_REQUIRED' : '');
    }

    const overlap = overlapOf(dirty, Array.isArray(options.overlap) ? options.overlap : []);
    const numbers = {
        expectDirty,
        dirtyCount,
        dirtyPaths: dirty.map((row) => row.path),
        dirtyOverlap: overlap,
        dirtyOverlapCount: overlap.reduce((n, o) => n + o.paths.length, 0),
        allowDirtyReason: expectDirty !== 0 && reason !== '' ? reason : null,
        head,
        runningCommit: running,
        stackVerdict: verdict,
        bindingSkipped: binding.skipped === true,
    };
    const failures = rows.filter((row) => !row.ok);
    const conclusion = failures.length === 0
        ? 'PASS 开窗'
        : `FAIL ${failures.map((row) => `${row.id}(${row.check})=${row.value}`).join('; ')}`;
    return { rows, failures, conclusion, numbers };
}

/** receipt 组装 + 结构自检（借共享契约形状；未知门一类按白名单减去，其余 problem 一个不吞）。 */
export function buildS0Receipt({ evaluation, command, durationMs, now = Date.now }) {
    const verdict = evaluation.failures.length === 0 ? 'pass' : 'fail';
    const receipt = createReceipt({
        gate: WINDOW_S0_GATE,
        verdict,
        code: verdict === 'pass' ? CODES.OK : CODES.E_GATE_FAILED,
        numbers: evaluation.numbers,
        command,
        durationMs,
        executed: { checks: evaluation.rows.length },
        reason: verdict === 'pass' ? null : evaluation.conclusion,
        at: new Date(now()).toISOString(),
    });
    return { ...receipt, s0: { rows: evaluation.rows, conclusion: evaluation.conclusion } };
}

/** 落盘目录：与门批次隔离（同 drive 的裁定——未知门 receipt 混进门批次会拖垮整批结论）。 */
export function s0ReceiptDir(root = REPO_ROOT) {
    return path.join(root, '.tmp', 'xh', 'receipts', 'window-s0');
}

export function writeS0Receipt({ receipt, root = REPO_ROOT, out = null, now = Date.now }) {
    const target = out ?? path.join(
        s0ReceiptDir(root),
        `window-s0-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.json`,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    return target;
}

/* ───────────────────────── 事实采集（全部可注入；单测不走这里） ───────────────────────── */

function gitHead(repoRoot, execImpl = execFileSync) {
    try {
        const out = execImpl('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
        const sha = String(out).trim();
        return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch {
        return null;
    }
}

function gitDirty(repoRoot, execImpl = execFileSync) {
    const out = execImpl('git', ['-C', repoRoot, 'status', '--porcelain', '-uall'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return parseDirtyRows(out);
}

function stackStatus(repoRoot, stack, spawnImpl = spawnSync) {
    const result = spawnImpl(process.execPath,
        [path.join(repoRoot, 'scripts/dev-stack.mjs'), 'status', '--stack', String(stack), '--json'],
        { encoding: 'utf8', cwd: repoRoot, timeout: 120_000 });
    const stdout = result.stdout ?? '';
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(stdout.slice(start, end + 1));
    } catch {
        return null;
    }
}

/** 只读 GET helper：HTTP 失败变成数据（判据要落 receipt），token 只进 header 绝不出现在输出。 */
async function getJson({ apiBase, fetchImpl, token, pathname }) {
    try {
        const response = await fetchImpl(`${apiBase}${pathname}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        });
        let body = null;
        try { body = await response.json(); } catch { body = null; }
        return { status: response.status, body };
    } catch {
        return { status: 0, body: null };
    }
}

/**
 * drive 前置绑定检查（只读；判定复用 session-binding.mjs，不复刻）。
 * @returns {Promise<{connection: object|null, template: object|null, error: string|null}>}
 */
export async function checkBinding({ apiBase, fetchImpl, token }) {
    const connections = await getJson({ apiBase, fetchImpl, token, pathname: '/api/v1/provider-connections' });
    if (connections.status !== 200 || !Array.isArray(connections.body?.connections)) {
        return { connection: null, template: null, error: `provider list 读不出（HTTP ${connections.status}）` };
    }
    const connection = pickChatConnection(connections.body.connections);
    if (!connection) {
        return {
            connection: null, template: null,
            error: 'stack 无 READY chat 连接（enabled≠false + status=READY + operation=chat）；先 provider add + verify',
        };
    }
    for (const layer of TEMPLATE_LAYERS) {
        const catalog = await getJson({
            apiBase, fetchImpl, token,
            pathname: `/api/v1/config/api-request-templates?layer=${encodeURIComponent(layer)}`,
        });
        if (catalog.status !== 200) continue;
        const candidates = publishedTemplates(parseTemplateCatalog(catalog.body), {
            apiTypeId: connection.apiTypeId,
            apiTypeVersion: connection.apiTypeVersion,
        });
        if (candidates.length > 0) {
            return { connection, template: candidates[0], error: null };
        }
    }
    return {
        connection, template: null,
        error: `连接 ${connection.id} 无兼容的已发布 api-request-template（user/workspace/instance 三层都没有）；先发布模板`,
    };
}

/**
 * 非交互 token 解析（lead 裁定 2026-11-17）：XIHE_TOKEN → CLI 缓存 hit，其余一律抛错。
 * **绝不**调 provider.login 的密码分支（TTY 输密 / env 口令登录都属交互或绕过，窗口门禁止）。
 * loginImpl 仅供单测注入；生产路径不 import provider.login。
 * 错误信息只含元数据（kind/path/expiresAt），不含 token 值或片段。
 */
export async function resolveTokenNonInteractive({ apiBase, env, loginImpl = null }) {
    if (typeof loginImpl === 'function') return loginImpl({ apiBase, env });
    const envToken = typeof env?.XIHE_TOKEN === 'string' ? env.XIHE_TOKEN.trim() : '';
    if (envToken !== '') return envToken;
    const { tokenEntryFor } = await import('./token-store.mjs');
    const entry = tokenEntryFor(env, apiBase);
    if (entry.kind === 'hit') return entry.token;
    const detail = entry.kind === 'expired'
        ? `缓存已过期（expiresAt=${entry.expiresAt}）`
        : entry.kind === 'absent'
            ? `该 base URL 无缓存条目（${apiBase}）`
            : entry.kind === 'disabled'
                ? 'token 缓存被 XIHE_CLI_TOKEN_CACHE 显式禁用'
                : `缓存不可用（kind=${entry.kind}${entry.reason ? ` reason=${entry.reason}` : ''}）`;
    throw new Error(`T1 token 链无可用令牌：${detail}`);
}

/* ───────────────────────── CLI ───────────────────────── */

class UsageError extends Error {}

export function parseArgs(argv, env = {}) {
    const out = {
        stack: '2',
        cp: '',
        expectDirtyRaw: undefined,
        allowDirtyReason: null,
        overlap: [],
        skipBinding: false,
        json: false,
        out: null,
        help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} 需要一个值`);
            i += 1;
            return value;
        };
        if (arg === '--stack') out.stack = next();
        else if (arg.startsWith('--stack=')) out.stack = arg.slice('--stack='.length);
        else if (arg === '--cp') out.cp = next();
        else if (arg.startsWith('--cp=')) out.cp = arg.slice('--cp='.length);
        else if (arg === '--expect-dirty') out.expectDirtyRaw = next();
        else if (arg.startsWith('--expect-dirty=')) out.expectDirtyRaw = arg.slice('--expect-dirty='.length);
        else if (arg === '--allow-dirty-reason') out.allowDirtyReason = next();
        else if (arg.startsWith('--allow-dirty-reason=')) out.allowDirtyReason = arg.slice('--allow-dirty-reason='.length);
        else if (arg === '--overlap') out.overlap.push(next());
        else if (arg.startsWith('--overlap=')) out.overlap.push(arg.slice('--overlap='.length));
        else if (arg === '--skip-binding') out.skipBinding = true;
        else if (arg === '--json') out.json = true;
        else if (arg === '--out') out.out = next();
        else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
        else if (arg === '--help' || arg === '-h') out.help = true;
        else throw new UsageError(`未知参数：${arg}`);
    }
    if (out.expectDirtyRaw === undefined && env.EXPECT_DIRTY !== undefined && env.EXPECT_DIRTY !== '') {
        out.expectDirtyRaw = env.EXPECT_DIRTY;
    }
    return out;
}

const USAGE = [
    '用法: node scripts/xihe-cli/window-preflight.mjs [--stack <n>] [--cp <url>]',
    '      [--expect-dirty <n>] [--allow-dirty-reason "<文本>"] [--overlap <path> ...]',
    '      [--skip-binding] [--json] [--out <file>]',
    '',
    'S0 三判据硬停门（T-2329）：verdict=healthy / cp.runningCommit==HEAD / dirty==EXPECT_DIRTY(默认0)。',
    'EXPECT_DIRTY 也可用环境变量传入；期望非 0 必须 --allow-dirty-reason 留痕（D-1074）。',
    'drive 前置：缺 READY chat 连接 / 已发布模板 ⇒ FAIL（--skip-binding 显式跳过，仅限不建会话的子项）。',
    'token：XIHE_TOKEN → CLI 缓存 hit（非交互 fail-closed：miss/expired ⇒ exit 2，不输密不登录；不打印值）。',
    '退出码: 0=PASS 开窗 / 1=FAIL / 2=用法错或事实读不出（fail-closed）。',
].join('\n');

export async function main(argv = process.argv.slice(2), {
    env = process.env,
    fetchImpl = fetch,
    repoRoot = REPO_ROOT,
    execImpl = execFileSync,
    spawnImpl = spawnSync,
    stdout = process.stdout,
    stderr = process.stderr,
    now = Date.now,
    loginImpl = null,
} = {}) {
    const started = now();
    let options;
    try {
        options = parseArgs(argv, env);
    } catch (error) {
        if (error instanceof UsageError) {
            stderr.write(`[window-s0] ${error.message}\n${USAGE}\n`);
            return 2;
        }
        throw error;
    }
    if (options.help) {
        stdout.write(`${USAGE}\n`);
        return 0;
    }
    const expectDirty = parseExpectDirty(options.expectDirtyRaw);
    if (expectDirty === null) {
        stderr.write(`[window-s0] EXPECT_DIRTY 非法：${JSON.stringify(String(options.expectDirtyRaw))}（需非负整数）\n`);
        return 2;
    }

    // 事实采集：git 两项读不出 ⇒ fail-closed exit 2（判不了不猜）。
    let head;
    let dirty;
    try {
        head = gitHead(repoRoot, execImpl);
        dirty = gitDirty(repoRoot, execImpl);
    } catch (error) {
        stderr.write(`[window-s0] git 事实读不出：${String(error?.message ?? error)}\n`);
        return 2;
    }
    if (head === null) {
        stderr.write('[window-s0] git rev-parse HEAD 读不出 ⇒ fail-closed\n');
        return 2;
    }
    const status = stackStatus(repoRoot, options.stack, spawnImpl);
    if (status === null) {
        stderr.write(`[window-s0] dev-stack status --stack ${options.stack} 读不出 JSON ⇒ fail-closed\n`);
        return 2;
    }

    // drive 前置（除非显式 skip）。token 解析**绝不交互**（lead 裁定 2026-11-17，task-30 窗口）：
    // XIHE_TOKEN → CLI 缓存 hit；miss/expired/corrupt ⇒ fail-closed exit 2 + 可读原因。
    // 不做 TTY 输密、不做 XIHE_DEV_ADMIN_PASSWORD 登录绕过 —— 前置门只读判定，不产生登录副作用。
    let binding = { skipped: true };
    if (!options.skipBinding) {
        const apiBase = (options.cp || env.XIHE_CP_URL || '').replace(/\/$/, '');
        if (apiBase === '') {
            stderr.write('[window-s0] 缺 --cp <url>（或 XIHE_CP_URL）；不查绑定请显式 --skip-binding\n');
            return 2;
        }
        let token = null;
        try {
            token = await resolveTokenNonInteractive({ apiBase, env, loginImpl });
        } catch (error) {
            stderr.write(`[window-s0] token 不可用（fail-closed，不交互输密）：${String(error?.message ?? error)}\n`
                + '[window-s0] 处置：先跑 `node scripts/xihe.mjs auth status --check` 看缓存元数据；'
                + '缓存无效则由操作员在终端跑 `node scripts/xihe.mjs auth login` 重建 T1 缓存，'
                + '或显式注入 XIHE_TOKEN 后重跑本门。\n');
            return 2;
        }
        try {
            binding = await checkBinding({ apiBase, fetchImpl, token });
        } catch (error) {
            binding = { connection: null, template: null, error: `绑定前置检查失败：${String(error?.message ?? error)}` };
        }
    }

    const evaluation = evaluateS0({
        facts: {
            head,
            stackVerdict: status.verdict ?? null,
            runningCommit: status.cpBuild?.runningCommit ?? null,
            dirty,
            binding,
        },
        options: { expectDirty, allowDirtyReason: options.allowDirtyReason, overlap: options.overlap },
    });
    const command = `node scripts/xihe-cli/window-preflight.mjs ${argv.join(' ')}`.trim();
    const receipt = buildS0Receipt({ evaluation, command, durationMs: now() - started, now });
    const receiptPath = writeS0Receipt({ receipt, root: repoRoot, out: options.out, now });

    if (options.json) {
        stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
    } else {
        for (const row of evaluation.rows) {
            stdout.write(`${row.id} ${row.check}: ${row.ok ? 'OK' : 'FAIL'} (${row.value}; 期望 ${row.expect})${row.note ? ` — ${row.note}` : ''}\n`);
        }
        // 脏清单始终打印；overlap 命中标注（parallel lane 归属判定，盘点 P0-1）。
        stdout.write(`dirty=${evaluation.numbers.dirtyCount} EXPECT_DIRTY=${expectDirty}\n`);
        const overlapPaths = new Set(evaluation.numbers.dirtyOverlap.flatMap((o) => o.paths));
        for (const row of dirty) {
            stdout.write(`  ${row.code} ${row.path}${overlapPaths.has(row.path) ? '  OVERLAP' : ''}\n`);
        }
        stdout.write(`${evaluation.conclusion}\nreceipt: ${receiptPath}\n`);
    }
    return evaluation.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main();
}
