#!/usr/bin/env node
// task-176（问题②，Lead 2026-11-18 照批规则草案）：UI 单测的**增量入口** test:ui:changed。
//
// 定位：慢档（全量 vitest ~604 s 串行）的可执行增量入口，收尾默认；全量留里程碑/申请窗口前（R2 不变）。
// 选择规则（保守并集，宁多勿漏 ⇒ 安全不假绿）：
//   ① 改动本身是 spec ⇒ 直选；
//   ② 改动是组件/模块 ⇒ 同名共置 spec（basename 跨 __tests__ 匹配）∪ 静态导入可达 spec（反向导入图 BFS）；
//   ③ 配置/全局面（vite.config/tsconfig/package.json/setup.ts/main.ts/router/i18n/main.css）⇒ 回退全量；
//   ④ hub 扇出护栏：单模块可达 spec > 40（起步值，可调）或总选择 > 25% ⇒ 回退全量。
// mock 处理：首版 **mock-agnostic**——忽略 vi.mock，凡静态导入可达即选 ⇒ 只多选不漏选（172/379 spec 用
//   vi.mock；mock-aware 剪枝列二期）。残余漏选风险（全局注册/懒加载/provide-inject）由 ③+②共置+④ 兜底。
// 解析用 **TypeScript 编译器 API**（ts.createSourceFile 走 Import/Export/动态 import）+ **vue/compiler-sfc**
//   抽 .vue 的 <script> 块——成熟 parser，零新增依赖（typescript/vue 已在 devDep），禁手写正则 parser。
//
// 跑法：mise run test:ui:changed（report-only 观察窗，不接 validate）
//       node scripts/test-ui-changed.mjs --print-only   # 只列选择不自跑
//       node scripts/test-ui-changed.mjs --full         # 强制全量
//       node scripts/test-ui-changed.mjs --base develop # 对基线比较（默认 HEAD）
//       node scripts/test-ui-changed.mjs --json         # 机读选择结果
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse as parseSfc } from "vue/compiler-sfc";

const UI = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(UI, "src");
const HUB_THRESHOLD = 40; // 起步值（Lead 批），--threshold 可调
const TOTAL_FRACTION = 0.25; // --max-fraction 可调

// 配置/全局面：改动任一 ⇒ 增量无意义，回退全量（规则③，Lead 批清单）。
const GLOBAL_PATTERNS = [
    /^vite\.config\./,
    /^tsconfig.*\.json$/,
    /^package\.json$/,
    /^pnpm-workspace\.yaml$/,
    /^src\/tests\/setup\.ts$/,
    /^src\/main\.ts$/,
    /^src\/router\//,
    /^src\/i18n\//,
    /^src\/styles\/main\.css$/,
];

function git(args) {
    const r = spawnSync("git", args, { cwd: UI, encoding: "utf8" });
    if (r.status !== 0)
        throw new Error("git " + args.join(" ") + " failed: " + (r.stderr ?? "").trim());
    return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

function changedFiles(opts) {
    const range = opts.staged ? ["--staged"] : opts.base ? [opts.base] : ["HEAD"];
    const tracked = git(["diff", "--name-only", ...range]);
    const untracked = opts.staged ? [] : git(["ls-files", "--others", "--exclude-standard"]);
    const all = [...new Set([...tracked, ...untracked])];
    // 仓根相对路径 → 只留 packages/ui/ 下，转成相对 UI 包的路径
    return all
        .filter((f) => f.startsWith("packages/ui/"))
        .map((f) => f.slice("packages/ui/".length).replaceAll("\\", "/"));
}

function walk(dir, out) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p, out);
        else if (/\.(ts|vue)$/.test(ent.name)) out.push(p);
    }
    return out;
}

