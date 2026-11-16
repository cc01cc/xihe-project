#!/usr/bin/env node
/**
 * 元测试：`scripts/**\/*.test.mjs` 里的每个文件都必须被某个 mise 任务**真正执行**。
 *
 * 为什么需要它：`test:cli` 用**显式文件列表**而不是 glob —— 跨 shell 行为确定，并且能用排除
 * 清单表达"需要外部依赖、不能进日常门禁"这类例外（glob 做不到）。代价是新增测试文件不会自动
 * 接上：2026-11 实测 `scripts/` 下有 5 个已存在的 `*.test.mjs` 从未被任何 mise 任务执行过
 * （PLAN-0628 M3b③ 才补上）。这份测试把"又忘了接线"变成红灯，而不是靠人记。
 *
 * 匹配规则（有意保守，只认会真的执行命令的行）：
 * - 读 `mise.toml` 文本，**先剔除注释行**：被注释掉的冻结任务不算接线（本仓有
 *   `# [tasks."test:e2e:compose"]` 这类冻结块，不剔除的话一个已停用的任务会伪装成"已引用"）；
 * - 再看 `run = ...` 行：只在任务命令里出现才算接线。写在 `description` 里的文件名不算 ——
 *   描述不会执行任何东西，这正是最容易骗过文本匹配的写法；
 * - 文件路径以仓库相对 POSIX 形式出现即视为已接线（允许落在任意任务里，不限于 `test:cli`）；
 * - 排除清单必须写明原因，且条目必须真实存在 —— 过时的排除项同样红灯。
 *
 * 跑法：`node --test scripts/test-wiring.test.mjs`
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** `scripts/` 的上一级 = 仓库根（不依赖 cwd，mise 从根跑、人从子目录跑都一样）。 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_SUFFIX = ".test.mjs";
const SELF = "scripts/test-wiring.test.mjs";

/**
 * 显式排除清单：仓库相对路径 → 原因。**目前只有 1 项**（真栈只读案例，见下）—— 其余 `scripts/` 下
 * 单测都是自洽的（无网络、不需要 mise/docker/live 栈、不绑端口）。将来若某个文件确实需要外部依赖，
 * 在这里登记并写清 "需要什么、为什么不能进 test:cli、它由哪个车道负责"；不要用注释掉列表项的办法
 * 临时排除（注释掉的项正是这份测试要抓的东西）。
 */
const EXCLUDED = new Map([
    [
        "scripts/lib/stack-lease-three-cases.test.mjs",
        "案例 C「真栈只读」需要 live 栈 healthy：直接跑 `dev-stack status --all --json` 并断言每栈 healthy /"
            + " mismatch=[] / cpBuild=fresh（2026-11-09 23:3x 实测：停栈环境 exit=1，案例 A/A′/B/A2 四个纯注入案例绿）。"
            + "日常门禁里没有真栈、也不该为跑单测起栈（用户裁定 B：停栈不是故障）；同一文件无法只接子集 ⇒"
            + " 由 dev-host-verification 车道在真栈窗口单独跑 `node --test scripts/lib/stack-lease-three-cases.test.mjs`。",
    ],
]);

function posix(path) {
    return path.split(sep).join("/");
}

function collectTestFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules") continue;
            found.push(...collectTestFiles(full));
        } else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
            found.push(posix(relative(ROOT, full)));
        }
    }
    return found.sort();
}

function miseLines() {
    return readFileSync(join(ROOT, "mise.toml"), "utf8").split(/\r?\n/);
}

/** 有效行：注释行被剔除，冻结/停用任务不能伪装成接线。 */
function effectiveMiseLines() {
    return miseLines().filter((line) => !line.trimStart().startsWith("#"));
}

/** 只会真的执行命令的行：`depends` 之外的 `run = ...`。 */
function miseRunLines() {
    return effectiveMiseLines().filter((line) => /^\s*run\s*=/.test(line));
}

test("every scripts/**/*.test.mjs is wired into a mise run line", () => {
    const runLines = miseRunLines();
    const files = collectTestFiles(join(ROOT, "scripts"));

    assert.ok(runLines.length > 0, "no `run = ...` line found in mise.toml — this check would be vacuous");
    assert.ok(
        runLines.filter((line) => line.includes("node --test")).length > 0,
        "no mise task runs `node --test` anymore; revisit this test instead of deleting it",
    );

    const missing = files.filter(
        (file) => !EXCLUDED.has(file) && !runLines.some((line) => line.includes(file)),
    );
    assert.deepEqual(
        missing,
        [],
        `unwired test files (add them to a mise \`run = ...\` line, e.g. test:cli, or to EXCLUDED`
            + ` with a reason): ${missing.join(", ")}`,
    );
});

test("the scan really walks the whole scripts tree", () => {
    const files = collectTestFiles(join(ROOT, "scripts"));

    assert.ok(files.includes(SELF), `${SELF} must be part of the scanned set`);
    assert.ok(
        files.some((file) => file.slice("scripts/".length).includes("/")),
        "no nested test file found: the recursive walk is broken and the wiring check is vacuous",
    );
    assert.ok(
        files.every((file) => file.startsWith("scripts/") && file.endsWith(TEST_SUFFIX)),
        `unexpected entry in the scanned set: ${files.join(", ")}`,
    );
});

test("a commented-out (frozen) task is not counted as wiring", () => {
    const commentedTasks = miseLines().filter((line) => /^\s*#\s*\[tasks\./.test(line));
    assert.ok(
        commentedTasks.length > 0,
        "the frozen-task convention (`# [tasks....]`) is gone from mise.toml; revisit this test",
    );

    const effective = effectiveMiseLines();
    for (const commented of commentedTasks) {
        const body = commented.replace(/^\s*#\s*/, "").trim();
        assert.ok(
            !effective.includes(body),
            `a commented-out task line survived the comment filter and would count as wiring: ${body}`,
        );
    }
});

test("the exclusion list is documented and free of stale entries", () => {
    const files = new Set(collectTestFiles(join(ROOT, "scripts")));
    for (const [file, reason] of EXCLUDED) {
        assert.ok(files.has(file), `stale EXCLUDED entry (no such test file): ${file}`);
        assert.equal(typeof reason, "string", `${file}: the exclusion reason must be a string`);
        assert.ok(
            reason.trim().length >= 20,
            `${file}: write a real reason (what external dependency, and which lane runs it instead)`,
        );
    }
});
