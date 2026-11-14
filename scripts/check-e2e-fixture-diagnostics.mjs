#!/usr/bin/env node
// task-118 ②的静态守卫：夹具失败诊断的「红点必须指向真因」三判据（Lead 2026-11-15 批）。
//
// 事故形状（task-75）：spec 用了一个不在 KNOWN_WORKSPACE_IDS 里的 workspace id ⇒
// GET /api/v1/workspaces/<id> 静默 404 ⇒ 页签工作区被清 ⇒ 页面不渲染 ⇒ 23 条用例连锁全红，
// 而失败输出里只有一句「Failed to load resource: … 404 (Not Found)」，红点落在 chat-input 找不到。
// 修法是两段（task-118）：夹具在 fulfill 之前同步登记原因（helpers/fixture-hints.ts），
// 收集器把三通道合并成一次断言并把原因拼进 >=400 条目。
//
// 为什么用**静态门**而不是 e2e spec：这三条约束不需要浏览器就能判；放进 spec 会占 mock 车道的
// 收集面与基线计数（task-118 的 scratch 就曾因此污染别人的全量 lint）。
//
// 判据（全部 fail-closed：判据被删/被搬走 ⇒ 红，不静默跳过 —— D-1470）：
//   1 三个文件必须都在；缺一个就报 FILE_MISSING（「判据被搬走」不是「没有判据」）；
//   2 workspace-fixture.ts 的未知 id 分支必须调用 recordFixtureHint(（删掉登记 ⇒ 红）；
//   3 page-failures.ts 必须 fixtureHintFor( 取回原因，且 failedResponses.push( 那一行必须用 hint
//     （退回「只记 status + url」⇒ 红）；
//   4 expectNoPageFailures 的函数体里只能有**一次** expect( —— 守 D-1475「合并不许减少输出」：
//     三条独立 expect 会让第一条红就吞掉后两条的信息（task-75 实测：>=400 那条从未被打印）。
//
// 跑法：mise run lint:e2e（= 聚合器的第 3 道），或 node scripts/check-e2e-fixture-diagnostics.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELPERS = path.join(ROOT, "packages/ui/e2e/mock/helpers");

export const FILES = {
    workspaceFixture: path.join(HELPERS, "workspace-fixture.ts"),
    pageFailures: path.join(HELPERS, "page-failures.ts"),
    fixtureHints: path.join(HELPERS, "fixture-hints.ts"),
};

function lineOf(text, index) {
    return text.slice(0, index).split("\n").length;
}

/** 从 `function <name>` 之后的花括号开始配对，返回函数体文本（找不到返回 null）。 */
export function functionBody(text, name) {
    const head = text.indexOf("function " + name);
    if (head < 0) return null;
    const open = text.indexOf("{", head);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") {
            depth -= 1;
            if (depth === 0) return text.slice(open + 1, i);
        }
    }
    return null;
}

/** 纯函数：给文本 + 读文件函数，返回问题清单（便于将来加自检）。 */
export function inspect(readFile = (file) => fs.readFileSync(file, "utf8")) {
    const problems = [];
    const sources = {};
    for (const [key, file] of Object.entries(FILES)) {
        if (!fs.existsSync(file)) {
            problems.push({
                file,
                line: 0,
                code: "FILE_MISSING",
                message:
                    "判据所需的文件不存在（被删除或搬走）—— 判据必须跟着文件一起搬；" +
                    "若确实要换位置，同批改本门，而不是让它在这里静默跳过",
            });
            continue;
        }
        sources[key] = readFile(file);
    }
    if (problems.length > 0) return problems;

    // 判据 2：未知 id 分支必须登记原因
    const fixture = sources.workspaceFixture;
    const branch = fixture.indexOf("if (!(KNOWN_WORKSPACE_IDS");
    const record = fixture.indexOf("recordFixtureHint(");
    if (branch < 0) {
        problems.push({
            file: FILES.workspaceFixture,
            line: 0,
            code: "UNKNOWN_ID_BRANCH_MISSING",
            message: "找不到 `if (!(KNOWN_WORKSPACE_IDS` 分支 —— 未知 id 的 404 语义被搬走或删掉了",
        });
    } else if (record < 0 || record < branch) {
        problems.push({
            file: FILES.workspaceFixture,
            line: lineOf(fixture, branch),
            code: "HINT_NOT_RECORDED",
            message:
                "未知 id 分支没有调用 recordFixtureHint( ⇒ 404 又不自解释了；" +
                "那就退回 task-75 的形态：红在 chat-input 找不到，真因在几百行之外",
        });
    }

    // 判据 3：收集器必须取回原因，并且真的拼进 >=400 条目
    const failures = sources.pageFailures;
    if (!failures.includes("fixtureHintFor(")) {
        problems.push({
            file: FILES.pageFailures,
            line: 0,
            code: "HINT_NOT_READ",
            message: "收集器没有调用 fixtureHintFor( ⇒ 登记的原因取不回来",
        });
    }
    const pushIndex = failures.indexOf("failedResponses.push(");
    if (pushIndex < 0) {
        problems.push({
            file: FILES.pageFailures,
            line: 0,
            code: "FAILED_RESPONSE_PUSH_MISSING",
            message: "找不到 failedResponses.push( —— >=400 通道被搬走或改名了",
        });
    } else {
        const pushLine = failures.slice(pushIndex, failures.indexOf("\n", pushIndex));
        if (!pushLine.includes("hint")) {
            problems.push({
                file: FILES.pageFailures,
                line: lineOf(failures, pushIndex),
                code: "HINT_NOT_IN_PUSH",
                message: "failedResponses.push( 这一行没有用 hint ⇒ 失败信息里看不到夹具原因",
            });
        }
    }

    // 判据 4：expectNoPageFailures 只能有一次 expect(
    const body = functionBody(failures, "expectNoPageFailures");
    if (body === null) {
        problems.push({
            file: FILES.pageFailures,
            line: 0,
            code: "GATE_FUNCTION_MISSING",
            message: "找不到 function expectNoPageFailures —— 三通道门被搬走或改名了",
        });
    } else {
        const expects = body.match(/expect\(/g) ?? [];
        if (expects.length !== 1) {
            problems.push({
                file: FILES.pageFailures,
                line: lineOf(failures, failures.indexOf("function expectNoPageFailures")),
                code: "EXPECT_NOT_MERGED",
                message:
                    "expectNoPageFailures 里有 " + expects.length + " 个 expect(，要求恰好 1 个：" +
                    "多条独立 expect 会让第一条失败就 throw，后面的通道一行都打不出来（D-1475）",
            });
        }
    }

    return problems;
}

function main() {
    let problems;
    try {
        problems = inspect();
    } catch (cause) {
        console.error("[fixture-diagnostics] ENV: " + (cause && cause.message ? cause.message : cause));
        return 2;
    }
    if (problems.length === 0) {
        console.log("[fixture-diagnostics] OK: 4 判据全绿（文件存在 / 登记 / 取回并拼接 / 单次断言）");
        return 0;
    }
    console.log("[fixture-diagnostics] FAIL: " + problems.length + " problem(s)");
    for (const problem of problems) {
        const relative = path.relative(ROOT, problem.file).replaceAll("\\", "/");
        console.log("  " + relative + ":" + problem.line + " [" + problem.code + "] " + problem.message);
    }
    return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main());
}
