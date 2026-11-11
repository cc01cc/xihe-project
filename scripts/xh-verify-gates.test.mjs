// xh-verify-gates 单测（task-37）：门表解析、门计划、SKIP 必带原因、失败传染总 exit、--list/--evidence。
// 全部用可注入的假 runner / 假 SSOT，不真跑任何重门。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GATES,
  checkMockBaselineReport,
  main,
  parseArgs,
  parseMiseTasks,
  parsePkgScripts,
  planGates,
  runGates,
  summarize,
} from "./xh-verify-gates.mjs";

const flush = () => new Promise((r) => setImmediate(r));

/** 造一个最小的假仓库：mise.toml（含指定任务）+ package.json。 */
function fakeRepo(t, { tasks = [], pkgScripts = {}, uiDeps = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "xh-gates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const toml = tasks
    .map(([name, run, description = `${name} gate`]) => `[tasks."${name}"]\nrun = "${run}"\ndescription = "${description}"\n`)
    .join("\n");
  writeFileSync(join(root, "mise.toml"), toml, "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: pkgScripts }), "utf8");
  if (uiDeps) mkdirSync(join(root, "packages", "ui", "node_modules"), { recursive: true });
  return root;
}

function runMain(argv, deps = {}) {
  const lines = [];
  const out = main(argv, { log: (s) => lines.push(s), runner: () => ({ exit: 0, durationMs: 1 }), ...deps });
  return { ...out, text: lines.join("\n") };
}

describe("SSOT 解析", () => {
  test("parseMiseTasks 取 description / run（多任务、忽略其它键）", () => {
    const tasks = parseMiseTasks(
      '[tasks."check:types"]\nrun = "pnpm typecheck"\ndescription = "类型门"\n\n[tasks.lint:ui]\nrun = "pnpm lint"\n',
    );
    assert.equal(tasks.get("check:types").run, "pnpm typecheck");
    assert.equal(tasks.get("check:types").description, "类型门");
    assert.equal(tasks.get("lint:ui").run, "pnpm lint");
  });

  test("parsePkgScripts：坏 JSON 不抛，返回空表", () => {
    assert.equal(parsePkgScripts("not json").size, 0);
    assert.equal(parsePkgScripts('{"scripts":{"a":"b"}}').get("a"), "b");
  });
});

describe("planGates：缺 SSOT / 缺依赖都要给 skipReason（不许静默跳过）", () => {
  test("mise 任务不存在 ⇒ skipReason 指向 mise.toml", (t) => {
    const root = fakeRepo(t, { tasks: [] });
    const [gate] = planGates({ gates: [{ id: "check:types", kind: "mise" }], miseTasks: parseMiseTasks(""), repoRoot: root });
    assert.match(gate.skipReason, /mise\.toml/);
  });

  test("UI 门缺 packages/ui/node_modules ⇒ skipReason；装了就 ready", (t) => {
    const gate = { id: "test:ui", kind: "mise" };
    const bare = fakeRepo(t, { tasks: [["test:ui", "vitest run"]] });
    assert.match(planGates({ gates: [gate], miseTasks: parseMiseTasks(readFileSync(join(bare, "mise.toml"), "utf8")), repoRoot: bare })[0].skipReason ?? "", /node_modules/);
    const withDeps = fakeRepo(t, { tasks: [["test:ui", "vitest run"]], uiDeps: true });
    const ready = planGates({
      gates: [gate],
      miseTasks: parseMiseTasks(readFileSync(join(withDeps, "mise.toml"), "utf8")),
      repoRoot: withDeps,
    })[0];
    assert.equal(ready.skipReason, undefined);
    assert.equal(ready.cmd, "mise run test:ui");
  });

  test("pkg 门从 package.json 取命令；缺 script ⇒ skipReason", (t) => {
    const root = fakeRepo(t, { pkgScripts: { lint: "eslint ." } });
    const scripts = parsePkgScripts(readFileSync(join(root, "package.json"), "utf8"));
    const ok = planGates({ gates: [{ id: "pkg:lint", kind: "pkg", pkgDir: "packages/ui" }], miseTasks: new Map(), pkgScripts: scripts, repoRoot: root })[0];
    assert.equal(ok.cmd, "pnpm --dir packages/ui run lint");
    assert.equal(ok.skipReason, undefined);
    const missing = planGates({ gates: [{ id: "pkg:nope", kind: "pkg" }], miseTasks: new Map(), pkgScripts: scripts, repoRoot: root })[0];
    assert.match(missing.skipReason, /package\.json/);
  });
});

describe("runGates / summarize：PASS/FAIL/SKIP 与总 exit", () => {
  const ready = { id: "a", cmd: "mise run a" };
  const failing = { id: "b", cmd: "mise run b" };
  const skipped = { id: "c", cmd: "mise run c", skipReason: "环境不满足" };

  test("全 PASS ⇒ exit 0，且 SKIP 不调用 runner", () => {
    const called = [];
    const results = runGates({
      planned: [ready, skipped],
      runner: ({ gate }) => {
        called.push(gate.id);
        return { exit: 0, durationMs: 3 };
      },
    });
    assert.deepEqual(called, ["a"], "SKIP 的门不得调用 runner");
    assert.equal(results[1].status, "SKIP");
    assert.equal(results[1].skipReason, "环境不满足");
    const summary = summarize(results);
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.skip, 1);
    assert.deepEqual(summary.skipped, [{ name: "c", skipReason: "环境不满足" }]);
  });

  test("一门 FAIL ⇒ status=FAIL、总 exit 1、汇总里点名", () => {
    const results = runGates({ planned: [ready, failing], runner: ({ gate }) => ({ exit: gate.id === "b" ? 2 : 0, durationMs: 1 }) });
    const summary = summarize(results);
    assert.equal(results[1].status, "FAIL");
    assert.equal(results[1].exit, 2);
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.fail, 1);
  });
});

