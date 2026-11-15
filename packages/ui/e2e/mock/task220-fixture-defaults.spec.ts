/**
 * task-220 ①：**预设表自身**的自洽断言（常量面，无浏览器）。
 *
 * 行为极性的判据在 `resources-ia.spec.ts` 的「默认夹具（不传 capabilitiesPreset）= 实例管理员」——
 * 那里用真实页面证明「默认 ⇒ 门槛可用 / `owner` 预设 ⇒ 置灰」。本文件只钉**表本身**：
 * 预设若被改宽（editor/viewer/none 带实例管理员位）或 instanceAdmin 被改窄，这里立刻红，
 * 且不需要起浏览器/页面 —— 最便宜的拦截点。
 */
import { CAPABILITY_PRESETS } from "./helpers/auth";
import { expect, test } from "./helpers/mock-test";

test("task-220 ① 预设表自洽：instanceAdmin 有实例管理员位，editor/viewer/none 都没有", () => {
    expect(CAPABILITY_PRESETS.instanceAdmin.capabilities.isInstanceAdmin).toBe(true);
    for (const key of ["editor", "viewer", "none"] as const) {
        expect(
            CAPABILITY_PRESETS[key].capabilities.isInstanceAdmin,
            "预设 " + key + " 不应带实例管理员能力位",
        ).toBe(false);
    }
});
