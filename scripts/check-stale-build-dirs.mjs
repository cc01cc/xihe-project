#!/usr/bin/env node
/**
 * check-stale-build-dirs — 构建缓存目录巡查（task-88，report-only，默认永不删东西）。
 *
 * 为什么需要它：mvn 的 `-Dxihe.build.suffix` / `-Dxihe.target.dir` 允许每次跑测试换一个
 * 输出目录，于是同一 package 下会攒出 `target-b/`、`target-c/`、`target-scope/` …
 * 这类一次性目录（2026-11-20 实测 control-plane 下 4 个共 67.8 MB）。它们被 .gitignore 的
 * `target-…` 通配规则挡住所以不污染 git status，也就没人注意；唯一被 mise 主动使用的是
 * `target-lint/`（`mvn run lint:cp` 刻意用它避开与 test:cp 抢 `target/`，见 mise.toml 注释）。
 *
 * 判据（两件同时成立才算 stale）：
 *   ① 目录名命中三类之一：`target-*` / `build-*` / `dist-*` / 字面 `.cache`
 *      ——裸 `target/`、`dist/`、`build/` **不是候选**（那是主构建目录，本门不碰）
 *   ② 最新文件 mtime 早于 `--age-days`（默认 7 天）**且** 目录名在「引用语料」里找不到
 *      引用语料 = mise.toml / package.json / pom.xml / 各 `scripts/` 下的脚本与配置
 *
 * 门不能判什么（判据边界）：
 *   · 判不了「这个目录是不是真的没用了」——被引用只是必要条件，没有人手工引用的一次性目录
 *     照样可能是某人在跑的构建；**本门只列清单，删不删由人决定**（它自己永不删除）。
 *   · 判不了引用语料之外的人肉用法（IDE 配置、命令行历史、别的 checkout）。
 *   · 不看 worktree / `.staging` / `.local`（别人的树，不在巡查面）。
 *
 * 退出码：0 = 正常（report-only，有 stale 也 exit 0）/ 1 = selftest 失败。
 *
 * 用法：
 *   node scripts/check-stale-build-dirs.mjs                 # 扫本仓库（7 天阈值）
 *   node scripts/check-stale-build-dirs.mjs --age-days 30   # 换阈值
 *   node scripts/check-stale-build-dirs.mjs --json          # 机读
 *   node scripts/check-stale-build-dirs.mjs --selftest      # 4 夹具自测（不碰真树）
 *
 * 刻意不带同名 `.test.mjs`：`scripts/test-wiring.test.mjs` 要求每个 `*.test.mjs` 都被某个
 * mise 任务的 `run =` 真执行，本门已有独立 mise 任务承载自测，故自测内建。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;

/** 候选目录名形态（③ .cache 是字面量，单独判）。 */
const NAME_PATTERNS = [/^target-/, /^build-/, /^dist-/];
const SPECIAL_NAMES = new Set([".cache"]);

/** 遍历时整棵跳过的目录：别人的树、依赖、主构建目录（主 target/ 不是候选也不必进去）。 */
const SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    ".worktrees",
    ".staging",
    ".local",
    ".venv",
    ".tmp",
    "target",
    "dist",
    "build",
]);

/** 引用语料的构成：这三类文件全收，`scripts/` 下只收脚本/配置扩展名。 */
const CORPUS_BASENAMES = new Set(["mise.toml", "package.json", "pom.xml"]);
const SCRIPT_EXTS = new Set([
    ".mjs",
    ".js",
    ".cjs",
    ".ts",
    ".sh",
    ".bash",
    ".ps1",
    ".toml",
    ".yml",
    ".yaml",
    ".json",
]);
const CORPUS_MAX_BYTES = 1024 * 1024;

function isCandidateName(name) {
    if (SPECIAL_NAMES.has(name)) return true;
    return NAME_PATTERNS.some((re) => re.test(name));
}

/** 收集候选目录（命中即不再下钻，免得把子目录也算成候选）。 */
function collectCandidates(root) {
    const found = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (SKIP_DIRS.has(e.name)) continue;
            const abs = path.join(dir, e.name);
            if (isCandidateName(e.name)) {
                found.push({ name: e.name, dir: abs });
                continue;
            }
            walk(abs);
        }
    };
    walk(root);
    return found;
}

