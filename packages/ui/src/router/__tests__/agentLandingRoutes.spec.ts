import { describe, expect, it } from "vitest";

import router from "../index";
import { instanceOpsGroups } from "../../lib/settingsIa";

/**
 * task-91（用户裁定「智能体是组织成员，不是资源」）：两个落点的机器判据。
 *
 * <p>为什么这条必须存在：资源区摘除后，「平台智能体」与「个人智能体主体」各只剩**一个新家**。
 * 落点如果没有绊线，某次重构把路由删掉/改名，唯一症状是用户点进去 404 —— 而资源区的
 * e2e 已经随摘除一起删了，没人会发现。</p>
 *
 * <p>用户层落点不是新页，而是**组织成员页**（用户 2026-11-14 ④「智能体个人属于成员管理，
 * 并不是在设置域里面」）⇒ 这里同时钉住两条 `agent-profile` 旧路径的 302 目标仍在，
 * 否则「旧书签能到成员页」这条兼容承诺会静默失效。</p>
 */

describe("智能体落点（task-91）", () => {
    it("实例层：平台智能体页已注册，且左栏入口指向它", () => {
        const route = router
            .getRoutes()
            .find((record) => record.path === "/settings/instance/agent-principals");
        expect(route?.name).toBe("settings-instance-agent-principals");
        const item = instanceOpsGroups()
            .flatMap((group) => group.items)
            .find((entry) => entry.id === "agent-principals");
        expect(item?.path).toBe("/settings/instance/agent-principals");
        // 复用既有键而不是新造：「平台智能体」这个概念在 i18n 里已经存在（迁移不是新概念）。
        expect(item?.labelKey).toBe("settings.ia.resourceAgents");
    });

    it("用户层：两条 agent-profile 旧路径仍 302 到组织成员页", () => {
        for (const path of ["/settings/user/agent-profile", "/settings/instance/agent-profile"]) {
            const route = router.getRoutes().find((record) => record.path === path);
            expect(route?.redirect, path).toEqual({ name: "org-members" });
        }
    });

    it("反向自检：设置区里没有第二份个人智能体主体页（落点唯一）", () => {
        const userLayerPage = router
            .getRoutes()
            .filter((record) => record.path.startsWith("/settings/user/"))
            .map((record) => record.path);
        expect(userLayerPage.some((path) => path.includes("agent-principal"))).toBe(false);
    });
});
