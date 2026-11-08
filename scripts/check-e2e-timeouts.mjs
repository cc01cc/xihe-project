#!/usr/bin/env node
// task-252: E2E timeout budget gate.
//
// User ruling 2026-11-08: E2E waits are budgeted — action/assertion ≤10 s, test ≤30 s; anything
// above 10 s must say why it is exempt (`// timeout-exempt: <reason>` on the same or previous
// line) and an exemption may never exceed 60 s. 240 s/300 s literals are bugs masking slowness,
// not waits (a fallback toggle burned a full 240 s doing nothing in the 0691 T1.7 window).
//
// Scans only *literals*: the shared constants in e2e/timeouts.ts are the legal way to ask for a
// budget, and `E2E_*_TIMEOUT_MS` envs override them at runtime.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const E2E_DIR = path.join(ROOT, "packages/ui/e2e");
const ACTION_CAP_MS = 10_000;
const EXEMPT_CAP_MS = 60_000;
const EXEMPT = /\/\/\s*timeout-exempt:\s*(.+)/;

// task-252 (2026-11-08): these two files were frozen for the concurrent oxfmt lane (task-238) and
// could not be rewritten in this card. They are skipped here on purpose and must be migrated in the
// follow-up that lands oxfmt: remove this set and the gate will cover them again.
const PENDING_OXFMT_FILES = new Set([
    "packages/ui/e2e/real/tool-cards.spec.ts",
    "packages/ui/e2e/real/helpers/journey.ts",
]);

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (entry.name.endsWith(".ts")) out.push(p);
    }
    return out;
}

const offenders = [];
let literals = 0;
let pending = 0;
const files = walk(E2E_DIR);
for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (PENDING_OXFMT_FILES.has(rel)) {
        pending++;
        continue;
    }
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i].matchAll(/(?:timeout:|test\.setTimeout\()\s*(\d[\d_]*)/g)) {
            const value = Number(m[1].replace(/_/g, ""));
            literals++;
            if (value <= ACTION_CAP_MS) continue;
            const exempt = EXEMPT.exec(lines[i]) ?? (i > 0 ? EXEMPT.exec(lines[i - 1]) : null);
            const where = `${rel}:${i + 1}`;
            if (!exempt) {
                offenders.push(`${where} ${m[0].trim()} (${value} ms) — no // timeout-exempt: <reason>`);
            } else if (value > EXEMPT_CAP_MS) {
                offenders.push(`${where} ${m[0].trim()} (${value} ms) — exemption exceeds ${EXEMPT_CAP_MS} ms cap`);
            }
        }
    }
}

console.log(`[timeout-budget] scanned ${files.length} files, ${literals} literal budgets, ${pending} file(s) pending the oxfmt follow-up`);
if (offenders.length) {
    console.error(`[timeout-budget] FAIL: ${offenders.length} over-budget literal(s)`);
    for (const line of offenders.slice(0, 200)) console.error(`  ${line}`);
    if (offenders.length > 200) console.error(`  … ${offenders.length - 200} more`);
    process.exit(1);
}
console.log("[timeout-budget] OK: every >10s budget is exempt and ≤60s");
