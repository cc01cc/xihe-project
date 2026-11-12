import { describe, expect, it } from "vitest";
import type { RouteLocationNormalized } from "vue-router";

import {
    normalizeResourceLayerQuery,
    RESOURCE_DETAIL_IDS,
    resourceDetailRouteName,
    resourceDetailRoutePath,
} from "../resourceDetailRoutes";

/**
 * task-228：资源详情路由的**装配**判据（不拉真 router 实例）。
 *
 * <p>为什么不用真 router：实测在 `beforeAll` 里 `import("../index")` 会把整条应用外壳拉起来
 * （全局守卫 + 布局 + api）并超时；而本卡要钉的两件事本身是**可判定**的：
 * ①路由名/路径段形状 ②`?layer=` 规范化的 redirect 语义（含 `replace: true`）。
 * "地址栏真的被改了"由浏览器用例 `e2e/mock/resource-detail.spec.ts` 证明 —— 纯函数证明不了它。</p>
 */
function location(
    name: string,
    query: Record<string, string> = {},
    hash = "",
): RouteLocationNormalized {
    return {
        name,
        params: { pk: "pk-1" },
        query,
        hash,
        fullPath: `/resources/x/pk-1`,
        path: `/resources/x/pk-1`,
        matched: [],
        meta: {},
        redirectedFrom: undefined,
    } as unknown as RouteLocationNormalized;
}

describe("资源详情路由表形状（task-228）", () => {
    it("四个可管理资源各一条详情路由；knowledge 不在「可管理资源」集合里", () => {
        expect([...RESOURCE_DETAIL_IDS]).toEqual(["credentials", "mcp", "skills", "agents"]);
    });

    it("路由名 = resources-<id>-detail，路径段 = <id>/:pk", () => {
        for (const id of ["credentials", "mcp", "skills", "agents", "knowledge"] as const) {
            expect(resourceDetailRouteName(id)).toBe(`resources-${id}-detail`);
            expect(resourceDetailRoutePath(id)).toBe(`${id}/:pk`);
        }
    });
});

describe("?layer= 强制（缺省/非法都落到默认层并 replace 回 URL）", () => {
    it("合法层原样保留 ⇒ 不产生重定向（不打断正常导航）", () => {
        expect(
            normalizeResourceLayerQuery("credentials")(
                location("resources-credentials-detail", { layer: "WORKSPACE" }),
            ),
        ).toBe(true);
    });

    it("缺省 layer ⇒ 补默认层（credentials=USER）并带 replace:true", () => {
        const redirect = normalizeResourceLayerQuery("credentials")(
            location("resources-credentials-detail"),
        );
        expect(redirect).toMatchObject({
            name: "resources-credentials-detail",
            query: { layer: "USER" },
            replace: true,
        });
    });

    it("非法 layer ⇒ 回落默认层，不给 404", () => {
        const redirect = normalizeResourceLayerQuery("mcp")(
            location("resources-mcp-detail", { layer: "SESSION" }),
        );
        expect(redirect).toMatchObject({ query: { layer: "WORKSPACE" }, replace: true });
    });

    it("小写写法规范化为大写 wire 值（?layer=user ⇒ USER）", () => {
        const redirect = normalizeResourceLayerQuery("credentials")(
            location("resources-credentials-detail", { layer: "user" }),
        );
        expect(redirect).toMatchObject({ query: { layer: "USER" }, replace: true });
    });

    it("该资源没有的层（mcp 无 USER）⇒ 落到默认层", () => {
        const redirect = normalizeResourceLayerQuery("mcp")(
            location("resources-mcp-detail", { layer: "USER" }),
        );
        expect(redirect).toMatchObject({ query: { layer: "WORKSPACE" }, replace: true });
    });

    it("规范化层时保留其余 query 与 hash", () => {
        const redirect = normalizeResourceLayerQuery("agents")(
            location("resources-agents-detail", { layer: "bogus", from: "list" }, "#body"),
        );
        expect(redirect).toMatchObject({
            query: { layer: "USER", from: "list" },
            hash: "#body",
            replace: true,
        });
    });

    it("knowledge 没有层（layerRules 为空）⇒ 恒回落 WORKSPACE（诚实态页面不再二次分叉）", () => {
        const redirect = normalizeResourceLayerQuery("knowledge")(
            location("resources-knowledge-detail", { layer: "INSTANCE" }),
        );
        expect(redirect).toMatchObject({ query: { layer: "WORKSPACE" }, replace: true });
    });
});
