#!/usr/bin/env node
/**
 * task-25 A —— window-preflight（S0 硬停门）L0 单测。
 *
 * 全部注入（facts 夹具 / fake fetch / fake exec/spawn），**不起栈、不联网、不写真实收据目录**。
 * 验收口径（task-25 卡面 A）：
 *   ① 缺前置必 exit≠0（缺 READY 连接 / 缺 published 模板 / 栈不 healthy / CP 非 HEAD / 读数不可得）；
 *   ② EXPECT_DIRTY=0 时脏树必拦；
 *   ③ 显式放行路径留痕（reason 进 numbers.allowDirtyReason 与结论文本；无 reason 的放宽被拒）；
 *   ④ overlap 交集语义与 gate-screenshot-preflight 对齐（等值/后缀/子串）；
 *   ⑤ receipt 借共享契约形状但 gate 不进 GATES（未知门白名单只减一类）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
    WINDOW_S0_GATE, buildS0Receipt, checkBinding, evaluateS0, main,
    overlapOf, parseArgs, parseDirtyRows, parseExpectDirty, writeS0Receipt,
} from './window-preflight.mjs';
import { GATES, validateReceipt } from '../lib/gate-receipt.mjs';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

const cleanFacts = () => ({
    head: HEAD,
    stackVerdict: 'healthy',
    runningCommit: HEAD,
    dirty: [],
    binding: { connection: { id: 'conn-1' }, template: { id: 'tpl-1', version: 2 }, error: null },
});
const opts = (patch = {}) => ({ expectDirty: 0, allowDirtyReason: null, overlap: [], ...patch });

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xh-window-s0-'));

/* ── 纯函数：三判据 ─────────────────────────────────────────── */

test('S0: clean facts + ready binding ⇒ PASS with all five rows ok', () => {
    const e = evaluateS0({ facts: cleanFacts(), options: opts() });
    assert.equal(e.conclusion, 'PASS 开窗');
    assert.equal(e.failures.length, 0);
    assert.deepEqual(e.rows.map((r) => r.id), ['G-S0-1', 'G-S0-2', 'G-S0-3', 'G-S0-4', 'G-S0-5']);
    assert.equal(e.numbers.dirtyCount, 0);
});

test('S0: stack not healthy ⇒ FAIL G-S0-1 (exit path 1)', () => {
    const e = evaluateS0({ facts: { ...cleanFacts(), stackVerdict: 'ghost' }, options: opts() });
    assert.equal(e.failures.length, 1);
    assert.equal(e.failures[0].id, 'G-S0-1');
    assert.match(e.conclusion, /^FAIL /);
});

test('S0: cp.runningCommit != HEAD ⇒ FAIL G-S0-2; unreadable either side is fail-closed', () => {
    const mismatch = evaluateS0({ facts: { ...cleanFacts(), runningCommit: 'f'.repeat(40) }, options: opts() });
    assert.equal(mismatch.failures[0].id, 'G-S0-2');
    const noStamp = evaluateS0({ facts: { ...cleanFacts(), runningCommit: null }, options: opts() });
    assert.equal(noStamp.failures[0].id, 'G-S0-2');
    assert.match(noStamp.failures[0].note, /fail-closed/);
    const noHead = evaluateS0({ facts: { ...cleanFacts(), head: null }, options: opts() });
    assert.equal(noHead.failures[0].id, 'G-S0-2');
});

test('S0: EXPECT_DIRTY=0 and a dirty tree ⇒ FAIL G-S0-3 (卡面验收②)', () => {
    const facts = { ...cleanFacts(), dirty: [{ code: ' M', path: 'scripts/xihe-cli/agent.mjs' }] };
    const e = evaluateS0({ facts, options: opts() });
    assert.equal(e.failures.length, 1);
    assert.equal(e.failures[0].id, 'G-S0-3');
    assert.equal(e.numbers.dirtyCount, 1);
    assert.deepEqual(e.numbers.dirtyPaths, ['scripts/xihe-cli/agent.mjs']);
});