/** 汇总一个候选目录：字节数、最新文件 mtime、文件数。 */
function measure(dir) {
    let bytes = 0;
    let files = 0;
    let newest = 0;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const abs = path.join(cur, e.name);
            if (e.isDirectory()) {
                stack.push(abs);
                continue;
            }
            if (!e.isFile()) continue;
            files += 1;
            try {
                const st = fs.statSync(abs);
                bytes += st.size;
                if (st.mtimeMs > newest) newest = st.mtimeMs;
            } catch {
                // 单个文件被并发改写/删除不致命：跳过它，别让门崩
            }
        }
    }
    return { bytes, files, newest };
}

/** 建引用语料：返回 { texts: [{file, text}], files }。 */
function buildCorpus(root) {
    const texts = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                walk(path.join(dir, e.name));
                continue;
            }
            if (!e.isFile()) continue;
            const abs = path.join(dir, e.name);
            const base = e.name;
            // 本门自己的源码不算「引用」：注释里举例一个目录名就把它钉成 keep 是自欺
            if (path.resolve(abs) === SELF) continue;
            const inScripts = dir.split(path.sep).includes("scripts");
            const wanted =
                CORPUS_BASENAMES.has(base) || (inScripts && SCRIPT_EXTS.has(path.extname(base)));
            if (!wanted) continue;
            try {
                const st = fs.statSync(abs);
                if (st.size > CORPUS_MAX_BYTES) continue;
                texts.push({ file: path.relative(root, abs), text: fs.readFileSync(abs, "utf8") });
            } catch {
                // 读不到就当它不存在：引用语料是「有没有人提到」，不是完整性检查
            }
        }
    };
    walk(root);
    return texts;
}

/** 目录名是否在语料里被提到（字面包含即可：注释里写 `target-lint/` 也算在用）。 */
function findReferences(name, corpus) {
    const hits = [];
    for (const c of corpus) {
        if (c.text.includes(name)) hits.push(c.file);
    }
    return hits;
}

function scan({ root = ROOT, ageDays = 7, now = Date.now() } = {}) {
    const corpus = buildCorpus(root);
    const rows = [];
    for (const c of collectCandidates(root)) {
        const m = measure(c.dir);
        const refs = findReferences(c.name, corpus);
        const newestMs = m.newest || 0;
        const ageDaysObserved = newestMs ? (now - newestMs) / DAY_MS : Infinity;
        const stale = ageDaysObserved >= ageDays && refs.length === 0;
        rows.push({
            path: path.relative(root, c.dir).split(path.sep).join("/"),
            name: c.name,
            bytes: m.bytes,
            files: m.files,
            newestMtime: newestMs ? new Date(newestMs).toISOString() : null,
            ageDays: Number.isFinite(ageDaysObserved) ? Math.floor(ageDaysObserved) : null,
            referencedBy: refs,
            stale,
        });
    }
    return {
        root,
        ageDays,
        candidates: rows.length,
        stale: rows.filter((r) => r.stale).length,
        rows,
        corpusFiles: corpus.length,
    };
}

function human(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
    return bytes + " B";
}

function printReport(res) {
    console.log(`[check-stale-build-dirs] root=${res.root}`);
    console.log(
        `[check-stale-build-dirs] 扫描 ${res.candidates} 个候选 / stale ${res.stale} 个（阈值 ${res.ageDays} 天；引用语料 ${res.corpusFiles} 文件）`,
    );
    console.log("");
    console.log("| 目录 | 大小 | 文件 | 最新 mtime | 龄（天） | 引用 | 判定 |");
    console.log("| --- | --- | --- | --- | --- | --- | --- |");
    for (const r of res.rows) {
        const refText = r.referencedBy.length ? r.referencedBy.slice(0, 2).join(", ") : "—";
        console.log(
            `| ${r.path} | ${human(r.bytes)} | ${r.files} | ${r.newestMtime ?? "—"} | ${r.ageDays ?? "—"} | ${refText} | ${r.stale ? "stale" : "keep"} |`,
        );
    }
    const staleRows = res.rows.filter((r) => r.stale);
    if (staleRows.length) {
        console.log("");
        console.log("建议（**本门不执行**，删不删由人决定；走回收站，逐条复核 Test-Path）：");
        console.log(
            `  stale 合计 ${staleRows.length} 个 / ${human(staleRows.reduce((s, r) => s + r.bytes, 0))}`,
        );
        for (const r of staleRows) console.log(`  - ${r.path}`);
        console.log("");
        console.log(
            "  回收站调用（PowerShell，OneDrive/回收站不可用时整段失败即停，不许退化成永久删除）：",
        );
        console.log("    Add-Type -AssemblyName Microsoft.VisualBasic");
        console.log(
            "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')",
        );
        console.log("    Test-Path $p   # 必须 False");
    } else {
        console.log("");
        console.log("无 stale 候选。");
    }
    console.log("");
    console.log("[check-stale-build-dirs] report-only：不改任何文件、不删任何目录，exit 0");
}

