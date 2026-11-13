#!/usr/bin/env node
/**
 * task-318 · 自带 i18n 副本的 spec：ratchet 门（只许缩小）
 *
 * 背景（D-1162 ③ / D-1166 ②）：改用户可见文案时，真实的危险不是「会红」，
 * 而是**不会红** —— spec 自带一份 i18n 副本，断言测的是副本，改源照旧全绿。
 * 这类断言从此测一个已不存在的字符串，而且没人会去修「绿的」。
 *
 * 实现纪律：**用 TypeScript AST，不用正则**。
 * 2026-11-13 首版用正则在全文抓字面量，被注释/模板里落单的引号打乱配对，
 * 抓出过 ",\n messages: {...pending: " 这种跨行垃圾 —— 同一份代码量出 48 个文件，
 * 而 AST 版是另一个数。手写 parser 的教训，规则见 workspace AGENTS
 * 「解析成熟文件格式必须用成熟库或原生机制，禁止手写 parser」。
 *
 * 定义（写死在这里；改定义等于换尺，必须同步改基线并说明）
 *   测试文件 := packages/ui 下的 .ts，路径匹配 *.spec.ts | *.test.ts | /__tests__/ | ^e2e/
 *               （必须含 e2e 下的 helpers 目录 —— 2026-11-13 首次盘点就因为漏了它而漏项）
 *   副本值   := 位于 createI18n(...) 实参（内联对象，或其实参引用到的本地 const）内部的
 *               字符串字面量，且 >=6 字符、与 src/i18n/index.ts 的叶子值完全相同
 *   使用值   := 断言行（.toContain/.toBe/.toHaveText/.toHaveAttribute/.toBeVisible）里的字面量  ⇒ kind=assert
 *               定位行（getByText/getByRole/locator 等）里的字面量（含 text= 前缀剥离）  ⇒ kind=locate
 *   真坑 (a) := 副本值 ∩ 使用值   ⇒ 改源仍绿，spec 对这份副本的认知被写死
 *   正常 (b) := 使用值 − 副本值   ⇒ 改源会红（这是对的）
 *   低危 (c) := 副本值 − 使用值   ⇒ 副本静默过期，但不会假绿
 *
 * 用法
 *   node scripts/check-i18n-fixture-copies.mjs                    人读摘要 + 门判定
 *   node scripts/check-i18n-fixture-copies.mjs --json             机器读
 *   node scripts/check-i18n-fixture-copies.mjs --verbose          逐文件明细
 *   node scripts/check-i18n-fixture-copies.mjs --selftest         反例自检（造临时文件 ⇒ 必须计入 (a)）
 *   node scripts/check-i18n-fixture-copies.mjs --write-baseline   重写基线（只在收账后手工执行）
 *
 * 退出码：0 = 未超出基线；1 = 出现基线外的 (a) 文件；2 = 脚本自身/仓库结构问题
 */

import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join, relative, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
/** A03-xihe 仓库根（本脚本所在仓） */
const REPO_ROOT = resolve(SELF_DIR, "..");
/** one 工作区根 —— 证据包落在 one 的 internal/ 下，不在 A03-xihe 仓里（两个独立 git 仓） */
const ONE_ROOT = resolve(REPO_ROOT, "..");
const DEFAULT_UI_ROOT = join(REPO_ROOT, "packages", "ui");
const EVIDENCE_DIR = join(ONE_ROOT, "internal", "A03-xihe", "evidence", "2026-11-13-i18n-fixture-copies");
/** 现行尺（cjk4）基线；旧尺（len6, a=22）留档在 baseline-len6.json，永不删除 */
const BASELINE_PATH = join(EVIDENCE_DIR, "baseline.json");
const LEGACY_BASELINE_PATHS = {
    len6: join(EVIDENCE_DIR, "baseline-len6.json"),
    cjk4: join(EVIDENCE_DIR, "baseline.json"),
};

/**
 * 值的合格判据（「尺」）。换尺必须同时留旧尺基线，否则「变好了」和「尺松了」长得一样。
 *   len6 : 长度 >= 6（2026-11-13 首版尺，a=22）
 *   cjk4 : 含 CJK 则长度 >= 4，否则 >= 6（现行尺，a=29）
 * 换尺理由：len6 会把中文 4 字文案（新建会话 / 暂无会话）滤掉，而 ratchet 只管
 * 「不许变大」—— 少报就是放松门，中文短文案那半边等于没设防。
 */
