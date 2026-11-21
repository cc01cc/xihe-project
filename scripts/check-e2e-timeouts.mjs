#!/usr/bin/env node
// task-252: E2E timeout budget gate（task-237 扩面：deadline 式等待预算也进门）。
//
// User ruling 2026-11-08: E2E waits are budgeted — action/assertion ≤10 s, test ≤30 s; anything
// above 10 s must say why it is exempt (`// timeout-exempt: <reason>` on the same or previous
// line) and an exemption may never exceed 60 s. 240 s/300 s literals are bugs masking slowness,
// not waits (a fallback toggle burned a full 240 s doing nothing in the 0691 T1.7 window).
//
// **本门只判「等待预算有没有出处」，不判「这个出处合不合理」**：
// 门能做到的是「每个 >10 s 的等待要么引用 SSOT 常量、要么写明豁免理由」；
// 它无法判断「180 s 是不是太长」——过了门不等于超时设计没问题。
//
// 扫描三类形态（task-237）：
//   ① `timeout: <literal>` / `test.setTimeout(<literal>)`            —— 原口径
//   ② `Date.now() + <literal>` / `performance.now() + <literal>`     —— deadline 式等待预算
//   ③ `Date.now() + <常量表达式>`                                    —— 合法出口，计入 declared（不判红）
// 但 ② 有两个必须排除的形态：
//   · **夹具时间戳**：`expiresAt: new Date(Date.now() + 5 * 60_000)` 是造数据，不是等（判红就是假红）
//   · ≤10 s 的短等待：与 ① 同一口径（`ACTION_CAP_MS`）
// 注意：正则是**按源码文本**匹配的 ⇒ 注释里写 `Date.now() + 180_000` 也会命中（task-236 实测教训：
// 有人在注释里举例，门就红在那行）。这是有意为之 —— 注释里的示例会被下一个人复制成代码。
//
// task-133 扩面：`waitForTimeout(` **调用形态**判据（`packages/ui/AGENTS.md:125`「新 E2E 禁止固定 sleep/waitForTimeout」）。
// 此前本脚本只匹配 `timeout:`/`test.setTimeout(`/`Date.now()+字面量`，`waitForTimeout` 命中 0 ⇒ 禁令没有门。
// 判据：扫 `packages/ui/e2e/**/*.{ts,mjs}`，先用 `maskSource`（复用 `check-e2e-inpage-bypass.mjs` 的注释/字符串
// 掩码，保留换行与列宽）剥掉注释与字符串，再匹配 `\bwaitForTimeout\s*\(` —— 注释里写「禁 waitForTimeout(」不算命中。
// 存量走 `config/e2e-fixed-wait-baseline.json`，**只许降**且必须与现实精确对账（双向 ratchet）：
//   · 有调用但基线没登记 ⇒ 红（点名 file:line）—— 新增固定等待必须显式登记并给理由；
//   · 基线有条目但代码里已无对应调用 ⇒ 红 —— 死条目会掩盖回归，必须同批删除。
// 基线按 `file + 掩码后整行签名` 匹配（不按行号），行号漂移不会假红。
// 自检：`node scripts/check-e2e-timeouts.mjs --selftest`
// 重建/下调基线：`node scripts/check-e2e-timeouts.mjs --write-fixed-wait-baseline [--reason <为什么>]`
//   （拒绝对新增调用静默抬高：新增条目必须给 `--reason`，否则 exit 2）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maskSource } from "./check-e2e-inpage-bypass.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const E2E_DIR = path.join(ROOT, "packages/ui/e2e");
const ACTION_CAP_MS = 10_000;
const EXEMPT_CAP_MS = 60_000;
const EXEMPT = /\/\/\s*timeout-exempt:\s*(.+)/;