function selftest() {
    let pass = 0;
    const fails = [];
    const check = (name, ok, detail) => {
        if (ok) {
            pass += 1;
            console.log("  PASS " + name);
        } else {
            fails.push(name + " :: " + detail);
            console.log("  FAIL " + name + " :: " + detail);
        }
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-build-dirs-"));
    const old = Date.now() - 30 * DAY_MS;
    const writeFile = (rel, body, mtime) => {
        const abs = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
        if (mtime) fs.utimesSync(abs, new Date(mtime), new Date(mtime)); // 毫秒数必须转 Date：utimesSync 的 number 形参单位是秒
    };
    try {
        // 夹具 1：可删 —— 30 天没动、没人引用
        writeFile("target-deletable/classes/A.class", "x", old);
        // 夹具 2：被引用 —— 30 天没动，但 mise.toml 里点了它的名
        writeFile("target-referenced/classes/B.class", "x", old);
        // 引用侧必须出现**目录名**本身（本门按字面包含判定，mise 注释点名的就是它）
        writeFile(
            "mise.toml",
            '# 这里点名 target-referenced/ 作为输出目录\n[tasks."lint:cp"]\nrun = \'mvn checkstyle:check "-Dxihe.build.suffix=-referenced"\'\n',
            Date.now(),
        );
        // 夹具 3：新鲜 —— 1 天前动过（阈值 7 天）
        writeFile("target-fresh/classes/C.class", "x", Date.now() - 1 * DAY_MS);
        // 夹具 4：裸 target/ 与字面 .cache —— 前者不是候选，后者是候选且可删
        writeFile("target/classes/D.class", "x", old);
        writeFile(".cache/blob.bin", "x", old);

        const res = scan({ root: tmp, ageDays: 7 });
        const byPath = Object.fromEntries(res.rows.map((r) => [r.path, r]));

        check(
            "候选 = 4（deletable/referenced/fresh/.cache）",
            res.candidates === 4,
            "实际 " + res.candidates + " :: " + Object.keys(byPath).join(","),
        );
        check(
            "target-deletable 判 stale",
            byPath["target-deletable"]?.stale === true,
            "actual " + JSON.stringify(byPath["target-deletable"]),
        );
        check(
            "target-referenced 不判 stale（引用钉住）",
            byPath["target-referenced"]?.stale === false &&
                (byPath["target-referenced"]?.referencedBy ?? []).includes("mise.toml"),
            "actual " + JSON.stringify(byPath["target-referenced"]),
        );
        check(
            "target-fresh 不判 stale（新鲜）",
            byPath["target-fresh"]?.stale === false,
            "actual " + JSON.stringify(byPath["target-fresh"]),
        );
        check("裸 target/ 不是候选", byPath["target"] === undefined, "却出现在清单里");
        check(
            ".cache 是候选且判 stale",
            byPath[".cache"]?.stale === true,
            "actual " + JSON.stringify(byPath[".cache"]),
        );
        check("stale 计数 = 2", res.stale === 2, "实际 " + res.stale);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    const total = pass + fails.length;
    console.log(`  selftest ${pass}/${total} 通过`);
    if (fails.length) {
        for (const f of fails) console.error("  E_SELFTEST " + f);
        return 1;
    }
    return 0;
}

function main(argv) {
    if (argv.includes("--selftest")) process.exit(selftest());
    const ageIdx = argv.indexOf("--age-days");
    const ageDays = ageIdx >= 0 ? Number(argv[ageIdx + 1]) : 7;
    if (!Number.isFinite(ageDays) || ageDays <= 0) {
        console.error("E_ARGS --age-days 必须是正数");
        return 2;
    }
    const res = scan({ ageDays });
    if (argv.includes("--json")) console.log(JSON.stringify(res, null, 2));
    else printReport(res);
    return 0;
}

process.exit(main(process.argv.slice(2)));
