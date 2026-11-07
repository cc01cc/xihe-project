#!/usr/bin/env node
/**
 * `scripts/check-commit-msg.mjs` 的**参数契约**自测（task-128，BL-477）。
 *
 * 为什么单单为参数写测试：这门禁的结论只有在"参数真的按预期生效"时才有意义，而改前它是
 * 逐个 `argv.includes("--xxx")` 探测的 —— 认不出的参数被**静默丢掉**，命令照常 PASS。
 * 最坏的一种不是拼错布尔开关（默认即阻断，fail-closed 碰巧还安全），而是拼错**取值参数**：
 * `--rang develop..HEAD` 不报错，直接回落到默认的 `--since 1dd57056..HEAD`，于是被校验的
 * **提交集换了一批却仍然报绿**（2026-11-08 实测：同一命令 `--range` 是 2 条提交、`--rang`
 * 是 585 条提交，两者都 exit 0）。
 *
 * 这份测试钉两件事：
 * 1) **未知参数 / 缺值 / 互斥组合 ⇒ exit 2 + usage，绝不进入校验**（stdout 不许有结论）；
 * 2) **合法参数的路径不变**：退出码契约 0/1/2、输出格式、`--range` 的 span 真的等于所给区间。
 *
 * 跑法：`node --test scripts/check-commit-msg.test.mjs`
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check-commit-msg.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE_PREFIX = "用法: node scripts/check-commit-msg.mjs";
/** 改后 usage 行必须列全的合法参数（新增参数时同批改这里，逼着文档与解析器同步）。 */
const LEGAL_FLAGS = ["--file", "--range", "--since", "--json", "--stats", "--report-only", "--enforce"];

function run(args, cwd = REPO_ROOT) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 临时 git 仓库：不碰宿主配置（`-c` 逐条给身份、hooks 指到不存在的目录）。 */
function makeRepo(messages) {
    const dir = mkdtempSync(join(tmpdir(), "xh-commit-msg-"));
    const git = (...args) =>
        spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=.git/no-hooks", ...args], {
            cwd: dir,
            encoding: "utf8",
        });
    assert.equal(git("init", "-q", "-b", "main").status, 0);
    for (const message of messages) {
        writeFileSync(join(dir, "f.txt"), `${message}\n`);
        assert.equal(git("add", "f.txt").status, 0);
        const commit = git("commit", "-q", "-m", message);
        assert.equal(commit.status, 0, `git commit 失败：${commit.stderr}`);
    }
    return dir;
}

const GOOD = "feat(scripts): 参数契约自测（BL-477）";
/** 85 列 > 72（全 ASCII，宽度可算）：非 merge 首行超宽。 */
const TOO_WIDE = `feat(scripts): ${"x".repeat(70)}`;

