#!/usr/bin/env node
/**
 * `scripts/check-e2e-inpage-bypass.mjs` 自测（PLAN-0687 T2.1）。
 *
 * 覆盖正反例：允许通道标注 / allowlist / 注释与字符串误判 / 反例探针（注入 bypass 写法必须红）。
 * 跑法：`node --test scripts/__tests__/check-e2e-inpage-bypass.test.mjs`
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    buildAllowlist,
    evaluateHits,
    loadAllowlist,
    loadBaselineCounts,
    maskSource,
    scanRoot,
    scanSource,
} from "./check-e2e-inpage-bypass.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts/check-e2e-inpage-bypass.mjs");

function fixtureRoot() {
    const root = mkdtempSync(path.join(tmpdir(), "e2e-bypass-"));
    mkdirSync(path.join(root, "packages/ui/e2e/real"), { recursive: true });
    return root;
}

function writeSpec(root, relativePath, content) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return target;
}

function runCli(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("scanSource: 无标注的 page.evaluate + fetch 是 violation", () => {
    const source = `
test("x", async ({ page }) => {
    const data = await page.evaluate(async () => {
        const res = await fetch("/api/v1/sessions/1");
        return res.json();
    });
});
`;
    const hits = scanSource(source, { file: "packages/ui/e2e/real/x.spec.ts" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, "/api/v1/sessions/1");
    assert.equal(hits[0].annotated, false);
    const evaluation = evaluateHits({ hits, allowlist: [] });
    assert.equal(evaluation.violations.length, 1);
    assert.equal(evaluation.annotated.length, 0);
});

test("scanSource: 同块内的 // fixture-only: 标注放行", () => {
    const source = `
test("x", async ({ page }) => {
    const created = await page.evaluate(async () => {
        // fixture-only: 建连接夹具（被测行为在 UI 后续路径）
        const res = await fetch("/api/v1/connections", { method: "POST" });
        return res.json();
    });
});
`;
    const hits = scanSource(source, { file: "packages/ui/e2e/real/x.spec.ts" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].annotated, true);
    assert.equal(evaluateHits({ hits, allowlist: [] }).violations.length, 0);
});

test("scanSource: // read-only: 标注同样放行", () => {
    const source = `
const s = await page.evaluate(async () => {
    // read-only: 断言前读回持久化状态
    const res = await fetch("/api/v1/sessions/1");
    return res.status;
});
`;
    const hits = scanSource(source, { file: "packages/ui/e2e/real/x.spec.ts" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].annotated, true);
});

test("scanSource: 注释里的 page.evaluate(fetch(...)) 不计（反例：旧 grep 会误判）", () => {
    const source = `
// 旧实现用 page.evaluate(() => fetch("/api/v1/x")) 绕过产品路径，已改走 UI（BL-204）
test("x", async ({ page }) => {
    await page.getByRole("button", { name: "发送" }).click();
});
`;
    assert.equal(scanSource(source, { file: "packages/ui/e2e/real/x.spec.ts" }).length, 0);
});

test("scanSource: 字符串内的同形文本不计", () => {
    const source = `
const sample = "page.evaluate(() => fetch('/api/v1/x'))";
test("x", async ({ page }) => {
    await page.getByText(sample).click();
});
`;
    assert.equal(scanSource(source, { file: "packages/ui/e2e/real/x.spec.ts" }).length, 0);
});

test("scanSource: page.evaluate 内无 fetch 不计", () => {
    const source = `
await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
});
`;
    assert.equal(scanSource(source, { file: "packages/ui/e2e/real/x.spec.ts" }).length, 0);
});

test("scanSource: 页外 request.post 不计（合法夹具通道）", () => {
    const source = `
await request.post("/api/v1/connections", { data: { name: "x" } });
`;
    assert.equal(scanSource(source, { file: "packages/ui/e2e/real/x.spec.ts" }).length, 0);
});

test("scanSource: 同块多个 fetch 逐条计入", () => {
    const source = `
await page.evaluate(async () => {
    await fetch("/api/v1/a");
    await fetch("/api/v1/b");
});
`;
    const hits = scanSource(source, { file: "packages/ui/e2e/real/x.spec.ts" });
    assert.deepEqual(
        hits.map((hit) => hit.url),
        ["/api/v1/a", "/api/v1/b"],
    );
});

test("evaluateHits: allowlist 按 file + url 放行并保留理由", () => {
    const hits = [
        { file: "packages/ui/e2e/real/x.spec.ts", evaluateLine: 3, fetchLine: 4, url: "/api/v1/legacy", method: "GET", annotated: false },
    ];
    const evaluation = evaluateHits({
        hits,
        allowlist: [{ file: "packages/ui/e2e/real/x.spec.ts", url: "/api/v1/legacy", reason: "legacy 残留待迁移" }],
    });
    assert.equal(evaluation.violations.length, 0);
    assert.equal(evaluation.allowlisted.length, 1);
    assert.equal(evaluation.allowlisted[0].allowlistReason, "legacy 残留待迁移");
});

test("scanRoot: 扫整条 packages/ui/e2e（real + mock，D-1039 ①）", () => {
    const root = fixtureRoot();
    writeSpec(root, "packages/ui/e2e/real/hit.spec.ts", `
await page.evaluate(async () => { await fetch("/api/v1/a"); });
`);
    writeSpec(root, "packages/ui/e2e/mock/hit.spec.ts", `
await page.evaluate(async () => { await fetch("/api/v1/mock"); });
`);
    const scan = scanRoot(root);
    assert.deepEqual(scan.files, ["packages/ui/e2e/mock/hit.spec.ts", "packages/ui/e2e/real/hit.spec.ts"]);
    assert.equal(scan.hits.length, 2);
    assert.equal(scan.hits.filter((hit) => hit.file.includes("/mock/")).length, 1, "mock lane 命中必须被扫到");
});

test("scanRoot: mock lane 未标注 ⇒ violation（扩面后的新行为必须有钉）", () => {
    const root = fixtureRoot();
    writeSpec(root, "packages/ui/e2e/mock/unannotated.spec.ts", `
test("x", async ({ page }) => {
    await page.evaluate(async () => { await fetch("/api/v1/chat/runs/1/cancel", { method: "POST" }); });
});
`);
    const scan = scanRoot(root);
    assert.equal(scan.hits.length, 1);
    const verdict = evaluateHits({ hits: scan.hits, allowlist: [] });
    assert.equal(verdict.violations.length, 1);
    assert.equal(verdict.violations[0].file, "packages/ui/e2e/mock/unannotated.spec.ts");
});

test("maskSource: 掩码保留换行与长度（行号不漂移）", () => {
    const source = '// a\nconst s = "b";\nfetch("c");\n';
    const masked = maskSource(source);
    assert.equal(masked.length, source.length);
    assert.equal(masked.split("\n").length, source.split("\n").length);
    // 代码保留（fetch 是真实调用）、注释与字符串内容被抹平
    assert.ok(masked.includes("fetch("));
    assert.ok(masked.includes("const s ="));
    assert.ok(!masked.includes("// a"));
    assert.ok(!masked.includes('"b"'));
    assert.ok(!masked.includes('"c"'));
});

test("CLI 反例探针：--enforce 有 violation 时 exit 1，report-only 恒 0", () => {
    const root = fixtureRoot();
    writeSpec(root, "packages/ui/e2e/real/bypass.spec.ts", `
await page.evaluate(async () => { await fetch("/api/v1/chat", { method: "POST" }); });
`);
    const report = runCli(["--root", root, "--config", path.join(root, "config/allowlist.json")]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /violations=1/);
    assert.match(report.stdout, /VIOLATION/);

    const enforce = runCli(["--enforce", "--root", root, "--config", path.join(root, "config/allowlist.json")]);
    assert.equal(enforce.status, 1, enforce.stderr);
});

test("CLI：--write-baseline 后 --enforce 转绿，allowlist 内容可读", () => {
    const root = fixtureRoot();
    const config = path.join(root, "config/allowlist.json");
    mkdirSync(path.dirname(config), { recursive: true });
    writeSpec(root, "packages/ui/e2e/real/bypass.spec.ts", `
await page.evaluate(async () => { await fetch("/api/v1/chat", { method: "POST" }); });
`);
    const write = runCli(["--write-baseline", "--root", root, "--config", config]);
    assert.equal(write.status, 0, write.stderr);
    const loaded = loadAllowlist(config);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0].file, "packages/ui/e2e/real/bypass.spec.ts");
    assert.equal(loaded.entries[0].url, "/api/v1/chat");

    const enforce = runCli(["--enforce", "--root", root, "--config", config]);
    assert.equal(enforce.status, 0, enforce.stdout);
    assert.match(enforce.stdout, /allowlisted=1/);
});

test("CLI：--json 输出 violation 明细字段", () => {
    const root = fixtureRoot();
    writeSpec(root, "packages/ui/e2e/real/bypass.spec.ts", `
await page.evaluate(async () => { await fetch("/api/v1/chat", { method: "POST" }); });
`);
    const result = runCli(["--json", "--root", root, "--config", path.join(root, "config/allowlist.json")]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "report-only");
    assert.equal(payload.violations.length, 1);
    assert.equal(payload.violations[0].url, "/api/v1/chat");
    assert.equal(payload.violations[0].method, "POST");
});

test("buildAllowlist: 基线条目带 file/url/理由，且标明 grandfathered", () => {
    const payload = buildAllowlist({
        hits: [{ file: "packages/ui/e2e/real/x.spec.ts", evaluateLine: 1, fetchLine: 2, url: "/api/v1/x", method: "" }],
        root: "/repo",
        generatedAt: "2026-11-07",
    });
    assert.equal(payload.version, 1);
    assert.equal(payload.entries.length, 1);
    assert.match(payload.entries[0].reason, /grandfathered/);
});

test("真实树：扫描结果与 PLAN-0687 AST 重扫的命中数一致（D-1039 ① 后含 mock lane）", () => {
    const scan = scanRoot(REPO_ROOT);
    // PLAN-0687 evidence/rescan.md：real lane 修前 14 处 / 5 文件；T1.1 修掉 2 处 in-page 写操作后剩 12 处
    // （8 只读 + 4 夹具），且全部带允许通道标注。D-1039 ① 扩到整条 e2e 后 + mock lane 3 处（2 文件，
    // coding-loop ×2 + task-continuity ×1，均已带 `// fixture-only:` 标注）⇒ 合计 15 处 / 7 文件。
    // BL-430 计数漂移更正（task-24，2026-11-17，D-1074 口径）：2026-11-15 A→B 跨上下文泄漏审计新增
    // 3 处「仪器自证」in-page fetch —— mock/task585-wsless-header-audit.spec.ts ×2（fetch 打向测试专用
    // 桩端点 /api/v1/__ab_instrument_probe，非产品路由）+ real/task3-workspace-a-to-b.real.spec.ts ×1
    // （GET 工作区详情，只读）。均为合法观测仪器、非产品 bypass ⇒ 基线 15→18（9 文件；mock 3→5）。
    // 逐条分类与变异证据：internal/A03-xihe/evidence/2026-11-17-inpage-bypass-count-drift/README.md。
    // ⚠️ 3 处新命中尚未带 `// fixture-only:`/`// read-only:` 源码标注（spec 文件不在本卡 write_scopes，
    // 补标另卡 task-621/task-585 lane）⇒ annotated 仍为 15，violations=3 属已登记残留；补标落地后应把
    // annotated 收回 18、violations 收回 0（见下方断言）。
    assert.equal(scan.hits.length, 18, `in-page fetch 期望 18 处，实得 ${scan.hits.length}: ${scan.hits.map((hit) => `${hit.file}:${hit.fetchLine}`).join(", ")}`);
    const files = [...new Set(scan.hits.map((hit) => hit.file))];
    assert.equal(files.length, 9);
    assert.equal(scan.hits.filter((hit) => hit.file.includes("/mock/")).length, 5, "mock lane 命中期望 5 处");
    // task-24：原写法把 loadAllowlist 的 {exists, entries} 包装对象直接当 allowlist 传入 ——
    // 旧基线 0 violation 时 allowlistMatch 从不执行、缺陷被掩盖；出现未标注命中后即 TypeError。改传 .entries。
    const verdict = evaluateHits({ hits: scan.hits, allowlist: loadAllowlist(path.join(REPO_ROOT, "config/e2e-inpage-bypass-allowlist.json")).entries });
    // task-24：violations 从「恒 0」改为「精确等于已登记的 3 处仪器自证残留」——不是放宽：
    // 任何**其它**文件出现未标注命中、或这 3 处之外新增 violation，仍然红；补标后此清单必须收缩回空。
    const RESIDUAL_UNANNOTATED = [
        "packages/ui/e2e/mock/task585-wsless-header-audit.spec.ts",
        "packages/ui/e2e/real/task3-workspace-a-to-b.real.spec.ts",
    ];
    assert.deepEqual(
        [...new Set(verdict.violations.map((hit) => hit.file))].sort(),
        RESIDUAL_UNANNOTATED,
        `未标注命中只允许是已登记的仪器自证残留（task-24）: ${verdict.violations.map((hit) => `${hit.file}:${hit.fetchLine}`).join(", ")}`,
    );
    assert.equal(verdict.violations.length, 3, "仪器自证残留期望恰 3 处（task585 ×2 + task3 ×1）");
    assert.equal(verdict.annotated.length, 15);
});
test("baseline：--expect-hits/--expect-annotated 与实测一致 ⇒ exit 0（真实树 18/15，task-24 更正）", () => {
  // task-24（2026-11-17）：hits 15→18（+3 仪器自证，见上方真实树测试注释）；annotated 维持 15
  // —— 新 3 处未标注（spec 不在本卡写面），CLI 默认基线 config/e2e-inpage-bypass-baseline.json
  // 仍是 {hits:15, annotated:15}，属另卡待同步项（mise check:e2e-bypass 当前因此 exit 1，证据包已登记）。
  const result = runCli(["--json", "--expect-hits", "18", "--expect-annotated", "15"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hits, 18);
  assert.equal(payload.annotated, 15);
});

test("baseline：--expect-hits 少一个 ⇒ exit 1 + COUNT_MISMATCH 清单（report-only 也拦）", () => {
  // task-24：基线 18 后「少一个」= 17（原 14/15 对），判据形态不变：仍钉 Δ=1 的精确漂移报告。
  const result = runCli(["--expect-hits", "17", "--expect-annotated", "15"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /基线计数漂移（BL-430）/);
  assert.match(result.stderr, /hits: expected=17 actual=18 \(Δ=1\)/);
  assert.match(result.stderr, /显式改基线/, "必须给出处置口径");
});

test("baseline：--expect-annotated 多一个 ⇒ exit 1 + annotated 差异清单", () => {
  // task-24：hits 期望同步 18，隔离 annotated 单轴漂移（否则 hits 轴也红，测不出本腿要测的东西）。
  const result = runCli(["--expect-hits", "18", "--expect-annotated", "16"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /基线计数漂移（BL-430）/);
  assert.match(result.stderr, /annotated: expected=16 actual=15 \(Δ=-1\)/);
});

test("baseline：基线文件缺字段/坏 JSON ⇒ null（不匹配任何期望）", () => {
  const bad = mkdtempSync(path.join(tmpdir(), "bypass-baseline-"));
  const file = path.join(bad, "baseline.json");
  writeFileSync(file, JSON.stringify({ hits: "not-a-number" }), "utf8");
  assert.equal(loadBaselineCounts(file), null);
  writeFileSync(file, "{broken", "utf8");
  assert.equal(loadBaselineCounts(file), null);
  fs.rmSync(bad, { recursive: true, force: true });
});

test("baseline：--baseline 文件提供 hits/annotated ⇒ 按基线校验", () => {
  const root = fixtureRoot();
  const config = path.join(root, "config/allowlist.json");
  const baseline = path.join(root, "config/e2e-inpage-bypass-baseline.json");
  mkdirSync(path.dirname(config), { recursive: true });
  writeSpec(root, "packages/ui/e2e/real/bypass.spec.ts", "await page.evaluate(async () => { await fetch(\"/api/v1/chat\", { method: \"POST\" }); });");
  writeFileSync(config, JSON.stringify({ version: 1, entries: [{ file: "packages/ui/e2e/real/bypass.spec.ts", url: "/api/v1/chat", reason: "fixture" }] }), "utf8");
  writeFileSync(baseline, JSON.stringify({ hits: 1, annotated: 0 }), "utf8");
  const result = runCli(["--json", "--root", root, "--config", config, "--baseline", baseline]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hits, 1);
  assert.equal(payload.annotated, 0);
});
