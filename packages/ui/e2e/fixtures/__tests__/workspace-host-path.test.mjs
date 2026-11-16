// 钉住 `e2e/real/helpers/workspace.ts#isolatedWorkspaceHostPath` 的两条车道（task-65 / D-1717）。
//
// 为什么必须有一条测试：隔离根用 `Date.now()` 命名，而 **Date.now() 在同一同步块内连续调用
// 会返回同一个毫秒值**、Playwright 的 worker 又**复用同一个 pid** ⇒ 同毫秒内多次调用会拿到
// 同一个目录，两个工作区就**静默共用**宿主目录。这种污染**不会报错**，跑完只会得到
// 「文件莫名有了/没了」，比断言失败更难查。
//
// **两条车道都在本文件里钉**（task-68 / D-1722）：原先只有回落车道防碰撞，run-id 车道
// `e2e-ws-<Date.now()>` 实测 50 次连续调用只得到 3~5 个不同目录（碰撞率 90%+，稳定撞）。
// `plan0639-multi-root.spec.ts` 当年只在那一处自己加随机后缀绕开 —— 绕开不等于修好。
// 所以这里钉的是「连续两次拿到的根不同」这条**静默失败的可观测判据**，不是打印好看。
//
// 运行：`pnpm run test:e2e:fixtures`（node:test，不起栈、不起浏览器，秒级）。
// 本文件直接 import 生产 helper（Node 24 原生剥 TS 类型），不是复刻一份逻辑 —— 复刻的测试
// 只能证明复刻品对，证明不了被测实现。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";

const HELPER = new URL("../../real/helpers/workspace.ts", import.meta.url).href;

/**
 * 在指定 env 车道里执行一段逻辑。env 必须在**调用期间**生效（而不是只在 import 期间），
 * 且每次切换一份模块实例，让进程内序号从 1 开始（否则前一个用例会抬高后一个的序号）。
 * @template T
 * @param {Record<string, string | undefined>} patch
 * @param {(isolated: () => string) => T} run
 * @returns {Promise<T>}
 */
async function inLane(patch, run) {
    const saved = new Map();
    for (const [key, value] of Object.entries(patch)) {
        saved.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        const mod = await import(`${HELPER}?case=${Date.now()}-${Math.random()}`);
        return run(mod.isolatedWorkspaceHostPath);
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

describe("isolatedWorkspaceHostPath", () => {
    it("run-id 车道：有 XIHE_E2E_RUN_ID 时根目录就是用该 run id（行为不变）", async () => {
        const root = await inLane({ XIHE_E2E_RUN_ID: "task65-run" }, (isolated) =>
            path.basename(path.dirname(isolated())),
        );
        assert.equal(root, "task65-run", `run-id lane must key off RUN_ID, got ${root}`);
    });

    it("run-id 车道：根仍是 <RUN_ID>，叶子仍是它的直接子目录（按轮隔离语义不变）", async () => {
        const hostPath = await inLane({ XIHE_E2E_RUN_ID: "task65-run" }, (isolated) => isolated());
        // 结构：<project>/.tmp/e2e-host/<RUN_ID>/e2e-ws-<ts>-<seq>-<nonce>
        assert.equal(path.basename(path.dirname(hostPath)), "task65-run");
        const expectedParent = path.resolve(process.cwd(), "../../.tmp/e2e-host");
        assert.equal(path.dirname(path.dirname(hostPath)), expectedParent);
    });

    it("external 车道：无 XIHE_E2E_RUN_ID 时回落到进程级隔离根（不再断言失败）", async () => {
        const hostPath = await inLane({ XIHE_E2E_RUN_ID: undefined }, (isolated) => isolated());
        const root = path.basename(path.dirname(hostPath));
        assert.match(root, /^external-\d+-\d+-\d+-[0-9a-f]{4}$/, `unexpected root: ${root}`);
        // 「绝不写共享目录」：根必须落在 .tmp/e2e-host 之下，且带 external- 前缀。
        const expectedParent = path.resolve(process.cwd(), "../../.tmp/e2e-host");
        assert.equal(path.dirname(path.dirname(hostPath)), expectedParent);
    });

    // 核心判据（task-68）：**两条车道各 50 次，必须 50 个不同目录**。
    // 这里用 table 而不是写两遍：两条车道的判据必须一模一样，否则"一条防住了、
    // 一条没防住"会再次变成读不出来的事（就是本卡修的那个半吊子状态）。
    const lanes = [
        { label: "external 车道（无 RUN_ID）", runId: undefined },
        { label: "run-id 车道（有 RUN_ID）", runId: "task68-collision" },
    ];
    for (const lane of lanes) {
        it(`碰撞防护[50 次不重复]：${lane.label}`, async () => {
            const roots = await inLane({ XIHE_E2E_RUN_ID: lane.runId }, (isolated) => {
                const seen = new Set();
                for (let i = 0; i < 50; i += 1) {
                    const hostPath = isolated();
                    assert.ok(!seen.has(hostPath), `collision at call ${i}: ${hostPath}`);
                    seen.add(hostPath);
                }
                return seen;
            });
            assert.equal(
                roots.size,
                50,
                `${lane.label}: 50 calls must yield 50 distinct dirs, got ${roots.size}`,
            );
        });
    }

    it("run-id 车道叶子名带序号+nonce（碰撞防护真的进了目录名，不只在根上）", async () => {
        const base = await inLane({ XIHE_E2E_RUN_ID: "task68-leaf" }, (isolated) =>
            path.basename(isolated()),
        );
        assert.match(
            base,
            /^e2e-ws-\d+-\d+-[0-9a-f]{4}$/,
            `leaf must be e2e-ws-<ts>-<seq>-<nonce>, got ${base}`,
        );
    });
});
