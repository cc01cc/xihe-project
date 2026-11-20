import type { ModelCache, ProviderCatalog } from "../../../types/provider";
import type { ProviderConnection } from "../../../types/providerConnection";
import type { SessionModelBinding } from "../../../types";
import type { LlmProviderProfile } from "../../../services/llmProviderProfile";
import type { SessionParticipantView } from "../../../types/participant";

/**
 * PLAN-0555: read-only display resolver for the composer model label.
 *
 * The server Session is authoritative for a bound run (CP reads
 * `providerConnectionId` and the Session model on dispatch), so the label uses
 * the Session first, then the local binding cache, then the llm-provider
 * profile. It never mutates config/session state and never changes what a run
 * dispatches.
 *
 * C1（2026-11-04 用户裁定）：`hasBinding` 只认**会话行**（`session.providerConnectionId`）。
 * 本地 binding 缓存与 profile 是"发送时会用的兜底"，不是"已经绑上"——把它们算进
 * `hasBinding` 会让裸会话显示成已绑模型（用户一发言就 409 `PROVIDER_REQUIRED`）。
 * 未绑定时触发器退回占位文案，不再展示"看起来像已绑定"的模型名。
 */
export type ConnectionDisplayState = "resolved" | "loading" | "unavailable" | "not-recorded";

export interface ModelDisplayInput {
    session?: {
        modelProvider?: string;
        modelName?: string;
        providerConnectionId?: string;
    };
    binding?: SessionModelBinding;
    profile?: LlmProviderProfile | null;
    catalogs?: ModelCache["providers"];
    connections: ProviderConnection[];
    connectionsLoaded: boolean;
    connectionsError?: boolean;
    /** Offline provider-name fallback (the catalog is the SSOT). */
    fallbackProviderName?: (providerId: string) => string | undefined;
}

export interface ModelDisplay {
    hasBinding: boolean;
    model: string | null;
    providerId: string | null;
    providerName: string | null;
    /** `label`, `label · connectionKey`, `connectionKey`, `—` or `…` (loading). */
    connectionDisplay: string;
    connectionLabel: string | null;
    connectionKey: string | null;
    connectionId: string | null;
    state: ConnectionDisplayState;
}

const EMPTY: ModelDisplay = {
    hasBinding: false,
    model: null,
    providerId: null,
    providerName: null,
    connectionDisplay: "—",
    connectionLabel: null,
    connectionKey: null,
    connectionId: null,
    state: "not-recorded",
};

function normalizeLabel(value: string | null | undefined): string {
    return (value ?? "").trim().toLowerCase();
}

function visibleConnectionLabel(connection: ProviderConnection): string {
    const label = (connection.label ?? "").trim();
    return label || connection.connectionKey;
}

function findCatalog(
    catalogs: ModelCache["providers"] | undefined,
    providerId: string,
    connectionId?: string,
): ProviderCatalog | undefined {
    const entries = Object.entries(catalogs ?? {});
    if (connectionId) {
        const byConnection = entries.find(
            ([key, catalog]) => key === connectionId || catalog.connectionId === connectionId,
        );
        if (byConnection) return byConnection[1];
    }
    return entries.find(([key, catalog]) => (catalog.providerId ?? key) === providerId)?.[1];
}

/** A profile connection is matched by provider+key; prefer WORKSPACE like the picker. */
function findProfileConnection(
    connections: ProviderConnection[],
    providerId: string,
    connectionKey: string,
): ProviderConnection | undefined {
    const matches = connections.filter(
        (item) => item.providerId === providerId && item.connectionKey === connectionKey,
    );
    return matches.find((item) => item.scope === "WORKSPACE") ?? matches[0];
}

