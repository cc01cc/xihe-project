#!/usr/bin/env node
// task-192（infra-1，2026-11-13）：`mise run test:cp:migration` 的执行体。
//
// 为什么不把 mvn 命令直接写进 mise.toml（task-181 证据包 §5 给的那两行）：
//   本机 mise 用 **cmd.exe** 执行 run 串，`$(...)` **不会被展开**。实测（2026-11-13 09:54）：
//   直接把 `-Dtest=$(node ../../scripts/check-migration-test-coverage.mjs --test-filter)` 交给 mvn，
//   surefire 报 `No tests matching pattern "$(node ... --test-filter)" were executed!` ⇒ BUILD FAILURE。
//   ⇒ 「两行已核」这句话当时没有在 Windows 上真跑过；本脚本把它补成可执行形态。
//
// 本脚本做两件事，不重写任何判据：
//   ① 求过滤清单：交给 `scripts/check-migration-test-coverage.mjs --test-filter`（唯一判据仍在那个脚本里）；
//   ② 在 packages/control-plane 下 spawn `mvn -o test -Dtest=<清单>`，stdio 直通、退出码原样转发。
// 禁区：不改 `check-migration-test-coverage.mjs` 本体、不改它那份 8 条清单。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const filterScript = path.join(here, "check-migration-test-coverage.mjs");

const filter = spawnSync(process.execPath, [filterScript, "--test-filter"], { encoding: "utf8" });
if (filter.status !== 0) {
  // 覆盖表本身有缺口时，脚本已经打印了缺哪个文件/哪条迁移 —— 原样带出来，别在这里加判断。
  process.stderr.write(filter.stderr || "");
  process.stderr.write("[test:cp:migration] 过滤清单求不出（check-migration-test-coverage.mjs --test-filter 退出 " + filter.status + "）\n");
  process.exit(filter.status ?? 1);
}
const testFilter = (filter.stdout || "").trim();
if (!testFilter) {
  process.stderr.write("[test:cp:migration] 过滤清单为空 —— 拒绝执行 mvn（空 -Dtest 会跑全部或零个，两者都不是本任务语义）\n");
  process.exit(1);
}
console.log("[test:cp:migration] -Dtest=" + testFilter);

const mvn = spawnSync("mvn", ["-o", "test", "-Dtest=" + testFilter], {
  cwd: path.join(repoRoot, "packages", "control-plane"),
  stdio: "inherit",
  shell: true, // Windows 上是 mvn.cmd，shell 解析扩展名
});
if (mvn.error) {
  process.stderr.write("[test:cp:migration] 起 mvn 失败：" + mvn.error.message + "\n");
  process.exit(1);
}
process.exit(mvn.status ?? 1);
