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
// task-104 债②：**唯一能保证「不管从哪个入口进来都带上 run-id」的位置**就是这里。
// 为什么不在 xh-verify-gates.mjs 一处注入：`mise run test:cp` 直接调本文件，不经过门跑器，
// 而 VW-20261111-09/-10 的残留容器正是「直接跑 test:cp」产生的。
// 调用方已给则沿用（窗内跑由窗口导出，值为窗 id）；未给则按沿用 e2e 的命名习惯自生成。
const RUN_ID = process.env.XIHE_E2E_RUN_ID
    ?? `cp-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
console.log(`[cp-test-run] XIHE_E2E_RUN_ID=${RUN_ID}（容器标签来源；用于残留归属）`);

const maven = spawnSync(mvn, ["test", ...args], {
    cwd: PACKAGE_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
    // 显式传 env：被测进程（含其拉起的 runtime）据此给容器打 xihe.e2e.run-id 标签。
    env: { ...process.env, XIHE_E2E_RUN_ID: RUN_ID },
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