/** task-133：存量固定等待基线（只许降）。 */
const FIXED_WAIT_BASELINE = path.join(ROOT, "config/e2e-fixed-wait-baseline.json");
const FIXED_WAIT_CALL = /\bwaitForTimeout\s*\(/g;
const FIXED_WAIT_TEST = /\bwaitForTimeout\s*\(/;
const DEFAULT_FIXED_WAIT_REASON = "grandfathered 2026-11-22 (task-133)：存量固定等待，只许降；归零后删除条目";
/** 超时预算门维持原扫描面（.ts）；固定等待门必须含 .mjs（preview/fixture 脚本里也有真调用）。 */
const TIMEOUT_EXTS = new Set([".ts"]);
const FIXED_WAIT_EXTS = new Set([".ts", ".mjs"]);

/** ① timeout:/setTimeout( 字面量；② Date.now()/performance.now() + 字面量；③ 同左但右侧是常量表达式。 */
const LITERAL_TIMEOUT = /(?:timeout:|test\.setTimeout\()\s*(\d[\d_]*)/g;
const LITERAL_DEADLINE = /(?:Date|performance)\.now\(\)\s*\+\s*(\d[\d_]*)/g;
const DECLARED_DEADLINE = /(?:Date|performance)\.now\(\)\s*\+\s*[A-Za-z_$]/g;
/** 夹具时间戳：new Date(Date.now() + N) —— 造数据，不是等待预算。 */
const FIXTURE_TIMESTAMP = /new\s+Date\(\s*Date\.now\(\)\s*\+/;

function walk(dir, exts) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p, exts));
        else if (exts.has(path.extname(entry.name))) out.push(p);
    }
    return out;
}

/**
 * 扫一个目录，返回 { files, literals, declared, offenders }。
 *
 * <p>offenders 是字符串数组（已含 `rel:line` 与原因）；declared 是「引用了 SSOT 常量」的处数，
 * 只用于报告，不参与判决 —— 门只拦字面量。</p>
 */
export function scanDir(dir, rootForRel) {
    const offenders = [];
    const declared = [];
    let files;
    let literals = 0;
    try {
        files = walk(dir, TIMEOUT_EXTS);
    } catch {
        return { files: 0, literals: 0, declared, offenders: ["<目录不存在> " + dir] };
    }
    for (const file of files) {
        const rel = path.relative(rootForRel, file).split(path.sep).join("/");
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const isFixtureTimestamp = FIXTURE_TIMESTAMP.test(line);
            const found = [];
            for (const m of line.matchAll(LITERAL_TIMEOUT)) found.push({ text: m[0].trim(), value: Number(m[1].replace(/_/g, "")) });
            if (!isFixtureTimestamp) {
                for (const m of line.matchAll(LITERAL_DEADLINE)) found.push({ text: m[0].trim(), value: Number(m[1].replace(/_/g, "")) });
            }
            if (!isFixtureTimestamp && DECLARED_DEADLINE.test(line)) declared.push(`${rel}:${i + 1}`);
            for (const hit of found) {
                literals++;
                if (hit.value <= ACTION_CAP_MS) continue;
                const exempt = EXEMPT.exec(line) ?? (i > 0 ? EXEMPT.exec(lines[i - 1]) : null);
                const where = `${rel}:${i + 1}`;
                if (!exempt) {
                    offenders.push(`${where} ${hit.text} (${hit.value} ms) — no // timeout-exempt: <reason>`);
                } else if (hit.value > EXEMPT_CAP_MS) {
                    offenders.push(`${where} ${hit.text} (${hit.value} ms) — exemption exceeds ${EXEMPT_CAP_MS} ms cap`);
                }
            }
        }
    }
    return { files: files.length, literals, declared, offenders };
}

function baselineKey(file, signature) {
    return file + "\u0000" + signature;
}

/** 基线签名：掩码后整行折叠空白（注释/字符串已抹空，行号不作为匹配键）。 */
export function fixedWaitSignature(line) {
    return line.replace(/\s+/g, " ").trim();
}

/**
 * 扫 `packages/ui/e2e` 下全部 `.ts`/`.mjs` 的 `waitForTimeout(` **调用形态**。
 *
 * <p>先 `maskSource` 再匹配：注释/字符串里的 `waitForTimeout(` 不计（task-133 要求「匹配调用形态而非注释」）。
 * 掩码保留换行，所以 `line` 是原文真实行号，`code` 取原文该行便于人工定位。</p>
 */
