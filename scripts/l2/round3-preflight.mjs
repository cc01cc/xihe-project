#!/usr/bin/env node
/**
 * L2 归档门 · 靶 SHA 发放前预检（一条命令替代"人肉记得跑 6 条门"）。
 *
 * 为什么存在（2026-11-05 事故）：Lead 合并 M5-C 后把 SHA 当靶发给 lane-e2e，round1 跑掉 13 分钟
 * 才发现 `check-event-keys --enforce` RED 1 —— 靶无效、整轮作废。机械门是秒级的，属于"便宜且必须早跑"。
 * 见 `.local/evidence/l2-archive-gate-2026-11-05.md` §12。
 *
 * 设计约束：
 *   - **零写操作**：只跑 git 读命令 / 只读校验脚本 / docker ps / netstat；不 commit、不 mvn、不重启栈。
 *   - 逐项打印 `[i/8] 名称 ... PASS/FAIL(原因)`，末尾 `PREFLIGHT OK <sha>` 或 `PREFLIGHT FAIL <原因清单>`。
 *   - `--json` 输出结构化结果（给 CI / 自动派活用）；失败退出码 1，用法错误 2。
 *
 * USAGE
 *   node scripts/l2/round3-preflight.mjs --expect-sha <sha> [--root <repo>] [--target-root <dir>] [--json]
 *
 *   --expect-sha <sha>   必填。期望的靶 SHA（接受完整 40 位或短前缀，如 9726ef82）。
 *   --root <repo>        仓库根，默认取当前目录的 `git rev-parse --show-toplevel`。
 *   --target-root <dir>  L2 隔离构建根的建议值（仅打印提示），默认 H:/zeotmp。
 *   --json               机器可读输出（stdout 只有一个 JSON 对象）。
 *
 * 8 项检查
 *   1 target-sha       HEAD == --expect-sha
 *   2 clean-tree       `git status --short --untracked-files=all` 为空
 *   3 event-keys       `node scripts/check-event-keys.mjs --enforce` 解析 RED 计数 == 0（不看 exit code：YELLOW 时 exit 仍可能 0）
 *   4 openapi          `mise run check:openapi` 输出含 "OpenAPI contract passed"
 *   5 ports-parity     `mise run check:ports` 输出含 "OK (no drift)"
 *   6 e2e-clean        docker 容器名含 e2e 的计数 == 0，且端口段 27000–28511 无 listener（27339 为 Windows 保留段，豁免）
 *   7 plan-drift       `pwsh scripts/plan-status-drift.ps1` 硬漂移 == 0
 *   8 cache-isolation  仅提示：主检出 target/ 是否在 HEAD 之后被写过 + 建议 --target-root（不阻断）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const EXPECT_SHA = flag('expect-sha');
const JSON_MODE = has('json');
const TARGET_ROOT_HINT = flag('target-root', 'H:/zeotmp');
// plan-status-drift.ps1 住在 **one 根**（不是 A03 根）；默认取 ROOT 的父目录，可用 --one-root 覆盖。
const ONE_ROOT = resolve(flag('one-root') ?? join(resolve(flag('root') ?? process.cwd()), '..'));
const RESERVED_PORTS = new Set([27339]); // netsh excludedportrange 实测占用（PID 4）
// 2026-11-06 口径修正（Lead 裁定）：host E2E 的端口由 `27000 + hash(runId) % 1500` 派生，**永远落在
// 27000–28511 段内**，所以"该段必须为空"不可能成立。默认把 e2e 占用降为 **WARN**（列出占用 project 与
// 端口段）；只有当本次**自己要起 host E2E** 时才用 `--require-e2e-free` 升为阻断项。
const REQUIRE_E2E_FREE = has('require-e2e-free');
const E2E_PORT_MIN = 27000;
const E2E_PORT_MAX = 28511;

if (!EXPECT_SHA) {
  console.error('usage: node scripts/l2/round3-preflight.mjs --expect-sha <sha> [--root <repo>] [--target-root <dir>] [--json]');
  process.exit(2);
}

const ROOT = resolve(flag('root') ?? gitToplevel());
if (!existsSync(join(ROOT, '.git')) && !existsSync(join(ROOT, 'packages'))) {
  console.error(`round3-preflight: --root does not look like the repo: ${ROOT}`);
  process.exit(2);
}

function gitToplevel() {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (res.status === 0) return res.stdout.trim();
  return process.cwd();
}

function run(command, { cwd = ROOT, timeout = 120_000 } = {}) {
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
  const res = spawnSync(shell, ['/c', command], {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { code: res.status ?? -1, out, timedOut: res.error?.code === 'ETIMEDOUT' };
}

// git 走 execFileSync（不经 shell）：`cmd /c git -C "H:\a\b"` 会把引号原样传下去，Windows 上炸成
// `cannot change to '"H:\a\b"'`（本脚本首轮自测就踩到了）。
function runGit(args, { timeout = 30_000 } = {}) {
  const res = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { code: res.status ?? -1, out };
}

const checks = [];
function record(id, name, ok, detail, { blocking = true } = {}) {
  checks.push({ id, name, ok, detail, blocking });
  return ok;
}

/* ------------------------------- 1. target sha ------------------------------- */
{
  const res = runGit(['rev-parse', 'HEAD']);
  const head = res.out.trim().split(/\s+/u).pop() ?? '';
  const ok = res.code === 0 && (head === EXPECT_SHA || head.startsWith(EXPECT_SHA));
  record('target-sha', 'target-sha', ok, ok ? `HEAD=${head.slice(0, 12)}` : `HEAD=${head.slice(0, 12)} != expect=${EXPECT_SHA}`);
}

