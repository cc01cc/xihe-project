/**
 * task-385 / task-386（D-1233 / D-1232）：llm-provider profile 的两条**纯前端**判据。
 *
 * 为什么是纯函数 + 纯前端：D-1203 守住契约面（不加 HTTP warning 字段、不加端点），
 * 服务端行为不变（实例层写入仍 accepted）。两条判据都只消费既有读面：
 * 生效 profile（`mergedConfig`，无 layer 的合并读面）+ 可见连接列表（`providerConnections`）。
 *
 * 与 CP 语义对齐（cp-1 task-389 只读定位，逐条）：
 * - `usesOwnCredential` 必须显式过滤 `scope === "USER"`：T1.5 对 user/instance profile 只找
 *   OWNER_USER（ProviderConnectionService.findReadyForProfileScope:189-191）；WORKSPACE 行只服务
 *   workspace/workspace-default profile ⇒ 不过滤会把工作区连接误判成「你自己的凭据」。
 * - 必须带 `enabled && status === "READY"`（findReadyByKey:164-169）：同 key 行若 UNVERIFIED/disabled，
 *   运行时回落 INSTANCE（:196-197）⇒ 那时说「用你自己的凭据」是假的。
 * - 匹配键是 `(providerId, connectionKey)`，不是 label/id（CP 按四元组找，:166-167）。
 * - **不复用 ProviderHub.defaultConnection**：它只比 key 对、不看 scope/就绪 ⇒ 管理员视角会命中
 *   INSTANCE 行，用它做判据会反向。
 */
import type { LlmProviderProfile } from "../../services/llmProviderProfile";
import type { ProviderConnection } from "../../types/providerConnection";

/** profile 引用的连接就绪态：ready / 未就绪（含 disabled）/ ghost（列表里根本没有）。 */
export type ProfileReadiness = "ready" | "unverified" | "ghost";

/**
 * task-385：保存 profile 后要不要给 inline 警示。无 profile ⇒ null（不警示）。
 * 注意这里**不**过滤 scope：写入侧关心的是「这条 profile 引用的连接能不能解析」，
 * 实例层 profile 引用的就是 INSTANCE 连接。
 */
export function profileReadiness(
    profile: LlmProviderProfile | null,
    connections: readonly ProviderConnection[],
): ProfileReadiness | null {
    if (!profile) return null;
    const match = connections.find(
        (item) =>
            item.providerId === profile.providerId && item.connectionKey === profile.connectionKey,
    );
    if (!match) return "ghost";
    return match.enabled && match.status === "READY" ? "ready" : "unverified";
}

/** task-386：消费层该不该标注「此模型将使用你自己的凭据」（USER ∧ enabled ∧ READY ∧ 同 key 对）。 */
export function usesOwnCredential(
    profile: LlmProviderProfile | null,
    connections: readonly ProviderConnection[],
): boolean {
    if (!profile) return false;
    return connections.some(
        (item) =>
            item.scope === "USER" &&
            item.providerId === profile.providerId &&
            item.connectionKey === profile.connectionKey &&
            item.enabled &&
            item.status === "READY",
    );
}
