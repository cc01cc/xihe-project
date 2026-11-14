import { describe, expect, it } from "vitest";

import router from "../index";
import { instanceOpsGroups } from "../../lib/settingsIa";
import { LEGACY_RESOURCE_PATHS } from "../../lib/legacyRoutes";

/**
 * task-91 / task-96（用户裁定「智能体是组织成员，不是资源」）：摘除后的**落点与 302** 判据。
 *
 * <p>两类判据刻意分开：</p>
 * <ul>
 *   <li>**落点**（task-91）：实例层新页已注册、左栏入口指向它、两条 `agent-profile` 旧路径仍 302 到
 *       组织成员页、设置区里没有第二份个人主体页；</li>
 *   <li>**302 分流**（task-96）：六种旧 URL 各落到哪个新家，**并且目标真的能解析** ——
 *       `D-1456` 判据 3：只断言「redirect 返回了某个 name」会假绿，必须再断言
 *       `router.resolve(<target>).name !== "settings-not-found"`，否则指向不存在页的 302 也能过。</li>
 * </ul>
 *
 * <p>`D-1456` 判据 4 在最后一例：`/resources/agents` **不得**进 `LEGACY_RESOURCE_PATHS` ——
 * 那个清单的语义是「一次性删除、不留 redirect（决策 10）」，与 302 相反；顺手加进去会让用户书签
 * 从「跳一次」退化成「白屏 404」。</p>
 */

type RedirectFn = (to: { query: Record<string, unknown> }) => unknown;

function redirectOf(path: string): RedirectFn {
    const record = router.getRoutes().find((route) => route.path === path);
    expect(record, "缺少路由记录：" + path).toBeTruthy();
    const redirect = record?.redirect;
    expect(typeof redirect, path + " 的 redirect 必须是函数（按 query 分流）").toBe("function");
    return redirect as unknown as RedirectFn;
}

/**
 * redirect 的返回值有三种形状（字符串路径 / `{name}` / `{path}`）⇒ 统一成 `{ name?, path? }` 再断言。
 * 不统一的话「返回了字符串」会被当成 `{}`，那条断言就成了假绿。
 */
function targetOf(value: unknown): {
    name?: string;
    path?: string;
    query?: Record<string, unknown>;
} {
    if (typeof value === "string") return { path: value };
    return value as { name?: string; path?: string; query?: Record<string, unknown> };
}

function assertResolvable(target: { name?: string; path?: string }, label: string): void {
    const to = target.path ? target.path : { name: target.name };
    const resolved = router.resolve(to as never);
    // 判据 3：目标必须存在（不是设置区 404 兜底）。
    expect(resolved.name, label + " 的 302 目标解析不到真实路由").not.toBe("settings-not-found");
    expect(resolved.matched.length, label + " 的 302 目标没有匹配到任何路由").toBeGreaterThan(0);
}

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

describe("资源区智能体页摘除后的 302 分流（task-96 / D-1456）", () => {
    it("?layer=INSTANCE ⇒ 实例层平台智能体页", () => {
        const target = targetOf(redirectOf("/resources/agents")({ query: { layer: "INSTANCE" } }));
        expect(target).toEqual({ name: "settings-instance-agent-principals", query: {} });
        assertResolvable(target, "?layer=INSTANCE");
    });

    it("?layer=WORKSPACE + ?workspaceId ⇒ 该工作区成员页", () => {
        const target = targetOf(
            redirectOf("/resources/agents")({ query: { layer: "WORKSPACE", workspaceId: "ws-1" } }),
        );
        expect(target).toEqual({ path: "/workspace/ws-1/members", query: {} });
        assertResolvable(target, "?layer=WORKSPACE&workspaceId=ws-1");
    });

    it("?layer=WORKSPACE 但没有 workspaceId ⇒ 不猜工作区，回组织成员页", () => {
        // 页签上下文（sessionStorage `xihe-workspace`）在单测里为空 ⇒ 走回退分支。
        const target = targetOf(redirectOf("/resources/agents")({ query: { layer: "WORKSPACE" } }));
        expect(target).toEqual({ name: "org-members", query: {} });
        assertResolvable(target, "?layer=WORKSPACE（无 id）");
    });

    it("?layer=USER 与缺省都 ⇒ 组织成员页（资源侧默认层是 USER）", () => {
        for (const query of [{ layer: "USER" }, {}, { layer: "nope" }]) {
            const target = targetOf(redirectOf("/resources/agents")({ query }));
            expect(target, JSON.stringify(query)).toEqual({ name: "org-members", query: {} });
            assertResolvable(target, "缺省/USER/非法层");
        }
    });

    it("详情深链 /resources/agents/:pk 同样 302 到列表级落点（不 404）", () => {
        const byInstance = targetOf(
            redirectOf("/resources/agents/:pk")({ query: { layer: "INSTANCE" } }),
        );
        expect(byInstance).toEqual({ name: "settings-instance-agent-principals", query: {} });
        assertResolvable(byInstance, "详情 + INSTANCE");
        const byUser = targetOf(redirectOf("/resources/agents/:pk")({ query: {} }));
        expect(byUser).toEqual({ name: "org-members", query: {} });
        assertResolvable(byUser, "详情 + 缺省层");
    });

    it("旧 query 一律不带到新家（三条出口都显式给 query: {}）", () => {
        // 机制出处（[源码] `node_modules/vue-router/dist/vue-router.js` 的 handleRedirectRecord）：
        //     assign({ query: to.query, hash: to.hash, params: … }, newTargetLocation)
        // ⇒ 返回值**不带 query 键**时旧 query 被继承，落地 URL 会变成
        //     /members?layer=USER 、/workspace/<id>/members?workspaceId=<id>
        // 那是过期参数（落地页可能自行解读 ?layer）。task-97 裁定 A：显式清空。
        const cases: { query: Record<string, unknown> }[] = [
            { query: { layer: "INSTANCE" } },
            { query: { layer: "WORKSPACE", workspaceId: "ws-1" } },
            { query: { layer: "WORKSPACE" } },
            { query: { layer: "USER" } },
            { query: {} },
            { query: { layer: "nope" } },
        ];
        for (const { query } of cases) {
            const target = targetOf(redirectOf("/resources/agents")({ query }));
            expect(target.query, JSON.stringify(query) + " 的旧 query 被继承了").toEqual({});
        }
    });
    it("判据 4：/resources/agents 不在 404 清单里（那是相反语义）", () => {
        expect(LEGACY_RESOURCE_PATHS as readonly string[]).not.toContain("/resources/agents");
    });
});