/* ------------------------------- 2. clean tree ------------------------------- */
{
  const res = runGit(['status', '--short', '--untracked-files=all']);
  const lines = res.out.split('\n').map((line) => line.trim()).filter(Boolean);
  const ok = res.code === 0 && lines.length === 0;
  record('clean-tree', 'clean-tree', ok, ok ? 'working tree clean' : `DIRTY ${lines.length} entr${lines.length === 1 ? 'y' : 'ies'}: ${lines.slice(0, 4).join(' | ')}`);
}

/* ------------------------------- 3. event keys ------------------------------- */
let eventKeys = null;
{
  const res = run('node scripts/check-event-keys.mjs --enforce', { timeout: 120_000 });
  const redMatch = /^RED\s+(\d+)/mu.exec(res.out);
  const red = redMatch ? Number(redMatch[1]) : null;
  eventKeys = { red, exitCode: res.code };
  const ok = red === 0;
  let detail;
  if (red === null) detail = `无法解析 RED 计数（exit=${res.code}）—— 视为失败`;
  else if (ok && res.code !== 0) detail = `RED 0，但 exit=${res.code}（YELLOW 非零，不阻断）`;
  else detail = `RED ${red}（exit=${res.code}）`;
  record('event-keys', 'event-keys', ok, detail);
}

/* --------------------------------- 4. openapi -------------------------------- */
{
  const res = run('mise run check:openapi', { timeout: 180_000 });
  const ok = res.code === 0 && res.out.includes('OpenAPI contract passed');
  const line = res.out.split('\n').find((item) => item.includes('OpenAPI contract passed'))?.trim();
  record('openapi', 'openapi', ok, ok ? line ?? 'OpenAPI contract passed' : `未看到 "OpenAPI contract passed"（exit=${res.code}）`);
}

/* ------------------------------- 5. ports parity ----------------------------- */
{
  const res = run('mise run check:ports', { timeout: 180_000 });
  const ok = res.code === 0 && res.out.includes('OK (no drift)');
  const line = res.out.split('\n').find((item) => item.includes('OK (no drift)'))?.trim();
  record('ports-parity', 'ports-parity', ok, ok ? line ?? 'OK (no drift)' : `未看到 "OK (no drift)"（exit=${res.code}）`);
}

