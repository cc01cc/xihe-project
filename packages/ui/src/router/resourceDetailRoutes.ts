import type { RouteLocationNormalized } from "vue-router";
import { resolveResourceLayer, RESOURCE_DEFS, type ResourceId } from "../lib/settingsIa";

/**
 * 资源详情单页的路由片段（PLAN-0772 M2 / task-228）。
 *
 * <p>抽成独立模块的原因：路由表本身在 `router/index.ts` 里与全局守卫、布局、懒加载组件绑在一起，
 * 单测要真实例化它就得连带拉起半条应用（实测 `beforeAll` 里 `import("../index")` 会超时）。
 * 把**可判定**的两件事单独拿出来后，单测不需要 router 实例也能钉住：</p>
 * <ul>
 *   <li>路由名/路径段的形状（`resources-<id>-detail` + `<id>/:pk`）；</li>
 *   <li>`?layer=` 的规范化语义（缺省/非法 ⇒ 默认层 + `replace: true`）。</li>
 * </ul>
 *
 * <p>"装到真 router 上还成立"（replace 真的改了地址栏）由 `e2e/mock/resource-detail.spec.ts`
 * 在浏览器里验 —— 纯函数证明不了地址栏。</p>
 */
export const RESOURCE_DETAIL_IDS: readonly ResourceId[] = RESOURCE_DEFS.filter(
    (def) => (def.gaps ?? []).length === 0,
).map((def) => def.id);

/** 路由名：`resources-<id>-detail`（四个可管理资源 + 缺口资源 knowledge 各一条）。 */
export function resourceDetailRouteName(id: ResourceId): string {
    return `resources-${id}-detail`;
}

/** 子路由路径段：`<id>/:pk`（挂在 `/resources` 父路由下）。 */
export function resourceDetailRoutePath(id: ResourceId): string {
    return `${id}/:pk`;
}

/**
 * `?layer=` **强制**（口径 1）：缺省或非法值一律按 `resolveResourceLayer` 落到该资源默认层，
 * 并**用 `replace` 写回地址栏**（不许只活在前端内存里 —— 否则同一屏的 URL 与实际层不一致，
 * 深链/截图/返回栈全都会错）。
 *
 * <p>层解析**只调** `settingsIa.resolveResourceLayer`（本卡不另写一套层口径）；大小写都收
 * （`?layer=user` ⇒ `?layer=USER`），非法值回默认层而**不是** 404 —— 与列表页同一语义：
 * 资源 id 非法才 404（由路由段兜底），层解析从不 404。</p>
 */
export function normalizeResourceLayerQuery(id: ResourceId) {
    return (to: RouteLocationNormalized) => {
        const resolved = resolveResourceLayer(id, to.query.layer);
        if (to.query.layer === resolved) return true;
        return {
            name: to.name ?? undefined,
            params: to.params,
            // 保留其余 query（例如将来的 `?from=`），只把层规范化。
            query: { ...to.query, layer: resolved },
            hash: to.hash,
            replace: true,
        };
    };
}