export function resolveModelDisplay(input: ModelDisplayInput): ModelDisplay {
    const { session, binding, profile, connections, connectionsLoaded } = input;

    let providerId: string | null = null,
        model: string | null = null,
        connectionId: string | undefined,
        connectionKey: string | undefined;

    // 1. A bound Session is what CP actually dispatches. Only the session row counts as
    //    "bound" for display (C1); the branches below still resolve what the send would use.
    const boundBySession = Boolean(
        session?.providerConnectionId && session?.modelProvider && session?.modelName,
    );
    if (boundBySession) {
        providerId = session!.modelProvider!;
        model = session!.modelName!;
        connectionId = session!.providerConnectionId;
    } else if (binding?.provider && binding.model) {
        // 2. Local binding cache (also covers the profile fallback of getEffectiveModel).
        providerId = binding.provider;
        model = binding.model;
        connectionId = binding.connectionId;
        if (
            !connectionId &&
            profile &&
            profile.providerId === binding.provider &&
            profile.model === binding.model
        ) {
            connectionKey = profile.connectionKey;
        }
    } else if (profile) {
        // 3. llm-provider profile default.
        providerId = profile.providerId;
        model = profile.model;
        connectionKey = profile.connectionKey;
    }

    if (!providerId || !model) return EMPTY;

    const catalog = findCatalog(input.catalogs, providerId, connectionId),
        providerName =
            catalog?.displayName ?? input.fallbackProviderName?.(providerId) ?? providerId;

    let connection: ProviderConnection | undefined,
        state: ConnectionDisplayState = "not-recorded",
        connectionDisplay = "—";

    if (connectionId) {
        if (!connectionsLoaded) {
            state = input.connectionsError ? "unavailable" : "loading";
            connectionDisplay = input.connectionsError ? "—" : "…";
        } else {
            connection = connections.find((item) => item.id === connectionId);
            if (connection) {
                state = "resolved";
                connectionDisplay = visibleConnectionLabel(connection);
            } else {
                state = "unavailable";
            }
        }
    } else if (connectionKey) {
        if (!connectionsLoaded) {
            state = input.connectionsError ? "unavailable" : "loading";
            connectionDisplay = input.connectionsError ? "—" : "…";
        } else {
            connection = findProfileConnection(connections, providerId, connectionKey);
            state = "resolved";
            // The profile records the key even when the connection is not visible.
            connectionDisplay = connection ? visibleConnectionLabel(connection) : connectionKey;
        }
    }

    const connectionLabel = connection ? (connection.label ?? "").trim() || null : null,
        resolvedKey = connection?.connectionKey ?? connectionKey ?? null;

    // PLAN-0555 decision #16: uniqueness is per owner, so USER and WORKSPACE can
    // still share a label. Within the visible set the key disambiguates the
    // third segment instead of adding a fourth one.
    if (connection && connectionLabel) {
        const normalized = normalizeLabel(connectionLabel),
            conflicts = connections.filter(
                (item) =>
                    item.providerId === providerId && normalizeLabel(item.label) === normalized,
            );
        if (conflicts.length > 1 && resolvedKey) {
            connectionDisplay = `${connectionLabel} · ${resolvedKey}`;
        }
    }

    return {
        // C1: 只有会话行真的绑了才叫"已绑"；profile/本地缓存兜底只回答"发送时会用什么"。
        hasBinding: boundBySession,
        model,
        providerId,
        providerName,
        connectionDisplay,
        connectionLabel,
        connectionKey: resolvedKey,
        connectionId: connection?.id ?? connectionId ?? null,
        state,
    };
}

