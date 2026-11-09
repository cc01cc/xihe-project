#!/usr/bin/env node
/**
 * task-62：check-doc-line-refs.mjs 的自测（node --test，零依赖）。
 *
 * 覆盖卡片要求的六类夹具：命中 / ±10 行边界（含边界外）/ anchor 不唯一 /
 * 路径不存在 / 越界行号 / 无锚（不判错只计数）；另加：scope 过滤、白名单目录跳过、
 * --strict 才非零退出、--baseline 三段对比。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT_SRC = path.join(import.meta.dirname, "check-doc-line-refs.mjs");

/** 造一个假项目：<tmp>/A03-xihe/{scripts,docs,src} */
function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), "doc-refs-"));
    const project = path.join(root, "A03-xihe");
    const write = (rel, body) => {
        const abs = path.join(project, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, body, "utf8");
    };
    const filler = (anchorLine, anchor, total = 40) => {
        const lines = [];
        for (let i = 1; i <= total; i += 1) lines.push(i === anchorLine ? "// " + anchor : "line " + i);
        return lines.join("\n") + "\n";
    };
    write("src/Hit.java", filler(20, "HIT_ANCHOR"));
    write("src/EdgeIn.java", filler(30, "EDGE_IN"));            // 引用 20 ⇒ 边界 +10 内
    write("src/EdgeOut.java", filler(31, "EDGE_OUT"));          // 引用 20 ⇒ 边界 +11 外
    const dup = [];
    for (let i = 1; i <= 200; i += 1) dup.push(i === 5 || i === 200 ? "// DUP_ANCHOR" : "line " + i);
    write("src/Dup.java", dup.join("\n") + "\n");
    write("src/Short.java", "a\nb\nc\n");
    write("src/NoAnchor.java", filler(5, "NONE"));
    write("src/a/Amb.ts", "const a = 1;\n");
    write("src/b/Amb.ts", "const b = 1;\n");
    write("src/Other.js", filler(5, "SCOPE_OUT"));
    write("src/main.css", filler(10, "MAIN_CSS_ANCHOR"));      // 一期 scope 内的目标
    write("docs/cases.md", [
        "- 命中 `src/Hit.java:20#HIT_ANCHOR`",
        "- 边界内 `src/EdgeIn.java:20#EDGE_IN`",
        "- 边界外 `src/EdgeOut.java:20#EDGE_OUT`",
        "- 锚不唯一 `src/Dup.java:100#DUP_ANCHOR`",
        "- 路径不存在 `src/Missing.java:5#NOTHING`",
        "- 越界 `src/Short.java:50#ANY`",
        "- 无锚 `src/NoAnchor.java:5`",
        "- 同名多义 `Amb.ts:1#const`",
        "- 非一期 scope `src/Other.js:5#SCOPE_OUT`",
        "- 一期 scope 内 `src/main.css:10#MAIN_CSS_ANCHOR`",
        "",
    ].join("\n"));
    write("docs/plans/old.md", "- 历史快照 `src/EdgeOut.java:20#EDGE_OUT`\n");
    return {
        root,
        project,
        script: path.join(project, "scripts", "check-doc-line-refs.mjs"),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

function prepare(fx) {
    // 把被测脚本复制进假项目（脚本按自身位置推 projectRoot / oneRoot）
    mkdirSync(path.dirname(fx.script), { recursive: true });
    copyFileSync(SCRIPT_SRC, fx.script);
}

function run(fx, extra = []) {
    return spawnSync(process.execPath, [fx.script, "--root", path.join(fx.project, "docs"), "--json", ...extra], { encoding: "utf8" });
}

function jsonOf(result) {
    try {
        return JSON.parse(result.stdout);
    } catch {
        throw new Error("输出不是 JSON（exit=" + result.status + "）：" + result.stdout + result.stderr);
    }
}

test("六类夹具的判定与计数（--all-targets）", () => {
    const fx = fixture();
    try {
        prepare(fx);
        const result = run(fx, ["--all-targets"]);
        assert.equal(result.status, 0, "默认必须是 report-only：exit 0");
        const out = jsonOf(result);
        const items = out.items;
        const byStatus = (s) => items.filter((i) => i.status === s);
        // 命中 4 条：精确命中 + 边界内(+10) + 一期 scope 内 + 非 scope 目标（--all-targets 放开后也检查）
        assert.equal(byStatus("ok").length, 4, JSON.stringify(byStatus("ok"), null, 1));
        assert.ok(byStatus("ok").some((i) => i.target === "src/EdgeIn.java"), "±10 边界内必须判 ok");
        // 已漂 2 条：边界外(+11) + 锚不唯一
        const drift = byStatus("drift");
        assert.equal(drift.length, 2, JSON.stringify(drift, null, 1));
        assert.ok(drift.some((i) => i.target === "src/EdgeOut.java"), "±11 行必须判 drift");
        const dupDrift = drift.find((i) => i.target === "src/Dup.java");
        assert.deepEqual(dupDrift.foundAt.slice(0, 2), [5, 200], "锚不唯一时要把全篇命中的行号报出来");
        // 越界 / 目标不存在 / 多义 / 无锚各 1
        assert.equal(byStatus("out-of-range").length, 1);
        assert.equal(byStatus("missing-target").length, 1);
        assert.equal(byStatus("ambiguous-target").length, 1);
        assert.equal(byStatus("no-anchor").length, 1);
        // 计数口径：无锚不判错、只计数；--all-targets ⇒ 无 out-of-scope
        assert.equal(out.totals.withoutAnchor, 1);
        assert.equal(out.totals.inScope, 10);
        assert.equal(out.totals.outOfScope, 0);
        assert.equal(out.totals.checked, out.totals.inScope - out.totals.withoutAnchor);
        // 白名单：docs/plans/ 下的历史快照不参与
        assert.ok(!items.some((i) => i.citing.includes("/plans/")), "白名单目录必须跳过");
        assert.equal(out.totals.refs, 10, "plans/ 里那条不应计入总数");
        // 字段序固定、无时间戳
        assert.deepEqual(Object.keys(out.totals), ["refs", "inScope", "outOfScope", "checked", "ok", "drift", "outOfRange", "missingTarget", "ambiguousTarget", "withoutAnchor", "anchorlessTargetIssues"]);
        assert.equal(out.schema, "check-doc-line-refs/1");
        assert.equal(out.reportOnly, true);
        assert.equal(out.window, 10);
        assert.ok(!JSON.stringify(out).includes("timestamp"));
    } finally {
        fx.cleanup();
    }
});

test("一期 scope 默认只查易漂集（其余只计 out-of-scope）", () => {
    const fx = fixture();
    try {
        prepare(fx);
        const out = jsonOf(run(fx));
        assert.equal(out.totals.inScope, 1, "只有 src/main.css 属于一期 scope");
        assert.equal(out.totals.outOfScope, 9);
        assert.equal(out.totals.ok, 1);
        assert.equal(out.totals.drift, 0);
        assert.deepEqual(out.scope, ["mise.toml", "ChatController.java", "index.ts", "openapi.yaml", "useSSE.ts", "main.css"]);
    } finally {
        fx.cleanup();
    }
});

test("--strict 才非零退出（report-only 默认永不红）", () => {
    const fx = fixture();
    try {
        prepare(fx);
        assert.equal(run(fx).status, 0, "默认 scope 无 drift ⇒ exit 0");
        assert.equal(run(fx, ["--strict"]).status, 0, "默认 scope 无 drift，--strict 也 exit 0");
        assert.equal(run(fx, ["--all-targets", "--strict"]).status, 1, "有 drift 时 --strict 必须 exit 1");
    } finally {
        fx.cleanup();
    }
});

test("--baseline 三段对比：新增 / 已修复 / 剩余", () => {
    const fx = fixture();
    try {
        prepare(fx);
        const baselinePath = path.join(fx.root, "baseline.json");
        assert.equal(run(fx, ["--all-targets", "--write-baseline", baselinePath]).status, 0);
        const same = jsonOf(run(fx, ["--all-targets", "--baseline", baselinePath]));
        assert.equal(same.baseline.newDrift, 0);
        assert.equal(same.baseline.fixed, 0);
        assert.equal(same.baseline.remaining, 2);
        // 修好一条（把 Dup.java 的引用改成锚真实所在行 5）⇒ 已修复 1、剩余 1
        const doc = path.join(fx.project, "docs", "cases.md");
        const body = readFileSync(doc, "utf8");
        writeFileSync(doc, body.split("src/Dup.java:100#DUP_ANCHOR").join("src/Dup.java:5#DUP_ANCHOR"), "utf8");
        const after = jsonOf(run(fx, ["--all-targets", "--baseline", baselinePath]));
        assert.equal(after.baseline.fixed, 1);
        assert.equal(after.baseline.remaining, 1);
        assert.equal(after.baseline.newDrift, 0);
    } finally {
        fx.cleanup();
    }
});

test("--help 可用且不扫盘", () => {
    const fx = fixture();
    try {
        prepare(fx);
        const help = spawnSync(process.execPath, [fx.script, "--help"], { encoding: "utf8" });
        assert.equal(help.status, 0);
        assert.match(help.stdout, /check-doc-line-refs/u);
        assert.match(help.stdout, /--all-targets/u);
    } finally {
        fx.cleanup();
    }
});
