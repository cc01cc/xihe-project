#!/usr/bin/env node
/**
 * run-branch-scope.mjs — 跨仓调用 ONE 侧 check:branch-scope 的薄包装（task-69 发现）
 *
 * 为什么需要它：mise 任务原来写的是 `node ../internal/A03-xihe/scripts/check-branch-scope.mjs`，
 * 这在主 checkout 成立（A03-xihe/../internal = one/internal），但**在 worktree 里必挂**：
 * A03-xihe/.worktrees/<slot>/../internal = A03-xihe/.worktrees/internal（不存在）⇒
 * MODULE_NOT_FOUND，而且报错在 node 启动阶段，看起来像「门坏了」。
 * 实测 2026-11-11 队列头 c0d8f056 的 W2 门梯：check:branch-scope exit=1 / 0.2s / MODULE_NOT_FOUND。
 *
 * 做法：用 `git rev-parse --git-common-dir` 定位**主仓库**（worktree 与主 checkout 返回同一个值，
 * 实测 H:/zeogit/one/A03-xihe/.git），再取它的父目录 = ONE 工作区根，脚本就从那里解析。
 * 这样主 checkout / 任意 worktree / 任意盘符都不依赖相对路径深度。
 *
 * 用法：node scripts/run-branch-scope.mjs --repo . [--branch <ref>] [--json]
 * 退出码：与被调用脚本一致（0 clean / 1 E_SHARED_FILE_WRITE / 2 usage-or-environment）
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const common = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
if (common.status !== 0) {
  console.error('[branch-scope] E_USAGE: 无法定位 git common dir（' + String(common.stderr || '').trim() + '）');
  process.exit(2);
}
const oneRoot = dirname(dirname(common.stdout.trim()));
const target = resolve(oneRoot, 'internal/A03-xihe/scripts/check-branch-scope.mjs');

const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit', cwd: repoRoot });
if (r.error) {
  console.error('[branch-scope] E_USAGE: 调用 ' + target + ' 失败：' + r.error.message);
  process.exit(2);
}
process.exit(typeof r.status === 'number' ? r.status : 2);
