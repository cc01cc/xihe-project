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
 *   3. **D 登记面**：`D-NNNN` 必须在台账主册有 `### D-NNNN` 标题，或在归档 D 号卷里出现过。
 *
 * 盲区（**本工具结构上不覆盖**，输出里会原样打印，别以为它全覆盖）
 *   a. **负向陈述**：「已删除 / 未落地 / 无 X」这类句子 —— 任何存在性检查都会把"正确地不存在"判成缺陷
 *      （`DEV-010` 实测 5/5 假阳性：`NavRail.vue`、`S1SettingsAfter.vue`、`workspace-nav`、`list-pane`）；
 *   b. **运行态 task 卡**：`task-NNNN` 的登记面是运行中的团队板（`team_task_list`），静态仓库没有权威清单
 *      ⇒ 本脚本只做中英对称差，**不判 task 号是否存在**（"查不到"≠"不存在"）；
 *   c. **相对子路由**：文档里的 `chat/:sessionId` 这类子路由要拼父级 `path:` 才成立，本脚本不解析路由
 *      ⇒ 任何"路径是否存在"的机械检查在这里都会大比例假阳性（实测 8/12）；
 *   d. **不在判据内**：组件名 / `data-testid` / CSS 类 / 参数值域 / 路由表 —— 这些只能人读或另立专用门。
 *
 * 用法
 *   node scripts/check-dev-i18n-drift.mjs                # report-only：有命中仍 exit 0，只打印
 *   node scripts/check-dev-i18n-drift.mjs --json         # 机器可读
 *   node scripts/check-dev-i18n-drift.mjs --enforce      # 有命中 exit 1（**手工用；绝对不要接 validate**）
 *   node scripts/check-dev-i18n-drift.mjs --selftest     # 夹具自测，不起任何外部依赖
 * 退出码：0 = 扫过（report-only 命中也是 0）；1 = `--enforce` 且有命中；2 = 内部错误/路径不可读。
 *
 * **不许接 `validate.depends`**（task-316 明写）：一条会被绕过的红门等于没有门（`D-1046`）。
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
    "  c. 相对子路由：`chat/:sessionId` 需拼父级 `path:`，本工具不解析路由 ⇒ 路径存在性检查实测 8/12 假阳；",
    "  d. 不覆盖：组件名 / data-testid / CSS 类 / 参数值域 / 路由表（这些只能人读或另立专用门）。",
    "  e. 登记面取「出现过」而非「被定义为条目」：正文顺带提一句也算已登记 ⇒ 会漏掉「从未定义、只被引用」的号；",
];

