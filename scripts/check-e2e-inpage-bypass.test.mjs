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
    assert.equal(scan.hits.length, 15, `in-page fetch 期望 15 处，实得 ${scan.hits.length}: ${scan.hits.map((hit) => `${hit.file}:${hit.fetchLine}`).join(", ")}`);
    const files = [...new Set(scan.hits.map((hit) => hit.file))];
    assert.equal(files.length, 7);
    assert.equal(scan.hits.filter((hit) => hit.file.includes("/mock/")).length, 3, "mock lane 命中期望 3 处");
    const verdict = evaluateHits({ hits: scan.hits, allowlist: loadAllowlist(path.join(REPO_ROOT, "config/e2e-inpage-bypass-allowlist.json")) });
    assert.equal(verdict.violations.length, 0, `真实树仍有未标注命中: ${verdict.violations.map((hit) => `${hit.file}:${hit.fetchLine}`).join(", ")}`);
    assert.equal(verdict.annotated.length, 15);
});
test("baseline：--expect-hits/--expect-annotated 与实测一致 ⇒ exit 0（真实树 15/15）", () => {
  const result = runCli(["--json", "--expect-hits", "15", "--expect-annotated", "15"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hits, 15);
  assert.equal(payload.annotated, 15);
});

test("baseline：--expect-hits 少一个 ⇒ exit 1 + COUNT_MISMATCH 清单（report-only 也拦）", () => {
  const result = runCli(["--expect-hits", "14", "--expect-annotated", "15"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /基线计数漂移（BL-430）/);
  assert.match(result.stderr, /hits: expected=14 actual=15 \(Δ=1\)/);
  assert.match(result.stderr, /显式改基线/, "必须给出处置口径");
});

test("baseline：--expect-annotated 多一个 ⇒ exit 1 + annotated 差异清单", () => {
  const result = runCli(["--expect-hits", "15", "--expect-annotated", "16"]);
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
