// lane-sync-hot.mjs 的守卫测试（node --test）：分类器 + 干净校验 + 窗口拒绝 + dry-run 输出 + 合并演练。
//
// 全部用 mkdtemp 造的临时 git 仓库（main + linked worktree lane），**不碰 one/A03 真仓**。
// "主检出零写入"用真实 git 事实断言：lane 合并前后，main 的 HEAD 必须一字不变。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bucketOf,
  buildHotPlan,
  classifyChanges,
  parseNameStatus,
  parsePorcelain,
} from "./lane-sync-hot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "lane-sync-hot.mjs");

const g = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const gTry = (dir, ...args) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim() };
  } catch (err) {
    return { ok: false, err };
  }
};

/** main（develop）+ 一个 linked worktree lane（task/256-lane-sync）；两个 CP main java 夹具 */
function initFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "lane-sync-hot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "main");
  mkdirSync(main, { recursive: true });
  g(main, "init", "-q");
  g(main, "symbolic-ref", "HEAD", "refs/heads/develop");
  g(main, "config", "user.email", "lane-sync@example.test");
  g(main, "config", "user.name", "lane-sync test");
  g(main, "config", "commit.gpgsign", "false");
  mkdirSync(join(main, "packages", "control-plane", "src", "main", "java", "com", "x"), { recursive: true });
  writeFileSync(join(main, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(main, "packages/control-plane/src/main/java/com/x/A.java"), "package com.x;\nclass A { }\n", "utf8");
  writeFileSync(join(main, "packages/control-plane/src/main/java/com/x/B.java"), "package com.x;\nclass B { }\n", "utf8");
  g(main, "add", "README.md", "packages/control-plane/src/main/java/com/x/A.java", "packages/control-plane/src/main/java/com/x/B.java");
  g(main, "commit", "-q", "-m", "chore: base fixture");
  const lane = join(root, "worktrees", "m3-a13");
  mkdirSync(join(root, "worktrees"), { recursive: true });
  g(main, "worktree", "add", "-b", "task/256-lane-sync", lane, "develop");
  return { root, main, lane };
}

/** 在 develop 上前进（写文件 + 逐路径 add + commit） */
function advanceDevelop(main, files, message = "feat(cp): develop 前进") {
  for (const rel of Object.keys(files)) {
    mkdirSync(dirname(join(main, rel)), { recursive: true });
    writeFileSync(join(main, rel), files[rel], "utf8");
  }
  g(main, "add", ...Object.keys(files));
  g(main, "commit", "-q", "-m", message);
  return g(main, "rev-parse", "HEAD");
}

/** 窗口台账桩：active 由参数决定（JSON 形态与真 xh-window list --json 一致） */
function windowStub(root, active) {
  const file = join(root, "window-stub.mjs");
  const payload = {
    now: "2026-11-08T20:00:00+08:00",
    active: active ? [{ id: "W-TEST-1", lane: "other-lane", sha: "deadbeefdeadbeef", ports: "28000-28099", status: "active" }] : [],
    history: [],
  };
  writeFileSync(file, "console.log(JSON.stringify(" + JSON.stringify(payload) + "));\n", "utf8");
  return file;
}

function runCli(args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const both = stdout + stderr;
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith("[lane-sync] summary "));
  let summary = null;
  if (line) {
    try {
      summary = JSON.parse(line.slice("[lane-sync] summary ".length));
    } catch {
      summary = null;
    }
  }
  return { status: res.status, stdout, stderr, both, summary };
}

// ── 纯函数：解析 + 分类器（§11③ 判据）──────────────────────────────────────

test("parsePorcelain / parseNameStatus：-uall 脏条目 / 新行 & -z & rename", () => {
  assert.deepEqual(parsePorcelain("?? dirty.txt\n M changed.md\n"), [
    { status: "??", path: "dirty.txt" },
    { status: "M", path: "changed.md" },
  ]);
  assert.deepEqual(parseNameStatus("M\tA.java\nA\tNew.java\n"), [
    { status: "M", path: "A.java" },
    { status: "A", path: "New.java" },
  ]);
  // -z 形态（生产路径：git diff --name-status -z）
  assert.deepEqual(parseNameStatus("M\u0000A.java\u0000D\u0000Gone.java\u0000"), [
    { status: "M", path: "A.java" },
    { status: "D", path: "Gone.java" },
  ]);
  // rename 拆成「旧删 + 新加」
  assert.deepEqual(parseNameStatus("R100\u0000old/A.java\u0000new/A.java\u0000"), [
    { status: "D", path: "old/A.java" },
    { status: "A", path: "new/A.java" },
  ]);
});

