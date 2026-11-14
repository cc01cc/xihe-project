#!/usr/bin/env node
/**
 * `scripts/check-e2e-block-comments.mjs` 的变异自测（task-66）。
 *
 * 为什么这个门需要自测：它是「门」本身 —— 判据写松了会漏掉整条车道加载失败的事故，
 * 判据写紧了会让人去改本来没问题的文件（误报的门比没门更糟）。第一版实现用 ts.createScanner，
 * 在 4 个干净的旧文件上误报过（全是**行注释**里的通配写法）⇒ 本测试把四个方向的结论都钉住。
 *
 * 变异样例在 `scripts/fixtures/e2e-block-comments/`（扩展名 .txt：坏样例本身就是非法 TS，
 * 用 .ts 会被 oxlint / typecheck 当作真实源码去解析，等于把夹具变成事故）。
 *
 * 跑法：`node --test scripts/check-e2e-block-comments.test.mjs`（已接入 `mise run test:cli`）
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { scanText } from "./check-e2e-block-comments.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts/check-e2e-block-comments.mjs");
const FIXTURES = path.join(REPO_ROOT, "scripts/fixtures/e2e-block-comments");

/** 把入仓夹具（.txt）复制成临时目录里的 .ts，让 CLI 走真实的文件走路径。 */
function fixtureTree(names) {
    const root = fs.mkdtempSync(path.join(tmpdir(), "e2e-block-comments-"));
    for (const name of names) {
        const source = path.join(FIXTURES, name);
        const target = path.join(root, name.replace(/\.txt$/, ".ts"));
        fs.writeFileSync(target, fs.readFileSync(source, "utf8"), "utf8");
    }
    return root;
}

function runCli(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("坏样例：CLI exit 1 且点名文件:行（变异 1）", () => {
    const dir = fixtureTree(["bad.txt"]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 1, `应 exit 1，实际 ${result.status}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /FAIL: 1 problem/);
    // 行号必须指到注释起始行（夹具里是第 2 行），而不是文件头
    assert.match(result.stderr, /bad\.ts:2 \[BLOCK_COMMENT_STAR_TAIL\]/);
});

test("行注释里的同样写法安全（变异 2）", () => {
    const dir = fixtureTree(["good-line.txt"]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK: no block comment is closed early/);
});

test("反斜杠隔开的转义写法安全（变异 3）", () => {
    const dir = fixtureTree(["good-escaped.txt"]);
    assert.equal(runCli(["--dir", dir]).status, 0);
});

test("块注释只写前缀、不带星号安全（变异 4）", () => {
    const dir = fixtureTree(["good-plain.txt"]);
    assert.equal(runCli(["--dir", dir]).status, 0);
});

test("四类样例同在一棵树里：只报坏的那一个（不连锁误报）", () => {
    const dir = fixtureTree(["bad.txt", "good-line.txt", "good-escaped.txt", "good-plain.txt"]);
    const result = runCli(["--dir", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL: 1 problem/);
    assert.match(result.stderr, /bad\.ts:2/);
    for (const name of ["good-line.ts", "good-escaped.ts", "good-plain.ts"]) {
        assert.doesNotMatch(result.stderr, new RegExp(name.replace(".", "\\.")));
    }
});

test("未闭合块注释 ⇒ UNTERMINATED（同族症状）", () => {
    const problems = scanText("const A = 1;\n/** 没闭合\nconst B = 2;\n");
    assert.equal(problems.length, 1);
    assert.equal(problems[0].kind, "UNTERMINATED");
});

test("CLI 目录不存在 ⇒ exit 2（环境问题不伪装成通过）", () => {
    const result = runCli(["--dir", path.join(tmpdir(), "definitely-not-here-task66")]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /E_ENV/);
});

test("真实仓树：默认目录 exit 0（守住默认路径解析）", () => {
    const result = runCli([]);
    assert.equal(result.status, 0, result.stderr);
    const match = /scanned (\d+) \.ts files/.exec(result.stdout);
    assert.ok(match, result.stdout);
    assert.ok(Number(match[1]) > 100, `扫描文件数应 >100，实际 ${match?.[1]}`);
});
