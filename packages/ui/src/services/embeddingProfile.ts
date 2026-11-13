import { request } from "../composables/api";
import type { ConfigLayer } from "../stores/config";
import type { ProviderConnection } from "../types/providerConnection";

export interface EmbeddingResolvedProfile {
    providerId: string;
    connectionKey: string;
    providerConnectionId: string;
    connectionOwnerScope: string;
    connectionRevision: number;
    modelId: string;
    dimension: number;
    profileScope: string;
    modelSource: string;
}

export interface EmbeddingEffectiveProfile {
    profile: { providerId: string; connectionKey: string; model: string } | null;
    profileScope: string | null;
    resolved: EmbeddingResolvedProfile | null;
    /** Server-owned pinned contract; clients must not re-declare it. */
    contract?: { modelId: string; dimension: number };
    code?: string;
}

export interface EmbeddingTestResult {
    status: "ok" | "error";
    model?: string;
    dimension?: number;
    requestId?: string;
    errorCode?: string;
}

export interface EmbeddingProfileInput {
    providerId: string;
    connectionKey: string;
    model: string;
}

export function embeddingConnections(
    connections: ProviderConnection[] | undefined | null,
): ProviderConnection[] {
    return (connections ?? []).filter(
        (item) => item.enabled && item.status === "READY" && item.operation === "embedding",
    );
}

export function fetchEmbeddingEffective(workspaceId?: string): Promise<EmbeddingEffectiveProfile> {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    return request<EmbeddingEffectiveProfile>(`/config/embedding/effective${query}`);
}

/**
 * embedding 写入口所在的层 —— **只有 instance / user 两层**。
 *
 * <p>为什么不是 `ConfigLayer`（D-1122 49A / PLAN-0766 T2.4，2026-11-13）：模型 4 域
 * （llm-provider / context-policy / embedding / rag）**退出了工作区层**，CP 侧
 * `WORKSPACE_WRITABLE_DOMAINS` 已不含它们 ⇒ 对 `workspace` / `workspace-default` 发
 * `PUT /config/<layer>/embedding` 必得 400。签名保留 `ConfigLayer` 等于把「能发必失败的
 * 请求」当成接口的一部分（宽签名留在外面），等于等着下一个调用点再把 400 报成产品缺陷
 * —— 卡级要求是**前端不画不该做的按钮**，类型层就该发不出去。</p>
 */
export type EmbeddingWriteLayer = Extract<ConfigLayer, "instance" | "user">;

/** 类型守卫：把「只有 instance/user 能写 embedding」变成可执行判据（组件层做第二道保险）。 */
export function isEmbeddingWriteLayer(layer: ConfigLayer): layer is EmbeddingWriteLayer {
    return layer === "instance" || layer === "user";
}

/** task-253 / D-1122：embedding profile 只能写实例/用户两层（工作区层不再有该写面）。 */
export function saveEmbeddingProfile(
    layer: EmbeddingWriteLayer,
    profile: EmbeddingProfileInput | null,
): Promise<void> {
    const body: Record<string, string> = {};
    if (profile) {
        body.profile = JSON.stringify(profile);
    }
    return request<void>(`/config/${layer}/embedding`, {
        method: "PUT",
        body: JSON.stringify(body),
    });
}

export function testEmbedding(workspaceId?: string): Promise<EmbeddingTestResult> {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    return request<EmbeddingTestResult>(`/config/embedding/test${query}`, {
        method: "POST",
        body: JSON.stringify({}),
    });
}
