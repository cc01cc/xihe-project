// 钉住 `e2e/real/helpers/workspace.ts#isolatedWorkspaceHostPath` 的两条车道（task-65 / D-1717）。
//
// 为什么必须有一条测试：外部栈车道的隔离根用 `<pid>-<Date.now()>` 命名，而 **Playwright 的
// worker 复用同一个 pid** —— 同毫秒内两次调用本来会拿到同一个根，两个工作区就**静默共用**
// 一个宿主目录。这种污染**不会报错**，跑完只会得到「文件莫名有了/没了」，比断言失败更难查
// （`plan0639-multi-root.spec.ts:63` 已警告过这条，但当时只在那一处加了随机后缀）。
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

    it("run-id 车道：返回形状仍是 e2e-ws-<ts>", async () => {
        const base = await inLane({ XIHE_E2E_RUN_ID: "task65-run" }, (isolated) =>
            path.basename(isolated()),
        );
        assert.match(base, /^e2e-ws-\d+$/);
    });

    it("external 车道：无 XIHE_E2E_RUN_ID 时回落到进程级隔离根（不再断言失败）", async () => {
        const hostPath = await inLane({ XIHE_E2E_RUN_ID: undefined }, (isolated) => isolated());
        const root = path.basename(path.dirname(hostPath));
        assert.match(root, /^external-\d+-\d+-\d+-[0-9a-f]{4}$/, `unexpected root: ${root}`);
        // 「绝不写共享目录」：根必须落在 .tmp/e2e-host 之下，且带 external- 前缀。
        const expectedParent = path.resolve(process.cwd(), "../../.tmp/e2e-host");
        assert.equal(path.dirname(path.dirname(hostPath)), expectedParent);
    });

    it("碰撞防护：连续 50 次调用的隔离根必须互不相同（同 pid 同毫秒也不许共用）", async () => {
        const roots = await inLane({ XIHE_E2E_RUN_ID: undefined }, (isolated) => {
            const seen = new Set();
            for (let i = 0; i < 50; i += 1) {
                const hostPath = isolated();
                assert.ok(!seen.has(hostPath), `collision at call ${i}: ${hostPath}`);
                seen.add(hostPath);
            }
            return seen;
        });
        assert.equal(roots.size, 50);
    });

    // 已知存量债（**本卡不改**，卡片约束 (c)：RUN_ID 有值时行为必须逐字节不变，60 个 spec 依赖它）：
    // run-id 车道的子目录仍是 `e2e-ws-<Date.now()>`，**同毫秒内两次调用会拿到同一个目录**。
    // 这条由 `plan0639-multi-root.spec.ts:63` 的注释记着、并在那一处自己加了随机后缀绕开。
    // 上面那条 50 次碰撞测试**只覆盖回落车道**，不要读成"两车道都防住了"。修 run-id 车道要
    // 单独一张卡（会改目录名 ⇒ 需全量复核依赖路径的 spec），这里只把它显式记录，不静默假装已修。
});