/* --------------------------------- 6. e2e clean ------------------------------ */
{
  const problems = [];
  const docker = run('docker ps -a --format "{{.Names}}"', { timeout: 30_000 });
  if (docker.code !== 0) {
    problems.push(`docker ps 不可用（exit=${docker.code}）`);
  } else {
    const e2eContainers = docker.out.split('\n').map((line) => line.trim()).filter((name) => /e2e/iu.test(name));
    if (e2eContainers.length > 0) problems.push(`${e2eContainers.length} 个 e2e 容器：${e2eContainers.slice(0, 3).join(', ')}`);
  }
  const portScan = process.platform === 'win32'
    ? run('netstat -ano -p tcp', { timeout: 30_000 })
    : run('ss -ltn', { timeout: 30_000 });
  if (portScan.code !== 0) {
    problems.push(`端口扫描不可用（${process.platform === 'win32' ? 'netstat' : 'ss'} exit=${portScan.code}）`);
  } else {
    const taken = [];
    for (const line of portScan.out.split('\n')) {
      const listen = process.platform === 'win32' ? /LISTENING/u.test(line) : /\bLISTEN\b/u.test(line);
      if (!listen) continue;
      const ports = [...line.matchAll(/:(\d{2,5})\b/gu)].map((match) => Number(match[1]));
      for (const port of ports) {
        if (port >= E2E_PORT_MIN && port <= E2E_PORT_MAX && !RESERVED_PORTS.has(port)) taken.push(port);
      }
    }
    const unique = [...new Set(taken)].sort((a, b) => a - b);
    if (unique.length > 0) problems.push(`e2e 端口段被占：${unique.join(', ')}`);
  }
  const detail = problems.length === 0
    ? `docker e2e=0，端口段 ${E2E_PORT_MIN}-${E2E_PORT_MAX} 干净`
    : `${REQUIRE_E2E_FREE ? 'FAIL(--require-e2e-free)' : 'WARN(不影响 CP shard；只有自己要起 host E2E 时才需换 runId)'}: ${problems.join('; ')}`;
  record('e2e-clean', 'e2e-clean', problems.length === 0, detail, { blocking: REQUIRE_E2E_FREE });
}

/* -------------------------------- 7. plan drift ------------------------------ */
{
  const res = run('pwsh scripts/plan-status-drift.ps1', { cwd: ONE_ROOT, timeout: 180_000 });
  const match = /硬漂移\s*(\d+)/u.exec(res.out);
  const hard = match ? Number(match[1]) : null;
  const ok = hard === 0;
  record('plan-drift', 'plan-drift', ok, hard === null ? `无法解析"硬漂移"计数（exit=${res.code}）` : `硬漂移 ${hard}（exit=${res.code}）`);
}

/* ----------------------------- 8. cache isolation ---------------------------- */
{
  const hints = [`建议 --target-root ${TARGET_ROOT_HINT}（L2 runner 会自建 l2-<tag>-<shard>）`];
  const headTime = (() => {
    const res = runGit(['log', '-1', '--format=%ct']);
    const seconds = Number(res.out.trim());
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  })();
  const targetDirs = ['packages/control-plane/target', 'target'].map((rel) => join(ROOT, rel)).filter((dir) => existsSync(dir));
  if (headTime !== null && targetDirs.length > 0) {
    for (const dir of targetDirs) {
      try {
        const newest = Math.max(...readdirSync(dir).map((entry) => statSync(join(dir, entry)).mtimeMs));
        if (newest > headTime + 60_000) {
          hints.push(`⚠ ${dir.replace(ROOT, '.').replaceAll('\\', '/')} 在 HEAD 之后被写过（mtime 新于 commit）⇒ 该目录不可用于验证，L2 必须用 --target-root`);
        }
      } catch {
        // 读不到就忽略：这是提示项，不是门
      }
    }
  } else if (targetDirs.length === 0) {
    hints.push('主检出 target/ 不存在（干净）');
  }
  record('cache-isolation', 'cache-isolation', true, hints.join('; '), { blocking: false });
}

/* ---------------------------------- 输出 ---------------------------------- */
const blockingFailures = checks.filter((check) => check.blocking && !check.ok);
const ok = blockingFailures.length === 0;
const sha = checks.find((check) => check.id === 'target-sha')?.detail ?? '';

if (JSON_MODE) {
  console.log(JSON.stringify({
    ok,
    expectSha: EXPECT_SHA,
    root: ROOT,
    targetRootHint: TARGET_ROOT_HINT,
    generatedAt: new Date().toISOString(),
    checks,
    failures: blockingFailures.map((check) => `${check.name}: ${check.detail}`),
  }, null, 2));
} else {
  const width = Math.max(...checks.map((check) => check.name.length));
  checks.forEach((check, index) => {
    const status = check.ok ? 'PASS' : check.blocking ? 'FAIL' : 'INFO';
    console.log(`[${index + 1}/${checks.length}] ${check.name.padEnd(width)} ... ${status}  ${check.detail}`);
  });
  console.log('');
  if (ok) {
    console.log(`PREFLIGHT OK ${EXPECT_SHA}`);
  } else {
    console.log(`PREFLIGHT FAIL ${blockingFailures.map((check) => `${check.name}(${check.detail})`).join('; ')}`);
  }
}

process.exit(ok ? 0 : 1);
