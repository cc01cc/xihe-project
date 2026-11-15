#!/usr/bin/env node
/**
 * 值命名空间导入检查器（task-261 / Lead 裁定 A1，2026-11-15）。
 *
 * <p><b>为什么存在</b>：oxlint 的 import/no-namespace 判据过宽 —— 它对 import type * as 照样报，
 * 而 type-only 命名空间在运行时被完全擦除、不产生任何命名空间对象，该规则的立法目的
 * （运行时对象 / 阻碍 tree-shaking）对它不适用。实测本仓 59 条命中里 57 条是 type-only。
 * 规则唯一选项 ignore 是模块 glob，allowTypeOnly 被配置解析拒绝（oxlint 1.83.0；上游
 * NoNamespaceConfig 亦只有 ignore）⇒ 无法按形态豁免。</p>
 *
 * <p><b>本检查器做的事比原规则少</b>：只接管「值命名空间」那一半（import * as X / import def, * as X），
 * 放行 import type * as。不是自研替代 oxlint。登记行见 AGENTS.md 的 lint-rule-registry 区间。</p>
 *
 * <p><b>已知盲区（诚实登记）</b>：① 只看静态 import 声明，动态 import() 不在判据内（它本就是
 * 取运行时模块对象的正规写法）；② 注释里的 import 不算（先剥注释）；③ 不做 AST，跨语句的极端
 * 写法可能漏 —— 漏判方向是「少报」，不会误伤 type-only。</p>
 *
 * 用法：node scripts/check-value-namespace.mjs [--json] [--selftest] [路径…]
 * 退出码：0 无值命名空间 / 1 有命中（逐条 file:line）/ 2 用法或环境错误 / selftest 不符 1。
 */
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "dist", ".tmp", "test-results", "e2e-results", ".git"]);
const EXT = /\.(ts|tsx|mts|cts|vue)$/;
/** 值命名空间：import 后**不是** type，且带 * as，且以 from "…" 收口（限定在一条真导入声明内）。 */
const VALUE_NS =
    /import\s+(?!type\b)([^;]*?)\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']([^"']+)["']/g;

/** 剥掉行注释与块注释（保留换行，行号不漂）。字符串里的 // 罕见，按最简处理并登记为盲区。 */
function stripComments(text) {
    // 字符串优先匹配，避免把字符串里的 // 当注释；注释一律换成等长空格（保留换行 ⇒ 行号不漂）。
    return text.replace(
        /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
        (m, str, comment) => str || comment.replace(/[^\n]/g, " "),
    );
}

function collectFiles(roots) {
    const files = [];
    function walk(dir) {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(e.name)) continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (EXT.test(e.name)) files.push(p);
        }
    }
    for (const r of roots) {
        const p = resolve(ROOT, r);
        let st;
        try {
            st = statSync(p);
        } catch {
            console.error("FAIL 路径不存在: " + r);
            process.exit(2);
        }
        if (st.isDirectory()) walk(p);
        else files.push(p);
    }
    return files;
}

function scan(files) {
    const hits = [];
    for (const f of files) {
        const text = stripComments(readFileSync(f, "utf8"));
        for (const m of text.matchAll(VALUE_NS)) {
            if (/\bimport\s/.test(m[1])) continue; // 跨到了下一条 import ⇒ 由那条自己匹配
            const line = text.slice(0, m.index).split("\n").length;
            hits.push({
                file: relative(ROOT, f).replace(/\\/g, "/"),
                line,
                name: m[2],
                module: m[3],
            });
        }
    }
    return hits;
}

const FIXTURES = [
    {
        name: "neg-value.ts",
        expect: 1,
        src: 'import * as B from "./x";\n\nexport const v = B.a;\n',
    },
    {
        name: "neg-mixed.ts",
        expect: 1,
        src: 'import def, * as C from "./x";\n\nexport const v = def;\n',
    },
    {
        name: "neg-multiline.ts",
        expect: 1,
        src: 'import def,\n    * as D\n    from "./x";\n\nexport const v = def;\n',
    },
    {
        name: "pos-type-only.ts",
        expect: 0,
        src: 'import type * as A from "./x";\n\nexport type AShape = typeof A;\n',
    },
    {
        name: "pos-value-in-comment.ts",
        expect: 0,
        src: '// import * as E from "./x";\n/* import * as F from "./x"; */\nexport const v = 1;\n',
    },
    {
        name: "pos-named.ts",
        expect: 0,
        src: 'import { a, type T } from "./x";\n\nexport const v = a;\nexport type U = T;\n',
    },
];

function selftest() {
    const dir = mkdtempSync(join(tmpdir(), "xh-value-ns-"));
    let bad = 0;
    try {
        for (const fx of FIXTURES) {
            const p = join(dir, fx.name);
            writeFileSync(p, fx.src, "utf8");
            const files = collectFiles([p]);
            const hits = scan(files);
            const ok = files.length === 1 && hits.length === fx.expect;
            if (!ok) bad++;
            console.log(
                (ok ? "PASS " : "FAIL ") +
                    fx.name +
                    "  扫描=" +
                    files.length +
                    " 命中=" +
                    hits.length +
                    " 期望=" +
                    fx.expect,
            );
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
const json = args.includes("--json");
const paths = args.filter((a) => !a.startsWith("--"));
const files = collectFiles(paths.length ? paths : ["src", "e2e", "scripts"]);
const hits = scan(files);
if (json) console.log(JSON.stringify({ scannedFiles: files.length, hits }, null, 4));
else {
    console.log(
        "扫描 " +
            files.length +
            " 文件 · 值命名空间命中 " +
            hits.length +
            "（type-only 命名空间放行）",
    );
    for (const h of hits)
        console.log(
            "  " + h.file + ":" + h.line + "  import * as " + h.name + ' from "' + h.module + '"',
        );
    if (hits.length)
        console.log(
            '修法：改具名导入；确需运行时模块对象时用 await import("…")（动态导入不在本判据内）',
        );
}
process.exit(hits.length ? 1 : 0);
