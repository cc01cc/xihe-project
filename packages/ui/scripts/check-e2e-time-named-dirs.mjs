#!/usr/bin/env node
/**
 * e2e 宿主工作区目录名检查器（task-71 / D-1724）—— 只守 `e2e-ws-` 这一族。
 *
 * <p><b>为什么存在</b>：`Date.now()` 在**同一同步块内连续调用返回同一个毫秒值** —— 实测 50 次
 * 连续调用只得到 3~5 个不同值；Playwright worker 又复用同一个 pid。所以「叶子名只由时间戳拼成」
 * 的宿主目录在同毫秒内**必然重名**。两个工作区静默共用一个宿主目录**比直接失败更隐蔽**：不报错，
 * 跑完只会得到「文件莫名有了/没了」。这正是 `helpers/workspace.ts#isolatedWorkspaceHostPath`
 * 用「序号 + 4 位随机 nonce」修掉的缺陷（task-68 / D-1722）。</p>
 *
 * <p><b>为什么需要这道门</b>：helper 修好之后，`chat.spec.ts`（task-49 的产物）仍自带一份手写
 * 拷贝，缺陷原封不动地留在那里 —— task-71 修的就是它。「复制一份实现」不是某个人的毛病，而是
 * 任何人在自建 seed 图省事时的**默认动作**；只修一处不留门，下一个人还会抄一份。</p>
 *
 * <p><b>判据（刻意收得极窄）</b>：只报 `e2e-ws-` 前缀 + **时间戳后立刻收模板**（没有任何序号/nonce
 * 后缀）的形态。helper 的合法形态 `e2e-ws-<ts>-<seq>-<nonce>` 带后缀 ⇒ 不命中。</p>
 *
 * <p><b>为什么不守「所有时间命名目录」</b>（第一版就是那么写的，实测 **63 条命中、几乎全是误伤**）：
 * 判据一宽到「任意 `PREFIX-${Date.now()}`」，`Idempotency-Key`、聊天正文、模型标记载体立刻全部
 * 落网 ⇒ 门在引入当天就是红的，而真正那条缺陷埋在 62 条噪音里。**一条会误伤的判据等于没有判据**。
 * 所以本门只守 `e2e-ws-` 这一族 —— 它既是 helper 的命名家族，也正是本卡判据 ① 原话
 * （`git grep 'e2e-ws-${Date.now}'` 归零）的范围。</p>
 *
 * <p><b>已知盲区（诚实登记）</b>：① 其它前缀的时间命名目录（如 `xihe-e2e-0384-<ts>`、
 * `plan0470-checkpoint-<ts>`，实测 **12 处**）**不在本门内** —— 它们有同样的同毫秒碰撞风险，
 * 但属于别的写面，须另卡；② 只做文本匹配不做 AST ⇒ 先赋变量再拼（`const ts = Date.now()`）漏判；
 * ③ `new Date().getTime()` 等价写法漏判；④ 注释里的旧写法会命中（**有意**：注释里推广旧写法与
 * 在代码里写它一样有害）。盲区方向统一是「少报」，不误伤合法拼接。</p>
 *
 * 用法：node scripts/check-e2e-time-named-dirs.mjs [--selftest] [路径…]
 * 退出码：0 无命中 / 1 有命中（逐条 file:line）/ 2 用法或环境错误 / selftest 不符 1。
 */
import {
    readdirSync,
    readFileSync,
    statSync,
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
} from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "dist", ".tmp", "test-results", "e2e-results", ".git"]);
const EXT = /\.(ts|tsx|mts|cts|vue|mjs)$/;
/**
 * 命中形态：`e2e-ws-${Date.now()}` 之后**立刻**收引号/反引号（叶子名没有别的成分）。
 * helper 的 `e2e-ws-${Date.now()}-${nextHostPathSuffix()}` 后面跟的是 `-` ⇒ 不命中。
 */