export function scanFixedWaits(dir, rootForRel) {
    const hits = [];
    let files;
    try {
        files = walk(dir, FIXED_WAIT_EXTS);
    } catch {
        return { files: 0, hits, missing: true };
    }
    for (const file of files) {
        const rel = path.relative(rootForRel, file).split(path.sep).join("/");
        const source = fs.readFileSync(file, "utf8");
        const maskedLines = maskSource(source).split(/\r?\n/);
        const rawLines = source.split(/\r?\n/);
        for (let i = 0; i < maskedLines.length; i++) {
            const line = maskedLines[i];
            if (!FIXED_WAIT_TEST.test(line)) continue;
            FIXED_WAIT_CALL.lastIndex = 0;
            while (FIXED_WAIT_CALL.exec(line) !== null) {
                hits.push({
                    file: rel,
                    line: i + 1,
                    signature: fixedWaitSignature(line),
                    code: (rawLines[i] ?? "").trim(),
                });
            }
        }
    }
    return { files: files.length, hits, missing: false };
}

/** 读取并校验固定等待基线。缺文件/格式坏/条目缺理由 ⇒ throw（main 映射 exit 2）。 */
export function loadFixedWaitBaseline(absPath) {
    if (!fs.existsSync(absPath)) {
        throw new Error(
            `baseline 不存在：${path.relative(ROOT, absPath)}（先跑 node scripts/check-e2e-timeouts.mjs --write-fixed-wait-baseline）`,
        );
    }
    const parsed = JSON.parse(fs.readFileSync(absPath, "utf8"));
    if (!Array.isArray(parsed.entries)) throw new Error(`baseline 缺少 entries 数组：${absPath}`);
    for (const [i, entry] of parsed.entries.entries()) {
        if (!entry || typeof entry.file !== "string" || typeof entry.signature !== "string") {
            throw new Error(`baseline.entries[${i}] 缺少 file/signature`);
        }
        if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
            throw new Error(`baseline.entries[${i}] 缺少 reason（豁免必须带理由）`);
        }
    }
    return parsed;
}

/**
 * 双向 ratchet：命中与基线条目按 `file + signature` 的多重集合精确对账。
 *   · unbaselined：调用多于登记 ⇒ 新增固定等待（红，点名 file:line）；
 *   · stale：登记多于调用 ⇒ 基线条目已失效（红，必须删除，否则会掩盖回归）。
 */
export function evaluateFixedWaits({ hits, entries }) {
    const hitGroups = new Map();
    for (const hit of hits) {
        const key = baselineKey(hit.file, hit.signature);
        if (!hitGroups.has(key)) hitGroups.set(key, []);
        hitGroups.get(key).push(hit);
    }
    const entryGroups = new Map();
    for (const entry of entries) {
        const key = baselineKey(entry.file, fixedWaitSignature(entry.signature));
        if (!entryGroups.has(key)) entryGroups.set(key, []);
        entryGroups.get(key).push(entry);
    }
    const unbaselined = [];
    for (const [key, group] of hitGroups) {
        const registered = entryGroups.get(key)?.length ?? 0;
        for (let i = registered; i < group.length; i++) unbaselined.push(group[i]);
    }
    const stale = [];
    for (const [key, group] of entryGroups) {
        const actual = hitGroups.get(key)?.length ?? 0;
        for (let i = actual; i < group.length; i++) stale.push(group[i]);
    }
    return { unbaselined, stale, hitCount: hits.length, entryCount: entries.length };
}

/**
 * 重建基线（推荐用途：存量归零后下调）。**拒绝静默抬高**：新增调用必须给 `--reason`，
 * 否则 exit 2 并逐条列出 —— 基线是 review 面，不允许一条命令把新债洗成存量。
 */
