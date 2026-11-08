/**
 * Windows User 级环境变量读取（task-234）。
 *
 * 背景：DSH 子 shell **不继承** User 级 env（`task-223` 坑 ⑧）⇒ 用 `node scripts/dev-stack.mjs`
 * 直启时 `XH_CARGO_TARGET_ROOT` 为空，cargo 回落 `lookup H:/.tmp/cargo-target`，使 cargo 单根不变量失效。
 * 本模块只做一件事：process env 缺值时从 `HKCU\Environment` 读一次并写回 process.env。
 *
 * 硬约束：
 * - **fail-open**：读不到（非 Windows / 变量不存在 / reg 不可用）⇒ `null`，不抛、不改行为。
 * - **不把机器路径写进代码**：这里只按变量名读，值来自用户环境。
 * - `exec` 可注入，便于单测不碰真实注册表。
 */
import { execFileSync } from 'node:child_process';

/**
 * 读 User 级（`HKCU\Environment`）环境变量。
 * @param {string} name 变量名
 * @param {{ exec?: (file: string, args: string[], opts: object) => string }} [options]
 * @returns {string | null} 值；不存在/读失败 ⇒ null
 */
export function readUserEnv(name, { exec = execFileSync } = {}) {
  if (typeof name !== 'string' || name.trim() === '') return null;
  try {
    const out = exec('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = String(out).match(new RegExp(`^\\s*${name}\\s+REG_[A-Z_]+\\s+(.+)$`, 'm'));
    const value = m?.[1]?.trim();
    return value === undefined || value === '' ? null : value;
  } catch {
    return null;
  }
}

/**
 * process env 缺 `name` 时用 User 级补齐（写回 `process.env`），并打印来源。
 * @param {string} name 变量名
 * @param {{ exec?: Function, logger?: { warn?: Function } }} [options]
 * @returns {{ name: string, value: string | null, source: 'process-env' | 'user-env' | 'unset' }}
 */
export function ensureEnvFromUser(name, { exec = execFileSync, logger = console } = {}) {
  const existing = typeof process.env[name] === 'string' ? process.env[name].trim() : '';
  if (existing !== '') return { name, value: existing, source: 'process-env' };
  const value = readUserEnv(name, { exec });
  if (value === null) return { name, value: null, source: 'unset' };
  process.env[name] = value;
  const warn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : console.warn.bind(console);
  warn(`[env] ${name} 取自 User 级 env（source=user-env）：${value}`);
  return { name, value, source: 'user-env' };
}