function readText(file) {
    return fs.readFileSync(file, "utf8");
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

/** 递归收集 `plans/` 下所有以 PLAN-NNNN 开头的**文件或目录**（含 `plans/archive/` —— task-314 的坑）。 */
function collectPlanLandings(plansDir, out = new Set(), depth = 0) {
    if (!fs.existsSync(plansDir) || depth > 4) return out;
    for (const entry of fs.readdirSync(plansDir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const m = /^PLAN-(\d{4})/u.exec(entry.name);
        if (m) out.add(`PLAN-${m[1]}`);
        if (entry.isDirectory()) collectPlanLandings(path.join(plansDir, entry.name), out, depth + 1);
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
function collectDecisionLandings(docsDir) {
    const main = new Set();
    const archive = new Set();
    const mainFile = path.join(docsDir, "lead-decisions-ledger.md");
    const collect = (text, into) => {
        for (const m of text.matchAll(/(?:^|[^A-Za-z])D-(\d{3,4})(?!\d)/gmu)) into.add(`D-${m[1]}`);
    };
    if (fs.existsSync(mainFile)) collect(readText(mainFile), main);
    const archiveDir = path.join(docsDir, "archive");
    if (fs.existsSync(archiveDir)) {
        for (const name of fs.readdirSync(archiveDir)) {
            if (!/^lead-decisions.*\.md$/u.test(name)) continue;
            collect(readText(path.join(archiveDir, name)), archive);
        }
    }
    // 操作台账（`lead-ledger.md`）：不属登记面，但历史上确有裁定写在错册（docs §1.1 有实证）
    const opsFile = path.join(docsDir, "lead-ledger.md");
    const ops = new Set();
    if (fs.existsSync(opsFile)) collect(readText(opsFile), ops);
    return { main, archive, ops, effective: new Set([...main, ...archive]) };
}

function scan({ workspace, a03 }) {
    const i18nRoot = path.join(a03, "docs", "i18n");
    const zhDir = path.join(i18nRoot, "zh-Hans");
    const enDir = path.join(i18nRoot, "en");
    if (!fs.existsSync(zhDir) || !fs.existsSync(enDir)) {
        throw new Error(`i18n 目录不可读：${zhDir} / ${enDir}`);
    }
    const zhFiles = fs.readdirSync(zhDir).filter((n) => n.endsWith(".md")).sort();
    const enFiles = new Set(fs.readdirSync(enDir).filter((n) => n.endsWith(".md")));
    const missingOnEn = zhFiles.filter((n) => !enFiles.has(n));
    const paired = zhFiles.filter((n) => enFiles.has(n));

    const surface = { pairedFiles: paired.length, missingOnEn: missingOnEn.length, zhSpans: 0, enSpans: 0, zhIds: {}, enIds: {} };
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

    for (const name of paired) {
        const zhText = readText(path.join(zhDir, name));
        const enText = readText(path.join(enDir, name));
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
    }
    for (const c of CLASSES) {
        surface.zhIds[c.key] = seenZh[c.key].size;
        surface.enIds[c.key] = seenEn[c.key].size;
    }

    const planLandings = collectPlanLandings(path.join(workspace, "plans"));
    const decisions = collectDecisionLandings(path.join(workspace, "internal", "A03-xihe", "docs"));
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

    return {
        surface,
        findings,
        registry: {
            plans: planLandings.size,
            decisionMain: decisions.main.size,
            decisionArchive: decisions.archive.size,
            decisionOps: decisions.ops.size,
        },
        missingOnEn,
        dirs: { i18nRoot, plans: path.join(workspace, "plans") },
    };
}

function render(result) {
    const lines = [];
    lines.push(
        `[dev-i18n-drift] 扫描面：配对文档 ${result.surface.pairedFiles} 篇；en 缺篇 ${result.surface.missingOnEn} 篇` +
            `${result.surface.missingOnEn ? "（" + result.missingOnEn.slice(0, 8).join(", ") + (result.surface.missingOnEn > 8 ? " …" : "") + "）" : ""}`,
    );
    lines.push(
        `[dev-i18n-drift] 代码跨度：zh ${result.surface.zhSpans} 个 / en ${result.surface.enSpans} 个；` +
            `编号抽取 zh PLAN ${result.surface.zhIds.PLAN} · D ${result.surface.zhIds.D} · task ${result.surface.zhIds.task} ｜ ` +
            `en PLAN ${result.surface.enIds.PLAN} · D ${result.surface.enIds.D} · task ${result.surface.enIds.task}`,
    );
    lines.push(
        `[dev-i18n-drift] 登记面：plans 落点 ${result.registry.plans} 个 PLAN 号（含 archive，文件+目录）；` +
            `台账主册 ${result.registry.decisionMain} 个 D 号 + 归档卷 ${result.registry.decisionArchive} 个` +
            `（操作台账 lead-ledger.md 另有 ${result.registry.decisionOps} 个，**不算登记面**，只作错册提示）`,
    );
    if (!result.findings.length) {
        lines.push("[dev-i18n-drift] 命中 0 处（判据：编号对称差 + 登记面存在性；盲区见下）");
    } else {
        lines.push(`[dev-i18n-drift] 命中 ${result.findings.length} 处：`);
        let n = 0;
        for (const f of result.findings) {
            n += 1;
            if (f.kind === "asymmetry") {
                lines.push(
                    `  ${n}. 中英不对称 · ${f.file} · ${f.class} · 仅 ${f.side} 有：${f.ids.join(", ")}`,
                );
            } else {
                lines.push(`  ${n}. 登记面缺失 · ${f.class} · ${f.ids.join(", ")}（plans/ 或台账里找不到落点）${f.hint ? " —— " + f.hint : ""}`);
            }
        }
    }
    lines.push(...BLIND_SPOTS);
    return lines.join("\n");
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
        check("1 全干净 ⇒ 0 命中", clean.findings.length === 0, JSON.stringify(clean.findings));

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
    if (enforce && result.findings.length) process.exit(1);
    process.exit(0);
} catch (e) {
    console.error(`[dev-i18n-drift] 内部错误：${e.message}`);
    process.exit(2);
}
