#!/usr/bin/env node
// PLAN L2 归档门 · 单类复跑判别（污染 vs 真红），2026-11-05 定稿（BL-326 之后）。
//
// 为什么有这个脚本：整包（两 shard）里红的类，未必真红——BL-326 实测过"探针把去门 class 编进
// 主检出 target ⇒ 5 类整包红、单跑全绿"。判别方法只有一个：**在隔离 target 里从源码现编、每次只跑
// 一个类**。本脚本把 2026-11-05 手工做的 17 类矩阵固化成命令，round3 若再有红，直接跑它。
//
// USAGE
//   node scripts/l2/solo-rerun.mjs --root <repo> [--target-root <dir>] [--out <tsv>]
//                                  [--whole-run-json <clean-sequential-result.json>]
//                                  [--class <SimpleOrFqcn>]... [--classes-file <file>]
// 默认类表 = 2026-11-05 的 17 类（含基线 3 类与 flaky 1 类），可用 --class 覆盖。
// 每类一次独立 mvn 调用（独立 JVM），共享同一个隔离 target（增量编译，省时间；仍与主检出 target 无关）。
//
// 判定（--whole-run-json 给出时）：
//   A-pollution          整包红 / 单跑绿        ⇒ 跨测试或构建污染，不是回归
//   B-deterministic-red  整包红 / 单跑红同计数  ⇒ 真红（回归或未修）
//   C-partial            整包红 / 单跑红不同计数 ⇒ 部分依赖顺序，需看日志
//   D-order-only         整包绿 / 单跑红        ⇒ 顺序依赖（整包靠别的测试铺路）
//   GREEN / RED-ONLY     两处一致                ⇒ 一致绿 / 一致红（分别记录）
//
// 输出：TSV（class,wholeF/E/S,soloF/E/S,soloExit,elapsed,verdict,log）+ 控制台表格；退出码 0（仅报告）。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const flags = (name) => {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}` && index + 1 < argv.length) values.push(argv[index + 1]);
  }
  return values;
};

const ROOT = resolve(flag('root', 'H:/zeogit/one/A03-xihe'));
const MODULE = join(ROOT, 'packages/control-plane');
const TARGET_ROOT = resolve(flag('target-root', 'H:/zeotmp/l2-round3/solo'));
const OUT_TSV = resolve(flag('out', join(TARGET_ROOT, 'solo-matrix.tsv')));
const WHOLE_JSON = flag('whole-run-json', null);

const DEFAULT_CLASSES = [
  'AgentCapWriteGateBoundaryTest',
  'AgentPrincipalRoleBindingContractTest',
  'AgentPrincipalRoleBindingIntegrationTest',
  'AgentDelegatorGrantIntegrationTest',
  'SetWorkspaceCapGateIntegrationTest',
  'AgentPrincipalSkillBindingContractTest',
  'AgentTemplateSnapshotIntegrationTest',
  'PrincipalGrantAuthorizationIntegrationTest',
  'WorkspaceAgentControllerContractTest',
  'AgentPrincipalControllerContractTest',
  'DefaultSetMigrationParityTest',
  'WorkspaceJobCancelIntegrationTest',
  'WorkspaceJobOutputIntegrationTest',
  'CpArchitectureTest',
  'ContextProjectionServiceTest',
  'GrantAuthorizationServiceIntegrationTest',
  'SpawnCancelSerializationTest',
];

const fromFiles = flags('classes-file').flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/u)).map((line) => line.trim()).filter(Boolean);
const classes = [...flags('class'), ...fromFiles];
const list = classes.length ? classes : DEFAULT_CLASSES;

mkdirSync(TARGET_ROOT, { recursive: true });

const wholeReds = new Map();
if (WHOLE_JSON && existsSync(WHOLE_JSON)) {
  const json = JSON.parse(readFileSync(WHOLE_JSON, 'utf8'));
  for (const suite of json.failingSuites ?? []) {
    wholeReds.set(suite.simpleClass, suite);
  }
}

function runOne(className) {
  const logPath = join(TARGET_ROOT, `solo-${className}.log`);
  // -D 用正斜杠、不加引号：cmd /c 会吃掉嵌套双引号（BL-326 自测实测）。
  const command = `mvn -o -Dxihe.target.dir=${TARGET_ROOT.replaceAll('\\', '/')} -Dtest=${className} test`;
  const startedAt = Date.now();
  return new Promise((done) => {
    const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
    const child = spawn(shell, ['/c', command], { cwd: MODULE, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (buffer) => chunks.push(buffer));
    child.stderr.on('data', (buffer) => chunks.push(buffer));
    child.on('close', (code) => {
      writeFileSync(logPath, Buffer.concat(chunks).toString('utf8'), 'utf8');
      done({ className, exitCode: code, elapsed: Number(((Date.now() - startedAt) / 1000).toFixed(1)), logPath });
    });
  });
}

function summaryOf(logPath) {
  const text = readFileSync(logPath, 'utf8');
  const matches = [...text.matchAll(/^\[(?:INFO|ERROR)\] Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/gmu)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  return { tests: Number(last[1]), failures: Number(last[2]), errors: Number(last[3]), skipped: Number(last[4]) };
}

function verdictFor(className, solo) {
  const whole = wholeReds.get(className);
  const soloRed = solo ? solo.failures + solo.errors : 0;
  if (!whole) return soloRed > 0 ? 'D-order-only' : 'GREEN';
  const wholeRed = whole.failures + whole.errors;
  if (wholeRed > 0 && soloRed === 0) return 'A-pollution';
  if (wholeRed > 0 && soloRed === wholeRed) return 'B-deterministic-red';
  if (wholeRed > 0 && soloRed > 0) return 'C-partial';
  return 'UNEXPECTED';
}

const rows = [];
for (const className of list) {
  const result = await runOne(className);
  const solo = summaryOf(result.logPath);
  const whole = wholeReds.get(className) ?? null;
  const verdict = verdictFor(className, solo);
  rows.push({ className, whole, solo, exitCode: result.exitCode, elapsed: result.elapsed, verdict, logPath: result.logPath });
  const wholeText = whole ? `${whole.failures}/${whole.errors}/${whole.skipped}` : '—';
  const soloText = solo ? `${solo.failures}/${solo.errors}/${solo.skipped}` : 'NO-SUMMARY';
  console.log(`${className.padEnd(44)} whole(F/E/S)=${wholeText.padEnd(9)} solo=${soloText.padEnd(10)} exit=${result.exitCode} ${result.elapsed}s  ${verdict}`);
}

const header = 'class\twholeFE S\tsoloFE S\tsoloExit\telapsed\tverdict\tlog';
const lines = rows.map((row) => [
  row.className,
  row.whole ? `${row.whole.failures}/${row.whole.errors}/${row.whole.skipped}` : '-',
  row.solo ? `${row.solo.failures}/${row.solo.errors}/${row.solo.skipped}` : 'NO-SUMMARY',
  String(row.exitCode),
  `${row.elapsed}s`,
  row.verdict,
  row.logPath,
].join('\t'));
mkdirSync(resolve(OUT_TSV, '..'), { recursive: true });
writeFileSync(OUT_TSV, `${header}\n${lines.join('\n')}\n`, 'utf8');
console.log(`\n[matrix] ${OUT_TSV}`);
const counts = rows.reduce((acc, row) => ({ ...acc, [row.verdict]: (acc[row.verdict] ?? 0) + 1 }), {});
console.log(`[verdicts] ${JSON.stringify(counts)}`);