/** 用 TS 编译器 API 抽一个脚本块的全部 import 说明符（静态 Import/Export + 动态 import/require）。 */
function specifiersOfScript(code, fileName) {
    const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const specs = [];
    const visit = (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            specs.push(node.moduleSpecifier.text);
        } else if (
            ts.isExportDeclaration(node) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            specs.push(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node)) {
            const ex = node.expression;
            const isImport = ex.kind === ts.SyntaxKind.ImportKeyword;
            const isRequire = ts.isIdentifier(ex) && ex.text === "require";
            if (
                (isImport || isRequire) &&
                node.arguments[0] &&
                ts.isStringLiteral(node.arguments[0])
            ) {
                specs.push(node.arguments[0].text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return specs;
}

function specifiersOfFile(abs) {
    const code = fs.readFileSync(abs, "utf8");
    if (abs.endsWith(".vue")) {
        const { descriptor, errors } = parseSfc(code, { filename: abs });
        if (errors?.length) return []; // 解析不了 ⇒ 不建边（共置/护栏兜底），不手写正则抽块
        const blocks = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(
            Boolean,
        );
        return blocks.flatMap((b) => specifiersOfScript(b, abs + ".ts"));
    }
    return specifiersOfScript(code, abs);
}

/** 把 import 说明符解析到 src 内真实文件；外部包/解析不到 ⇒ null。 */
function resolveSpecifier(spec, fromFile) {
    let base;
    if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
    else return null; // bare package（vue/pinia/…）⇒ 外部
    base = base.replaceAll("\\", "/");
    if (!base.startsWith(SRC.replaceAll("\\", "/"))) return null;
    const candidates = [
        base,
        base + ".ts",
        base + ".vue",
        base + ".tsx",
        path.join(base, "index.ts"),
    ];
    if (base.endsWith(".js")) candidates.push(base.slice(0, -3) + ".ts");
    for (const c of candidates)
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c.replaceAll("\\", "/");
    return null;
}

export function buildReverseGraph() {
    const files = walk(SRC, []).map((f) => f.replaceAll("\\", "/"));
    const reverse = new Map(); // imported → Set<importer>
    let unresolved = 0;
    for (const f of files) {
        let specs;
        try {
            specs = specifiersOfFile(f);
        } catch {
            specs = [];
        }
        for (const s of specs) {
            const target = resolveSpecifier(s, f);
            if (!target) {
                if (s.startsWith("@/") || s.startsWith(".")) unresolved++;
                continue;
            }
            if (!reverse.has(target)) reverse.set(target, new Set());
            reverse.get(target).add(f);
        }
    }
    return { reverse, files, unresolved };
}

/** 从改动模块向上 BFS，收集传递导入它的 spec。 */
export function reachableSpecs(seed, reverse) {
    const seen = new Set([seed]);
    const specs = new Set();
    const queue = [seed];
    while (queue.length) {
        const cur = queue.shift();
        for (const importer of reverse.get(cur) ?? []) {
            if (seen.has(importer)) continue;
            seen.add(importer);
            if (importer.endsWith(".spec.ts")) specs.add(importer);
            queue.push(importer);
        }
    }
    return specs;
}

export function select(opts, changedOverride) {
    const hubThreshold = opts.threshold ?? HUB_THRESHOLD;
    const totalFraction = opts.maxFraction ?? TOTAL_FRACTION;
    const changed = changedOverride ?? changedFiles(opts);
    const allSpecs = walk(SRC, [])
        .filter((f) => f.endsWith(".spec.ts"))
        .map((f) => f.replaceAll("\\", "/"));
    const rel = (abs) => path.relative(UI, abs).replaceAll("\\", "/");

    if (opts.full)
        return { mode: "full", reason: "--full 强制全量", specs: allSpecs.map(rel), changed };
    if (changed.length === 0)
        return { mode: "none", reason: "无 packages/ui 改动面", specs: [], changed };

    const globalHit = changed.filter((f) => GLOBAL_PATTERNS.some((re) => re.test(f)));
    if (globalHit.length)
        return {
            mode: "full",
            reason: "配置/全局面改动: " + globalHit.join(", "),
            specs: allSpecs.map(rel),
            changed,
        };

    const changedSpecs = changed.filter((f) => f.startsWith("src/") && f.endsWith(".spec.ts"));
    const changedModules = changed.filter(
        (f) => f.startsWith("src/") && /\.(ts|vue)$/.test(f) && !f.endsWith(".spec.ts"),
    );

    const { reverse, unresolved } = buildReverseGraph();
    const selected = new Map(); // relSpec → reason
    for (const s of changedSpecs) selected.set(s, "changed-spec");

    let hubHit = null;
    for (const m of changedModules) {
        const abs = path.join(UI, m).replaceAll("\\", "/");
        const base = path.basename(m).replace(/\.(ts|vue)$/, "");
        // ②a 同名共置（basename 跨 __tests__）
        for (const sp of allSpecs) {
            if (path.basename(sp).replace(/\.spec\.ts$/, "") === base) {
                const r = rel(sp);
                if (!selected.has(r)) selected.set(r, "colocated:" + m);
            }
        }
        // ②b 静态导入可达
        const reach = reachableSpecs(abs, reverse);
        if (reach.size > hubThreshold) {
            hubHit = m + " 可达 " + reach.size + " spec > " + hubThreshold;
            break;
        }
        for (const sp of reach) {
            const r = rel(sp);
            if (!selected.has(r)) selected.set(r, "imports:" + m);
        }
    }
    if (hubHit)
        return {
            mode: "full",
            reason: "hub 扇出护栏: " + hubHit,
            specs: allSpecs.map(rel),
            changed,
        };
    if (selected.size > allSpecs.length * totalFraction) {
        return {
            mode: "full",
            reason:
                "总选择 " +
                selected.size +
                " > " +
                Math.round(totalFraction * 100) +
                "% (" +
                Math.floor(allSpecs.length * totalFraction) +
                ")",
            specs: allSpecs.map(rel),
            changed,
        };
    }
    if (selected.size === 0) {
        return {
            mode: "none",
            reason: "改动模块无共置/可达 spec（可能纯类型/工具）；不放心用 --full",
            specs: [],
            changed,
            unresolved,
        };
    }
    return {
        mode: "incremental",
        reason: "保守并集（mock-agnostic）",
        specs: [...selected.keys()].sort(),
        reasons: Object.fromEntries(selected),
        changed,
        unresolved,
    };
}

function main(argv) {
    const opts = {
        full: argv.includes("--full"),
        printOnly: argv.includes("--print-only"),
        staged: argv.includes("--staged"),
        json: argv.includes("--json"),
        base: argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : null,
        threshold: argv.includes("--threshold")
            ? Number(argv[argv.indexOf("--threshold") + 1])
            : null,
        maxFraction: argv.includes("--max-fraction")
            ? Number(argv[argv.indexOf("--max-fraction") + 1])
            : null,
    };
    const result = select(opts);
    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log("[test:ui:changed] mode=" + result.mode + " — " + result.reason);
        console.log(
            "  改动面 " +
                result.changed.length +
                " 文件；入选 " +
                result.specs.length +
                " spec" +
                (result.unresolved
                    ? "；未解析内部导入 " + result.unresolved + "（共置/护栏兜底）"
                    : ""),
        );
        if (result.mode === "incremental")
            for (const s of result.specs)
                console.log("    " + s + "  [" + (result.reasons?.[s] ?? "") + "]");
        else if (result.mode === "full")
            console.log("    （全量 " + result.specs.length + " spec）");
    }
    if (opts.printOnly || result.mode === "none") process.exit(0);
    const args =
        result.mode === "full"
            ? ["exec", "vitest", "run"]
            : ["exec", "vitest", "run", ...result.specs];
    const r = spawnSync("pnpm", args, { cwd: UI, stdio: "inherit", shell: true });
    process.exit(r.status ?? 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