test("bucketOf：pom / migration / config / cp-java / cp-resource / runtime / agent / ui / docs", () => {
  assert.equal(bucketOf("pom.xml"), "pom");
  assert.equal(bucketOf("packages/control-plane/pom.xml"), "pom");
  assert.equal(bucketOf("packages/control-plane/src/main/resources/db/migration/V1__init.sql"), "migration");
  assert.equal(bucketOf("packages/control-plane/src/main/resources/application.properties"), "config");
  assert.equal(bucketOf("packages/control-plane/src/main/resources/application-dev.yml"), "config");
  assert.equal(bucketOf("packages/control-plane/src/main/java/com/x/A.java"), "cp-java");
  assert.equal(bucketOf("packages/control-plane/src/main/resources/static/logo.svg"), "cp-resource");
  assert.equal(bucketOf("packages/control-plane/src/test/java/com/x/ATest.java"), "cp-test");
  assert.equal(bucketOf("packages/runtime/src/main.rs"), "runtime");
  assert.equal(bucketOf("packages/agent/xihe_agent/main.py"), "agent");
  assert.equal(bucketOf("packages/ui/src/App.vue"), "ui");
  assert.equal(bucketOf("docs/README.md"), "docs");
});

test("classifyChanges：仅 java ≤4 ⇒ javac；>4 / 删除 / 资源 ⇒ mvn；pom·迁移·配置 ⇒ restart", () => {
  const java = (n) => Array.from({ length: n }, (_, i) => ({ status: "M", path: "packages/control-plane/src/main/java/com/x/C" + i + ".java" }));
  assert.equal(classifyChanges(java(2)).cpAction, "javac");
  assert.equal(classifyChanges(java(4)).cpAction, "javac");
  assert.equal(classifyChanges(java(5)).cpAction, "mvn");
  assert.equal(classifyChanges([{ status: "A", path: "packages/control-plane/src/main/java/com/x/New.java" }]).cpAction, "javac");
  assert.equal(classifyChanges([{ status: "D", path: "packages/control-plane/src/main/java/com/x/Gone.java" }]).cpAction, "mvn");
  assert.equal(classifyChanges([...java(2), { status: "M", path: "packages/control-plane/src/main/resources/static/a.svg" }]).cpAction, "mvn");
  assert.equal(classifyChanges([{ status: "M", path: "pom.xml" }]).cpAction, "restart");
  assert.equal(classifyChanges([{ status: "A", path: "packages/control-plane/src/main/resources/db/migration/V9__x.sql" }]).cpAction, "restart");
  assert.equal(classifyChanges([{ status: "M", path: "packages/control-plane/src/main/resources/application.properties" }]).cpAction, "restart");
  assert.equal(classifyChanges([]).cpAction, "none");
  assert.equal(classifyChanges([{ status: "M", path: "docs/AGENTS.md" }]).cpAction, "none");
  // 混合：java ≤4 + runtime ⇒ CP 走 javac，runtime 只作为 followup（不自动动它的进程）
  const mixed = classifyChanges([...java(2), { status: "M", path: "packages/runtime/src/main.rs" }]);
  assert.equal(mixed.cpAction, "javac");
  assert.deepEqual(mixed.followups.map((f) => f.kind), ["runtime"]);
  // CP 测试文件不触发热编
  assert.equal(classifyChanges([{ status: "M", path: "packages/control-plane/src/test/java/com/x/ATest.java" }]).cpAction, "none");
});

test("buildHotPlan：javac 带 --git-range、mvn 不带、restart 只给人工命令、runtime 只给命令", () => {
  const laneAbs = join("H:", "zeogit", "one", "A03-xihe", ".worktrees", "m3-a13");
  const javac = buildHotPlan({ classification: classifyChanges([{ status: "M", path: "packages/control-plane/src/main/java/com/x/A.java" }]), stack: 2, laneAbs, range: "aaa..bbb" });
  assert.equal(javac.steps.length, 1);
  assert.equal(javac.steps[0].mode, "javac");
  assert.ok(javac.steps[0].argv.includes("--javac"));
  assert.deepEqual(javac.steps[0].argv.slice(javac.steps[0].argv.indexOf("--git-range")), ["--git-range", "aaa..bbb"]);
  assert.equal(javac.waitRestart, true);

  const mvn = buildHotPlan({ classification: classifyChanges([{ status: "M", path: "pom.xml" }]), stack: 2, laneAbs, range: "aaa..bbb" });
  assert.equal(mvn.steps.length, 0, "restart 场景不得自动编译");
  assert.deepEqual(mvn.manual, ["node scripts/dev-stack.mjs stop --stack 2 --json", "node scripts/dev-stack.mjs start --stack 2 --json"]);
  assert.equal(mvn.needsManual, true);

  const runtime = buildHotPlan({ classification: classifyChanges([{ status: "M", path: "packages/runtime/src/main.rs" }]), stack: 2, laneAbs, range: "aaa..bbb" });
  assert.equal(runtime.steps.length, 0);
  assert.ok(runtime.manual.some((line) => line.includes("dev-hot-runtime.mjs")));

  // 安全断言：计划里绝不出现 reset/rebase/push/checkout --
  const all = JSON.stringify([javac, mvn, runtime]);
  for (const forbidden of ["git reset", "git rebase", "git push", "checkout --", "git clean"]) {
    assert.equal(all.includes(forbidden), false, "计划里不得出现 " + forbidden);
  }
});