export function writeFixedWaitBaseline(absPath, hits, { reason } = {}) {
    const existing = fs.existsSync(absPath) ? JSON.parse(fs.readFileSync(absPath, "utf8")) : { entries: [] };
    const existingEntries = Array.isArray(existing.entries) ? existing.entries : [];
    const existingGroups = new Map();
    const existingReasons = new Map();
    for (const entry of existingEntries) {
        const key = baselineKey(entry.file, fixedWaitSignature(entry.signature ?? ""));
        if (!existingGroups.has(key)) existingGroups.set(key, 0);
        existingGroups.set(key, existingGroups.get(key) + 1);
        if (!existingReasons.has(key) && typeof entry.reason === "string" && entry.reason.trim()) {
            existingReasons.set(key, entry.reason);
        }
    }
    const currentGroups = new Map();
    for (const hit of hits) {
        const key = baselineKey(hit.file, hit.signature);
        if (!currentGroups.has(key)) currentGroups.set(key, []);
        currentGroups.get(key).push(hit);
    }
    const added = [];
    for (const [key, group] of currentGroups) {
        const registered = existingGroups.get(key) ?? 0;
        for (let i = registered; i < group.length; i++) added.push(group[i]);
    }
    if (added.length > 0 && !(typeof reason === "string" && reason.trim())) {
        console.error(`[fixed-wait] 拒绝静默抬高基线：${added.length} 处新增调用没有 --reason`);
        for (const hit of added) console.error(`  ${hit.file}:${hit.line} ${hit.code}`);
        return { ok: false, added, stale: 0, written: 0 };
    }
    const stale = evaluateFixedWaits({ hits, entries: existingEntries }).stale;
    const seen = new Map();
    const entries = hits.map((hit) => {
        const key = baselineKey(hit.file, hit.signature);
        const index = seen.get(key) ?? 0;
        seen.set(key, index + 1);
        return {
            file: hit.file,
            line: hit.line,
            signature: hit.signature,
            reason: existingReasons.get(key) ?? reason?.trim() ?? DEFAULT_FIXED_WAIT_REASON,
        };
    });
    const now = new Date();
    const generatedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const payload = {
        $comment:
            "task-133 固定 waitForTimeout 存量基线：只许降。判据与双向 ratchet 见 scripts/check-e2e-timeouts.mjs 文件头；" +
            "匹配键 = file + 掩码后整行签名（不按行号）。新增调用必须先登记并带 reason；条目失效必须同批删除。",
        version: 1,
        generatedBy: "scripts/check-e2e-timeouts.mjs --write-fixed-wait-baseline",
        generatedAt,
        rule: "packages/ui/AGENTS.md:125 — 新 E2E 禁止固定 sleep/waitForTimeout",
        scan: "packages/ui/e2e/**/*.{ts,mjs}（注释/字符串先掩码）",
        entries,
    };
    fs.writeFileSync(absPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log(
        `[fixed-wait] wrote ${entries.length} entries to ${path.relative(ROOT, absPath)} ` +
            `(added ${added.length}, stale removed ${stale.length})`,
    );
    return { ok: true, added, stale: stale.length, written: entries.length };
}

/**
 * 自检：两红三绿（task-237 判据 ④ 与「不许误伤合法用法」）+ 固定等待门四向用例（task-133）。
 *
 * <p>为什么要「绿」的对照：扩门最容易犯的错是「扩了形态但顺手把合法写法判红」，
 * 而假红会让人给门加豁免，最后门形同废止。</p>
 */
export function selftest() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xh-timeout-gate-"));
    const cases = {
        // 红 1：真代码里的字面量等待
        "a-literal.ts": "const deadline = Date.now() + 180_000;\n",
        // 红 2：注释里的示例（门扫文本，注释不算豁免）
        "b-comment.ts": "// 例：const deadline = Date.now() + 180_000;\n",
        // 绿 1：夹具时间戳 —— 造数据不是等
        "c-timestamp.ts": "const payload = { expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };\n",
        // 绿 2：引用 SSOT 常量
        "d-declared.ts": "const deadline = Date.now() + REAL_PROVIDER_POLL_MS.catalog;\n",
        // 绿 3：≤10 s 的短等待
        "e-short.ts": "const settleDeadline = Date.now() + 3_000;\n",
        // 绿 4：原口径里带豁免的理由行（确保旧路径没被扩面改坏）
        "f-exempt.ts": "// timeout-exempt: 真实 provider 轮次\ntest.setTimeout(45_000);\n",
    };
    for (const [name, text] of Object.entries(cases)) fs.writeFileSync(path.join(dir, name), text, "utf8");
    const result = scanDir(dir, dir);
    const flagged = result.offenders.map((line) => line.split(" ")[0].split(":")[0]).sort();
    const expected = ["a-literal.ts", "b-comment.ts"];
    const declaredFiles = result.declared.map((line) => line.split(":")[0]).sort();
    fs.rmSync(dir, { recursive: true, force: true });
    const checks = [
        { name: "真代码字面量 → 红", ok: flagged.includes("a-literal.ts") },
        { name: "注释里的示例 → 红（注释不是豁免）", ok: flagged.includes("b-comment.ts") },
        { name: "夹具时间戳 new Date(Date.now()+N) → 绿（不是等待）", ok: !flagged.includes("c-timestamp.ts") },
        { name: "引用 SSOT 常量 → 绿且计入 declared", ok: !flagged.includes("d-declared.ts") && declaredFiles.includes("d-declared.ts") },
        { name: "≤10 s 短等待 → 绿", ok: !flagged.includes("e-short.ts") },
        { name: "旧口径豁免（45 s + 理由）→ 绿", ok: !flagged.includes("f-exempt.ts") },
        { name: "命中集合恰为 {a,b}（没有多判）", ok: JSON.stringify(flagged) === JSON.stringify(expected) },
    ];
    // task-133：固定等待门自检（调用形态 vs 注释/字符串、双向 ratchet）。
    const fwDir = fs.mkdtempSync(path.join(os.tmpdir(), "xh-fixed-wait-gate-"));
    const fwCases = {
        // 红：真调用
        "g-call.ts": "await page.waitForTimeout(500);\n",
        // 绿：注释里的禁令举例（调用形态门不扫注释）
        "h-comment.ts": "// 新 E2E 禁 waitForTimeout( —— 用显式 readiness\n",
        // 绿：字符串里的文本（maskSource 抹掉字符串）
        "i-string.ts": "const hint = 'waitForTimeout(500)';\n",
        // 红：.mjs 也在扫描面（preview/fixture 脚本有真调用）
        "j-call.mjs": "await page.waitForTimeout(200);\n",
    };
    for (const [name, text] of Object.entries(fwCases)) fs.writeFileSync(path.join(fwDir, name), text, "utf8");
    const fw = scanFixedWaits(fwDir, fwDir);
    const fwFiles = [...new Set(fw.hits.map((hit) => hit.file))].sort();
    const baseline = fw.hits.map((hit) => ({ file: hit.file, signature: hit.signature, reason: "selftest" }));
    const clean = evaluateFixedWaits({ hits: fw.hits, entries: baseline });
    const dropped = evaluateFixedWaits({
        hits: fw.hits,
        entries: baseline.filter((entry) => entry.file !== "g-call.ts"),
    });
    const staleEntry = { file: "g-call.ts", signature: "await page.waitForTimeout(900);", reason: "selftest" };
    const rotted = evaluateFixedWaits({ hits: fw.hits, entries: [...baseline, staleEntry] });
    fs.rmSync(fwDir, { recursive: true, force: true });
    checks.push(
        { name: "固定等待：真调用（.ts）→ 命中", ok: fwFiles.includes("g-call.ts") },
        { name: "固定等待：注释里的示例 → 不命中（匹配调用形态）", ok: !fwFiles.includes("h-comment.ts") },
        { name: "固定等待：字符串里的文本 → 不命中", ok: !fwFiles.includes("i-string.ts") },
        { name: "固定等待：.mjs 真调用 → 命中", ok: fwFiles.includes("j-call.mjs") },
        { name: "固定等待：基线齐 ⇒ 0 unbaselined / 0 stale", ok: clean.unbaselined.length === 0 && clean.stale.length === 0 },
        {
            name: "固定等待：基线删一条但代码仍在 ⇒ unbaselined 且点名 file:line",
            ok:
                dropped.unbaselined.length === 1 &&
                /^g-call\.ts:\d+$/.test(`${dropped.unbaselined[0].file}:${dropped.unbaselined[0].line}`),
        },
        { name: "固定等待：基线死条目 ⇒ stale（必须删除）", ok: rotted.stale.length === 1 },
    );
    for (const c of checks) console.log((c.ok ? "  ✔ " : "  ✘ ") + c.name);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
        console.error(`[timeout-budget] SELFTEST FAIL：${failed.length} 项不符（offenders=${JSON.stringify(result.offenders)}）`);
        process.exit(1);
    }
    console.log("[timeout-budget] SELFTEST PASS：超时预算两红四绿 + 固定等待门七项（调用形态/注释/字符串/.mjs/双向 ratchet）");
}

