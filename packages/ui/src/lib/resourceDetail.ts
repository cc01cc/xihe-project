import { resourcePath, type ResourceId, type ResourceLayer } from "./settingsIa";

/**
 * 资源**详情单页**的路径与返回栈口径（PLAN-0772 M2 / task-228）。
 *
 * <p>为什么单独一个文件而不是散在视图里：路径拼法与"后退还是回落"都是**可判定**的纯函数，
 * 单测要能直接钉住；`?layer=` 的解析**不在本文件**——那是 `settingsIa.resolveResourceLayer`
 * 的唯一职责（本卡只消费，不复制层口径）。</p>
 *
 * ## pk 的唯一性 = 资源 + 层
 *
 * `pk` 在**资源 + 层**内唯一，不是全局唯一：同一个 `skillId` 可以在实例层与工作区层各有一条定义，
 * 同一个 `principalId` 可以在"我的主体"与"本工作区绑定"两处出现。因此 **`?layer=` 必须进 URL**
 * （不是内存态），否则同一个 URL 会指向两条不同的行。
 *
 * ## 各资源的 pk 口径（详情页解析与列表行链接必须逐字一致，不许一边 id 一边 name）
 *
 * | 资源 | 层 | pk |
 * | --- | --- | --- |
 * | `credentials` | USER / WORKSPACE | `CredentialSummary.id`（也是 实例层 `InstanceCredential.id`） |
 * | `mcp` | WORKSPACE | stdio server 名（`GET /workspaces/{id}/stdio-servers` 的 `servers` 键） |
 * | `mcp` | INSTANCE | `InstanceMcpServer.id` |
 * | `skills` | WORKSPACE / INSTANCE | `skillId` |
 * | `agents` | USER / WORKSPACE | `principalId` |
 * | `agents` | INSTANCE | `InstanceAgent.id` |
 */
export function resourceDetailPath(id: ResourceId, layer: ResourceLayer, pk: string): string {
    return `${resourcePath(id)}/${encodeURIComponent(pk)}?layer=${layer}`;
}

/**
 * 返回栈：**后退优先**；没有应用内历史时回落到该层列表页（口径 2）。
 *
 * <p>"有没有历史"的唯一判据是 vue-router 4 写在 `history.state.back` 里的**上一个内部路由**：
 * 硬导航（直接粘贴 URL / 新标签页）时为 `null`，此时 `router.back()` 会把人送出应用（或原地不动），
 * 所以必须先判空再决定。**不用** `window.history.length`：它把跨站历史也算进来，
 * 在"从搜索引擎点进来"时会出现"后退到 Google"的经典错。</p>
 */
export function shouldUseBrowserBack(backState: unknown): boolean {
    return typeof backState === "string" && backState.length > 0;
}