const RULERS = {
    len6: { label: "len>=6", qualifies: (v) => v.length >= 6 },
    cjk4: {
        label: "CJK>=4 或 ASCII>=6",
        qualifies: (v) => (/[\u3400-\u9fff\uf900-\ufaff]/.test(v) ? v.length >= 4 : v.length >= 6),
    },
};
const DEFAULT_RULER = "cjk4";
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "coverage",
    "playwright-report",
    "test-results",
    ".local",
    ".tmp",
]);
const ASSERT_METHODS = new Set([
    "toContain",
    "toBe",
    "toEqual",
    "toHaveText",
    "toHaveAttribute",
    "toBeVisible",
    "toMatch",
    "toHaveCount",
]);
const LOCATE_FUNCS = new Set([
    "getByText",
    "getByRole",
    "getByLabelText",
    "getByPlaceholder",
    "getByTitle",
    "getByTestId",
    "locator",
    "find",
    "filter",
    "querySelector",
]);

function parseArgs(argv) {
    const opts = {
        json: false,
        verbose: false,
        selftest: false,
        writeBaseline: false,
        ruler: DEFAULT_RULER,
        minLen: null,
        uiRoot: DEFAULT_UI_ROOT,
        baseline: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--json") opts.json = true;
        else if (a === "--verbose") opts.verbose = true;
        else if (a === "--selftest") opts.selftest = true;
        else if (a === "--write-baseline") opts.writeBaseline = true;
        else if (a === "--ui-root") opts.uiRoot = resolve(argv[(i += 1)]);
        else if (a === "--min-len") opts.minLen = Number(argv[(i += 1)]);
        else if (a === "--ruler") opts.ruler = argv[(i += 1)];
        else if (a === "--baseline-legacy") opts.baselineLegacy = resolve(argv[(i += 1)]);
        else if (a === "--baseline") opts.baseline = resolve(argv[(i += 1)]);
        else if (a === "--help" || a === "-h") {
            process.stdout.write("见本文件头部注释\n");
            process.exit(0);
        } else {
            process.stderr.write("[i18n-copies] 未知参数：" + a + "\n");
            process.exit(2);
        }
    }
    return opts;
}

function loadTs(uiRoot) {
    const req = createRequire(join(uiRoot, "package.json"));
    try {
        return req("typescript");
    } catch (e) {
        process.stderr.write("[i18n-copies] 需要 typescript（在 " + uiRoot + " 下解析不到）：" + e.message + "\n");
        process.exit(2);
    }
}

function parseFile(ts, path) {
    const text = readFileSync(path, "utf8");
    return { text, sf: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS) };
}

/** 收集节点范围内所有字符串字面量：[{ value, line, kind }] */
function stringsIn(ts, sf, node, kind) {
    const out = [];
    const visit = (n) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
            const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf));
            out.push({ value: n.text, line: lc.line + 1, kind });
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
}

/** 找 createI18n(...) 的实参节点；没有则 null */
function findCreateI18nArg(ts, sf) {
    let found = null;
    const visit = (n) => {
        if (found) return;
        if (ts.isCallExpression(n)) {
            const callee = n.expression;
            const name = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee)
                  ? callee.name.text
                  : "";
            if (name === "createI18n" && n.arguments.length > 0) {
                found = n.arguments[0];
                return;
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
}

/** 把 createI18n 实参展开成若干根节点：内联对象 + 它引用的本地 const 初始化器 */
function fixtureRoots(ts, sf, argNode) {
    const roots = [argNode];
    const unresolved = [];
    const declared = new Map();
    for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.initializer) declared.set(d.name.text, d.initializer);
        }
    }
    const visit = (n) => {
        if (ts.isShorthandPropertyAssignment(n)) {
            const init = declared.get(n.name.text);
            if (init) roots.push(init);
            else unresolved.push(n.name.text);
        } else if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
            /* 结构内的成员引用不必展开 */
        } else if (ts.isIdentifier(n)) {
            const init = declared.get(n.text);
            if (init && !roots.includes(init)) roots.push(init);
        }
        ts.forEachChild(n, visit);
    };
    visit(argNode);
    return { roots, unresolved };
}