/**
 * task-140（DSD-1508 / 卡面 J1~J3）：**运行期模型来源**的唯一解析实现。
 *
 * 与 CP `ChatModelResolutionService.java:62-103` 同构（三步 + 兜底）：
 *   1. 会话覆盖（Session 的四列模型绑定完整 ⇒ source=`session`）；
 *   2. PRIMARY（To 主体）Agent 的 `default_model_*`（binding 门在 `AgentPrincipalService#defaultModel`）；
 *   3. 生效的 llm-provider profile（source=`llm-profile`）；
 *   4. 全无 ⇒ `none`（CP 侧对应 409 `LLM_NOT_CONFIGURED`）。
 *
 * 两条与旧 `getEffectiveModel` 的**刻意差异**：
 * - **本地模型清单不参与裁决**。清单（`/models` 缓存）只回答"这个模型在不在这台机器已发现的列表里"，
 *   不回答"发送时会用哪个模型"；CP 的链路从头到尾不看 UI 清单。旧实现在清单过期/未就绪时把
 *   会话绑定判成不可用，UI 显示"未绑定"而真发出去却能成功 —— 展示与事实反了（J1）。
 * - 清单里没有只给**中性角标**，不禁用发送（J3 / DSD-1508 ②）。
 *
 * 这里是纯函数：store 只负责喂数据（会话本地镜像、PRIMARY 默认、profile、清单），组件只负责展示。
 * 三个消费方（composer chip / SSEStream 发送 / ChatPanel 幂等签名）必须读同一份结果，禁止各自再算（J4）。
 */
export type ChatModelSourceKind = "session" | "agent-principal" | "llm-profile" | "none";

export interface ChatModelSourceInput {
    /** 本地镜像的会话绑定（`configStore.getActiveModel`）。 */
    sessionBinding?: { provider?: string | null; model?: string | null } | null;
    /** PRIMARY（To 主体）Agent 的默认模型 —— **必须**来自带工作区 binding 门的列表。 */
    principalDefault?: { provider?: string | null; model?: string | null } | null;
    profile?: LlmProviderProfile | null;
    /** 已发现的 chat 模型清单；`null` = 清单还没就绪（角标未知，不等于"不在列表"）。 */
    discoveredModels?: string[] | null;
}

export interface ChatModelSourceResult {
    provider: string | null;
    model: string | null;
    source: ChatModelSourceKind;
    /** 角标用：true=在已发现列表内 / false=不在 / null=清单未知。**不参与**能否发送。 */
    inDiscoveredList: boolean | null;
}

/** 空白与 null 一律当"没填"—— CP 侧 `StringUtils.hasText` 同口径。 */
function trimmed(value: string | null | undefined): string {
    return (value ?? "").trim();
}

export function resolveChatModelSource(input: ChatModelSourceInput): ChatModelSourceResult {
    const discovered = input.discoveredModels ?? null;
    const found = (
        provider: string,
        model: string,
        source: ChatModelSourceKind,
    ): ChatModelSourceResult => ({
        provider,
        model,
        source,
        inDiscoveredList: discovered === null ? null : discovered.includes(model),
    });

    const sessionProvider = trimmed(input.sessionBinding?.provider);
    const sessionModel = trimmed(input.sessionBinding?.model);
    if (sessionProvider && sessionModel) return found(sessionProvider, sessionModel, "session");

    const principalProvider = trimmed(input.principalDefault?.provider);
    const principalModel = trimmed(input.principalDefault?.model);
    if (principalProvider && principalModel)
        return found(principalProvider, principalModel, "agent-principal");

    const profileProvider = trimmed(input.profile?.providerId);
    const profileModel = trimmed(input.profile?.model);
    if (profileProvider && profileModel) return found(profileProvider, profileModel, "llm-profile");

    return { provider: null, model: null, source: "none", inDiscoveredList: null };
}

/**
 * 从会话名册里取"To 主体"的 principal id —— 与 CP 的 `admissionPrincipalId` 同口径
 * （`ChatSubmissionService.java:1102-1116`：PRIMARY + AGENT + 取 responder）。
 *
 * 停用行不参与（CP 的 responder 不返回停用参与者）；若只剩停用行则返回 null，让来源判定落到 profile。
 */
export function primaryAgentPrincipalId(
    participants: SessionParticipantView[] | null,
): string | null {
    if (!participants) return null;
    const primaryAgent = participants.find(
        (item) => item.role === "PRIMARY" && item.principalKind === "AGENT",
    );
    return primaryAgent?.principalId ?? null;
}
