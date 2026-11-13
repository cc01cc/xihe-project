import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
    BUILD_COMMIT_ENV,
    buildCommitEnv,
    buildCommitForBoot,
    cpBuildForStack,
    describeBuildCommit,
    resolveBuildCommit,
} from './build-commit-env.mjs';
import { BUILD_INFO_RELATIVE_PATH, buildInfoPath, cpBuildStatus, gitHead } from './cp-build-info.mjs';
import { resolveBuildTargetForStack } from './cp-build-dir.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

/** 在临时目录造一个 targetDir，可选写入 build-info 文本。 */
function withTargetDir(info, run) {
    const root = mkdtempSync(join(tmpdir(), 'g12-commit-'));
    try {
        const targetDir = join(root, 'target');
        if (info) {
            const file = join(targetDir, BUILD_INFO_RELATIVE_PATH);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, info, 'utf8');
        }
        return run(targetDir);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test('①build-info 存在且是合法 sha ⇒ status ok，value 就是戳里的 commit', () => {
    withTargetDir('commit=' + SHA + '\nbuiltAt=2026-11-10T00:00:00Z\ndirty=false\n', (targetDir) => {
        const state = resolveBuildCommit({ targetDir });
        assert.equal(state.status, 'ok');
        assert.equal(state.value, SHA);
        assert.equal(state.commit, SHA);
        assert.equal(state.sha, SHA.slice(0, 12));
        assert.equal(state.reason, null);
        assert.equal(state.builtAt, '2026-11-10T00:00:00Z');
        assert.equal(state.dirty, false);
        assert.equal(state.file, buildInfoPath(targetDir));
    });
});

test('②build-info 缺失 ⇒ 空串 + unknown（不是跳过），并说明原因', () => {
    withTargetDir(null, (targetDir) => {
        const state = resolveBuildCommit({ targetDir });
        assert.equal(state.status, 'unknown');
        assert.equal(state.value, '');
        assert.equal(state.reason, 'missing-build-info');
        assert.deepEqual(buildCommitEnv(state), { [BUILD_COMMIT_ENV]: '' });
        assert.match(describeBuildCommit(state), /status=unknown reason=missing-build-info/);
    });
});

test('③commit 非法（非十六进制）⇒ 空串 + unknown reason=invalid-commit', () => {
    withTargetDir('commit=not-a-sha\n', (targetDir) => {
        const state = resolveBuildCommit({ targetDir });
        assert.equal(state.status, 'unknown');
        assert.equal(state.value, '');
        assert.equal(state.reason, 'invalid-commit');
    });
});

test('④短 sha 与全 sha 都接受（与三侧 reader 的校验口径一致）', () => {
    withTargetDir('commit=b0c68ddf\n', (targetDir) => {
        const state = resolveBuildCommit({ targetDir });
        assert.equal(state.status, 'ok');
        assert.equal(state.value, 'b0c68ddf');
    });
});

test('⑤targetDir 缺失或 read 抛错 ⇒ unknown，且 buildCommitEnv 恒有一个键', () => {
    assert.equal(resolveBuildCommit({}).reason, 'no-target-dir');
    const state = resolveBuildCommit({
        targetDir: '/tmp/whatever',
        read: () => {
            throw new Error('boom');
        },
    });
    assert.equal(state.status, 'unknown');
    assert.equal(state.reason, 'unreadable');
    assert.deepEqual(buildCommitEnv(null), { [BUILD_COMMIT_ENV]: '' });
});

// task-61：注入值必须回答「**这次要跑的**构建是哪个」，而不是「上一次那个目录里躺着的是哪个」。
const STALE_SHA = 'be2cd4e97554ed9a3d5f5554485574ca81904c89';

test('⑥verdict=fresh ⇒ 注入指针里的 sha（fresh ⇒ 不会重建 ⇒ 必等于将要运行的构建）', () => {
    withTargetDir('commit=' + SHA + '\nbuiltAt=2026-11-10T00:00:00Z\ndirty=false\n', (targetDir) => {
        const state = buildCommitForBoot({ cpBuild: { verdict: 'fresh', targetDir } });
        assert.equal(state.status, 'ok');
        assert.equal(state.value, SHA);
        assert.deepEqual(buildCommitEnv(state), { [BUILD_COMMIT_ENV]: SHA });
    });
});

test('⑦verdict≠fresh ⇒ 注入空串且**绝不**读旧 targetDir 的 sha（task-61 核心回归）', () => {
    // 旧 targetDir 里**确实躺着**一个合法 sha —— 正是真实事故形态（指针指向上一构建）。
    withTargetDir('commit=' + STALE_SHA + '\nbuiltAt=2026-11-11T13:13:00Z\ndirty=false\n', (targetDir) => {
        for (const verdict of ['stale', 'dirty', 'missing', 'unverified']) {
            const state = buildCommitForBoot({ cpBuild: { verdict, targetDir } });
            assert.equal(state.status, 'unknown', `${verdict}: 必须 unknown`);
            assert.equal(state.value, '', `${verdict}: 注入值必须为空串`);
            assert.equal(state.commit, null, `${verdict}: commit 必须 null`);
            assert.notEqual(state.value, STALE_SHA, `${verdict}: 绝不能再注入旧 sha`);
            assert.equal(state.reason, `cp-build-${verdict}`);
            assert.deepEqual(buildCommitEnv(state), { [BUILD_COMMIT_ENV]: '' }, `${verdict}: env 必须是空串`);
        }
    });
});

test('⑧fresh 才允许调用 read：verdict≠fresh 时 resolve 一次都不该被调用', () => {
    let calls = 0;
    const resolve = () => {
        calls += 1;
        return { value: STALE_SHA, status: 'ok', commit: STALE_SHA, sha: STALE_SHA.slice(0, 12), reason: null, builtAt: '', dirty: false, file: null };
    };
    const unknown = buildCommitForBoot({ cpBuild: { verdict: 'stale', targetDir: '/whatever' }, resolve });
    assert.equal(unknown.value, '');
    assert.equal(calls, 0, '非 fresh 时不得去读任何 targetDir');

    const ok = buildCommitForBoot({ cpBuild: { verdict: 'fresh', targetDir: '/whatever' }, resolve });
    assert.equal(ok.value, STALE_SHA);
    assert.equal(calls, 1);

    // 缺省 verdict（cpBuild 为空）按 unverified 处理 —— 不知道就不报值。
    assert.equal(buildCommitForBoot({}).reason, 'cp-build-unverified');
});

/**
 * task-283 判据③：**同一个问题只有一个实现**。
 *
 * 这两条守的是「路径 B 不许重新长出自己的一套解析」：`cpBuildForStack` 必须把
 * 「找构建目录 → 读戳 → 判新鲜度」整段委托给 `resolveBuildTargetForStack` + `cpBuildStatus`，
 * 且**不得**自己解析 build-info 文本或自带 sha 校验。任何一处重新实现都会造出
 * 「两个来源两个值」——那正是本模块禁止的形态。
 */
test('⑨cpBuildForStack 委托同一个解析链：targetDir/verdict 与分步调用逐字段相等', () => {
    // 有指针 ⇒ resolveBuildTargetForStack 走 pointer 分支；用显式 root 隔离，不碰真构建根。
    const root = mkdtempSync(join(tmpdir(), 'g12-stack-'));
    try {
        const stackId = 'stack-9';
        const targetDir = join(root, stackId, 'abc123abc123');
        mkdirSync(join(targetDir, BUILD_INFO_RELATIVE_PATH.replace(/\\/g, '/'), '..'), {
            recursive: true,
        });
        writeFileSync(
            join(targetDir, BUILD_INFO_RELATIVE_PATH),
            'commit=' + SHA + '\nbuiltAt=2026-11-10T00:00:00Z\ndirty=false\n',
            'utf8',
        );
        mkdirSync(join(root, stackId), { recursive: true });
        writeFileSync(
            join(root, stackId, '.current'),
            JSON.stringify({ stackId, targetDir, commit: SHA, verdict: 'fresh' }),
            'utf8',
        );

        const row = cpBuildForStack({
            projectRoot: process.cwd(),
            stackId,
            env: { XIHE_CP_TARGET_DIR: '' },
            root,
        });
        // 与分步调用逐字段对照：同一份 lib 实现 ⇒ 必须完全一致（不是「大致相同」）。
        const target = resolveBuildTargetForStack({ root, stackId, env: {}, commit: SHA, dirty: false });
        const expected = cpBuildStatus({
            targetDir: target.targetDir,
            headCommit: gitHead({ cwd: process.cwd() }).commit,
            cwd: process.cwd(),
            targetDirSource: target.source,
        });
        assert.equal(row.targetDir, expected.targetDir);
        assert.equal(row.verdict, expected.verdict);
        assert.equal(row.targetDirSource, 'pointer');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/**
 * task-283 判据②（负例保护）：**修根不许修成「两条路径一起报错值」**。
 *
 * 非 fresh 时 `cpBuildForStack` + `buildCommitForBoot` 的组合必须仍然给空串 —— 空串是
 * 「不敢报」，不是「没有答案」。若哪天有人为了「让 commit 总能显示」而在这里退回猜测 sha，
 * 这条会红。
 */
test('⑩非 fresh 的栈 ⇒ cpBuildForStack 拿到的 verdict 让注入为空串（不是猜一个 sha）', () => {
    const root = mkdtempSync(join(tmpdir(), 'g12-stack-'));
    try {
        const stackId = 'stack-9';
        const targetDir = join(root, stackId, 'deadbeefdead');
        // 指针存在但**没有** build-info 戳 ⇒ verdict=missing，绝不可当 fresh。
        mkdirSync(join(root, stackId), { recursive: true });
        writeFileSync(
            join(root, stackId, '.current'),
            JSON.stringify({ stackId, targetDir, commit: 'deadbeefdead', verdict: 'fresh' }),
            'utf8',
        );

        const row = cpBuildForStack({ projectRoot: process.cwd(), stackId, env: {}, root });
        assert.equal(row.verdict, 'missing');
        const state = buildCommitForBoot({
            cpBuild: { verdict: row.verdict, targetDir: row.targetDir, file: row.file },
        });
        assert.equal(state.status, 'unknown');
        assert.deepEqual(buildCommitEnv(state), { [BUILD_COMMIT_ENV]: '' });
        assert.match(describeBuildCommit(state), /reason=cp-build-missing/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

