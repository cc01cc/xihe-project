import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
    BUILD_COMMIT_ENV,
    buildCommitEnv,
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
