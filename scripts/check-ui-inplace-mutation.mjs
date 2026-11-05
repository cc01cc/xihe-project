#!/usr/bin/env node
/**
 * BL-365 (2026-11-06): report-only guard against in-place mutation of shared UI objects.
 *
 * The BL-364 inventory showed the real pattern is NOT props mutation (0) but objects shared
 * between a store/action and components: `message.x = ...`, `Object.assign(existing, ...)`.
 * This gate only targets the *component-side* direct field writes that the inventory found
 * actionable, and deliberately stays narrow to keep the false-positive rate near zero:
 *   - scan `packages/ui/src/**`, skipping `__tests__`, `*.spec.ts` and `stores/**`;
 *   - match `(agent|row|item|record|session|message|file).<field> =` only;
 *   - skip `==` / `===` / `=>` comparisons, `x.value =` ref replacement, and declarations.
 * Report-only: exit code is always 0 so it can be observed before it ever blocks a lane.
 *
 * Usage:
 *   node scripts/check-ui-inplace-mutation.mjs                 # scan the repo (stores out of scope)
 *   node scripts/check-ui-inplace-mutation.mjs --json          # {findings,count,reportOnly:true,scope}
 *   node scripts/check-ui-inplace-mutation.mjs --root <dir>    # scan another root (tests)
 *   node scripts/check-ui-inplace-mutation.mjs --file <path>   # scan one file (tests/debug)
 *   node scripts/check-ui-inplace-mutation.mjs --include-stores # also scan `stores/**` (BL-365 migration)
 *
 * Coverage is part of the result: the default scope **skips `stores/**`**, so "0 findings" does NOT
 * mean "no in-place writes in the store layer" — BL-365's 48 store-side sites were only visible via
 * `--include-stores` / `--file`. The `scope` field in `--json` and the summary line state this.
 *
 * Exit codes: always 0 (report-only); usage problems print help and still exit 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SELF_DIR, '..');
const TARGETS = ['agent', 'row', 'item', 'record', 'session', 'message', 'file'];
const ASSIGN = new RegExp(`\\b(${TARGETS.join('|')})\\.(?!value\\b)\\w+\\s*=(?!=|>)`);
const SKIP_DIR = new Set(['__tests__', 'stores', 'node_modules', 'dist', 'coverage']);
/** BL-365: `--include-stores` widens the scope to the store layer (still skips tests/build dirs). */
const SKIP_DIR_WITH_STORES = new Set([...SKIP_DIR].filter((dir) => dir !== 'stores'));
const DECL = /^\s*(?:const|let|var)\s/;

/** Keep this list shrinking-only: each entry needs a reason and is excluded by path+line. */
const ALLOWLIST = [
  // { file: 'packages/ui/src/...', line: 123, reason: '...' },
];

function walk(dir, out = [], skip = SKIP_DIR) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(path.join(dir, entry.name), out, skip);
    } else if (/\.(vue|ts|tsx|js|mjs)$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function scanFile(file, root) {
  const findings = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const rel = path.relative(root, file).replaceAll('\\', '/');
  for (const [i, line] of lines.entries()) {
    if (DECL.test(line)) continue;
    if (!ASSIGN.test(line)) continue;
    const allowed = ALLOWLIST.some((a) => rel.endsWith(a.file) && a.line === i + 1);
    if (!allowed) findings.push({ file: rel, line: i + 1, code: line.trim() });
  }
  return findings;
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(arg('--root') ?? DEFAULT_ROOT);
  const single = arg('--file');
  const json = argv.includes('--json');
  const includeStores = argv.includes('--include-stores');
  const scope = includeStores
    ? 'packages/ui/src (incl. stores/**)'
    : 'packages/ui/src (excl. stores/**)';
  let findings = [];
  if (single) {
    findings = scanFile(path.resolve(single), root);
  } else if (fs.existsSync(path.join(root, 'packages/ui/src'))) {
    const src = path.join(root, 'packages/ui/src');
    const skip = includeStores ? SKIP_DIR_WITH_STORES : SKIP_DIR;
    for (const file of walk(src, [], skip)) findings.push(...scanFile(file, root));
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ findings, count: findings.length, reportOnly: true, scope })}\n`,
    );
  } else {
    for (const f of findings) process.stdout.write(`[ui-inplace] ${f.file}:${f.line} ${f.code}\n`);
    process.stdout.write(`${findings.length} finding(s) — report only (exit 0), scope: ${scope}\n`);
  }
  process.exitCode = 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}

export { scanFile };