const PATTERNS = [/e2e-ws-\$\{Date\.now\(\)\}[`'"]/, /"e2e-ws-"\s*\+\s*Date\.now\(\)/];
/** 白名单：helper 的实现文件本身就是「加后缀」的那一端（将来调整拼接顺序也不该被判红）。 */
const ALLOWED = new Set(["e2e/real/helpers/workspace.ts"]);

function collectFiles(entries) {
    const seen = [],
        files = [];
    const walk = (dir) => {
        if (seen.includes(dir)) return;
        seen.push(dir);
        for (const name of readdirSync(dir)) {
            if (SKIP.has(name)) continue;
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (EXT.test(name)) files.push(full);
        }
    };
    for (const entry of entries) {
        const full = resolve(ROOT, entry),
            st = statSync(full, { throwIfNoEntry: false });
        if (!st) continue;
        if (st.isDirectory()) walk(full);
        else if (EXT.test(full)) files.push(full);
    }
    return files;
}

/** 逐行匹配，返回 [{line, snippet}]；注释行不跳过（见文件头盲区 ④）。 */
function hitsIn(text) {
    const out = [];
    for (const [index, line] of text.split("\n").entries()) {
        if (PATTERNS.some((re) => re.test(line)))
            out.push({ line: index + 1, snippet: line.trim() });
    }
    return out;
}

function scan(files) {
    const hits = [];
    for (const file of files) {
        const rel = relative(ROOT, file).replaceAll("\\", "/");
        if (ALLOWED.has(rel)) continue;
        for (const h of hitsIn(readFileSync(file, "utf8"))) hits.push({ file: rel, ...h });
    }
    return hits;
}

/** 自检夹具：正负两侧都咬（只报形态、不误伤合法用途）。 */
const BQ = "\x60",
    DS = "${";
const FIXTURES = [
    {
        name: "旧写法（本卡修掉的那份手写拷贝）⇒ 必须红",
        file: "e2e/real/chat.spec.ts",
        body: "        " + BQ + "e2e-ws-" + DS + "Date.now()}" + BQ + ",",
        expect: 1,
    },
    {
        name: "helper 合法形态（带序号 + nonce）⇒ 必须绿",
        file: "helpers/workspace.ts",
        body:
            "    const hostPath = path.join(hostRoot, " +
            BQ +
            "e2e-ws-" +
            DS +
            "Date.now()}-" +
            DS +
            "nextHostPathSuffix()}" +
            BQ +
            ");",
        expect: 0,
    },
    {
        name: "合法用途：Idempotency-Key / 聊天正文 ⇒ 必须绿",
        file: "e2e/real/plan0390.spec.ts",
        body: [
            '    headers: { "Idempotency-Key": ' +
                BQ +
                "plan0390-" +
                DS +
                "Date.now()}" +
                BQ +
                " },",
            "    await page.fill(" + BQ + "hello-" + DS + "Date.now()}" + BQ + ");",
        ].join("\n"),
        expect: 0,
    },
    {
        name: "同族但没后缀、在别的文件里 ⇒ 必须红（门看形态不看文件名）",
        file: "e2e/real/somewhere.spec.ts",
        body:
            "    const dir = path.join(hostRoot, " +
            BQ +
            "e2e-ws-" +
            DS +
            "Date.now()}" +
            BQ +
            ");",
        expect: 1,
    },
];

function selftest() {
    const dir = mkdtempSync(join(tmpdir(), "e2e-ws-family-"));
    let bad = 0;
    try {
        for (const fx of FIXTURES) {
            const full = join(dir, fx.file);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, fx.body + "\n");
            const n = ALLOWED.has(fx.file) ? 0 : hitsIn(readFileSync(full, "utf8")).length;
            if (n !== fx.expect) {
                bad += 1;
                console.error("  x " + fx.name + "：命中 " + n + "（期望 " + fx.expect + "）");
            } else console.log("  ok " + fx.name + "：命中 " + n);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    console.log(
        bad === 0
            ? "SELFTEST OK（" + FIXTURES.length + " 例，正负两侧都咬）"
            : "SELFTEST FAIL " + bad + " 例",
    );
    return bad === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) process.exit(selftest());
const paths = args.filter((a) => !a.startsWith("--"));
const files = collectFiles(paths.length ? paths : ["e2e"]);
const hits = scan(files);
console.log(
    "扫描 " +
        files.length +
        " 文件 · 时间命名的宿主工作区目录命中 " +
        hits.length +
        "（只报 e2e-ws- 族）",
);
for (const h of hits) console.log("  " + h.file + ":" + h.line + "  " + h.snippet);
if (hits.length)
    console.log(
        "修法：改用 e2e/real/helpers/workspace.ts#isolatedWorkspaceHostPath()（两条车道都内含序号 + nonce）",
    );
process.exit(hits.length ? 1 : 0);