// ── 集成：门禁与 dry-run ───────────────────────────────────────────────────

test("窗口期 active>0 ⇒ E_WINDOW_ACTIVE 拒绝（dry-run 也拒，ref 不动）", (t) => {
  const fixture = initFixture(t);
  const window = windowStub(fixture.root, true);
  const before = g(fixture.lane, "rev-parse", "HEAD");
  advanceDevelop(fixture.main, { "packages/control-plane/src/main/java/com/x/A.java": "package com.x;\nclass A { int v; }\n" });

  const res = runCli(["--repo", fixture.lane, "--dry-run"], { XH_WINDOW_SCRIPT: window });

  assert.equal(res.status, 1, res.both);
  assert.match(res.both, /E_WINDOW_ACTIVE/);
  assert.match(res.both, /W-TEST-1/, "拒绝信息必须列出窗口 id");
  assert.equal(res.summary?.code, 1);
  assert.equal(g(fixture.lane, "rev-parse", "HEAD"), before, "拒绝时 lane ref 不得移动");
});

test("lane 不干净 ⇒ E_DIRTY（打印脏文件，ref 不动）", (t) => {
  const fixture = initFixture(t);
  writeFileSync(join(fixture.lane, "dirty.txt"), "uncommitted\n", "utf8");
  const before = g(fixture.lane, "rev-parse", "HEAD");
  const res = runCli(["--repo", fixture.lane, "--dry-run"], { XH_WINDOW_SCRIPT: windowStub(fixture.root, false) });
  assert.equal(res.status, 1, res.both);
  assert.match(res.both, /E_DIRTY/);
  assert.match(res.both, /dirty\.txt/, "必须打印脏文件清单");
  assert.equal(g(fixture.lane, "rev-parse", "HEAD"), before);
});

test("窗口台账不可判定（脚本缺失）⇒ E_WINDOW_UNKNOWN fail-closed", (t) => {
  const fixture = initFixture(t);
  const res = runCli(["--repo", fixture.lane, "--dry-run"], { XH_WINDOW_SCRIPT: join(fixture.root, "no-such-window.mjs") });
  assert.equal(res.status, 1, res.both);
  assert.match(res.both, /E_WINDOW_UNKNOWN/);
});

test("主检出（非 linked worktree）⇒ E_PRIMARY_CHECKOUT 拒绝（零写入原则）", (t) => {
  const fixture = initFixture(t);
  const before = g(fixture.main, "rev-parse", "HEAD");
  const res = runCli(["--repo", fixture.main, "--dry-run"], { XH_WINDOW_SCRIPT: windowStub(fixture.root, false) });
  assert.equal(res.status, 1, res.both);
  assert.match(res.both, /E_PRIMARY_CHECKOUT/);
  assert.equal(g(fixture.main, "rev-parse", "HEAD"), before);
});

test("dry-run：输出分段计划 + 分类（incoming），且不写 lane / 不写主检出", (t) => {
  const fixture = initFixture(t);
  const window = windowStub(fixture.root, false);
  const laneBefore = g(fixture.lane, "rev-parse", "HEAD");
  advanceDevelop(fixture.main, {
    "packages/control-plane/src/main/java/com/x/A.java": "package com.x;\nclass A { int v; }\n",
    "packages/control-plane/src/main/java/com/x/B.java": "package com.x;\nclass B { int v; }\n",
  });
  const mainBefore = g(fixture.main, "rev-parse", "HEAD"); // 夹具前进后再取，之后 CLI 不得再动它

  const res = runCli(["--repo", fixture.lane, "--merge", "--dry-run"], { XH_WINDOW_SCRIPT: window });

  assert.equal(res.status, 0, res.both);
  assert.match(res.both, /classification\(incoming\): changes=2 cp=javac/, "应分类为 javac（仅 java 2 个）");
  assert.match(res.both, /plan: javac 单文件增量/, "dry-run 必须打印分段计划");
  assert.match(res.both, /behind=1/, "必须报告 lane 落后 develop 的提交数");
  assert.match(res.both, /dry-run: 未合并、未编译/);
  assert.match(res.both, /timings: merge=/, "必须打印墙钟分段（dry-run 为 0）");
  assert.equal(res.summary?.classification?.cpAction, "javac");
  assert.equal(res.summary?.dryRun, true);
  assert.equal(g(fixture.lane, "rev-parse", "HEAD"), laneBefore, "dry-run 不得动 lane ref");
  assert.equal(g(fixture.main, "rev-parse", "HEAD"), mainBefore, "dry-run 不得动主检出 ref");
});

