/**
 * task-234：`scripts/lib/user-env.mjs` 单测（三态 + reg 解析 + fail-open）。
 * 不碰真实注册表：`exec` 全部注入；process.env 改动都在 try/finally 里还原。
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { ensureEnvFromUser, readUserEnv } from './user-env.mjs';

const NAME = 'XH_CARGO_TARGET_ROOT';
const USER_VALUE = join(tmpdir(), 'cargo-target');
const REG_OK = `\r\nHKEY_CURRENT_USER\\Environment\r\n    ${NAME}    REG_SZ    ${USER_VALUE}\r\n\r\n`;
let savedProcessValue;
let savedExisted;

beforeEach(() => {
  savedExisted = Object.hasOwn(process.env, NAME);
  savedProcessValue = process.env[NAME];
  delete process.env[NAME];
});

afterEach(() => {
  if (savedExisted) process.env[NAME] = savedProcessValue;
  else delete process.env[NAME];
});

test('process env 已设 ⇒ 不读注册表、source=process-env', () => {
  process.env[NAME] = 'G:\\probe-target';
  const calls = [];
  const exec = (file, args) => {
    calls.push({ file, args });
    return REG_OK;
  };
  const r = ensureEnvFromUser(NAME, { exec, logger: { warn() {} } });
  assert.equal(r.source, 'process-env');
  assert.equal(r.value, 'G:\\probe-target');
  assert.equal(calls.length, 0);
});

test('process env 空 + User 级有值 ⇒ 写回 process.env 且 source=user-env（带 warn）', () => {
  const warnings = [];
  const exec = () => REG_OK;
  const r = ensureEnvFromUser(NAME, { exec, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(r.source, 'user-env');
  assert.equal(r.value, USER_VALUE);
  assert.equal(process.env[NAME], USER_VALUE);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /source=user-env/);
});

test('process env 空 + User 级无值 ⇒ source=unset 且不改 process.env（fail-open）', () => {
  const exec = () => {
    throw new Error('reg: The system was unable to find the specified registry key or value.');
  };
  const r = ensureEnvFromUser(NAME, { exec, logger: { warn() {} } });
  assert.equal(r.source, 'unset');
  assert.equal(r.value, null);
  assert.equal(process.env[NAME], undefined);
});

test('readUserEnv 解析 reg 输出；无匹配/异常 ⇒ null', () => {
  assert.equal(readUserEnv(NAME, { exec: () => REG_OK }), USER_VALUE);
  assert.equal(readUserEnv(NAME, { exec: () => 'HKEY_CURRENT_USER\\Environment\r\n    OTHER    REG_SZ    x\r\n' }), null);
  assert.equal(readUserEnv(NAME, { exec: () => { throw new Error('boom'); } }), null);
  assert.equal(readUserEnv('', { exec: () => REG_OK }), null);
});
