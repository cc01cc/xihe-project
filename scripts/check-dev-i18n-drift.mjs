#!/usr/bin/env node
/**
 * `check:dev-i18n-drift` —— DEV 文档「中英编号集合漂移」+「编号登记面存在性」只读检查（**report-only**）。
 *
 * 为什么有这个工具（task-316，判据来自 task-310 的探针）：
 * `DEV-010` 连改 5 轮（redirect 假陈述 / 死组件名 / tab 清单 / 路由表 / 组件名），每一轮都是"发现了才改"。
 * 那个探针把 5 类可能的假陈述逐类跑了一遍：`*.vue` 名 / `data-testid` 词 / 路由 path 三类**假阳性 5/5**
 * —— 因为这份文档用同一种形态记录「已删除」「未落地」「无」，存在性检查会把"正确地不存在"判成假陈述。
 * 唯一真能机械核的一类是**跨语言集合差**：zh 引用了某个编号/术语而 en 没引用，反过来说 en 侧漏了一句
 * 溯源（`D-924`：模块名 工作区 → 工作台，就是被这条抓到，连带牵出 en 两处旧名残留）。
 *
 * 三条判据
 *   1. **编号对称差**：同一篇文档，`PLAN-\d{4}` / `D-\d{3,4}` / `task-\d+` 中英两侧集合取对称差，非空即报；
 *   2. **PLAN 登记面**：`PLAN-NNNN` 必须在 `plans/`（**含 `plans/archive/`，且单文件与目录都收**）有落点；
 *   3. **D 登记面**：`D-NNNN` 必须在台账主册（`lead-decisions-ledger.md`）**全文出现过**，或在归档 D 号卷里出现过。
 *   4. **小节标题对拍**（`task-88` 新增；判据来自 `task-87` 实测的口径盲区）：同一篇文档按**层级**（H2/H3/H4）取小节标题做对称差 ——
 *      三条老判据全部以「编号」为锚，**一个不含任何编号/日期/code span 的小节标题在另一册整节消失，一条都不会报**。
 *      实测样本：`DEV-011` zh 有 `### 可发现性例外`、en 无 ⇒ 旧版命中 0（见 `internal/A03-xihe/docs/dev-i18n-heading-drift-20261119.md`）。
 *      对齐口径（翻译场景下措辞必然不同，所以**不比文字**）：同层内**签名有交集即视为同一小节**；
 *      签名 = 标题里的 code span / 编号 / 日期 / 数字（翻译不会改动的那部分）；剩下**两侧都无签名**的标题按出现顺序互相抵消，
 *      抵消不完的就是分叉，按侧列出标题原文。读数首行带**作用域根 + cwd + 册数** —— 不带作用域的「0 问题」不算数（同一把门换 cwd 作用域就变，实测）。
 *
 * 盲区（**本工具结构上不覆盖**，输出里会原样打印，别以为它全覆盖）
 *   a. **负向陈述**：「已删除 / 未落地 / 无 X」这类句子 —— 任何存在性检查都会把"正确地不存在"判成缺陷
 *      （`DEV-010` 实测 5/5 假阳性：`NavRail.vue`、`S1SettingsAfter.vue`、`workspace-nav`、`list-pane`）；
 *   b. **运行态 task 卡**：`task-NNNN` 的登记面是运行中的团队板（`team_task_list`），静态仓库没有权威清单
 *      ⇒ 本脚本只做中英对称差，**不判 task 号是否存在**（"查不到"≠"不存在"）；
 *   c. **相对子路由**：文档里的 `session/:sessionId` 这类子路由要拼父级 `path:` 才成立，本脚本不解析路由
 *      ⇒ 任何"路径是否存在"的机械检查在这里都会大比例假阳性（实测 8/12）；
 *   d. **不在判据内**：组件名 / `data-testid` / CSS 类 / 参数值域 / 路由表 —— 这些只能人读或另立专用门。
 *
 * 用法
 *   node scripts/check-dev-i18n-drift.mjs                # report-only：有命中仍 exit 0，只打印
 *   node scripts/check-dev-i18n-drift.mjs --json         # 机器可读
 *   node scripts/check-dev-i18n-drift.mjs --enforce      # 有命中 exit 1（**手工用；绝对不要接 validate**）
 *   node scripts/check-dev-i18n-drift.mjs --selftest     # 夹具自测，不起任何外部依赖
 * 退出码：0 = 扫过（report-only 命中也是 0）；1 = `--enforce` 且有命中；2 = **输入缺失（E_INPUT_MISSING）**或内部错误 —— 见下「task-73」。
 *
 * **不许接 `validate.depends`**（task-316 明写）：一条会被绕过的红门等于没有门（`D-1046`）。
 *
 * task-73（2026-11-20）：**输入缺失一律 E 级，不许读成「0 命中」**。改前四处静默降级：
 *   (a) 单边篇（zh 独有 / en 独有）完全不进判据 —— 门自称覆盖全部册，实际只扫配对篇（真树上 33 篇里只扫了 19 篇）；
 *   (b) 登记面三源（plans/ 目录、台账主册、归档卷）缺失时静默成空集 —— 主册缺失 ⇒ 全部 D 号报「未登记」（假红），
 *       ops 台账缺失 ⇒ 「疑似错册登记」提示永不出现（假绿，正是 task-62 矩阵 ④-1）；
 *   (c) 读取失败裸 throw ⇒ 整轮崩掉，已算出的 findings 全丢。
 * 现口径：单边篇**进登记面判据**（它们的编号照样要能落到 plans/台账）；三源缺失与读取失败都进 `errors`（E_INPUT_MISSING），
 * 且**抑制**由空登记面产生的 unregistered 假红；有 E 时 exit 2，绝不以「0 命中」收场。判据本体（对称差 / 标题对拍 / 登记面存在性）一字未放宽。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE = path.resolve(SCRIPT_DIR, "..", "..");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const enforce = args.has("--enforce");
const selftest = args.has("--selftest");

const CLASSES = [
    { key: "PLAN", re: /PLAN-(\d{4})/gu, id: (m) => `PLAN-${m[1]}` },
    { key: "D", re: /(?:^|[^A-Za-z])D-(\d{3,4})(?!\d)/gu, id: (m) => `D-${m[1]}` },
    { key: "task", re: /task-(\d+)/gu, id: (m) => m[0] },
];

const BLIND_SPOTS = [
    "盲区（本工具结构上不覆盖，勿据此认为「全覆盖」）：",
    "  a. 负向陈述：「已删除 / 未落地 / 无 X」—— 存在性检查会把「正确地不存在」判成缺陷（DEV-010 实测 5/5 假阳）；",
    "  b. 运行态 task 卡：task 号的登记面是运行中的团队板，静态仓库无权威清单 ⇒ 本工具只做中英对称差；",
    "  c. 相对子路由：`session/:sessionId` 需拼父级 `path:`，本工具不解析路由 ⇒ 路径存在性检查实测 8/12 假阳；",
    "  d. 不覆盖：组件名 / data-testid / CSS 类 / 参数值域 / 路由表（这些只能人读或另立专用门）。",
    "  e. 登记面取「出现过」而非「被定义为条目」：正文顺带提一句也算已登记 ⇒ 会漏掉「从未定义、只被引用」的号；",
    "  f. 小节标题对拍的残余盲区：无签名标题按「同层出现顺序」配对 ⇒ 两侧条数相同而内容互换（改名 + 换序）不报；章号在两册故意分叉（en DEV-011 第 10 节自己写着别按编号平移）⇒ H2 条数相同就不报。",
    "  g. 单边篇（task-73 起）报 E 级并进「登记面存在性」，但不做中英对称差与标题对拍 —— 它们没有对侧，这两个判据在单边篇上本来就没有对象。真树上 en 缺篇 10 篇是真缺口（归 task-62 的 en 译稿面），ADR-001 / RFC-001 是 en 独有历史档（按设计不参与）。",
];

function readText(file) {
    return fs.readFileSync(file, "utf8");
}

/** task-73：读取失败必须收成 E 级错误，不能变成「该篇不算数」。 */
function readTextSafe(file) {
    try {
        return { ok: true, text: readText(file) };
    } catch (e) {
        return { ok: false, error: (e && e.code) || (e && e.message) || String(e) };
    }
}

