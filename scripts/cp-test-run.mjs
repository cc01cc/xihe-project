#!/usr/bin/env node
/**
 * BL-461 / PLAN-0727: run the CP Maven suite and then prove it actually executed tests.
 *
 * `mise run test:cp -- -Dtest=<typo>` used to print BUILD SUCCESS with zero reports.
 * This wrapper keeps the Maven command unchanged but adds the zero-execution guard on
 * success (on a real Maven failure the original exit code is preserved).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_DIR = path.join(ROOT, "packages", "control-plane");
const args = process.argv.slice(2);
const mvn = process.platform === "win32" ? "mvn.cmd" : "mvn";
// BL-461: 只让本次运行写出的 surefire 报告参与"是否执行"判定（旧报告不算数）。
const startedAt = Date.now();

const maven = spawnSync(mvn, ["test", ...args], {
    cwd: PACKAGE_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
});
if (maven.error) {
    console.error(`[cp-test-run] failed to launch Maven: ${maven.error.message}`);
    process.exit(2);
}
if (maven.status !== 0) process.exit(maven.status ?? 1);

const guard = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "check-test-executed.mjs"), "--since", String(startedAt)],
    {
    cwd: PACKAGE_DIR,
    stdio: "inherit",
});
process.exit(guard.status ?? 1);