/** 收集使用点：断言行与定位行 */
function collectUsages(ts, sf) {
    const out = [];
    const visit = (n) => {
        if (ts.isCallExpression(n)) {
            const callee = n.expression;
            let method = "";
            let isLocate = false;
            if (ts.isPropertyAccessExpression(callee)) method = callee.name.text;
            else if (ts.isIdentifier(callee)) {
                method = callee.text;
                isLocate = LOCATE_FUNCS.has(method);
            }
            if (ASSERT_METHODS.has(method) || isLocate) {
                const kind = isLocate ? "locate" : "assert";
                for (const arg of n.arguments) out.push(...stringsIn(ts, sf, arg, kind));
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const u of out) {
        if (u.kind === "locate" && u.value.startsWith("text=")) {
            out.push({ value: u.value.slice("text=".length), line: u.line, kind: "locate" });
        }
    }
    return out;
}

/** 从 i18n 源抽取叶子值（AST：messages 对象里的字符串字面量） */
/** 当前生效的判据：--min-len 覆盖优先（临时探针用），否则按 --ruler 取名尺 */
function resolveQualifier(opts) {
    if (opts.minLen != null) {
        return { name: "custom", label: "len>=" + opts.minLen, qualifies: (v) => v.length >= opts.minLen };
    }
    const ruler = RULERS[opts.ruler];
    if (!ruler) {
        process.stderr.write("[i18n-copies] 未知尺：" + opts.ruler + "（可选 " + Object.keys(RULERS).join(" / ") + "）\n");
        process.exit(2);
    }
    return { name: opts.ruler, ...ruler };
}

function loadRealValues(ts, i18nFile, qualifies) {
    if (!existsSync(i18nFile)) {
        process.stderr.write("[i18n-copies] 找不到 i18n 源：" + i18nFile + "\n");
        process.exit(2);
    }
    const { sf } = parseFile(ts, i18nFile);
    const values = new Set();
    for (const s of stringsIn(ts, sf, sf, "all")) {
        if (qualifies(s.value)) values.add(s.value);
    }
    return values;
}

function isTestFile(rel) {
    return (
        rel.endsWith(".spec.ts") ||
        rel.endsWith(".test.ts") ||
        rel.includes("/__tests__/") ||
        rel.startsWith("e2e/")
    );
}

function collectTestFiles(root) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            if (SKIP_DIRS.has(name)) continue;
            const p = join(dir, name);
            let st;
            try {
                st = statSync(p);
            } catch {
                continue;
            }
            if (st.isDirectory()) walk(p);
            else if (extname(name) === ".ts") {
                const rel = relative(root, p).split("\\").join("/");
                if (isTestFile(rel)) out.push({ path: p, rel });
            }
        }
    };
    walk(root);
    return out;
}

function analyzeFile(ts, file, realValues) {
    const { sf } = parseFile(ts, file.path);
    const argNode = findCreateI18nArg(ts, sf);
    if (!argNode) return null;
    const { roots, unresolved } = fixtureRoots(ts, sf, argNode);
    const fixtureVals = new Set();
    for (const r of roots) {
        for (const s of stringsIn(ts, sf, r, "fixture")) {
            if (realValues.has(s.value)) fixtureVals.add(s.value);
        }
    }
    if (fixtureVals.size === 0) return { rel: file.rel, empty: true, unresolved };

    const usages = collectUsages(ts, sf).filter((u) => realValues.has(u.value));
    const usedVals = new Set(usages.map((u) => u.value));

    const poisoned = [...fixtureVals].filter((v) => usedVals.has(v)).sort();
    const aligned = [...usedVals].filter((v) => !fixtureVals.has(v)).sort();
    const staleOnly = [...fixtureVals].filter((v) => !usedVals.has(v)).sort();

    const locations = {};
    for (const v of poisoned) {
        locations[v] = usages
            .filter((u) => u.value === v)
            .map((u) => ({ line: u.line, kind: u.kind }))
            .sort((a, b) => a.line - b.line);
    }

    return {
        rel: file.rel,
        tier: poisoned.length > 0 ? "a" : aligned.length > 0 ? "b" : "c",
        counts: { a: poisoned.length, b: aligned.length, c: staleOnly.length },
        poisonedValues: poisoned,
        alignedValues: aligned,
        staleOnlyValues: staleOnly,
        locations,
        unresolved,
    };
}

function scan(ts, uiRoot, qualifies) {
    const realValues = loadRealValues(ts, join(uiRoot, "src", "i18n", "index.ts"), qualifies);
    const rows = [];
    let unresolvedFiles = 0;
    for (const file of collectTestFiles(uiRoot)) {
        const r = analyzeFile(ts, file, realValues);
        if (!r || r.empty) {
            if (r && r.unresolved && r.unresolved.length) unresolvedFiles += 1;
            continue;
        }
        rows.push(r);
    }
    rows.sort((x, y) => y.counts.a - x.counts.a || y.counts.b - x.counts.b || (x.rel < y.rel ? -1 : 1));
    const aFiles = rows.filter((r) => r.counts.a > 0).map((r) => r.rel).sort();
    return { rows, aFiles, realValueCount: realValues.size, unresolvedFiles };
}