function countCodeSpans(text) {
    return [...text.matchAll(/`[^`\n]{1,90}`/gu)].length;
}

function extractIds(text) {
    const out = {};
    for (const c of CLASSES) {
        const set = new Set();
        for (const m of text.matchAll(new RegExp(c.re.source, c.re.flags))) set.add(c.id(m));
        out[c.key] = set;
    }
    return out;
}

/** 递归收集 `plans/` 下所有以 PLAN-NNNN 开头的**文件或目录**（含 `plans/archive/` —— task-314 的坑）。
 * task-73：目录缺失旧实现静默返回空集 ⇒ 每个 PLAN 号都被报「未登记」（假红）。现改为 E 级。 */
function collectPlanLandings(plansDir, out = new Set(), depth = 0, errors = []) {
    if (!fs.existsSync(plansDir)) {
        errors.push({ code: "E_INPUT_MISSING", detail: "登记面源不可读：plans 目录不存在（" + plansDir + "）⇒ 登记面判据停用", path: plansDir, source: "registry" });
        return out;
    }
    if (depth > 4) return out;
    for (const entry of fs.readdirSync(plansDir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const m = /^PLAN-(\d{4})/u.exec(entry.name);
        if (m) out.add(`PLAN-${m[1]}`);
        if (entry.isDirectory()) collectPlanLandings(path.join(plansDir, entry.name), out, depth + 1, errors);
    }
    return out;
}
/**
 * 台账登记面：主册 + 归档 D 号卷。
 * **判据取「全文出现过」而不是「有 `### D-xxxx` 标题」** —— 主册里相当一部分裁定是列表条目
 * （如 `- **D-766｜…**`，实测 `D-766`/`D-810` 都无三级标题），只认标题会当场造 2 条假阳
 * （`D-776`/`D-810` 的教训就写在 `D-1046`：一条会假红的判据会被绕过）。
 * 反向代价：正文顺带提一句也算"登记"，会漏掉"只在别处被提到、从未被定义"的号 —— 写进盲区 e。
 */
function collectDecisionLandings(docsDir, errors = []) {
    const main = new Set();
    const archive = new Set();
    const mainFile = path.join(docsDir, "lead-decisions-ledger.md");
    const collect = (text, into) => {
        for (const m of text.matchAll(/(?:^|[^A-Za-z])D-(\d{3,4})(?!\d)/gmu)) into.add(`D-${m[1]}`);
    };
    const pushErr = (detail, p) => errors.push({ code: "E_INPUT_MISSING", detail, path: p, source: "registry" });
    // task-73（b）：三源（主册 / 归档卷 / plans）缺失或读失败一律 E 级。
    // 旧实现静默成空集 ⇒ 假红（全部 D 号报未登记）与假绿（ops 恒 0 ⇒「错册提示」永不出现）双向。
    if (fs.existsSync(mainFile)) {
        const res = readTextSafe(mainFile);
        if (res.ok) collect(res.text, main);
        else pushErr(`登记面源读取失败：台账主册 ${res.error} ⇒ 登记面判据停用`, mainFile);
    } else {
        pushErr("登记面源不可读：台账主册 lead-decisions-ledger.md 不存在 ⇒ 登记面判据停用（旧实现静默成空集，会把全部 D 号报成未登记）", mainFile);
    }
    const archiveDir = path.join(docsDir, "archive");
    if (fs.existsSync(archiveDir)) {
        for (const name of fs.readdirSync(archiveDir)) {
            if (!/^lead-decisions.*\.md$/u.test(name)) continue;
            const res = readTextSafe(path.join(archiveDir, name));
            if (res.ok) collect(res.text, archive);
            else pushErr(`登记面源读取失败：归档卷 ${name}（${res.error}）⇒ 归档 D 号未纳入登记面`, path.join(archiveDir, name));
        }
    } else {
        pushErr(`登记面源不可读：归档卷目录不存在（${archiveDir}）⇒ 归档 D 号未纳入登记面`, archiveDir);
    }
    // 操作台账（`lead-ledger.md`）：**不在登记面**（2026-11-19 按 D-1898 退役）。缺它不是错误，
    // 但旧实现把「文件不存在」渲染成「另有 0 个」⇒ 读者读成「确实没有错册登记」。现显式带存在性。
    const opsFile = path.join(docsDir, "lead-ledger.md");
    const ops = new Set();
    const opsFilePresent = fs.existsSync(opsFile);
    if (opsFilePresent) {
        const res = readTextSafe(opsFile);
        if (res.ok) collect(res.text, ops);
        else pushErr(`ops 台账读取失败：${res.error}`, opsFile);
    }
    return { main, archive, ops, opsFilePresent, effective: new Set([...main, ...archive]) };
}
// ─────────────────── 小节标题对拍（task-88：无 token 的分叉也要报） ───────────────────
const LF_CH = String.fromCharCode(10);
const CR_CH = String.fromCharCode(13);
const HEADING_LINE = /^ {0,3}(#{2,4}) +(.+?) *$/u;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/u;
const QUOTE_PREFIX = /^ {0,3}(?:> ?)+/u;

// 标题里「翻译不会改动」的部分当签名：code span / 编号 / 日期 / 数字。日期先摘掉，免得它的片段被当成普通数字到处乱配。
function headingSignature(title) {
    const s = new Set();
    // 先剥前导序号：两册章号**故意**分叉（en DEV-011 第 10 节明写别按编号平移），
    // 不剥就会把 zh `1.1. UI 模块` 与 en `2.1. UI Module` 当成两节不同的小节 —— 纯噪声（本卡实测 DEV-002 一度报 43 条）。
    let ord = title.replace(/^[0-9]+(?:[.][0-9]+)*[.、]?[ ]+/u, "");
    for (const m of ord.matchAll(/`([^`]+)`/gu)) s.add("code:" + m[1]);
    for (const m of ord.matchAll(/(?:PLAN-[0-9]{4}|D-[0-9]{3,4}|BL-[0-9]+|task-[0-9]+)/gu)) s.add("id:" + m[0]);
    let bare = ord;
    for (const m of ord.matchAll(/[0-9]{4}-[0-9]{2}-[0-9]{2}/gu)) s.add("date:" + m[0]);
    bare = bare.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}/gu, " ");
    for (const m of bare.matchAll(/[0-9]+(?:[.][0-9]+)*/gu)) s.add("num:" + m[0]);
    return s;
}

function extractHeadings(text) {
    const out = [];
    let inFence = false;
    for (const raw of text.split(LF_CH)) {
        const line = raw.endsWith(CR_CH) ? raw.slice(0, -1) : raw;
        if (FENCE_LINE.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const m = HEADING_LINE.exec(line.replace(QUOTE_PREFIX, ""));
        if (!m) continue;
        const title = m[2];
        out.push({ level: m[1].length, title, sig: headingSignature(title) });
    }
    return out;
}

function sigOverlap(a, b) {
    if (a.size === 0 || b.size === 0) return false;
    for (const t of a) if (b.has(t)) return true;
    return false;
}

// 同层内：签名有交集即认同一小节；剩下两侧都无签名的按顺序互相抵消，抵消不完 = 分叉。
function headingDiffByLevel(zhHeads, enHeads) {
    const used = new Set();
    const zhRest = [];
    for (const z of zhHeads) {
        let hit = -1;
        for (let i = 0; i < enHeads.length; i += 1) {
            if (!used.has(i) && sigOverlap(z.sig, enHeads[i].sig)) {
                hit = i;
                break;
            }
        }
        if (hit >= 0) used.add(hit);
        else zhRest.push(z);
    }
    const enRest = enHeads.filter((_, i) => !used.has(i));
    const zhBare = zhRest.filter((h) => h.sig.size === 0);
    const enBare = enRest.filter((h) => h.sig.size === 0);
    const cancel = Math.min(zhBare.length, enBare.length);
    return {
        zhOnly: [...zhRest.filter((h) => h.sig.size > 0), ...zhBare.slice(cancel)].map((h) => h.title),
        enOnly: [...enRest.filter((h) => h.sig.size > 0), ...enBare.slice(cancel)].map((h) => h.title),
    };
}

function compareHeadings(name, zhText, enText, findings) {
    const zhAll = extractHeadings(zhText);
    const enAll = extractHeadings(enText);
    const group = (heads) => {
        const m = new Map();
        for (const h of heads) {
            if (!m.has(h.level)) m.set(h.level, []);
            m.get(h.level).push(h);
        }
        return m;
    };
    const zhM = group(zhAll);
    const enM = group(enAll);
    for (const level of new Set([...zhM.keys(), ...enM.keys()])) {
        const d = headingDiffByLevel(zhM.get(level) ?? [], enM.get(level) ?? []);
        if (d.zhOnly.length) findings.push({ kind: "headingAsymmetry", file: name, level, side: "zh", titles: d.zhOnly });
        if (d.enOnly.length) findings.push({ kind: "headingAsymmetry", file: name, level, side: "en", titles: d.enOnly });
    }
    return { zh: zhAll.length, en: enAll.length };
}

// task-73（a）：单边篇的说明文字。真树上 en 缺篇 10 篇 / zh 缺篇 2 篇（ADR-001 / RFC-001 是 en 独有历史档），
// 前者是真缺口（归 task-62 的 en 译稿面），后者按设计不参与对称差。门只报「这一侧无对侧」，不替人判定归属。
const UNPAIRED_NOTE = "该篇只有一侧可读 ⇒ 中英对称差与标题对拍在这一篇上没有对象（这本身就是 E 级覆盖缺口，不是 W 级措辞差异）";
function scan({ workspace, a03 }) {
    const i18nRoot = path.join(a03, "docs", "i18n");
    const zhDir = path.join(i18nRoot, "zh-Hans");
    const enDir = path.join(i18nRoot, "en");
    // task-73：**输入缺失 = E 级红，不是「0 命中」**。旧实现四处静默兜底（登记面三源 existsSync 跳过、
    // 单边篇不进判据、读取失败裸 throw 崩整轮），下面把每一处都收成显式 errors，由 main 以 exit 2 拦下。
    const errors = [];
    const noteInput = (detail, p) => errors.push({ code: "E_INPUT_MISSING", detail, path: p, source: "doc" });
    if (!fs.existsSync(zhDir) || !fs.existsSync(enDir)) {
        const missing = [!fs.existsSync(zhDir) ? zhDir : null, !fs.existsSync(enDir) ? enDir : null].filter(Boolean);
        noteInput(`i18n 目录不可读（${missing.join(" / ")}）⇒ 该侧册未参与判据，本轮不得读成「0 命中」`, i18nRoot);
        return {
            surface: { pairedFiles: 0, missingOnEn: 0, missingOnZh: 0, zhFiles: 0, enFiles: 0, zhSpans: 0, enSpans: 0, headingZh: 0, headingEn: 0, zhIds: {}, enIds: {} },
            findings: [],
            errors,
            suppression: "",
            registry: { plans: 0, decisionMain: 0, decisionArchive: 0, decisionOps: 0, opsFilePresent: false, registryReadable: false },
            missingOnEn: [],
            missingOnZh: [],
            dirs: { workspace, i18nRoot, plans: path.join(workspace, "plans") },
        };
    }
    const zhFiles = fs.readdirSync(zhDir).filter((n) => n.endsWith(".md")).sort();
    const enList = fs.readdirSync(enDir).filter((n) => n.endsWith(".md")).sort();
    const enFiles = new Set(enList);
    const zhSet = new Set(zhFiles);
    const missingOnEn = zhFiles.filter((n) => !enFiles.has(n));
    // task-73（a）：仅 en 有的篇（真树实测 ADR-001 / RFC-001）旧实现**完全不可见** —— 既不计数也不进判据。
    const missingOnZh = enList.filter((n) => !zhSet.has(n));
    const paired = zhFiles.filter((n) => enFiles.has(n));

    const surface = { pairedFiles: paired.length, missingOnEn: missingOnEn.length, missingOnZh: missingOnZh.length, zhFiles: zhFiles.length, enFiles: enFiles.size, zhSpans: 0, enSpans: 0, headingZh: 0, headingEn: 0, zhIds: {}, enIds: {} };
    for (const c of CLASSES) {
        surface.zhIds[c.key] = 0;
        surface.enIds[c.key] = 0;
    }
    const findings = [];
    const seenZh = {};
    const seenEn = {};
    for (const c of CLASSES) {
        seenZh[c.key] = new Set();
        seenEn[c.key] = new Set();
    }
    const readOrNote = (dir, name, side) => {
        const abs = path.join(dir, name);
        const res = readTextSafe(abs);
        if (res.ok) return res.text;
        noteInput(`${side} 侧 ${name} 读取失败（${res.error}）⇒ 该篇未参与判据，本轮不得读成「0 命中」`, abs);
        return null;
    };

    for (const name of paired) {
        const zhText = readOrNote(zhDir, name, "zh");
        const enText = readOrNote(enDir, name, "en");
        if (zhText === null || enText === null) continue;
        surface.zhSpans += countCodeSpans(zhText);
        surface.enSpans += countCodeSpans(enText);
        const zh = extractIds(zhText);
        const en = extractIds(enText);
        for (const c of CLASSES) {
            for (const id of zh[c.key]) seenZh[c.key].add(id);
            for (const id of en[c.key]) seenEn[c.key].add(id);
            const onlyZh = [...zh[c.key]].filter((id) => !en[c.key].has(id));
            const onlyEn = [...en[c.key]].filter((id) => !zh[c.key].has(id));
            if (onlyZh.length) findings.push({ kind: "asymmetry", file: name, class: c.key, side: "zh", ids: onlyZh });
            if (onlyEn.length) findings.push({ kind: "asymmetry", file: name, class: c.key, side: "en", ids: onlyEn });
        }
        const heads = compareHeadings(name, zhText, enText, findings);
        surface.headingZh += heads.zh;
        surface.headingEn += heads.en;
    }
    // task-73（a）：单边篇不再被丢掉。它们没有对侧可做对称差（missingOnEn/missingOnZh 是既有口径），
    // 但**编号登记面**照样适用于它们 —— 旧实现连它们的 D/PLAN 号都不收，等于「从没扫过」。
    for (const name of missingOnEn) {
        const t = readOrNote(zhDir, name, "zh");
        if (t === null) continue;
        surface.zhSpans += countCodeSpans(t);
        const z = extractIds(t);
        for (const c of CLASSES) for (const id of z[c.key]) seenZh[c.key].add(id);
        // task-73（a）：单边篇本身就是 E 级命中 —— 门自称覆盖全部册，实际只有这一侧可读，
        // 对侧的对称差与标题对拍**没有对象**。旧实现把它当成「不存在的篇」直接跳过 ⇒ 口径谎报。
        findings.push({ kind: "unpaired", severity: "E", file: name, side: "zh", note: UNPAIRED_NOTE });
    }
    for (const name of missingOnZh) {
        const t = readOrNote(enDir, name, "en");
        if (t === null) continue;
        surface.enSpans += countCodeSpans(t);
        const eIds = extractIds(t);
        for (const c of CLASSES) for (const id of eIds[c.key]) seenEn[c.key].add(id);
        findings.push({ kind: "unpaired", severity: "E", file: name, side: "en", note: UNPAIRED_NOTE });
    }
    for (const c of CLASSES) {
        surface.zhIds[c.key] = seenZh[c.key].size;
        surface.enIds[c.key] = seenEn[c.key].size;
    }

    const planLandings = collectPlanLandings(path.join(workspace, "plans"), new Set(), 0, errors);
    const decisions = collectDecisionLandings(path.join(workspace, "internal", "A03-xihe", "docs"), errors);
    const registryReadable = !errors.some((e) => e.source === "registry");
    let suppression = "";
    if (registryReadable) {
        const missingPlan = [...new Set([...seenZh.PLAN, ...seenEn.PLAN])].filter((id) => !planLandings.has(id)).sort();
        const missingD = [...new Set([...seenZh.D, ...seenEn.D])].filter((id) => !decisions.effective.has(id)).sort();
        for (const id of missingPlan) findings.push({ kind: "unregistered", class: "PLAN", ids: [id], hint: "" });
        for (const id of missingD) {
            findings.push({
                kind: "unregistered",
                class: "D",
                ids: [id],
                hint: decisions.ops.has(id)
                    ? "仅在 lead-ledger.md（操作台账）出现 ⇒ 疑似错册登记（docs §1.1 实证：D-775～786 同类）"
                    : "",
            });
        }
    } else {
        // task-73（b）：登记面源缺失时**必须抑制**由空登记面产生的 unregistered 假红（否则 300+ 条噪音淹没那条 E）。
        suppression = "登记面源缺失（见 errors）⇒ 本轮登记面判据停用：这不是「登记面全绿」，也不是「全部号未登记」";
    }

    return {
        surface,
        findings,
        errors,
        suppression,
        registry: {
            plans: planLandings.size,
            decisionMain: decisions.main.size,
            decisionArchive: decisions.archive.size,
            decisionOps: decisions.ops.size,
            opsFilePresent: decisions.opsFilePresent,
            registryReadable,
        },
        missingOnEn,
        missingOnZh,
        dirs: { workspace, i18nRoot, plans: path.join(workspace, "plans") },
    };
}

function render(result) {
    const lines = [];
    lines.push(
        `[dev-i18n-drift] 作用域根 ${result.dirs.workspace} ｜ cwd ${process.cwd()} ｜ 册数 zh ${result.surface.zhFiles} · en ${result.surface.enFiles} · 配对 ${result.surface.pairedFiles}`,
    );
    lines.push(
        `[dev-i18n-drift] 扫描面：配对文档 ${result.surface.pairedFiles} 篇；en 缺篇 ${result.surface.missingOnEn} 篇 / zh 缺篇 ${result.surface.missingOnZh} 篇` +
            `（单边篇报 E 并进登记面存在性；对称差与标题对拍在它们身上不适用）` +
            `${result.surface.missingOnEn ? "｜ en 缺篇：" + result.missingOnEn.slice(0, 8).join(", ") + (result.surface.missingOnEn > 8 ? " …" : "") : ""}` +
            `${result.surface.missingOnZh ? "｜ zh 缺篇：" + result.missingOnZh.slice(0, 8).join(", ") + (result.surface.missingOnZh > 8 ? " …" : "") : ""}`,
    );
    lines.push(
        `[dev-i18n-drift] 代码跨度：zh ${result.surface.zhSpans} 个 / en ${result.surface.enSpans} 个；` +
            `编号抽取 zh PLAN ${result.surface.zhIds.PLAN} · D ${result.surface.zhIds.D} · task ${result.surface.zhIds.task} ｜ ` +
            `en PLAN ${result.surface.enIds.PLAN} · D ${result.surface.enIds.D} · task ${result.surface.enIds.task}`,
    );
    lines.push(
        `[dev-i18n-drift] 小节标题对拍：zh ${result.surface.headingZh} 条 / en ${result.surface.headingEn} 条（同层内签名相同即配对；两侧无签名按顺序互相抵消）`,
    );
    lines.push(
        `[dev-i18n-drift] 登记面：plans 落点 ${result.registry.plans} 个 PLAN 号（含 archive，文件+目录）；` +
            `台账主册 ${result.registry.decisionMain} 个 D 号 + 归档卷 ${result.registry.decisionArchive} 个` +
            `（操作台账 lead-ledger.md ${result.registry.opsFilePresent ? "存在，另有 " + result.registry.decisionOps + " 个 D 号，**不算登记面**，只作错册提示" : "**已退役、文件不存在** ⇒ 「错册登记」提示本轮无对象（旧版渲染成「另有 0 个」，读起来像已核过）"}）`,
    );
    // task-73：E 级输入缺失必须**显式**打印，否则 report-only 的 exit 0 会被读成「扫过了」
    if (result.errors.length) {
        lines.push(`[dev-i18n-drift] E 级输入缺失 ${result.errors.length} 条（本轮判据**不完整**，不得读成「0 命中」）：`);
        for (const e of result.errors) lines.push(`  E ${e.code} · ${e.detail}`);
    }
    if (result.suppression) lines.push(`[dev-i18n-drift] ${result.suppression}`);
    if (!result.findings.length) {
        lines.push("[dev-i18n-drift] 命中 0 处（作用域根 " + result.dirs.workspace + "；判据：编号对称差 + 登记面存在性 + 小节标题对拍；盲区见下，0 处只在这条作用域内成立）");
    } else {
        lines.push(`[dev-i18n-drift] 命中 ${result.findings.length} 处（其中 E 级单边篇 ${result.findings.filter((f) => f.severity === "E").length} 处）：`);
        let n = 0;
        for (const f of result.findings) {
            n += 1;
            if (f.kind === "unpaired") {
                lines.push(`  ${n}. [E] 单边篇 · ${f.file} · 仅 ${f.side} 有 ⇒ 对称差与标题对拍在这一篇上无对象（E 级覆盖缺口，非 W 级措辞差异）`);
            } else if (f.kind === "asymmetry") {
                lines.push(`  ${n}. 中英不对称 · ${f.file} · ${f.class} · 仅 ${f.side} 有：${f.ids.join(", ")}`);
            } else if (f.kind === "headingAsymmetry") {
                lines.push(`  ${n}. 小节标题分叉 · ${f.file} · H${f.level} · 仅 ${f.side} 有 ${f.titles.length} 条：「${f.titles.join("」「")}」`);
            } else {
                lines.push(`  ${n}. 登记面缺失 · ${f.class} · ${f.ids.join(", ")}（plans/ 或台账里找不到落点）${f.hint ? " —— " + f.hint : ""}`);
            }
        }
    }
    lines.push(...BLIND_SPOTS);
    return lines.join(LF_CH);
}

// ────────────────────────────── selftest ──────────────────────────────
function makeFixture(root) {
    const a03 = path.join(root, "A03-xihe");
    const zh = path.join(a03, "docs/i18n/zh-Hans");
    const en = path.join(a03, "docs/i18n/en");
    fs.mkdirSync(zh, { recursive: true });
    fs.mkdirSync(en, { recursive: true });
    fs.mkdirSync(path.join(root, "plans/PLAN-0099-fixture"), { recursive: true });
    fs.mkdirSync(path.join(root, "plans/archive/20260101"), { recursive: true });
    // task-314 的坑：归档里老计划是**单文件**，必须也算落点
    fs.writeFileSync(path.join(root, "plans/archive/20260101/PLAN-0088-legacy.md"), "# legacy\n", "utf8");
    const docs = path.join(root, "internal/A03-xihe/docs");
    fs.mkdirSync(path.join(docs, "archive"), { recursive: true });
    fs.writeFileSync(
        path.join(docs, "lead-decisions-ledger.md"),
        "### D-0002 main volume\n\ntext\n",
        "utf8",
    );
    fs.writeFileSync(
        path.join(docs, "archive/lead-decisions-2026-01-01-x.md"),
        "### D-0001 archive volume\n",
        "utf8",
    );
    const write = (dir, name, body) => fs.writeFileSync(path.join(dir, name), body, "utf8");
    // 干净对：两侧编号与登记面都齐
    write(zh, "T1.md", "见 `PLAN-0099` / `D-0002` / `D-0001` / `task-7`。\n");
    write(en, "T1.md", "See `PLAN-0099` / `D-0002` / `D-0001` / `task-7`.\n");
    // 不对称对：zh 多一个 D-0002（en 缺）
    write(zh, "T2.md", "`D-0002` 裁定。\n");
    write(en, "T2.md", "no citation here.\n");
    // 未登记对：PLAN-8888 / D-7777 都不存在
    write(zh, "T3.md", "`PLAN-8888` 与 `D-7777`。\n");
    write(en, "T3.md", "`PLAN-8888` and `D-7777`.\n");
    // 单边篇（en 缺篇）
    write(zh, "Z9.md", "只在 zh 有。\n");
    return { root, a03, zh, en };
}

function runSelftest() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-i18n-drift-selftest-"));
    const fx = makeFixture(root);
    const cases = [];
    const check = (name, ok, detail = "") => cases.push({ name, ok, detail });

    try {
        // 1) 干净对不报
        fs.writeFileSync(path.join(fx.en, "T2.md"), "`D-0002` ruling.\n", "utf8");
        fs.writeFileSync(path.join(fx.zh, "T3.md"), "见 `PLAN-0099`。\n", "utf8");
        fs.writeFileSync(path.join(fx.en, "T3.md"), "See `PLAN-0099`.\n", "utf8");
        const clean = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "1 全干净 ⇒ 除单边篇 Z9 外 0 命中",
            !clean.findings.some((f) => f.kind !== "unpaired"),
            JSON.stringify(clean.findings),
        );

        // 2) zh 有、en 缺 D-0002 ⇒ 报「仅 zh」
        fs.writeFileSync(path.join(fx.en, "T2.md"), "no citation here.\n", "utf8");
        const asym = scan({ workspace: fx.root, a03: fx.a03 });
        const asymHit = asym.findings.find((f) => f.kind === "asymmetry" && f.file === "T2.md" && f.class === "D");
        check("2 zh 有 en 缺 ⇒ 报仅 zh", Boolean(asymHit) && asymHit.side === "zh" && asymHit.ids.includes("D-0002"), JSON.stringify(asym.findings));

        // 3) en 有、zh 缺 ⇒ 报「仅 en」
        fs.writeFileSync(path.join(fx.en, "T2.md"), "`D-0002` ruling.\n", "utf8");
        fs.writeFileSync(path.join(fx.zh, "T2.md"), "无引用。\n", "utf8");
        const asym2 = scan({ workspace: fx.root, a03: fx.a03 });
        const enHit = asym2.findings.find((f) => f.kind === "asymmetry" && f.file === "T2.md" && f.side === "en");
        check("3 en 有 zh 缺 ⇒ 报仅 en", Boolean(enHit) && enHit.ids.includes("D-0002"), JSON.stringify(asym2.findings));

        // 4) 未登记 PLAN ⇒ 报
        fs.writeFileSync(path.join(fx.zh, "T3.md"), "`PLAN-8888`。\n", "utf8");
        fs.writeFileSync(path.join(fx.en, "T3.md"), "`PLAN-8888`.\n", "utf8");
        const badPlan = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "4 未登记 PLAN ⇒ 报 unregistered",
            badPlan.findings.some((f) => f.kind === "unregistered" && f.ids.includes("PLAN-8888")),
            JSON.stringify(badPlan.findings),
        );

        // 5) 未登记 D ⇒ 报
        fs.writeFileSync(path.join(fx.zh, "T3.md"), "`PLAN-0099` 与 `D-7777`。\n", "utf8");
        fs.writeFileSync(path.join(fx.en, "T3.md"), "`PLAN-0099` and `D-7777`.\n", "utf8");
        const badD = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "5 未登记 D ⇒ 报 unregistered",
            badD.findings.some((f) => f.kind === "unregistered" && f.ids.includes("D-7777")),
            JSON.stringify(badD.findings),
        );

        // 6) task-314 的坑：归档里**单文件** PLAN-0088 必须算落点
        fs.writeFileSync(path.join(fx.zh, "T3.md"), "`PLAN-0088`。\n", "utf8");
        fs.writeFileSync(path.join(fx.en, "T3.md"), "`PLAN-0088`.\n", "utf8");
        const archivedFile = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "6 归档单文件 PLAN 算落点",
            !archivedFile.findings.some((f) => f.kind === "unregistered" && f.ids.includes("PLAN-0088")),
            JSON.stringify(archivedFile.findings),
        );

        // 7) 归档 D 号卷也算落点
        fs.writeFileSync(path.join(fx.zh, "T3.md"), "`D-0001`。\n", "utf8");
        fs.writeFileSync(path.join(fx.en, "T3.md"), "`D-0001`.\n", "utf8");
        const archivedD = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "7 归档台账卷 D 号算落点",
            !archivedD.findings.some((f) => f.kind === "unregistered" && f.ids.includes("D-0001")),
            JSON.stringify(archivedD.findings),
        );

        // 8) 扫描面必须打印（分母：token 数与编号数）
        const text = render(archivedD);
        check("8 打印扫描面（含分母）", /扫描面/.test(text) && /代码跨度/.test(text) && /编号抽取/.test(text), text.slice(0, 200));

        // 9) 盲区段必须原样打印
        check("9 打印盲区自白", text.includes("盲区（本工具结构上不覆盖") && text.includes("负向陈述"), text.slice(-200));

        // 10) task-88：无 token 的小节标题两侧**只是翻译不同**（条数相同）⇒ 不许误报
        fs.writeFileSync(path.join(fx.zh, "T4.md"), "## 章" + LF_CH + LF_CH + "### 可发现性例外" + LF_CH + LF_CH + "正文。" + LF_CH, "utf8");
        fs.writeFileSync(path.join(fx.en, "T4.md"), "## Chapter" + LF_CH + LF_CH + "### Discoverability exception" + LF_CH + LF_CH + "Text." + LF_CH, "utf8");
        const renamed = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "10 无 token 标题只是改写译文 ⇒ 不报（不误伤翻译）",
            !renamed.findings.some((f) => f.kind === "headingAsymmetry" && f.file === "T4.md"),
            JSON.stringify(renamed.findings.filter((f) => f.kind === "headingAsymmetry")),
        );

        // 11) task-88 主案：en 侧整节消失且该节**不含任何 token** ⇒ 必须报，并附标题原文
        fs.writeFileSync(path.join(fx.en, "T4.md"), "## Chapter" + LF_CH + LF_CH + "Text." + LF_CH, "utf8");
        const lost = scan({ workspace: fx.root, a03: fx.a03 });
        const lostHit = lost.findings.find((f) => f.kind === "headingAsymmetry" && f.file === "T4.md" && f.side === "zh");
        check(
            "11 en 少一整节无 token 标题 ⇒ 报并给原文",
            Boolean(lostHit) && lostHit.titles.includes("可发现性例外"),
            JSON.stringify(lost.findings.filter((f) => f.kind === "headingAsymmetry")),
        );

        // 12) 读数首行必须带作用域根 / cwd / 册数（不带作用域的 0 问题不算数）
        const firstLine = render(lost).split(LF_CH)[0];
        check(
            "12 首行含作用域根 + cwd + 册数",
            firstLine.includes("作用域根") && firstLine.includes("cwd") && firstLine.includes("册数"),
            firstLine,
        );

        // 13) task-73 (a) 正：**单边篇必须报 E 级**（旧实现把它当「不存在的篇」直接跳过 ⇒ 自称覆盖 33 篇实际扫 19 篇）
        fs.rmSync(path.join(fx.en, "T5.md"), { force: true });
        fs.writeFileSync(path.join(fx.zh, "T5.md"), "仅 zh 有，引用已登记的 `D-0002`。" + LF_CH, "utf8");
        const sideOnly = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "13 单边篇（仅 zh）⇒ E_UNPAIRED_DOC",
            sideOnly.findings.some((f) => f.kind === "unpaired" && f.severity === "E" && f.file === "T5.md"),
            JSON.stringify(sideOnly.errors),
        );

        // 14) task-73 (a) 反：单边篇**不进对称差 / 不报未登记**（它没有对侧，且编号已登记 ⇒ 不许借单边篇造噪音）
        check(
            "14 单边篇不产生对称差与 unregistered 噪音",
            !sideOnly.findings.some((f) => f.file === "T5.md" && f.kind !== "unpaired"),
            JSON.stringify(sideOnly.findings),
        );

        // 15) task-73 (a) 正：单边篇里的**未登记** D 号照样要进登记面判据（旧实现连读都不读）
        fs.writeFileSync(path.join(fx.zh, "T5.md"), "仅 zh 有，且 `D-8888` 未登记。" + LF_CH, "utf8");
        const sideOnlyUnreg = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "15 单边篇的未登记 D 号必须报",
            sideOnlyUnreg.findings.some((f) => f.kind === "unregistered" && f.class === "D" && f.ids.includes("D-8888")) &&
                sideOnlyUnreg.findings.some((f) => f.kind === "unpaired" && f.file === "T5.md"),
            JSON.stringify(sideOnlyUnreg.findings),
        );

        // 16) task-73 (b) 正：台账主册缺失 ⇒ E 级，且**必须抑制**由空登记面产生的 unregistered 假红
        const mainLedger = path.join(fx.root, "internal/A03-xihe/docs/lead-decisions-ledger.md");
        const mainLedgerBody = fs.readFileSync(mainLedger, "utf8");
        fs.rmSync(mainLedger, { force: true });
        const noLedger = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "16 主册缺失 ⇒ E_INPUT_MISSING 且不产生 unregistered 假红",
            noLedger.errors.some((e) => e.code === "E_INPUT_MISSING") &&
                !noLedger.findings.some((f) => f.kind === "unregistered") &&
                Boolean(noLedger.suppression),
            JSON.stringify(noLedger.errors) + " / findings " + JSON.stringify(noLedger.findings),
        );
        fs.writeFileSync(mainLedger, mainLedgerBody, "utf8");

        // 17) task-73 (b) 正：plans/ 目录缺失同样 E 级，且抑制 PLAN 假红
        const plansDir = path.join(fx.root, "plans");
        fs.renameSync(plansDir, path.join(fx.root, "plans-bak"));
        const noPlans = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "17 plans 目录缺失 ⇒ E 且不产生 PLAN 假红",
            noPlans.errors.some((e) => e.code === "E_INPUT_MISSING") &&
                noPlans.errors.some((e) => e.source === "registry" && e.detail.includes("plans")) &&
                !noPlans.findings.some((f) => f.kind === "unregistered" && f.class === "PLAN"),
            JSON.stringify(noPlans.errors),
        );
        fs.renameSync(path.join(fx.root, "plans-bak"), plansDir);

        // 18) task-73 (c) 正：读取失败收成 E，且**已算出的 findings 不许丢**（旧实现裸 throw ⇒ 整轮崩）
        const badDir = path.join(fx.zh, "T6.md");
        fs.mkdirSync(badDir, { recursive: true });
        fs.writeFileSync(path.join(fx.en, "T6.md"), "paired only on en side." + LF_CH, "utf8");
        const readFail = scan({ workspace: fx.root, a03: fx.a03 });
        check(
            "18 读取失败 ⇒ E 级且不丢 findings",
            readFail.errors.some((e) => e.detail.includes("读取失败")) && readFail.findings.length > 0,
            JSON.stringify(readFail.errors) + " / findings " + JSON.stringify(readFail.findings),
        );
        fs.rmSync(badDir, { recursive: true, force: true });

        // 19) task-73 反：**可读输入不许误报 E_INPUT_MISSING**（夹具里本来就有一侧独有篇，那是 E_UNPAIRED_DOC，不是输入缺失）。
        // 读数还必须显式打印 E 段（有 E 时）/ 单边篇计数 / ops 台账存在性，否则 exit 0 会被读成「扫过了」。
        const cleanAll = scan({ workspace: fx.root, a03: fx.a03 });
        const cleanText = render(cleanAll);
        const readFailText = render(readFail);
        check(
            "19 可读输入无 E_INPUT_MISSING，且读数打印单边篇 / E 段 / ops 台账存在性",
            !cleanAll.errors.some((e) => e.code === "E_INPUT_MISSING") && readFailText.includes("E 级输入缺失") &&
                cleanText.includes("zh 缺篇") && cleanText.includes("en 缺篇") && cleanText.includes("已退役、文件不存在"),
            cleanText.split(LF_CH).slice(1, 4).join(" | "),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    const failed = cases.filter((c) => !c.ok);
    for (const c of cases) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `  ← ${c.detail}`}`);
    console.log(`[selftest] ${cases.length - failed.length}/${cases.length} 通过`);
    process.exit(failed.length ? 1 : 0);
}

// ────────────────────────────── main ──────────────────────────────
try {
    if (selftest) runSelftest();
    const argRoot = process.argv.find((a) => a.startsWith("--workspace="));
    const workspace = argRoot ? path.resolve(argRoot.slice("--workspace=".length)) : DEFAULT_WORKSPACE;
    const a03 = path.join(workspace, "A03-xihe");
    const result = scan({ workspace, a03 });
    if (asJson) {
        console.log(JSON.stringify({ ...result, findings: result.findings }, null, 4));
    } else {
        console.log(render(result));
    }
    // task-73：输入缺失 ⇒ exit 2（E_INPUT_MISSING 就是「本轮判据不完整」的红）。旧实现一律 exit 0，
    // report-only 的 0 会把「没扫到」读成「扫过且干净」。
    // task-73：**输入缺失（E_INPUT_MISSING）= 判据不完整 ⇒ exit 2**；单边篇这类「可判定的真缺口」进 findings，
    // 走 report-only（exit 0）/ --enforce（exit 1）的老口径。
    // 理由：把真缺口塞进 exit 2 会让这条门在真树上恒红，恒红的门必被绕过（D-1046）。
    if (result.errors.length) process.exit(2);
    if (enforce && result.findings.length) process.exit(1);
    process.exit(0);
} catch (e) {
    console.error(`[dev-i18n-drift] 内部错误：${e.message}`);
    process.exit(2);
}
