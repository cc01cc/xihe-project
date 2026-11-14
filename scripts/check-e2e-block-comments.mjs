#!/usr/bin/env node
// task-66: E2E 块注释提前闭合门（事故来源 task-62）。
//
// 症状：块注释正文里出现「星号紧跟斜杠」这一对相邻字符 ⇒ 注释被**提前闭合**，后半段变成代码。
// 最常见后果是反引号开了一个永不结束的模板串 ⇒ SyntaxError: Unterminated string constant
// ⇒ **整条 mock 车道加载失败**（playwright test --list 归零、报 No tests found）。不是一条用例红，
// 是整包跑不起来 —— 2026-11-15 一夜踩三次：新 spec、e2e/mock/helpers/context-events.ts、
// 以及本门自己的头注释。**危险序列出现在你最想解释它的地方**，所以只能靠门拦。
//
// 判据（手写词法，不依赖 typescript 是否装在 packages/ui 里 —— 本门在仓库根 cwd 下跑）：
//   1 BLOCK_COMMENT_STAR_TAIL：块注释正文以星号结尾 ⇒ 作者本意写了通配路径、已在中间闭合；
//   2 UNTERMINATED：扫到文件末尾还停在块注释或字符串里（同族症状，常与 1 伴生）。
// 行注释里的同样写法**安全**，不计入：第一版误用 ts.createScanner 时曾在 4 个干净旧文件上误报，
// 换成手写词法后归零。误报的门会让人去改本来没问题的文件，比没门更糟。
//
// 跑法：mise run lint:e2e（= 超时预算门 + 本门），或 node scripts/check-e2e-block-comments.mjs
//      排障：node scripts/check-e2e-block-comments.mjs --dir <某个目录>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_DIR = path.join(ROOT, "packages/ui/e2e");

/** 词法状态机：返回块注释区间与「扫到末尾仍未闭合」的位置（无则 null）。 */
export function lex(text) {
    const comments = [];
    let state = "code";
    let quote = "";
    let start = 0;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (state === "code") {
            if (ch === "/" && next === "/") {
                state = "line";
                i += 2;
                continue;
            }
            if (ch === "/" && next === "*") {
                state = "block";
                start = i;
                i += 2;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === "`") {
                state = "string";
                quote = ch;
                i += 1;
                continue;
            }
            i += 1;
            continue;
        }
        if (state === "line") {
            if (ch === "\n") state = "code";
            i += 1;
            continue;
        }
        if (state === "string") {
            if (ch === "\\") {
                i += 2;
                continue;
            }
            if (ch === quote) state = "code";
            i += 1;
            continue;
        }
        // state === "block"
        if (ch === "*" && next === "/") {
            comments.push({ start, end: i + 2, inner: text.slice(start + 2, i) });
            state = "code";
            i += 2;
            continue;
        }
        i += 1;
    }
    const unterminated = state === "block" || state === "string" ? { state, index: start } : null;
    return { comments, unterminated };
}

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
    return line;
}

/** 纯函数：一段源码文本 ⇒ 问题清单（file 由调用方补）。 */
export function scanText(text) {
    const problems = [];
    const { comments, unterminated } = lex(text);
    // 句柄 1：块注释正文以星号结尾
    for (const comment of comments) {
        if (!comment.inner.endsWith("*")) continue;
        problems.push({
            line: lineOf(text, comment.start),
            kind: "BLOCK_COMMENT_STAR_TAIL",
            message:
                "块注释正文以星号结尾 ⇒ 通配路径里的「星号+斜杠」把注释提前闭合了；" +
                "改用 /api/v1/ 这种不带星号的写法，或用反斜杠隔开星号与斜杠",
        });
    }
    // 句柄 2：扫到末尾仍未闭合
    if (unterminated) {
        problems.push({
            line: lineOf(text, unterminated.index),
            kind: "UNTERMINATED",
            message:
                unterminated.state === "block"
                    ? "块注释没有闭合（多半是前面某处被提前闭合又吞掉了后续代码）"
                    : "字符串没有闭合（常见于模板串被提前闭合的注释打断）",
        });
    }
    return problems;
}

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
}

function main(argv) {
    const dirFlag = argv.indexOf("--dir");
    const target = dirFlag >= 0 ? path.resolve(argv[dirFlag + 1]) : DEFAULT_DIR;
    if (!fs.existsSync(target)) {
        console.error(`[block-comments] E_ENV: 目录不存在 ${target}`);
        return 2;
    }
    const files = walk(target);
    const offenders = [];
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        for (const problem of scanText(text)) {
            offenders.push(`${rel}:${problem.line} [${problem.kind}] ${problem.message}`);
        }
    }
    console.log(`[block-comments] scanned ${files.length} .ts files under ${path.relative(ROOT, target) || "."}`);
    if (offenders.length) {
        console.error(`[block-comments] FAIL: ${offenders.length} problem(s)`);
        for (const line of offenders.slice(0, 200)) console.error(`  ${line}`);
        if (offenders.length > 200) console.error(`  … ${offenders.length - 200} more`);
        return 1;
    }
    console.log("[block-comments] OK: no block comment is closed early");
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