test('S0: explicit expect-dirty with reason passes AND leaves the reason on the record (卡面验收③)', () => {
    const facts = { ...cleanFacts(), dirty: [{ code: ' M', path: 'packages/ui/src/a.vue' }] };
    const e = evaluateS0({ facts, options: opts({ expectDirty: 1, allowDirtyReason: 'task-25 实验需要变脏（D-1074）' }) });
    assert.equal(e.conclusion, 'PASS 开窗');
    assert.equal(e.numbers.allowDirtyReason, 'task-25 实验需要变脏（D-1074）');
    const row = e.rows.find((r) => r.id === 'G-S0-3');
    assert.match(row.note, /显式放行 reason=/);
    // receipt 侧同样留痕
    const receipt = buildS0Receipt({ evaluation: e, command: 'node x', durationMs: 5 });
    assert.equal(receipt.numbers.allowDirtyReason, 'task-25 实验需要变脏（D-1074）');
});

test('S0: expect-dirty nonzero WITHOUT a reason is refused (改门必须留痕，不许静默放宽)', () => {
    const facts = { ...cleanFacts(), dirty: [{ code: ' M', path: 'x' }] };
    const e = evaluateS0({ facts, options: opts({ expectDirty: 1, allowDirtyReason: '   ' }) });
    assert.equal(e.failures.length, 1);
    assert.equal(e.failures[0].id, 'G-S0-3');
    assert.match(e.failures[0].note, /--allow-dirty-reason/);
    assert.equal(e.numbers.allowDirtyReason, null);
});

test('S0: expect-dirty must match exactly — fewer dirty rows than expected also fails', () => {
    const e = evaluateS0({ facts: cleanFacts(), options: opts({ expectDirty: 2, allowDirtyReason: 'why' }) });
    assert.equal(e.failures[0].id, 'G-S0-3');
});

test('S0: missing READY connection ⇒ FAIL G-S0-4 with actionable reason (卡面验收①)', () => {
    const facts = { ...cleanFacts(), binding: { connection: null, template: null, error: 'stack 无 READY chat 连接' } };
    const e = evaluateS0({ facts, options: opts() });
    const failed = e.failures.map((r) => r.id);
    assert.ok(failed.includes('G-S0-4'));
    assert.match(e.conclusion, /READY chat 连接/);
});

test('S0: missing published template ⇒ FAIL G-S0-5 (卡面验收①)', () => {
    const facts = { ...cleanFacts(), binding: { connection: { id: 'conn-1' }, template: null, error: '无兼容的已发布 api-request-template' } };
    const e = evaluateS0({ facts, options: opts() });
    const failed = e.failures.map((r) => r.id);
    assert.deepEqual(failed, ['G-S0-5']);
    assert.match(e.conclusion, /api-request-template/);
});

test('S0: --skip-binding is an explicit visible skip, not a silent pass', () => {
    const e = evaluateS0({ facts: { ...cleanFacts(), binding: { skipped: true } }, options: opts() });
    assert.equal(e.conclusion, 'PASS 开窗');
    const g4 = e.rows.find((r) => r.id === 'G-S0-4');
    assert.equal(g4.value, 'skipped');
    assert.match(g4.note, /显式/);
    assert.equal(e.numbers.bindingSkipped, true);
});

/* ── 纯函数：dirty 解析 / overlap / EXPECT_DIRTY 解析 ─────────── */

test('parseDirtyRows: rename takes the new path, quoted paths are unquoted', () => {
    const rows = parseDirtyRows(' M scripts/a.mjs\nR  old.mjs -> new.mjs\n?? "带 空格.txt"\n');
    assert.deepEqual(rows, [
        { code: ' M', path: 'scripts/a.mjs' },
        { code: 'R ', path: 'new.mjs' },
        { code: '??', path: '带 空格.txt' },
    ]);
});

test('overlapOf: equality / suffix / substring all hit (宁可多报，与截拍门同语义)', () => {
    const dirty = [
        { code: ' M', path: 'scripts/xihe-cli/agent.mjs' },
        { code: ' M', path: 'packages/ui/src/components/AgentList.vue' },
        { code: '??', path: 'docs/note.md' },
    ];
    const hits = overlapOf(dirty, ['scripts/xihe-cli', 'AgentList.vue', 'scripts\\xihe-cli\\agent.mjs']);
    assert.equal(hits.length, 3);
    assert.deepEqual(hits[0].paths, ['scripts/xihe-cli/agent.mjs']);
    assert.deepEqual(hits[1].paths, ['packages/ui/src/components/AgentList.vue']);
    assert.deepEqual(hits[2].paths, ['scripts/xihe-cli/agent.mjs']);
    assert.deepEqual(overlapOf(dirty, ['packages/agent']), []);
});

