// task-208 / D-1567：`isLeakRow` 的三态单测（`task585` 的 picker 断言靠它判红）。
//
// 为什么用 node:test 而不是 vitest：纯函数在 `e2e/` 下，`vitest` 的 include 只覆盖 `src/**/*.spec.ts`
// （`vite.config.ts:162`），而本目录的既有纯代码测试都在 `e2e/fixtures/__tests__/*.test.mjs`
// （`pnpm run test:e2e:fixtures`，已并入 validate）。所以这里走同一条门。
//
// 判据三态（D-1567）：<0 合法在途 / >0 泄漏 / null = 测量缺口 ⇒ 按泄漏处理（fail-closed）。
// 运行：pnpm run test:e2e:fixtures
import test from "node:test";
import assert from "node:assert/strict";
import { isLeakRow } from "../../mock/helpers/headerAuditVerdict.ts";

// `-384` = `task-204` 的实测值（picker 家族那条在途 `GET /api/v1/sessions`）。
test("msSinceCtxWrite < 0 ⇒ 合法在途，不算泄漏", () => {
    assert.equal(isLeakRow({ msSinceCtxWrite: -384 }), false);
    assert.equal(isLeakRow({ msSinceCtxWrite: -1 }), false);
});

// `+41` = `task-196`/`task-188` 的真实泄漏读数（`D-1570` 的正例）。
test("msSinceCtxWrite > 0 ⇒ 泄漏", () => {
    assert.equal(isLeakRow({ msSinceCtxWrite: 41 }), true);
    assert.equal(isLeakRow({ msSinceCtxWrite: 1 }), true);
});

test("msSinceCtxWrite === null ⇒ 测量缺口，按泄漏处理（fail-closed）", () => {
    assert.equal(isLeakRow({ msSinceCtxWrite: null }), true);
});

// 边界值钉清楚：判据是 `> 0` 才算泄漏，所以恰好 `0`（同一毫秒）落在**清白**一侧。
// 这不是「放宽」—— 卡面公式就是 `null || > 0`；把它单列成用例是为了让边界值有明确归属，
// 将来若有人想改成 `>= 0`，这条会当场红。
test("msSinceCtxWrite === 0 ⇒ 同一毫秒，按公式落在清白一侧（改成 >=0 会红）", () => {
    assert.equal(isLeakRow({ msSinceCtxWrite: 0 }), false);
});
