import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
    BUILD_COMMIT_ENV,
    buildCommitEnv,
    buildCommitForBoot,
    describeBuildCommit,
    resolveBuildCommit,
} from './build-commit-env.mjs';
import { BUILD_INFO_RELATIVE_PATH, buildInfoPath } from './cp-build-info.mjs';

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