test('evaluateS0 records dirtyOverlap for lane attribution without a second implicit gate', () => {
    const facts = { ...cleanFacts(), dirty: [{ code: ' M', path: 'scripts/xihe-cli/agent.mjs' }, { code: ' M', path: 'docs/x.md' }] };
    const e = evaluateS0({ facts, options: opts({ expectDirty: 2, allowDirtyReason: 'lane experiment', overlap: ['scripts/xihe-cli'] }) });
    assert.equal(e.conclusion, 'PASS 开窗');
    assert.equal(e.numbers.dirtyOverlapCount, 1);
    assert.deepEqual(e.numbers.dirtyOverlap, [{ page: 'scripts/xihe-cli', paths: ['scripts/xihe-cli/agent.mjs'] }]);
});

test('parseExpectDirty: default 0, non-negative integers only', () => {
    assert.equal(parseExpectDirty(undefined), 0);
    assert.equal(parseExpectDirty(''), 0);
    assert.equal(parseExpectDirty('0'), 0);
    assert.equal(parseExpectDirty('3'), 3);
    assert.equal(parseExpectDirty('-1'), null);
    assert.equal(parseExpectDirty('abc'), null);
    assert.equal(parseExpectDirty('1.5'), null);
});

test('parseArgs: env EXPECT_DIRTY is the fallback, flag wins; unknown arg is a usage error', () => {
    assert.equal(parseArgs([], {}).expectDirtyRaw, undefined);
    assert.equal(parseArgs([], { EXPECT_DIRTY: '2' }).expectDirtyRaw, '2');
    assert.equal(parseArgs(['--expect-dirty', '1'], { EXPECT_DIRTY: '2' }).expectDirtyRaw, '1');
    const parsed = parseArgs(['--overlap', 'scripts/xihe-cli', '--overlap=packages/ui', '--skip-binding']);
    assert.deepEqual(parsed.overlap, ['scripts/xihe-cli', 'packages/ui']);
    assert.equal(parsed.skipBinding, true);
    assert.throws(() => parseArgs(['--bogus']), /未知参数/);
    assert.throws(() => parseArgs(['--expect-dirty']), /需要一个值/);
});

/* ── checkBinding：fake fetch（判定复用 session-binding，不复刻） ── */

const jsonResponse = (status, body) => ({ status, json: async () => body });

test('checkBinding: picks the READY chat connection and the newest compatible published template', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.endsWith('/api/v1/provider-connections')) {
            return jsonResponse(200, { connections: [
                { id: 'c-unverified', status: 'UNVERIFIED', enabled: true },
                { id: 'c-ready', status: 'READY', enabled: true, apiTypeId: 'openai-chat', apiTypeVersion: 1 },
            ] });
        }
        if (url.includes('/api/v1/config/api-request-templates?layer=user')) {
            return jsonResponse(200, { templates: JSON.stringify([
                { id: 't-old', status: 'published', version: 1, apiTypeId: 'openai-chat', apiTypeVersion: 1 },
                { id: 't-new', status: 'published', version: 3, apiTypeId: 'openai-chat', apiTypeVersion: 1 },
                { id: 't-draft', status: 'draft', version: 9, apiTypeId: 'openai-chat', apiTypeVersion: 1 },
            ]) });
        }
        return jsonResponse(200, { templates: '[]' });
    };
    const binding = await checkBinding({ apiBase: 'http://cp-fake', fetchImpl, token: 't' });
    assert.equal(binding.connection.id, 'c-ready');
    assert.equal(binding.template.id, 't-new');
    assert.equal(binding.error, null);
    assert.ok(calls.every((u) => u.startsWith('http://cp-fake/api/v1/')), 'only read-only /api/v1 GETs');
});

test('checkBinding: no READY connection ⇒ readable error, no template probing', async () => {
    let templateCalls = 0;
    const fetchImpl = async (url) => {
        if (url.endsWith('/provider-connections')) return jsonResponse(200, { connections: [{ id: 'c1', status: 'INVALID_CREDENTIALS' }] });
        templateCalls += 1;
        return jsonResponse(200, { templates: '[]' });
    };
    const binding = await checkBinding({ apiBase: 'http://cp-fake', fetchImpl, token: 't' });
    assert.equal(binding.connection, null);
    assert.match(binding.error, /无 READY chat 连接/);
    assert.equal(templateCalls, 0);
});

