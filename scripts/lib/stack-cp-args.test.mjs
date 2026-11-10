import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CP_NO_REBUILD_ENV,
    CP_NO_REBUILD_FLAG,
    describeCpNoRebuild,
    resolveCpNoRebuild,
    serviceArgs,
} from './stack-cp-args.mjs';

test('①不传 flag/env ⇒ 不生效，子进程参数与原先逐字节相同', () => {
    assert.deepEqual(resolveCpNoRebuild({ flag: false, env: {} }), { active: false, source: null });
    assert.deepEqual(serviceArgs({ stackRun: 'S', service: 'cp' }), ['S', 'cp']);
    assert.match(describeCpNoRebuild({ active: false, source: null }), /默认策略/);
});

test('②只传 flag ⇒ 生效，cp 子进程多一个 --no-rebuild，其它服务不变', () => {
    assert.deepEqual(resolveCpNoRebuild({ flag: true, env: {} }), { active: true, source: 'flag' });
    assert.deepEqual(serviceArgs({ stackRun: 'S', service: 'cp', noRebuild: true }), ['S', 'cp', '--no-rebuild']);
    for (const service of ['agent', 'runtime', 'ui']) {
        assert.deepEqual(serviceArgs({ stackRun: 'S', service, noRebuild: true }), ['S', service]);
    }
});

test('③只给 env ⇒ 生效，source=env；假值不生效', () => {
    assert.deepEqual(resolveCpNoRebuild({ flag: false, env: { [CP_NO_REBUILD_ENV]: '1' } }), {
        active: true,
        source: 'env',
    });
    for (const value of ['', '0', 'false', 'off', 'NO']) {
        assert.deepEqual(resolveCpNoRebuild({ flag: false, env: { [CP_NO_REBUILD_ENV]: value } }), {
            active: false,
            source: null,
        });
    }
});

test('④flag 与 env 同时给出 ⇒ 抛错（单一来源纪律，不猜不合并）', () => {
    assert.throws(
        () => resolveCpNoRebuild({ flag: true, env: { [CP_NO_REBUILD_ENV]: '1' } }),
        (error) => {
            assert.match(error.message, new RegExp(CP_NO_REBUILD_FLAG.replace(/-/g, '\\-')));
            assert.match(error.message, new RegExp(CP_NO_REBUILD_ENV));
            assert.match(error.message, /只允许一个来源生效/);
            return true;
        },
    );
});

test('⑤describeCpNoRebuild 把来源说清楚（flag/env 两档不同措辞）', () => {
    assert.match(describeCpNoRebuild({ active: true, source: 'flag' }), /来源 flag/);
    assert.match(describeCpNoRebuild({ active: true, source: 'env' }), /来源 env/);
});