/** 本地时间 + 显式偏移（ISO 8601）。基线是「某时刻」的产物，时刻必须自带时区。 */
function isoTimestamp(d) {
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const abs = Math.abs(off);
    return (
        d.getFullYear() +
        "-" +
        pad(d.getMonth() + 1) +
        "-" +
        pad(d.getDate()) +
        "T" +
        pad(d.getHours()) +
        ":" +
        pad(d.getMinutes()) +
        ":" +
        pad(d.getSeconds()) +
        sign +
        pad(Math.floor(abs / 60)) +
        ":" +
        pad(abs % 60)
    );
}

/**
 * 基线是「某时刻某个树状态」的产物。只记时刻不记树状态，数字就没有出处：
 * 下一个读者无法判断"当时是不是有并行改动在跑"。返回相对 UI 根的路径。
 */
function dirtyFilesAtMeasure(uiRoot) {
    try {
        const out = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], {
            encoding: "utf8",
            timeout: 20000,
        });
        const prefix = relative(REPO_ROOT, uiRoot).split("\\").join("/") + "/";
        const files = [];
        for (const raw of out.split("\n")) {
            if (raw.trim().length < 4) continue;
            let p = raw.slice(3).trim();
            const arrow = p.indexOf(" -> ");
            if (arrow !== -1) p = p.slice(arrow + 4);
            p = p.replace(/^"|"$/g, "").split("\\").join("/");
            if (p.startsWith(prefix)) files.push(p.slice(prefix.length));
        }
        return files.sort();
    } catch (e) {
        return { error: e.message };
    }
}

function readBaseline(path) {
    if (!existsSync(path)) return { files: [] };
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
        process.stderr.write("[i18n-copies] 基线读不动：" + e.message + "\n");
        process.exit(2);
    }
}

