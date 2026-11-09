// xh-verify-gates 单测（task-37）：门表解析、门计划、SKIP 必带原因、失败传染总 exit、--list/--evidence。
// 全部用可注入的假 runner / 假 SSOT，不真跑任何重门。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GATES,
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
    assert.deepEqual(full.sort(), ["test:cp:executed", "test:mock", "test:ui"]);
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
  });
});
