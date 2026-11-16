#!/usr/bin/env node
/**
 * `scripts/check-e2e-spec-lane.mjs` 的自测（T-2318 判据④）。
 *
 * 为什么这个门需要自测：它拦的是「第 19 个孤儿 spec」（host/compose 车道都无法归属的 real spec）。
 * 判据松了（比如把注释里的标记词也算数）⇒ 删掉真标记后门照样绿 = 没门；判据紧了（比如把块注释
 * 里的叙述文本当违规）⇒ 119 个既有 @host 文件里的头注释全中，误报的门比没门更糟。
 * 本测试把两个方向都钉住：正例腿（标记 / lane 注释 / 逐测试形态）、变异腿（删标记 ⇒ 红）、
 * 防自证腿（注释里提标记词不算）、真实树腿（对 packages/ui/e2e/real 全量必须 0 违规 ——
 * 「长出第 19 个孤儿」在 test:cli 里就会红，不用等 host 窗口）。
 *
 * 夹具在 `scripts/fixtures/e2e-spec-lane/`（扩展名 .txt：复制到临时目录才改名 .spec.ts，
 * 避免被 oxlint/typecheck 当真实源码解析，沿 task-66 先例）。
 *
 * 跑法：`node --test scripts/check-e2e-spec-lane.test.mjs`
 * （接线：单测文件需在 mise.toml `test:cli` 显式清单登记 —— 本卡写入面不含 mise.toml，
 *   由 Lead 接线；`scripts/test-wiring.test.mjs` 会把「未接线」变红灯，这是预期态。）
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { classifySpec } from "./check-e2e-spec-lane.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts/check-e2e-spec-lane.mjs");
const FIXTURES = path.join(REPO_ROOT, "scripts/fixtures/e2e-spec-lane");

/** 把入仓夹具（.txt）复制成临时目录里的 .spec.ts，让 CLI 走真实的文件走路径。 */
function fixtureTree(names) {
    const root = fs.mkdtempSync(path.join(tmpdir(), "e2e-spec-lane-"));
    for (const name of names) {
        const source = path.join(FIXTURES, name);
        const target = path.join(root, name.replace(/\.txt$/, ".spec.ts"));
        fs.writeFileSync(target, fs.readFileSync(source, "utf8"), "utf8");
    }
    return root;
}

/** 变异工具：复制夹具到临时目录并按 (from, to) 替换正文，返回目录。 */
function mutatedFixture(name, replacements) {
    const root = fixtureTree([]);
    const target = path.join(root, name.replace(/\.txt$/, ".spec.ts"));
    let text = fs.readFileSync(path.join(FIXTURES, name), "utf8");
    for (const [from, to] of replacements) text = text.replace(from, to);
    fs.writeFileSync(target, text, "utf8");
    return root;
}

function runCli(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("正例腿：describe 级标记 + lane 注释 + 逐测试形态都过（exit 0）", () => {
    const dir = fixtureTree(["marked.txt", "lane-comment.txt", "per-test.txt"]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 0, `应 exit 0，实际 ${result.status}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /3 个 spec/);
    assert.match(result.stdout, /违规=0/);
    assert.match(result.stdout, /标记=2/); // marked.txt + per-test.txt（文件级有标记即计）
    assert.match(result.stdout, /lane注释=1/); // lane-comment.txt
});

test("变异腿：删掉 describe 标题里的 @host ⇒ exit 1 且点名文件（T-2318 判据④核心要求）", () => {
    const dir = mutatedFixture("marked.txt", [["@host ", ""]]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 1, `删标记后应 exit 1，实际 ${result.status}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /marked\.spec\.ts/);
    assert.match(result.stderr, /profile 标记/);
});

test("变异腿：删掉 // lane: 注释 ⇒ exit 1", () => {
    const dir = mutatedFixture("lane-comment.txt", [[/^\/\/ lane:.*\n/m, ""]]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 1, `删 lane 注释后应 exit 1，实际 ${result.status}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /lane-comment\.spec\.ts/);
});

test("无标记无注释 ⇒ exit 1 并说明两判据都不满足", () => {
    const dir = fixtureTree(["unmarked.txt"]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unmarked\.spec\.ts/);
    assert.match(result.stderr, /T-2318/);
});

test("防自证：行注释里提到 @host 不算标记（删真标记后门不能还绿）", () => {
    const dir = fixtureTree(["comment-mentions-host.txt"]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 1, `注释提及标记词不应算数\n${result.stdout}${result.stderr}`);
});

test("防自证：块注释里出现 test(\"…@host…\") 示例文本不算标记", () => {
    const dir = fixtureTree(["block-comment-mentions-host.txt"]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 1, `块注释示例不应算数\n${result.stdout}${result.stderr}`);
});

test("lane 注释里提到标记词不影响 lane 判据（exit 0）", () => {
    const dir = fixtureTree(["lane-comment-mentions-host.txt"]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 0, `lane 注释是归属声明，应放行\n${result.stdout}${result.stderr}`);
});

test("classifySpec 纯函数：全角冒号 lane 注释也认；字符串里的标记词需同行 test( 调用", () => {
    const full = classifySpec([
        "// lane：非 host（全角冒号）",
        'test("login page loads", async () => {});',
    ].join("\n"));
    assert.deepEqual(full, { marker: false, lane: true });

    const perTest = classifySpec([
        'test("no marker", async () => {});',
        'test("with @host marker", async () => {});',
    ].join("\n"));
    assert.deepEqual(perTest, { marker: true, lane: false });

    // 已记录盲区（脚本头注释）：同一**代码行**里同时出现 test( 与 @host（哪怕都在字符串里）
    // 会计入标记 —— 夹具故意把两个词拆到两行，钉住「不同行不合并」这条保证。
    const neither = classifySpec([
        'const t = "@host in a string";',
        'const u = "test( no marker";',
    ].join("\n"));
    assert.deepEqual(neither, { marker: false, lane: false });
});

test("真实树腿：packages/ui/e2e/real 全量 0 违规（第 19 个孤儿在 test:cli 就红）", () => {
    const result = runCli([]);
    assert.equal(result.status, 0, `真实树应全绿\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /违规=0/);
    const scanned = /(\d+) 个 spec/.exec(result.stdout);
    assert.ok(scanned && Number(scanned[1]) >= 137, `应扫到 ≥137 个 spec，实际 ${result.stdout}`);
});