function selftest(ts, opts) {
    const probeRel = "src/__tests__/__ratchet-selftest.spec.ts";
    const probePath = join(opts.uiRoot, probeRel);
    const body =
        'import { createI18n } from "vue-i18n";\n' +
        "// task-318 自检：故意让「被断言的值」同时是夹具副本，正确行为是计入 (a)。\n" +
        "// 这一行只有一个引号，用来证明实现不靠引号配对（正则版会在这里错位）：\"\n" +
        'const messages = { "zh-CN": { demo: { label: "搜索会话...", other: "正在创建分叉会话" } } };\n' +
        'const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });\n' +
        "export { i18n };\n" +
        'it("selftest", () => { expect("搜索会话...").toBe("搜索会话..."); });\n';
    try {
        writeFileSync(probePath, body, "utf8");
        const { rows } = scan(ts, opts.uiRoot, resolveQualifier(opts).qualifies);
        const hit = rows.find((r) => r.rel === probeRel);
        const ok = Boolean(hit) && hit.counts.a > 0;
        process.stdout.write(
            (ok ? "[PASS] " : "[FAIL] ") +
                "自检：临时探针 " +
                (hit
                    ? "tier=" + hit.tier + " a=" + hit.counts.a + " (" + hit.poisonedValues.join(", ") + ")"
                    : "未被识别") +
                "\n",
        );
        return ok ? 0 : 1;
    } finally {
        if (existsSync(probePath)) rmSync(probePath, { force: true });
        if (existsSync(probePath)) {
            process.stderr.write("[i18n-copies] 严重：临时探针删不掉：" + probePath + "\n");
            process.exit(2);
        }
    }
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(opts.uiRoot)) {
        process.stderr.write("[i18n-copies] UI 根不存在：" + opts.uiRoot + "\n");
        process.exit(2);
    }
    const ts = loadTs(opts.uiRoot);
    if (opts.selftest) process.exit(selftest(ts, opts));

    const qualifier = resolveQualifier(opts);
    const { rows, aFiles, realValueCount, unresolvedFiles } = scan(ts, opts.uiRoot, qualifier.qualifies);
    /** 基线按尺分文件：旧尺 len6 留档，永不删除（换尺必须两个数都在盘上） */
    const baselinePath = opts.baseline ?? LEGACY_BASELINE_PATHS[qualifier.name] ?? BASELINE_PATH;
    const baseline = readBaseline(baselinePath);
    const baselineSet = new Set(baseline.files ?? []);
    const newBeyondBaseline = aFiles.filter((f) => !baselineSet.has(f));
    const fixedNotReconciled = [...baselineSet].filter((f) => !aFiles.includes(f)).sort();

    if (opts.writeBaseline) {
        const dirty = dirtyFilesAtMeasure(opts.uiRoot);
        const dirtyFiles = Array.isArray(dirty) ? dirty : [];
        const dirtyNote = Array.isArray(dirty) ? undefined : "git status 取不到：" + dirty.error;
        const measuredAt = isoTimestamp(new Date());
        writeFileSync(
            baselinePath,
            JSON.stringify(
                {
                    note: "task-318 ratchet 基线：只许缩小。收账后手工重跑 --write-baseline。",
                    ruler: qualifier.name,
                    rulerLabel: qualifier.label,
                    measuredAt,
                    dirtyAtMeasure: dirtyFiles,
                    ...(dirtyNote ? { dirtyAtMeasureNote: dirtyNote } : {}),
                    uiRoot: relative(ONE_ROOT, opts.uiRoot).split("\\").join("/"),
                    aCount: aFiles.length,
                    files: aFiles,
                },
                null,
                4,
            ) + "\n",
            "utf8",
        );
        process.stdout.write(
            "[i18n-copies] 基线已写入 " +
                baselinePath +
                "（尺=" +
                qualifier.label +
                "，a=" +
                aFiles.length +
                "，measuredAt=" +
                measuredAt +
                "，dirtyAtMeasure=" +
                dirtyFiles.length +
                " 个）\n" +
                (dirtyNote ? "[i18n-copies] " + dirtyNote + "\n" : ""),
        );
        process.exit(0);
    }

    const tiers = { a: aFiles.length, b: 0, c: 0 };
    for (const r of rows) if (r.counts.a === 0) tiers[r.tier] += 1;

    if (opts.json) {
        process.stdout.write(
            JSON.stringify(
                {
                    realValues: realValueCount,
                    ruler: qualifier.name,
                    rulerLabel: qualifier.label,
                    filesScannedWithCopies: rows.length,
                    unresolvedFixtureRefs: unresolvedFiles,
                    tierCounts: tiers,
                    baselineACount: baselineSet.size,
                    newBeyondBaseline,
                    fixedNotReconciled,
                    rows,
                },
                null,
                2,
            ) + "\n",
        );
        process.exit(newBeyondBaseline.length === 0 ? 0 : 1);
    }

    const legacyLines = [];
    for (const [name, p] of Object.entries(LEGACY_BASELINE_PATHS)) {
        if (name === qualifier.name) continue;
        const other = readBaseline(p);
        if (other.files && other.files.length > 0) {
            legacyLines.push(
                "[i18n-copies] 留档（另一把尺 " + (RULERS[name]?.label ?? name) + "）：a=" + other.files.length + "  " + p,
            );
        }
    }
    process.stdout.write("[i18n-copies] 尺 = " + qualifier.label + "（--ruler " + qualifier.name + "）\n");
    process.stdout.write(
        "[i18n-copies] 真源叶子值 " +
            realValueCount +
            " 个；自带副本的测试文件 " +
            rows.length +
            " 个（另 " +
            unresolvedFiles +
            " 个的夹具引用解析不到，已跳过）\n" +
            "[i18n-copies] (a) 真坑 " +
            tiers.a +
            " / (b) 正常 " +
            tiers.b +
            " / (c) 低危 " +
            tiers.c +
            "；基线 a=" +
            baselineSet.size +
            "\n" +
            (legacyLines.length > 0 ? legacyLines.join("\n") + "\n" : ""),
    );
    if (opts.verbose) {
        process.stdout.write("\n| 文件 | 档 | a | b | c | 被断言/定位的值（行） |\n| --- | --- | --- | --- | --- | --- |\n");
        for (const r of rows) {
            const detail = r.poisonedValues
                .map((v) => v + "@" + r.locations[v].map((l) => l.line + l.kind[0]).join(","))
                .join(" · ");
            process.stdout.write(
                "| " +
                    r.rel +
                    " | " +
                    r.tier +
                    " | " +
                    r.counts.a +
                    " | " +
                    r.counts.b +
                    " | " +
                    r.counts.c +
                    " | " +
                    detail +
                    " |\n",
            );
        }
    }
    if (newBeyondBaseline.length > 0) {
        process.stdout.write("\n[i18n-copies] FAIL：以下文件是基线外的 (a) 真坑（ratchet 只许缩小）\n");
        for (const f of newBeyondBaseline) process.stdout.write("  + " + f + "\n");
        process.exit(1);
    }
    if (fixedNotReconciled.length > 0) {
        process.stdout.write("\n[i18n-copies] NOTE：以下基线项已不再是 (a)，可收账（--write-baseline）\n");
        for (const f of fixedNotReconciled) process.stdout.write("  - " + f + "\n");
    }
    process.stdout.write("[i18n-copies] PASS：未超出基线\n");
    process.exit(0);
}

main();
