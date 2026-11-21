import { describe, expect, it } from "vitest";
import router from "../index";
import { LAYER_DOMAINS } from "../../stores/config";
import { instanceOpsGroups } from "../../lib/settingsIa";

/**
 * task-8 的机器判据：授权总览（`/settings/authorization-overview`）**不是配置域**，
 * 它是运维/安全组里的独立页 —— 所以 `settingsLayer` 必须显式写在路由 meta 上。
 *
 * <p>为什么专门钉：`lib/settingsIa.ts:142-145` 的 `settingsLayerForPath()` 对未知路径
 * **一律兜底 "instance"**。靠兜底写层，页面上看不出任何异常，只有把页搬层时才会静默出错
 * （task-160 同类隐式 bug）。所以这里判的是「路由记录自己写了层」，不是「函数算出来的层」。</p>
 */
describe("authorizationOverviewRoute（task-8：授权总览显式写层，不靠派生）", () => {
    const NAME = "settings-authorization-overview";
    const PATH = "/settings/authorization-overview";

    function record(): ReturnType<typeof router.getRoutes>[number] {
        const found = router.getRoutes().find((item) => item.name === NAME);
        expect(found, `路由表里必须有 ${NAME}`).toBeTruthy();
        return found!;
    }

    it("路由存在，name/path 精确，meta.settingsLayer 显式是 instance", () => {
        const route = record();
        expect(route.path).toBe(PATH);
        // 显式写层：读 meta 本身，不经过 settingsLayerForPath 的兜底。
        expect(route.meta.settingsLayer).toBe("instance");
        // 不是配置域：域路由都会带 settingsDomain（router/index.ts:302-329 生成的形态）。
        expect(route.meta.settingsDomain).toBeUndefined();
    });

    it("路径不进 LAYER_DOMAINS：一进就等于把非域页塞进配置矩阵", () => {
        const last = PATH.slice("/settings/".length);
        for (const layer of ["instance", "user", "workspace-default"] as const) {
            expect(LAYER_DOMAINS[layer]).not.toContain(last);
        }
        // 反面对照：真的域路由必须带 settingsDomain，证明上一条不是空判据。
        const domainRoute = router
            .getRoutes()
            .find((item) => item.name === `settings-instance-domain-${LAYER_DOMAINS.instance[0]}`);
        expect(domainRoute?.meta.settingsDomain).toBe(LAYER_DOMAINS.instance[0]);
    });

    it("运维/安全组里每个入口都有显式写层的路由（新增条目不许靠兜底）", () => {
        const items = instanceOpsGroups().flatMap((group) => group.items);
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            const route = router.getRoutes().find((candidate) => candidate.path === item.path);
            expect(route, `${item.path} 必须有路由`).toBeTruthy();
            expect(route!.meta.settingsLayer, `${item.path} 必须显式写 settingsLayer`).toBe(
                "instance",
            );
            expect(route!.meta.settingsDomain).toBeUndefined();
        }
        // 本页在其中，且安全组末尾——顺序变了也当场红。
        expect(items.some((item) => item.path === PATH)).toBe(true);
        const security = instanceOpsGroups().find((group) => group.id === "security");
        expect(security?.items.at(-1)?.path).toBe(PATH);
    });
});
