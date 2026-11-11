#!/usr/bin/env node
/**
 * BL-461 / PLAN-0727: run the CP Maven suite and then prove it actually executed tests.
 *
 * `mise run test:cp -- -Dtest=<typo>` used to print BUILD SUCCESS with zero reports.
 * This wrapper keeps the Maven command unchanged but adds the zero-execution guard on
 * success (on a real Maven failure the original exit code is preserved).
 *
 * task-104 债①（infra-1, 2026-11-11）：同一位置再加一道「本轮残留」报告/门。
 * 背景（实测，非推断）：`test:cp` 曾两次（VW-20261111-08/-09）**exit 0 却留下
 * `xihe-workspace-ws_*` 沙箱容器**；而 `scripts/e2e-preflight.mjs:412-414` 对**未打标**的
 * 沙箱只打 INFO「do not remove blindly」⇒「用例全绿、环境未复原」在门里看不见。
 * 这里用**既有 by-label 过滤**（与 `scripts/e2e-host.mjs:1979/2384` 同一手法）把残留摆上台面：
 *   - 默认 report-only：打印清单，**exit code 不受影响**（门禁纪律：新增门必须参数化、默认不阻断；
 *     先观察一轮验证窗无残留，再回来找 Lead 决定是否翻默认）；
 *   - `--enforce-residue`：有残留 ⇒ exit 2（且参数**不再透传给 maven**，见下方过滤）。
 * **只报不删**：清理按 one/AGENTS.md「删除与清理分级」逐项授权后执行，本脚本不做任何删除动作。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_DIR = path.join(ROOT, "packages", "control-plane");
// task-104 债①：本开关属于包装器自身，必须从透传参数里剔除 —— 否则 maven 会收到
// `Unknown lifecycle phase "--enforce-residue"`（D-893 同族：参数没到达它该到的地方）。
const ENFORCE_RESIDUE = "--enforce-residue";
const rawArgs = process.argv.slice(2);
const enforceResidue = rawArgs.includes(ENFORCE_RESIDUE);
const args = rawArgs.filter((arg) => arg !== ENFORCE_RESIDUE);
const mvn = process.platform === "win32" ? "mvn.cmd" : "mvn";
// BL-461: 只让本次运行写出的 surefire 报告参与"是否执行"判定（旧报告不算数）。
const startedAt = Date.now();
// task-104 债②：**唯一能保证「不管从哪个入口进来都带上 run-id」的位置**就是这里。
// 为什么不在 xh-verify-gates.mjs 一处注入：`mise run test:cp` 直接调本文件，不经过门跑器，
// 而 VW-20261111-08/-09 的残留容器正是「直接跑 test:cp」产生的。
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
const guardStatus = guard.status ?? 1;

// task-104 债①：残留报告放在"用例确实执行过"之后 —— 这一层要回答的问题正是
// 「用例全绿了，环境复原了吗」。执行守卫本身失败时优先保留它的退出码。
const residue = reportResidue(RUN_ID, enforceResidue);
// report-only 下这一项**永不**改变退出码；enforce 下"有残留"和"查不到"都算不通过
// （把未知读成干净是典型的假绿）。
const residueFails = enforceResidue && (residue.count > 0 || residue.unverifiable !== null);
process.exit(guardStatus !== 0 ? guardStatus : (residueFails ? 2 : 0));

/**
 * 本轮（run-id 相同）还留着的容器，按两个标签族分别查——**两个族是不同的东西**，
 * 混在一起会让人以为"已打标"就是全部：
 *   ① `xihe.cp.test.run-id`：Testcontainers 容器（`TestContainerLabels`，由本轮写入）；
 *   ② `xihe.e2e.run-id`：Runtime 的 workspace 沙箱容器（`workspace.rs:248-251`），
 *      即 VW-08/-09 真正漏收的那一族。
 * 只查容器，**不断言卷/网络**（Testcontainers 默认不建命名卷/网络；越界断言会误红）。
 *
 * 语义边界（别把它读成"残留检测"）：查询是 `label=<key>=<value>` 的**精确匹配** ⇒ 标签值必须与被查 run id 相等；
 * 所以本门只保证「**本轮没漏**」，**跨轮残留不归它**（归窗口收尾，如 task-95 那一类）；将来翻默认
 * （fail-closed）前必须确保 **run id 唯一且由调用方显式给**，否则会假绿 exit 0。
 */
function reportResidue(runId, enforce) {
    const families = [
        { label: "xihe.cp.test.run-id", what: "CP 测试容器(Testcontainers)" },
        { label: "xihe.e2e.run-id", what: "workspace 沙箱容器" },
    ];
    console.log(`[cp-test-run] 残留检查（只报不删，run-id=${runId}，模式=${enforce ? "enforce" : "report-only"}）`);
    let total = 0;
    let unverifiable = null;
    for (const family of families) {
        const listed = listByLabel(`${family.label}=${runId}`);
        if (!listed.ok) {
            unverifiable = listed.error;
            console.log(`  WARN  ${family.label}（${family.what}）：无法查询 —— ${listed.error}`);
            continue;
        }
        total += listed.rows.length;
        console.log(`  ${listed.rows.length === 0 ? "OK   " : "FOUND"} ${family.label}（${family.what}）：${listed.rows.length} 个`);
        for (const row of listed.rows) console.log(`          ${row}`);
    }
    if (total > 0) {
        console.log("[cp-test-run] 上面这些容器**本轮没有自行消失**。清理不由本脚本执行："
            + "按 one/AGENTS.md「删除与清理分级」列出清单、确认归属与可重建性后逐项授权再删。");
    }
    if (unverifiable) {
        // fail-closed 只在 enforce 模式生效：report-only 下"查不到"不改变退出码，
        // enforce 下"查不到"不能当"干净"用（那是把未知读成通过）。
        if (enforce) console.log("[cp-test-run] --enforce-residue：残留**无法验证** ⇒ exit 2（未知≠干净）");
        return { count: total, unverifiable };
    }
    if (enforce && total > 0) {
        console.log("[cp-test-run] --enforce-residue：本轮残留 ⇒ exit 2（默认 report-only 时不阻断）");
    }
    return { count: total, unverifiable: null };
}

function listByLabel(filter) {
    const docker = process.platform === "win32" ? "docker.exe" : "docker";
    const result = spawnSync(
        docker,
        ["ps", "-a", "--filter", `label=${filter}`, "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}"],
        { encoding: "utf8" },
    );
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) {
        return { ok: false, error: (result.stderr ?? "").trim().split("\n")[0] || `exit ${result.status}` };
    }
    const rows = (result.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    return { ok: true, rows };
}