test('checkBinding: connection but no published template anywhere ⇒ readable error', async () => {
    const fetchImpl = async (url) => {
        if (url.endsWith('/provider-connections')) return jsonResponse(200, { connections: [{ id: 'c1', status: 'READY' }] });
        return jsonResponse(200, { templates: '[]' });
    };
    const binding = await checkBinding({ apiBase: 'http://cp-fake', fetchImpl, token: 't' });
    assert.equal(binding.connection.id, 'c1');
    assert.equal(binding.template, null);
    assert.match(binding.error, /已发布 api-request-template/);
});

test('checkBinding: unreadable provider list is an error, never a pass', async () => {
    const binding = await checkBinding({ apiBase: 'http://cp-fake', fetchImpl: async () => jsonResponse(500, null), token: 't' });
    assert.equal(binding.connection, null);
    assert.match(binding.error, /HTTP 500/);
});

/* ── receipt 形状 ───────────────────────────────────────────── */

test('S0 receipt borrows the shared shape but stays out of GATES (unknown-gate whitelist only)', () => {
    assert.equal(GATES[WINDOW_S0_GATE], undefined);
    const e = evaluateS0({ facts: cleanFacts(), options: opts() });
    const receipt = buildS0Receipt({ evaluation: e, command: 'node scripts/xihe-cli/window-preflight.mjs --stack 2', durationMs: 12 });
    const shared = validateReceipt(receipt);
    const filtered = shared.problems.filter((p) => !(receipt.gate === WINDOW_S0_GATE && p.startsWith('未知门 ')));
    assert.deepEqual(filtered, []);
    assert.equal(receipt.verdict, 'pass');
    assert.equal(receipt.executed.checks, 5);
    const failing = buildS0Receipt({
        evaluation: evaluateS0({ facts: { ...cleanFacts(), stackVerdict: 'down' }, options: opts() }),
        command: 'node x', durationMs: 1,
    });
    assert.equal(failing.verdict, 'fail');
    assert.match(failing.reason, /^FAIL /);
});

