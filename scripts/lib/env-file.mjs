#!/usr/bin/env node
// PLAN-0547: zero-dependency .env chain loader for XH Node tooling.
//
// Semantics mirror the CP-side DotenvLoader exactly (G1):
//   chain: .env → .env.$XIHE_ENV (default dev) → .env.local, resolved from the
//   A03-xihe repo root (found by walking up from cwd to the nearest .git);
//   first occurrence wins inside the chain; OS env and existing keys are never
//   overwritten (fill-gaps only); missing files are skipped silently.
//
// Usage in scripts:
//   import { loadEnvFileChain } from "./lib/env-file.mjs";
//   loadEnvFileChain();                          // fills process.env gaps, returns count
//   const { values } = loadEnvFileChain({ env: new Map(...) });  // custom target
//
// CLI (for bash consumers like the reset-admin wrapper):
//   node scripts/lib/env-file.mjs --print XIHE_DEV_ADMIN_PASSWORD
//   Prints exactly the resolved value (empty line when unset); never logs the value
//   with any other text, so `$(...)` capture stays clean.

import fs from "node:fs";
import path from "node:path";

function findRepoRoot(startDir) {
    let dir = path.resolve(startDir);
    for (;;) {
        if (fs.existsSync(path.join(dir, ".git"))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function parseEnvFile(text, lookup) {
    // KEY=VALUE lines; '#' comments; optional surrounding quotes are stripped.
    // Interpolation (${VAR}) is NOT supported — keep parity with DotenvLoader's parser.
    const out = new Map();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        if (lookup.has(key)) continue; // first occurrence wins
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        out.set(key, value);
        lookup.set(key, value);
    }
    return out;
}

/**
 * Loads the .env chain and fills gaps in `env` (an object-like bag; defaults to
 * process.env). Returns { count, files } — count of newly filled keys, never values.
 */
export function loadEnvFileChain({ env = process.env, cwd = process.cwd() } = {}) {
    const root = findRepoRoot(cwd);
    if (!root) return { count: 0, files: [] };
    const envName = env.XIHE_ENV || "dev";
    const files = [
        path.join(root, ".env"),
        path.join(root, `.env.${envName}`),
        path.join(root, ".env.local"),
    ];
    // First-wins lookup seeded with existing env (OS env + already-set keys are sticky).
    const lookup = new Map();
    for (const [k, v] of Object.entries(env)) {
        if (v !== undefined && v !== "") lookup.set(k, v);
    }
    let count = 0;
    const loaded = [];
    for (const file of files) {
        if (!fs.existsSync(file)) continue;
        loaded.push(file);
        const filled = parseEnvFile(fs.readFileSync(file, "utf8"), lookup);
        for (const [k, v] of filled) {
            const current = env[k];
            if (current === undefined || current === "") {
                env[k] = v;
                count += 1;
            }
        }
    }
    return { count, files: loaded };
}

function main() {
    const argIndex = process.argv.indexOf("--print");
    if (argIndex === -1 || !process.argv[argIndex + 1]) {
        process.stderr.write("usage: node env-file.mjs --print KEY\n");
        process.exit(2);
    }
    const key = process.argv[argIndex + 1];
    const bag = {};
    loadEnvFileChain({ env: bag });
    process.stdout.write((bag[key] ?? "") + "\n");
}

function isMainModule() {
    // Normalize both sides: file URL -> decoded OS path, case-insensitive on Windows.
    try {
        const self = path.resolve(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"));
        const invoked = path.resolve(process.argv[1] ?? "");
        return self.toLowerCase() === invoked.toLowerCase();
    } catch {
        return false;
    }
}

if (isMainModule()) {
    main();
}