test("未知参数硬拒：exit 2 + `未知参数:` + usage，且 stdout 不许出现任何结论", () => {
    const r = run(["--range", "develop..HEAD", "--strict"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^未知参数: --strict$/m);
    assert.ok(r.stderr.includes(USAGE_PREFIX), `stderr 缺 usage 行：\n${r.stderr}`);
    assert.equal(r.stdout, "", "用法错误时不许输出 PASS/FAIL 之类的结论");
});

test("拼错取值参数不会静默回落：`--rang` 是未知参数，不是 `--range` 的替身", () => {
    const r = run(["--rang", "develop..HEAD", "--stats"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^未知参数: --rang$/m);
    // 改前这里会回落到默认区间并照常打印 JSON（span 会诚实地写成 1dd57056..HEAD，但没人看）
    assert.ok(!r.stdout.includes("1dd57056..HEAD"), "不许回落到默认 --since 区间还继续出结论");
});

test("位置参数硬拒：区间必须由 `--range` 给，不能裸写", () => {
    const r = run(["develop..HEAD"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^未知位置参数: develop\.\.HEAD$/m);
    assert.ok(r.stderr.includes(USAGE_PREFIX));
});

test("取值参数缺值 ⇒ exit 2（改前 `--range` 落单会静默忽略整个参数）", () => {
    for (const flag of ["--range", "--file", "--since"]) {
        const r = run([flag]);
        assert.equal(r.code, 2, `${flag} 落单时应 exit 2，实际 ${r.code}`);
        assert.match(r.stderr, new RegExp(`^参数缺值: ${flag}$`, "m"));
    }
    // 下一个 token 是 flag 时同样算缺值：绝不把另一个 flag 当成值吞掉
    const swallowed = run(["--range", "--stats"]);
    assert.equal(swallowed.code, 2);
    assert.match(swallowed.stderr, /^参数缺值: --range$/m);
});

test("互斥组合 `--report-only --enforce` ⇒ exit 2（改前 report-only 静默胜出）", () => {
    const r = run(["--range", "develop..HEAD", "--report-only", "--enforce"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^参数冲突: --report-only 与 --enforce 不能同时给$/m);
    assert.ok(r.stderr.includes(USAGE_PREFIX));
});

test("usage 行列全全部合法参数（新增参数必须同批更新文档与解析器）", () => {
    const r = run(["--nope"]);
    const usage = r.stderr.split(/\r?\n/).find((line) => line.startsWith(USAGE_PREFIX));
    assert.ok(usage, "stderr 里没有 usage 行");
    for (const flag of LEGAL_FLAGS) {
        assert.ok(usage.includes(flag), `usage 行漏了 ${flag}：${usage}`);
    }
});

test("合法路径不变：`--file` 的退出码契约仍是 0 通过 / 1 违规 / 2 用法错误", () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-commit-msg-file-"));
    try {
        const good = join(dir, "ok.txt");
        const bad = join(dir, "bad.txt");
        writeFileSync(good, `${GOOD}\n\nWhy: 钉住参数契约。\n`);
        writeFileSync(bad, `${TOO_WIDE}\n\n没有引用。\n`);

        const ok = run(["--file", good]);
        assert.equal(ok.code, 0, ok.stdout + ok.stderr);
        assert.match(ok.stdout, /^\[PASS\] /m);

        const fail = run(["--file", bad]);
        assert.equal(fail.code, 1);
        assert.match(fail.stdout, /^\[FAIL\] /m);
        assert.match(fail.stdout, /E_SUBJECT_TOO_WIDE/);

        const missing = run(["--file", join(dir, "no-such.txt")]);
        assert.equal(missing.code, 2);
        assert.match(missing.stderr, /^找不到文件：/m);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("`--enforce` 是显式写出的默认口径：结论与不带它时逐字相同", () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-commit-msg-enforce-"));
    try {
        const bad = join(dir, "bad.txt");
        writeFileSync(bad, `${TOO_WIDE}\n\n没有引用。\n`);
        const plain = run(["--file", bad]);
        const forced = run(["--file", bad, "--enforce"]);
        assert.equal(forced.code, plain.code);
        assert.equal(forced.stdout, plain.stdout);
        assert.equal(forced.stderr, plain.stderr);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("`--range` 真的生效：`--stats` 的 span 等于所给区间，违规数随区间变化", () => {
    const dir = makeRepo([GOOD, TOO_WIDE]);
    try {
        const span = "HEAD~1..HEAD";
        const stats = run(["--range", span, "--stats"], dir);
        assert.equal(stats.code, 1, stats.stdout + stats.stderr);
        const report = JSON.parse(stats.stdout);
        assert.equal(report.span, span, "span 必须等于 `--range` 给的值（参数被忽略时这里会露馅）");
        assert.equal(report.commits, 1);
        assert.ok(report.errors >= 1, `区间内的违规提交没被算出来：${stats.stdout}`);

        // 同一区间换 --report-only：吐同样的违规，但永不失败
        const reportOnly = run(["--range", span, "--report-only", "--stats"], dir);
        assert.equal(reportOnly.code, 0);
        assert.equal(JSON.parse(reportOnly.stdout).errors, report.errors);

        // 区间非法（git 不认）⇒ exit 2，不许当成"没提交 ⇒ PASS"
        const bogus = run(["--range", "no-such-rev..HEAD", "--stats"], dir);
        assert.equal(bogus.code, 2, bogus.stdout + bogus.stderr);
        assert.match(bogus.stderr, /^git log .* 失败：/m);
        assert.equal(bogus.stdout, "");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