test('writeS0Receipt lands under .tmp/xh/receipts/window-s0 (isolated from gate batches)', () => {
    const root = tmpRoot();
    try {
        const e = evaluateS0({ facts: cleanFacts(), options: opts() });
        const receipt = buildS0Receipt({ evaluation: e, command: 'node x', durationMs: 1 });
        const target = writeS0Receipt({ receipt, root });
        assert.ok(target.startsWith(path.join(root, '.tmp', 'xh', 'receipts', 'window-s0')));
        assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).s0.rows.length, 5);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/* ── main：注入 exec/spawn/fetch，验证退出码纪律 ─────────────── */

const mainHarness = ({ dirty = '', verdict = 'healthy', runningCommit = HEAD, head = HEAD, bindingFetch, argv = [], env = {} }) => {
    const root = tmpRoot();
    const out = [];
    const err = [];
    const execImpl = (cmd, args) => {
        assert.equal(cmd, 'git');
        if (args.includes('rev-parse')) return head === null ? 'not-a-sha\n' : `${head}\n`;
        return dirty;
    };
    const spawnImpl = () => ({ stdout: JSON.stringify({ verdict, cpBuild: { runningCommit } }) });
    const code = main(argv, {
        env,
        repoRoot: root,
        execImpl,
        spawnImpl,
        fetchImpl: bindingFetch ?? (async () => jsonResponse(200, { connections: [] })),
        loginImpl: async () => 'fake-token',
        stdout: { write: (t) => out.push(t) },
        stderr: { write: (t) => err.push(t) },
    });
    return { code, out, err, root };
};

test('main: clean tree + healthy HEAD stack + ready binding ⇒ exit 0 (卡面验收①反腿)', async () => {
    const bindingFetch = async (url) => {
        if (url.endsWith('/provider-connections')) return jsonResponse(200, { connections: [{ id: 'c1', status: 'READY' }] });
        return jsonResponse(200, { templates: JSON.stringify([{ id: 't1', status: 'published', version: 1 }]) });
    };
    const h = mainHarness({ bindingFetch, argv: ['--cp', 'http://cp-fake', '--json'] });
    try {
        assert.equal(await h.code, 0);
        const payload = JSON.parse(h.out.join(''));
        assert.equal(payload.verdict, 'pass');
        assert.ok(payload.receiptPath.includes(path.join('.tmp', 'xh', 'receipts', 'window-s0')));
    } finally {
        fs.rmSync(h.root, { recursive: true, force: true });
    }
});

test('main: dirty tree with default EXPECT_DIRTY ⇒ exit 1 and the dirty list is printed (卡面验收②)', async () => {
    const h = mainHarness({ dirty: ' M scripts/xihe-cli/agent.mjs\n', argv: ['--skip-binding', '--overlap', 'scripts/xihe-cli'] });
    try {
        assert.equal(await h.code, 1);
        const text = h.out.join('');
        assert.match(text, /FAIL G-S0-3/);
        assert.match(text, /M scripts\/xihe-cli\/agent\.mjs {2}OVERLAP/);
    } finally {
        fs.rmSync(h.root, { recursive: true, force: true });
    }
});

test('main: EXPECT_DIRTY env=1 + reason ⇒ exit 0 with the reason on stdout and in the receipt (卡面验收③)', async () => {
    const h = mainHarness({
        dirty: ' M x.mjs\n',
        env: { EXPECT_DIRTY: '1' },
        argv: ['--skip-binding', '--allow-dirty-reason', 'task-25 实验（D-1074）', '--json'],
    });
    try {
        assert.equal(await h.code, 0);
        const payload = JSON.parse(h.out.join(''));
        assert.equal(payload.numbers.allowDirtyReason, 'task-25 实验（D-1074）');
        assert.equal(payload.numbers.expectDirty, 1);
    } finally {
        fs.rmSync(h.root, { recursive: true, force: true });
    }
});

test('main: EXPECT_DIRTY=1 without reason ⇒ exit 1 (silent widening refused)', async () => {
    const h = mainHarness({ dirty: ' M x.mjs\n', env: { EXPECT_DIRTY: '1' }, argv: ['--skip-binding'] });
    try {
        assert.equal(await h.code, 1);
        assert.match(h.out.join(''), /--allow-dirty-reason/);
    } finally {
        fs.rmSync(h.root, { recursive: true, force: true });
    }
});

test('main: missing READY connection ⇒ exit 1 with the actionable reason (卡面验收①)', async () => {
    const h = mainHarness({
        bindingFetch: async (url) => url.endsWith('/provider-connections')
            ? jsonResponse(200, { connections: [{ id: 'c1', status: 'UNVERIFIED' }] })
            : jsonResponse(200, { templates: '[]' }),
        argv: ['--cp', 'http://cp-fake'],
    });
    try {
        assert.equal(await h.code, 1);
        assert.match(h.out.join(''), /无 READY chat 连接/);
    } finally {
        fs.rmSync(h.root, { recursive: true, force: true });
    }
});

test('main: unreadable HEAD or stack status ⇒ exit 2 fail-closed, never a green', async () => {
    const badHead = mainHarness({ head: null, argv: ['--skip-binding'] });
    try {
        assert.equal(await badHead.code, 2);
        assert.match(badHead.err.join(''), /fail-closed/);
    } finally {
        fs.rmSync(badHead.root, { recursive: true, force: true });
    }
    const root = tmpRoot();
    try {
        const code = await main(['--skip-binding'], {
            repoRoot: root,
            execImpl: () => `${HEAD}\n`,
            spawnImpl: () => ({ stdout: 'not json' }),
            stdout: { write: () => {} },
            stderr: { write: () => {} },
        });
        assert.equal(code, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('main: invalid EXPECT_DIRTY and missing --cp are usage errors (exit 2)', async () => {
    const bad = mainHarness({ env: { EXPECT_DIRTY: 'lots' }, argv: ['--skip-binding'] });
    try {
        assert.equal(await bad.code, 2);
    } finally {
        fs.rmSync(bad.root, { recursive: true, force: true });
    }
    const noCp = mainHarness({ argv: [] });
    try {
        assert.equal(await noCp.code, 2);
        assert.match(noCp.err.join(''), /--skip-binding/);
    } finally {
        fs.rmSync(noCp.root, { recursive: true, force: true });
    }
});

/* ── 非交互 token fail-closed（lead 裁定 2026-11-17，task-30 窗口缺陷回归） ── */

test('resolveTokenNonInteractive: XIHE_TOKEN wins; cache miss/expired throw metadata-only errors', async () => {
    const { resolveTokenNonInteractive } = await import('./window-preflight.mjs');
    assert.equal(await resolveTokenNonInteractive({ apiBase: 'http://cp', env: { XIHE_TOKEN: 'env-tok' } }), 'env-tok');
    // Cache disabled ⇒ readable error, never a prompt.
    await assert.rejects(
        resolveTokenNonInteractive({ apiBase: 'http://cp', env: { XIHE_CLI_TOKEN_CACHE: 'off' } }),
        /显式禁用/,
    );
    // Absent entry (point the store at an empty temp file path).
    const root = tmpRoot();
    try {
        const tokenFile = path.join(root, 'cli-token.json');
        await assert.rejects(
            resolveTokenNonInteractive({ apiBase: 'http://cp', env: { XIHE_CLI_TOKEN_FILE: tokenFile } }),
            /无缓存条目|kind=/,
        );
        // Expired entry ⇒ metadata-only error (expiresAt shown, no token material).
        fs.writeFileSync(tokenFile, JSON.stringify({
            version: 1,
            tokens: { 'http://cp': { token: 'SECRET-EXPIRED-TOKEN', email: 'a@b.c', expiresAt: '2020-01-01T00:00:00.000Z', obtainedAt: '2019-12-31T23:45:00.000Z' } },
        }));
        await assert.rejects(
            resolveTokenNonInteractive({ apiBase: 'http://cp', env: { XIHE_CLI_TOKEN_FILE: tokenFile } }),
            (error) => {
                assert.match(error.message, /缓存已过期/);
                assert.equal(error.message.includes('SECRET-EXPIRED-TOKEN'), false);
                return true;
            },
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('main: no XIHE_TOKEN and no usable cache ⇒ exit 2 fail-closed, never prompts or logs in', async () => {
    const root = tmpRoot();
    const out = [];
    const err = [];
    let loginCalls = 0;
    try {
        const code = await main(['--cp', 'http://cp-fake'], {
            env: { XIHE_CLI_TOKEN_FILE: path.join(root, 'missing-token.json') },
            repoRoot: root,
            execImpl: (cmd, args) => (args.includes('rev-parse') ? `${HEAD}\n` : ''),
            spawnImpl: () => ({ stdout: JSON.stringify({ verdict: 'healthy', cpBuild: { runningCommit: HEAD } }) }),
            fetchImpl: async () => { throw new Error('must not fetch without a token'); },
            loginImpl: null,
            stdout: { write: (t) => out.push(t) },
            stderr: { write: (t) => err.push(t) },
        });
        assert.equal(code, 2, 'unusable T1 chain is fail-closed exit 2');
        const text = err.join('');
        assert.match(text, /fail-closed/);
        assert.match(text, /auth login/);
        assert.equal(text.includes('promptSecret'), false, 'the crash must be gone');
        assert.equal(loginCalls, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('main: token value never appears in any output', async () => {
    const secret = 'SECRET-TOKEN-VALUE-9f8e7d';
    const h = mainHarness({
        bindingFetch: async (url) => url.endsWith('/provider-connections')
            ? jsonResponse(200, { connections: [{ id: 'c1', status: 'READY' }] })
            : jsonResponse(200, { templates: JSON.stringify([{ id: 't1', status: 'published', version: 1 }]) }),
        argv: ['--cp', 'http://cp-fake', '--json'],
    });
    assert.ok(h.root); // harness fixed login below via override
    try {
        const out = [];
        const code = await main(['--cp', 'http://cp-fake', '--json'], {
            env: {},
            repoRoot: h.root,
            execImpl: (cmd, args) => (args.includes('rev-parse') ? `${HEAD}\n` : ''),
            spawnImpl: () => ({ stdout: JSON.stringify({ verdict: 'healthy', cpBuild: { runningCommit: HEAD } }) }),
            fetchImpl: async (url) => url.endsWith('/provider-connections')
                ? jsonResponse(200, { connections: [{ id: 'c1', status: 'READY' }] })
                : jsonResponse(200, { templates: JSON.stringify([{ id: 't1', status: 'published', version: 1 }]) }),
            loginImpl: async () => secret,
            stdout: { write: (t) => out.push(t) },
            stderr: { write: (t) => out.push(t) },
        });
        assert.equal(code, 0);
        assert.equal(out.join('').includes(secret), false);
    } finally {
        fs.rmSync(h.root, { recursive: true, force: true });
    }
});
