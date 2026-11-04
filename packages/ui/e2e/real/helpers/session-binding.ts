import { expect, type APIRequestContext } from "@playwright/test";

/**
 * 2026-11-04 用户裁定移除 composer 模型选择器后，real-lane 规格改走 CP 的会话绑定
 * `PATCH /api/v1/sessions/{id}`（即原 ModelPopover 内部调用的同一产品 API）。
 *
 * 选择器 UI 已不存在，"点开选择器选模型"这条路径随之作废；规格要断言的**效果**
 * （会话持久化了真实 provider/model/connection）保持不变，所以走同一 API。
 * 不再断言选择器 UI 本身（`model-popover-trigger` / 分组过滤等）——那是被裁定删除的面。
 */

export interface SessionBindingOverride {
    /** 显式指定连接（需要断言特定连接的规格用，如 workspace shared 连接）。 */
    connectionId?: string;
    connectionRevision?: number;
}

/** 按 provider 解析唯一 READY 的 chat 连接，或用 override 直接给定连接。 */
async function resolveConnection(
    request: APIRequestContext,
    cpUrl: string,
    headers: Record<string, string>,
    provider: string,
    override?: SessionBindingOverride,
): Promise<{ id: string; revision: number }> {
    if (override?.connectionId && override?.connectionRevision) {
        return { id: override.connectionId, revision: override.connectionRevision };
    }
    const list = await request.get(`${cpUrl}/api/v1/provider-connections`, { headers });
    expect(list.ok(), await list.text()).toBe(true);
    const body = (await list.json()) as {
        connections?: Array<{
            id: string;
            providerId: string;
            operation: string;
            status: string;
            enabled: boolean;
            revision: number;
        }>;
    };
    const matches = (body.connections ?? []).filter(
        (item) =>
            item.providerId === provider &&
            item.operation === "chat" &&
            item.status === "READY" &&
            item.enabled,
    );
    expect(
        matches.length,
        `no READY chat connection for provider ${provider} (needed to bind the session)`,
    ).toBeGreaterThan(0);
    return { id: matches[0]!.id, revision: matches[0]!.revision };
}

/** Bind `sessionId` to `provider/model` through the product's session PATCH API. */
export async function bindSessionViaApi(
    request: APIRequestContext,
    cpUrl: string,
    headers: Record<string, string>,
    sessionId: string,
    provider: string,
    model: string,
    override?: SessionBindingOverride,
): Promise<void> {
    const connection = await resolveConnection(request, cpUrl, headers, provider, override);
    const patch = await request.patch(`${cpUrl}/api/v1/sessions/${sessionId}`, {
        headers,
        data: {
            modelProvider: provider,
            modelName: model,
            providerConnectionId: connection.id,
            connectionRevision: connection.revision,
        },
    });
    expect(patch.ok(), `session bind PATCH failed: ${await patch.text()}`).toBe(true);
}
