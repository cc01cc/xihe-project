#!/usr/bin/env node
/**
 * task-874 / D-1919: A03-side launcher for the one-workspace delivery-receipt gate.
 *
 * 卡的 SSOT（`internal/A03-xihe/cards/**`）与门本体都在 one 私有层；A03 侧只留这个入口，
 * 便于以后在 `A03-xihe/mise.toml` 注册而不复制判据（与 `check-a11y-refs.mjs` 同型）。
 *
 * 解析 one 根：用 git common dir（主检出与 linked worktree 都适用）。
 * 单独 clone A03（没有 ../internal）时 **exit 2 fail-closed** —— 「读不到卡」不许当「全绿」。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const A03_ROOT = path.resolve(import.meta.dirname, "..");

let ONE_ROOT = null;
try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: A03_ROOT,
        encoding: "utf8",
    }).trim();
    ONE_ROOT = path.dirname(path.resolve(A03_ROOT, commonDir, ".."));
} catch (err) {
    process.stderr.write(`E_INPUT 无法解析 one 根（git rev-parse --git-common-dir 失败）：${err.message}\n`);
    process.exit(2);
}

const gate = path.join(ONE_ROOT, "internal/A03-xihe/scripts/check-delivery-receipt.mjs");
if (!existsSync(gate)) {
    process.stderr.write(
        `E_INPUT 找不到门本体：${gate}\n` +
            "  该门读取 one 私有层的 cards SSOT；单独 clone A03 时不可用（fail-closed，不当全绿）。\n",
    );
    process.exit(2);
}

const result = spawnSync(process.execPath, [gate, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