describe("CLI", () => {
  test("--list 列出全部门、exit 0、不跑 runner", (t) => {
    const root = fakeRepo(t, { tasks: [["check:types", "tsc"], ["check:ports", "node x.mjs"]] });
    let ran = 0;
    const { exitCode, text } = runMain(["--list"], {
      repoRoot: root,
      runner: () => {
        ran += 1;
        return { exit: 0, durationMs: 1 };
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(ran, 0);
    assert.match(text, /check:types/);
    assert.match(text, /check:ports/);
  });

  test("--skip 的门带 skipReason 进汇总（显式跳过也要写原因）", (t) => {
    const root = fakeRepo(t, { tasks: [["check:types", "tsc"], ["check:ports", "node x.mjs"]] });
    const { exitCode, results, summary } = runMain(["--only=check:ports", "--skip=check:ports"], { repoRoot: root });
    assert.equal(exitCode, 0);
    assert.equal(results[0].status, "SKIP");
    assert.match(results[0].skipReason, /--skip/);
    assert.equal(summary.skip, 1);
  });

  test("未知门 id ⇒ 用法错误 exit 2 并列出可用门", (t) => {
    const root = fakeRepo(t, { tasks: [["check:types", "tsc"]] });
    const { exitCode, text } = runMain(["--only=nope"], { repoRoot: root });
    assert.equal(exitCode, 2);
    assert.match(text, /未知门 id/);
    assert.match(text, /check:types/);
  });

  test("--evidence 落 JSON（含 gates/summary/commit 字段），默认不写文件", async (t) => {
    const root = fakeRepo(t, { tasks: [["check:types", "tsc"]] });
    const evidencePath = join(root, "evidence", "gates.json");
    mkdirSync(join(root, "evidence"), { recursive: true });
    const { exitCode } = runMain(["--only=check:types", `--evidence=${evidencePath}`], { repoRoot: root });
    await flush();
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(parsed.tool, "xh-verify-gates");
    assert.equal(parsed.summary.total, 1);
    assert.equal(parsed.gates[0].name, "check:types");
    assert.ok("durationMs" in parsed.gates[0]);
    for (const key of ["status", "skipReason", "cmd", "exit"]) assert.ok(key in parsed.gates[0]);
  });

  test("默认门表 ≥6 门且全部是 mise 任务（命令不硬编码在门表里），class 分 fast/full", () => {
    assert.ok(DEFAULT_GATES.length >= 6);
    for (const gate of DEFAULT_GATES) {
      assert.equal(gate.kind ?? "mise", "mise");
      assert.ok(!("cmd" in gate), "门表只登记 task 名，命令由 SSOT 解析");
      assert.ok(["fast", "full"].includes(gate.class), `${gate.id} 缺 class`);
    }
    // L2 全量门必须显式标 full（只能在窗口内跑），其余为 fast
    const full = DEFAULT_GATES.filter((g) => g.class === "full").map((g) => g.id);
    assert.deepEqual(full.sort(), ["test:agent", "test:cp", "test:cp:executed", "test:mock", "test:ui"]);
  });

  test("--fast 只跑 class=fast 的门，L2 重门既不跑也不出现在结果里", (t) => {
    const root = fakeRepo(t, { tasks: [["check:ports", "node x.mjs"], ["test:mock", "playwright test"]] });
    const gates = [
      { id: "check:ports", kind: "mise", class: "fast" },
      { id: "test:mock", kind: "mise", class: "full" },
    ];
    const ran = [];
    const { exitCode, results } = runMain(["--fast"], {
      repoRoot: root,
      gates,
      runner: ({ gate }) => {
        ran.push(gate.id);
        return { exit: 0, durationMs: 5 };
      },
    });
    assert.deepEqual(ran, ["check:ports"]);
    assert.equal(results.length, 1);
    assert.equal(exitCode, 0);
  });

  test("输入前置缺失（mock 报告 / logs）⇒ SKIP 并说明补齐方式，不是 FAIL", (t) => {
    const root = fakeRepo(t, { tasks: [["check:mock-baseline", "node c.mjs"], ["lint:log-secrets", "node s.mjs"]] });
    const miseTasks = parseMiseTasks(readFileSync(join(root, "mise.toml"), "utf8"));
    const planned = planGates({
      gates: [
        { id: "check:mock-baseline", kind: "mise", class: "fast" },
        { id: "lint:log-secrets", kind: "mise", class: "fast" },
      ],
      miseTasks,
      repoRoot: root,
    });
    assert.match(planned[0].skipReason, /mock-report\.json/);
    assert.match(planned[1].skipReason, /logs\//);
    const results = runGates({ planned, runner: () => ({ exit: 1, durationMs: 1 }) });
    assert.deepEqual(results.map((r) => r.status), ["SKIP", "SKIP"]);
    assert.equal(summarize(results).exitCode, 0);
  });

  test("--list 展示 class 列（fast / full）", (t) => {
    const root = fakeRepo(t, { tasks: [["test:mock", "playwright test"]] });
    const { text } = runMain(["--list"], {
      repoRoot: root,
      gates: [{ id: "test:mock", kind: "mise", class: "full" }],
    });
    assert.match(text, /\[full\]/);
  });

  test("parseArgs：未知参数返回 null（由 main 转 exit 2）", () => {
    assert.equal(parseArgs(["--bogus"]), null);
    assert.equal(parseArgs(["--only=a,b"]).only.length, 2);
    assert.equal(parseArgs(["--list"]).list, true);
    assert.equal(parseArgs(["--evidence=x.json"]).evidence, "x.json");
    assert.equal(parseArgs(["--strict"]).strict, true);
    assert.equal(parseArgs(["--since=2026-11-09T21:00:00+08:00"]).since, "2026-11-09T21:00:00+08:00");
    assert.equal(parseArgs(["--run-id=r1"]).runId, "r1");
  });
});

// BL-528：`check:mock-baseline` 只查「报告存在」⇒ 旧报告可判绿（W-24 实证：槽里躺着 17 分钟前的报告）。
// 这组测试钉住新鲜度 / runId+commit 绑定 / 归属三道校验，以及 `--strict` 的 FAIL 降级。
describe("BL-528 假绿通道：mock 报告必须新鲜且属于本轮", () => {

  function repoWithMockGate(t) {
    return fakeRepo(t, { tasks: [["check:mock-baseline", "node scripts/check-mock-baseline.mjs"]] });
  }

  function writeReport(root, { startTime, runId, commit, rootDir } = {}) {
    mkdirSync(join(root, "packages", "ui", "e2e"), { recursive: true });
    const report = { stats: { startTime }, suites: [] };
    if (runId) report.runId = runId;
    if (commit) report.commit = commit;
    if (rootDir) report.config = { rootDir };
    writeFileSync(join(root, "packages", "ui", "e2e", ".mock-report.json"), JSON.stringify(report), "utf8");
    return join(root, "packages", "ui", "e2e", ".mock-report.json");
  }

  test("①新鲜报告（startTime 在本轮之后）⇒ 门照常执行 (PASS)", (t) => {
    const root = repoWithMockGate(t);
    writeReport(root, { startTime: new Date().toISOString(), runId: "run-1" });
    let ran = 0;
    const { exitCode, results } = runMain(["--only=check:mock-baseline", "--run-id=run-1", "--since=2026-01-01T00:00:00Z"], {
      repoRoot: root,
      runner: () => {
        ran += 1;
        return { exit: 0, durationMs: 1 };
      },
    });
    assert.equal(ran, 1, "输入可信 ⇒ 必须真跑这道门");
    assert.equal(results[0].status, "PASS");
    assert.equal(exitCode, 0);
  });

  test("②陈旧报告（17 分钟前）⇒ SKIP 且原因含 stale-report（不是静默通过）", (t) => {
    const root = repoWithMockGate(t);
    const stale = new Date(Date.now() - 17 * 60 * 1000).toISOString();
    writeReport(root, { startTime: stale, runId: "run-old" });
    let ran = 0;
    const { exitCode, results, summary } = runMain(["--only=check:mock-baseline", "--run-id=run-new"], {
      repoRoot: root,
      runner: () => {
        ran += 1;
        return { exit: 0, durationMs: 1 };
      },
    });
    assert.equal(ran, 0, "陈旧报告不得执行该门");
    assert.equal(results[0].status, "SKIP");
    assert.match(results[0].skipReason, /stale-report/);
    assert.equal(summary.skip, 1);
    assert.equal(exitCode, 0, "默认行为：SKIP 但 exit 0（原因进汇总）");
  });

  test("③runId / commit 不匹配 ⇒ SKIP 带原因（禁止拿别轮/别 commit 的报告判绿）", (t) => {
    const root = repoWithMockGate(t);
    writeReport(root, { startTime: new Date().toISOString(), runId: "run-other" });
    const runIdMismatch = runMain(["--only=check:mock-baseline", "--run-id=run-mine", "--since=2026-01-01T00:00:00Z"], { repoRoot: root, runner: () => ({ exit: 0, durationMs: 1 }) });
    assert.equal(runIdMismatch.results[0].status, "SKIP");
    assert.match(runIdMismatch.results[0].skipReason, /foreign-run/);

    const commitMismatch = checkMockBaselineReport({
      repoRoot: root,
      since: Date.now() - 1000,
      runId: "run-mine",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reportPath: writeReport(root, { startTime: new Date().toISOString(), runId: "run-mine", commit: "bbbbbbbb" }),
    });
    assert.equal(commitMismatch.ok, false);
    assert.equal(commitMismatch.code, "foreign-commit");
  });

  test("④--strict：陈旧/不匹配从 SKIP 降级为 FAIL（非 0）", (t) => {
    const root = repoWithMockGate(t);
    writeReport(root, { startTime: new Date(Date.now() - 17 * 60 * 1000).toISOString(), runId: "run-old" });
    const { exitCode, results } = runMain(["--only=check:mock-baseline", "--run-id=run-new", "--strict"], {
      repoRoot: root,
      runner: () => ({ exit: 0, durationMs: 1 }),
    });
    assert.equal(results[0].status, "FAIL");
    assert.match(results[0].detail, /stale-report/);
    assert.equal(exitCode, 1);
  });

  test("⑤归属：报告路径不在当前 checkout 内 ⇒ SKIP 并打印路径", (t) => {
    const root = repoWithMockGate(t);
    const elsewhere = mkdtempSync(join(tmpdir(), "xh-gates-foreign-"));
    t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
    writeFileSync(join(elsewhere, ".mock-report.json"), JSON.stringify({ stats: { startTime: new Date().toISOString() } }), "utf8");
    const verdict = checkMockBaselineReport({
      repoRoot: root,
      since: Date.now() - 1000,
      reportPath: join(elsewhere, ".mock-report.json"),
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "foreign-path");
    assert.match(verdict.reason, /禁止跨槽复用/);
  });

  test("⑥没有 startTime 时退文件 mtime；mtime 过旧同样判 stale", (t) => {
    const root = repoWithMockGate(t);
    const file = join(root, "packages", "ui", "e2e", ".mock-report.json");
    mkdirSync(join(root, "packages", "ui", "e2e"), { recursive: true });
    writeFileSync(file, JSON.stringify({ suites: [] }), "utf8");
    const old = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(file, old, old);
    const verdict = checkMockBaselineReport({ repoRoot: root, since: Date.now() - 60 * 1000, reportPath: file });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "stale-report");
  });
});

describe("task-27 A′：DEFAULT_GATES 补两条缺门", () => {
  test("默认门集包含 check:api-docs 与 lint:links", () => {
    const ids = DEFAULT_GATES.map((g) => g.id);
    assert.ok(ids.includes("check:api-docs"), "缺 check:api-docs ⇒ doc↔contract 门回到无人跑的旧状态");
    assert.ok(ids.includes("lint:links"), "缺 lint:links ⇒ 文档链接漂移只能靠人守");
  });

  test("mise.toml 缺 check:api-docs 任务 ⇒ SKIP 且带原因（未跑 ≠ 通过）", (t) => {
    const root = fakeRepo(t, { tasks: [["check:openapi", "node scripts/validate-openapi.mjs"]] });
    const plan = planGates({ miseTasks: parseMiseTasks(readFileSync(join(root, "mise.toml"), "utf8")), repoRoot: root });
    const gate = plan.find((g) => g.id === "check:api-docs");
    assert.match(gate.skipReason ?? "", /SSOT 缺该门/);
  });

  test("解释器缺失 ⇒ missing-input SKIP；--strict ⇒ preflightFailure", (t) => {
    const root = fakeRepo(t, { tasks: [["check:api-docs", "node scripts/gen-api-docs.mjs --check"]] });
    const miseTasks = parseMiseTasks(readFileSync(join(root, "mise.toml"), "utf8"));
    const prev = process.env.XH_PYTHON;
    delete process.env.XH_PYTHON;
    try {
      const relaxed = planGates({ miseTasks, repoRoot: root }).find((g) => g.id === "check:api-docs");
      assert.match(relaxed.skipReason ?? "", /missing-input/);
      const strict = planGates({ miseTasks, repoRoot: root, preconditionContext: { strict: true } }).find((g) => g.id === "check:api-docs");
      assert.match(strict.preflightFailure ?? "", /missing-input/);
      assert.equal(strict.skipReason, undefined);
    } finally {
      if (prev !== undefined) process.env.XH_PYTHON = prev;
    }
  });
});

// —— task-105：resolveWindow 四象限（窗有/无 × run-id 缺省/相等/不等）——
test("resolveWindow 四象限", async () => {
  const { resolveWindow } = await import("./xh-verify-gates.mjs");
  const A = ["VW-20261111-11"];
  // ① 窗存在 + run-id 缺省 ⇒ 采用窗 id
  assert.deepEqual(
    (({ ok, window, effectiveRunId }) => ({ ok, window, effectiveRunId }))(resolveWindow({ activeWindowIds: A })),
    { ok: true, window: "VW-20261111-11", effectiveRunId: "VW-20261111-11" },
  );
  // ② 窗存在 + run-id == 窗 id ⇒ 允许
  assert.equal(resolveWindow({ activeWindowIds: A, runId: "VW-20261111-11" }).ok, true);
  // ③ 窗存在 + run-id != 窗 id ⇒ exit 2 且点名两个值
  const r3 = resolveWindow({ activeWindowIds: A, runId: "other" });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 2);
  assert.match(r3.message, /other/);
  assert.match(r3.message, /VW-20261111-11/);
  // ④ 窗不存在 + run-id 缺省 ⇒ window "none"（断言，不是缺失）
  const r4 = resolveWindow({});
  assert.equal(r4.ok, true);
  assert.equal(r4.window, "none");
  // ⑤ 窗不存在 + 给了 run-id ⇒ 不覆盖调用方值，仍 window "none"
  const r5 = resolveWindow({ runId: "caller-id" });
  assert.equal(r5.window, "none");
  assert.equal(r5.effectiveRunId, "caller-id");
  assert.match(r5.note, /不具窗内效力/);
});