// ── 集成：apply（只合并；无栈时不自己 start）────────────────────────────────

test("--apply --merge --no-hot：真的合并 develop，主检出 HEAD 前后一致（零写入证据）", (t) => {
  const fixture = initFixture(t);
  const window = windowStub(fixture.root, false);
  const laneBefore = g(fixture.lane, "rev-parse", "HEAD");
  const developSha = advanceDevelop(fixture.main, { "README.md": "# fixture v2\n" });
  const mainBefore = g(fixture.main, "rev-parse", "HEAD"); // 夹具前进后再取，之后 CLI 不得再动它

  const res = runCli(["--repo", fixture.lane, "--merge", "--apply", "--no-hot"], { XH_WINDOW_SCRIPT: window });

  assert.equal(res.status, 0, res.both);
  assert.match(res.both, /merge: /);
  assert.match(res.both, /hot: skipped（--no-hot）/);
  assert.match(res.both, /timings: merge=/);
  const laneAfter = g(fixture.lane, "rev-parse", "HEAD");
  assert.notEqual(laneAfter, laneBefore, "merge 必须真的前进 lane");
  assert.ok(gTry(fixture.lane, "merge-base", "--is-ancestor", developSha, laneAfter).ok, "develop 必须成为 lane 的祖先");
  assert.equal(g(fixture.main, "rev-parse", "HEAD"), mainBefore, "主检出 HEAD 必须一字不变（零写入）");
  assert.equal(res.summary?.gates?.mainCheckout?.unchanged, true, "summary 必须给出主检出前后一致的事实");
});

test("--apply --merge（无栈）：合并照做、hot 显式跳过、exit 3（不自己 start 栈）", (t) => {
  const fixture = initFixture(t);
  const window = windowStub(fixture.root, false);
  const laneBefore = g(fixture.lane, "rev-parse", "HEAD");
  advanceDevelop(fixture.main, { "packages/control-plane/src/main/java/com/x/B.java": "package com.x;\nclass B { int v; }\n" });

  const res = runCli(["--repo", fixture.lane, "--merge", "--apply"], { XH_WINDOW_SCRIPT: window });

  assert.equal(res.status, 3, res.both);
  assert.match(res.both, /hot: 跳过/);
  assert.match(res.both, /本脚本不自己 start 栈/);
  assert.notEqual(g(fixture.lane, "rev-parse", "HEAD"), laneBefore, "合并必须先完成（hot 跳过不影响 sync）");
  assert.equal(res.summary?.code, 3);
});

test("--apply 缺 --merge / --range ⇒ E_USAGE（exit 2，ref 不动）", (t) => {
  const fixture = initFixture(t);
  const before = g(fixture.lane, "rev-parse", "HEAD");
  const res = runCli(["--repo", fixture.lane, "--apply"], { XH_WINDOW_SCRIPT: windowStub(fixture.root, false) });
  assert.equal(res.status, 2, res.both);
  assert.match(res.both, /E_USAGE/);
  assert.equal(g(fixture.lane, "rev-parse", "HEAD"), before);
});

test("合并冲突 ⇒ E_MERGE_CONFLICT（停、不自动 abort、给恢复命令）", (t) => {
  const fixture = initFixture(t);
  const window = windowStub(fixture.root, false);
  // lane 自有提交改 A.java；develop 改同一行 ⇒ 冲突
  writeFileSync(join(fixture.lane, "packages/control-plane/src/main/java/com/x/A.java"), "package com.x;\nclass A { int lane; }\n", "utf8");
  g(fixture.lane, "add", "packages/control-plane/src/main/java/com/x/A.java");
  g(fixture.lane, "commit", "-q", "-m", "feat(cp): lane 改动");
  advanceDevelop(fixture.main, { "packages/control-plane/src/main/java/com/x/A.java": "package com.x;\nclass A { int develop; }\n" });

  const res = runCli(["--repo", fixture.lane, "--merge", "--apply", "--no-hot"], { XH_WINDOW_SCRIPT: window });

  assert.equal(res.status, 1, res.both);
  assert.match(res.both, /E_MERGE_CONFLICT/);
  assert.match(res.both, /merge --abort/, "必须给出恢复命令");
  assert.ok(gTry(fixture.lane, "rev-parse", "-q", "--verify", "MERGE_HEAD").ok, "不自动 abort ⇒ 冲突现场保留给 Lead");
});
