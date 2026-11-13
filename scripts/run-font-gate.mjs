#!/usr/bin/env node
/**
 * run-font-gate.mjs — 字体覆盖门的两步聚合入口（task-258，`mise run check:font` 的执行体）
 *
 * 为什么需要这个包装（而不是 mise 里直接写两行 node）：
 *   ① 字体产物有两份 —— internal/A03-xihe/assets/fonts（构建落点）与 packages/ui/src/assets/fonts
 *      （真正被 @font-face 引用的那份）。重建只更新前者、忘了拷后者，屏上仍然是旧子集，
 *      而所有门都绿（task-258 当晚就发生了一次）⇒ 第一步必须带 --parity 逐文件比 sha256。
 *   ② mise 任务原来若写 `node ../internal/...`，在主 checkout 成立，在 worktree 里必挂
 *      （<slot>/../internal 不存在 ⇒ MODULE_NOT_FOUND，看起来像门坏了）。这里与
 *      scripts/run-branch-scope.mjs 同形态，用 git common dir 定位 ONE 根。
 *
 * 两步判据（都红才叫红，任一红即本命令红）：
 *   1) check-font-subset.mjs --assets <internal> --parity <packages/ui>：源码用字 ⊆ 子集，且两份产物一致
 *   2) check-font-face.mjs --selftest：运行时断言门自证可用（正例绿 + 漏写 font-weight 的反例红）
 *      —— 非 --selftest 形态需要起重页面（--url），不进本命令（低频、需栈；见 font-stack-decision.md §7.2）
 *
 * 用法：
 *   mise run check:font
 *   node scripts/run-font-gate.mjs [-- <check-font-subset.mjs 的额外参数>]   # 例：-- --ui-root <另一棵树>
 * 退出码：0 全绿 / 1 断言红（缺字、产物漂移、face 夹具红）/ 2 基建（ONE 根找不到、脚本缺失）
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const common = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
if (common.status !== 0) {
  console.error('[font] E_USAGE: 无法定位 git common dir（' + String(common.stderr || '').trim() + '）');
  process.exit(2);
}
const oneRoot = dirname(dirname(common.stdout.trim()));
const scriptsDir = join(oneRoot, 'internal', 'A03-xihe', 'scripts');
const subsetScript = join(scriptsDir, 'check-font-subset.mjs');
const faceScript = join(scriptsDir, 'check-font-face.mjs');
const internalFonts = join(oneRoot, 'internal', 'A03-xihe', 'assets', 'fonts');
const uiFonts = join(repoRoot, 'packages', 'ui', 'src', 'assets', 'fonts');
for (const p of [subsetScript, faceScript, internalFonts, uiFonts]) {
  if (!existsSync(p)) { console.error('[font] E_ENV: 缺少 ' + p); process.exit(2); }
}

// mise 会把 `--` 原样透传过来（`mise run check:font -- --ui-root <dir>`），先剥掉它，
// 否则第一个实参是 "--" ⇒ 被 subset 脚本当未知参数报 E_USAGE，负例看起来像"基建错"而不是"断言红"。
const raw = process.argv.slice(2);
const extra = raw[0] === "--" ? raw.slice(1) : raw;
const run = (label, script, args) => {
  console.log('[font] ' + label + ': node ' + script + ' ' + args.join(' '));
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', cwd: repoRoot });
  if (r.error) { console.error('[font] E_USAGE: ' + r.error.message); return 2; }
  return typeof r.status === 'number' ? r.status : 2;
};

const step1 = run('1/2 覆盖 + 副本一致性', subsetScript, ['--assets', internalFonts, '--parity', uiFonts, ...extra]);
const step2 = run('2/2 运行时断言门自证', faceScript, ['--selftest']);
const bad = [step1, step2].filter((c) => c !== 0);
console.log('[font] 读数: subset=' + step1 + ' face-selftest=' + step2 + ' ⇒ ' + (bad.length ? 'FAIL' : 'PASS'));
process.exit(bad.length ? (bad.indexOf(2) >= 0 ? 2 : 1) : 0);
