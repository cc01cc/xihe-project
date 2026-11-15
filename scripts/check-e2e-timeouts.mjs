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
// 自检：`node scripts/check-e2e-timeouts.mjs --selftest`（两红三绿，见 selftest()）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const E2E_DIR = path.join(ROOT, "packages/ui/e2e");
const ACTION_CAP_MS = 10_000;
const EXEMPT_CAP_MS = 60_000;
const EXEMPT = /\/\/\s*timeout-exempt:\s*(.+)/;

/** ① timeout:/setTimeout( 字面量；② Date.now()/performance.now() + 字面量；③ 同左但右侧是常量表达式。 */
const LITERAL_TIMEOUT = /(?:timeout:|test\.setTimeout\()\s*(\d[\d_]*)/g;
const LITERAL_DEADLINE = /(?:Date|performance)\.now\(\)\s*\+\s*(\d[\d_]*)/g;
const DECLARED_DEADLINE = /(?:Date|performance)\.now\(\)\s*\+\s*[A-Za-z_$]/g;
/** 夹具时间戳：new Date(Date.now() + N) —— 造数据，不是等待预算。 */
const FIXTURE_TIMESTAMP = /new\s+Date\(\s*Date\.now\(\)\s*\+/;

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (entry.name.endsWith(".ts")) out.push(p);
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
        files = walk(dir);
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

/**
 * 自检：两红三绿（task-237 判据 ④ 与「不许误伤合法用法」）。
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
    for (const c of checks) console.log((c.ok ? "  ✔ " : "  ✘ ") + c.name);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
        console.error(`[timeout-budget] SELFTEST FAIL：${failed.length} 项不符（offenders=${JSON.stringify(result.offenders)}）`);
        process.exit(1);
    }
    console.log("[timeout-budget] SELFTEST PASS：两红四绿，且命中集合恰为 {真代码, 注释示例}");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
    if (process.argv.includes("--selftest")) {
        selftest();
    } else {
        const result = scanDir(E2E_DIR, ROOT);
        console.log(
            `[timeout-budget] scanned ${result.files} files, ${result.literals} literal budgets, ` +
                `${result.declared.length} declared (SSOT constant) deadlines`,
        );
        if (result.offenders.length) {
            console.error(`[timeout-budget] FAIL: ${result.offenders.length} over-budget literal(s)`);
            for (const line of result.offenders.slice(0, 200)) console.error(`  ${line}`);
            if (result.offenders.length > 200) console.error(`  … ${result.offenders.length - 200} more`);
            process.exit(1);
        }
        console.log("[timeout-budget] OK: every >10s budget is exempt and ≤60s");
    }
}