/** 跑两条判据并聚合退出码（2 环境/配置 > 1 判定失败 > 0 全绿）；各自都打印后再定 verdict。 */
function runGate({ reportOnly, e2eDir, baselinePath, relRoot }) {
    let worst = 0;
    const bump = (code) => {
        if (code === 2) worst = 2;
        else if (code === 1 && worst === 0) worst = 1;
    };

    const result = scanDir(e2eDir, relRoot);
    console.log(
        `[timeout-budget] scanned ${result.files} files, ${result.literals} literal budgets, ` +
            `${result.declared.length} declared (SSOT constant) deadlines`,
    );
    if (result.offenders.length) {
        console.error(`[timeout-budget] FAIL: ${result.offenders.length} over-budget literal(s)`);
        for (const line of result.offenders.slice(0, 200)) console.error(`  ${line}`);
        if (result.offenders.length > 200) console.error(`  … ${result.offenders.length - 200} more`);
        bump(1);
    } else {
        console.log("[timeout-budget] OK: every >10s budget is exempt and ≤60s");
    }

    const fixed = scanFixedWaits(e2eDir, relRoot);
    if (fixed.missing || fixed.files === 0) {
        console.error(`[fixed-wait] FAIL: 扫描面为空（${path.relative(relRoot, e2eDir)}）—— 门失明，按环境错误处理`);
        bump(2);
        return worst;
    }
    console.log(
        `[fixed-wait] scanned ${fixed.files} files (.ts/.mjs under packages/ui/e2e), ` +
            `${fixed.hits.length} waitForTimeout call(s), baseline ${path.relative(relRoot, baselinePath)}`,
    );
    let baseline;
    try {
        baseline = loadFixedWaitBaseline(baselinePath);
    } catch (error) {
        console.error(`[fixed-wait] FAIL: ${error.message}`);
        bump(2);
        return worst;
    }
    const evaluated = evaluateFixedWaits({ hits: fixed.hits, entries: baseline.entries });
    console.log(
        `[fixed-wait] baseline ${evaluated.entryCount} entries; ` +
            `covered ${evaluated.hitCount - evaluated.unbaselined.length}, ` +
            `unbaselined ${evaluated.unbaselined.length}, stale ${evaluated.stale.length}`,
    );
    if (evaluated.unbaselined.length) {
        console.error(
            `[fixed-wait] FAIL: ${evaluated.unbaselined.length} unregistered waitForTimeout call(s) ` +
                `— 新 E2E 禁止固定等待（packages/ui/AGENTS.md:125）；登记须带理由`,
        );
        for (const hit of evaluated.unbaselined.slice(0, 200)) console.error(`  ${hit.file}:${hit.line} ${hit.code}`);
        bump(reportOnly ? 0 : 1);
    }
    if (evaluated.stale.length) {
        console.error(
            `[fixed-wait] FAIL: ${evaluated.stale.length} baseline entr(ies) no longer match any call ` +
                `— 基线只许降且必须与现实一致；删除失效条目`,
        );
        for (const entry of evaluated.stale.slice(0, 200)) {
            console.error(`  ${entry.file}:${entry.line ?? "?"} (baseline) ${entry.signature}`);
        }
        bump(reportOnly ? 0 : 1);
    }
    if (!evaluated.unbaselined.length && !evaluated.stale.length) {
        console.log("[fixed-wait] OK: every waitForTimeout call is in the baseline (ratchet: only down, no dead entries)");
    } else if (reportOnly) {
        console.error("[fixed-wait] REPORT-ONLY: 默认会 exit 1；当前仅报告（--report-only）");
    }
    return worst;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    const args = process.argv.slice(2);
    const argValue = (name) => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const rootArg = argValue("--root");
    const relRoot = rootArg ? path.resolve(rootArg) : ROOT;
    const e2eDir = rootArg ? path.join(relRoot, "packages/ui/e2e") : E2E_DIR;
    const baselinePath = argValue("--baseline")
        ? path.resolve(argValue("--baseline"))
        : rootArg
          ? path.join(relRoot, "config/e2e-fixed-wait-baseline.json")
          : FIXED_WAIT_BASELINE;
    if (args.includes("--selftest")) {
        selftest();
    } else if (args.includes("--write-fixed-wait-baseline")) {
        const reason = argValue("--reason");
        const scanned = scanFixedWaits(e2eDir, relRoot);
        if (scanned.missing || scanned.files === 0) {
            console.error(`[fixed-wait] FAIL: 扫描面为空（${path.relative(relRoot, e2eDir)}）`);
            process.exitCode = 2;
        } else {
            const written = writeFixedWaitBaseline(baselinePath, scanned.hits, { reason });
            if (!written.ok) process.exitCode = 2;
        }
    } else {
        process.exitCode = runGate({
            reportOnly: args.includes("--report-only"),
            e2eDir,
            baselinePath,
            relRoot,
        });
    }
}
