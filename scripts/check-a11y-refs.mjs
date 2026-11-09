#!/usr/bin/env node
/**
 * PLAN-0733 / BL-519: A03-side launcher for the one-workspace a11y gate.
 * Resolves the main A03 checkout via git's common dir, so it works from both the
 * primary checkout and linked worktrees, then forwards arguments to the gate script.
 */
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const A03_ROOT = path.resolve(import.meta.dirname, "..");
const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: A03_ROOT,
    encoding: "utf8",
}).trim();
const ONE_ROOT = path.dirname(path.resolve(A03_ROOT, commonDir, ".."));
const gate = path.join(ONE_ROOT, "internal/A03-xihe/scripts/check-a11y-label-refs.mjs");
const result = spawnSync(process.execPath, [gate, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
