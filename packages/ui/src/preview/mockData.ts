/**
 * Mock data for the real-component UI preview (`preview.html`).
 *
 * Every object below is typed against the **product** types (`src/types/*`,
 * `src/composables/api.ts`, `src/services/apiRequestTemplates.ts`) so the shapes
 * cannot drift from the real contract while staying 100% offline: the preview never
 * calls `/api/v1/**`. Field names mirror `docs/api/openapi.yaml`; nothing here is
 * invented locally.
 */
import type { AttachmentFile, CredentialSummary, Message, Session } from "../types";
import type { SessionParticipantView } from "../types/participant";
import type { ApiTypePair, ProviderConnection } from "../types/providerConnection";
import type {
    AgentRoleBinding,
    ApiBindingSet,
    ApiRole,
    WorkspaceAgentBinding,
    WorkspaceAgentMemory,
} from "../composables/api";
import type { ApiRequestTemplate } from "../services/apiRequestTemplates";

export const PREVIEW_WORKSPACE_ID = "8f2a1c40-0000-4000-8000-000000000001";
export const PREVIEW_SESSION_ID = "6d1b7e20-0000-4000-8000-000000000002";

export const mockSessions: Session[] = [
    {
        id: PREVIEW_SESSION_ID,
        title: "重构 checkpoint 回滚路径",
        createdAt: "2026-11-03T09:12:00Z",
        updatedAt: "2026-11-03T10:02:00Z",
        workspaceId: PREVIEW_WORKSPACE_ID,
        agentPrincipalId: "7a10c3e0-0000-4000-8000-0000000000a1",
        modelProvider: "anthropic",
        modelName: "claude-sonnet-4.5",
        providerConnectionId: "conn-anthropic",
    },
    {
        id: "6d1b7e20-0000-4000-8000-000000000003",
        title: "多根 workspace 的切片归属",
        createdAt: "2026-11-03T08:40:00Z",
        updatedAt: "2026-11-03T09:15:00Z",
        workspaceId: PREVIEW_WORKSPACE_ID,
        modelProvider: "openai",
        modelName: "gpt-5.1",
    },
    {
        id: "6d1b7e20-0000-4000-8000-000000000004",
        title: "凭据轮换与审计留痕",
        createdAt: "2026-11-02T20:05:00Z",
        updatedAt: "2026-11-02T21:31:00Z",
        workspaceId: PREVIEW_WORKSPACE_ID,
        modelProvider: "deepseek",
        modelName: "deepseek-v4",
    },
    {
        id: "6d1b7e20-0000-4000-8000-000000000005",
        title: "记忆条目的置顶排序",
        createdAt: "2026-11-02T15:22:00Z",
        updatedAt: "2026-11-02T16:04:00Z",
        workspaceId: PREVIEW_WORKSPACE_ID,
    },
];

/** Session participants — drives the composer's TO (single) / CC (multi) chips. */
export const mockParticipants: SessionParticipantView[] = [
    {
        participantId: "pt-atlas",
        principalKind: "AGENT",
        principalId: "7a10c3e0-0000-4000-8000-0000000000a1",
        displayName: "Atlas · 架构",
        role: "PRIMARY",
        orderIndex: 10,
        wakePolicy: "ALL_MESSAGES",
        respondPolicy: "ALWAYS",
        source: "workspace",
        disabledAt: null,
        selfOwned: true,
        defaultModelProvider: "anthropic",
    },
    {
        participantId: "pt-nova",
        principalKind: "AGENT",
        principalId: "7a10c3e0-0000-4000-8000-0000000000a2",
        displayName: "Nova · 实现",
        role: "MEMBER",
        orderIndex: 20,
        wakePolicy: "MENTION",
        respondPolicy: "WHEN_MENTIONED",
        source: "personal",
        disabledAt: null,
        selfOwned: true,
        defaultModelProvider: "openai",
    },
    {
        participantId: "pt-lin",
        principalKind: "HUMAN",
        principalId: "3c55d2b0-0000-4000-8000-0000000000b1",
        displayName: "林可",
        role: "MEMBER",
        orderIndex: 30,
        wakePolicy: "ALL_MESSAGES",
        respondPolicy: "ALWAYS",
        selfOwned: true,
    },
    {
        participantId: "pt-zhou",
        principalKind: "HUMAN",
        principalId: "3c55d2b0-0000-4000-8000-0000000000b2",
        displayName: "周衡",
        role: "GUARD",
        orderIndex: 40,
        wakePolicy: "MENTION",
        respondPolicy: "MUTED",
        selfOwned: false,
    },
];

export const mockParticipantCapabilities = {
    view: true,
    manage: true,
    mention: true,
    speakAs: true,
};

const attachment: AttachmentFile = {
    id: "att-1",
    name: "run_checkpoints.sql",
    type: "text/plain",
    size: 4_812,
    url: "#",
    state: "done",
};

const ts = (minute: number) => `2026-11-03T10:${String(minute).padStart(2, "0")}:00Z`;

/** Conversation for the workbench block (user → assistant, tool calls inside). */
export const mockConversation: Message[] = [
    {
        id: "m-1",
        sessionId: PREVIEW_SESSION_ID,
        role: "user",
        content: "把回滚路径改成按根路由，顺便确认主根行为不变。",
        timestamp: ts(2),
        attachments: [attachment],
    },
    {
        id: "m-2",
        sessionId: PREVIEW_SESSION_ID,
        role: "assistant",
        content:
            "拆成三段：**读切片** → **定位影子库** → **按根还原**。主根（`root_id == workspace_id`）保持原路径，非主根才走 `_for_root` 变体。",
        parts: [
            {
                type: "text",
                content:
                    "拆成三段：**读切片** → **定位影子库** → **按根还原**。主根（`root_id == workspace_id`）保持原路径，非主根才走 `_for_root` 变体。",
            },
        ],
        timestamp: ts(3),
        toolCalls: [
            {
                id: "tc-1",
                name: "workspace.read_file",
                arguments: '{"path":"packages/runtime/src/checkpoint_revert.rs"}',
                status: "completed",
                result: "fn resolve_restore_context(workspace_id, root_id, slice_ref) …",
                startedAt: ts(3),
                completedAt: ts(3),
            },
            {
                id: "tc-2",
                name: "delegate.spawn_worker",
                arguments: '{"role":"reviewer","scope":"packages/runtime"}',
                status: "completed",
                refusalCode: "DELEGATION_LIMIT_EXCEEDED",
                startedAt: ts(4),
                completedAt: ts(4),
            },
        ],
    },
];

/** Standalone message samples for the messages/tool-cards block. */
export const mockMessageSamples: Message[] = [
    {
        id: "m-user",
        sessionId: PREVIEW_SESSION_ID,
        role: "user",
        content: "先只看不写：列出这个 workspace 的两个根。",
        timestamp: ts(6),
    },
    {
        id: "m-assistant-ok",
        sessionId: PREVIEW_SESSION_ID,
        role: "assistant",
        content: "两个根都在：主根 `ws/primary`，附加根 `ws/vendor-lib`（已声明，未嵌套）。",
        parts: [
            {
                type: "text",
                content:
                    "两个根都在：主根 `ws/primary`，附加根 `ws/vendor-lib`（已声明，未嵌套）。",
            },
        ],
        timestamp: ts(7),
    },
];

export const mockSuccessToolCall = {
    id: "tc-ok",
    runId: "run-ok",
    name: "workspace.list_roots",
    arguments: '{"workspaceId":"8f2a1c40"}',
    status: "completed" as const,
    result: '{"roots":[{"rootId":"…0001","role":"primary"},{"rootId":"…00b7","role":"declared"}]}',
    startedAt: ts(7),
    completedAt: ts(7),
};

export const mockRefusedToolCall = {
    id: "tc-refused",
    runId: "run-refused",
    name: "delegate.spawn_worker",
    arguments: '{"role":"reviewer","budget":"unbounded"}',
    status: "completed" as const,
    refusalCode: "DELEGATION_LIMIT_EXCEEDED",
    startedAt: ts(8),
    completedAt: ts(8),
};

export const mockAgents: WorkspaceAgentBinding[] = [
    {
        principalId: "7a10c3e0-0000-4000-8000-0000000000a1",
        name: "Atlas",
        templateId: "tpl-arch",
        templateName: "架构评审",
        createdAt: "2026-10-21T08:00:00Z",
        permissionsSnapshot: [
            { actionClass: "file_read", resource: "workspace" },
            { actionClass: "shell_exec", resource: "workspace" },
        ],
        source: "workspace",
        bound: true,
        disabled: false,
        scope: "WORKSPACE",
        defaultModelProvider: "anthropic",
        defaultModelName: "claude-sonnet-4.5",
        allowedModels: null,
        hooks: null,
    },
    {
        principalId: "7a10c3e0-0000-4000-8000-0000000000a2",
        name: "Nova",
        templateId: "tpl-impl",
        templateName: "实现",
        createdAt: "2026-10-25T11:30:00Z",
        permissionsSnapshot: [{ actionClass: "file_write", resource: "workspace" }],
        source: "personal",
        bound: true,
        disabled: false,
        scope: "PERSONAL",
        defaultModelProvider: "openai",
        defaultModelName: "gpt-5.1",
        allowedModels: [{ provider: "openai", model: "gpt-5.1" }],
        hooks: null,
    },
    {
        principalId: "7a10c3e0-0000-4000-8000-0000000000a3",
        name: "Scribe",
        templateId: null,
        templateName: null,
        createdAt: "2026-09-02T02:10:00Z",
        permissionsSnapshot: [],
        source: "instance",
        bound: false,
        disabled: true,
        scope: "INSTANCE",
        allowedModels: null,
        hooks: null,
    },
];

/**
 * Mock agent-principal role bindings for the M5 T5.2 preview block.
 * `a1` has one editable row plus one seed row; `a2` is deliberately unbound.
 */
export const mockAgentRoleBindings: Record<string, AgentRoleBinding[]> = {
    "7a10c3e0-0000-4000-8000-0000000000a1": [
        {
            bindingId: "arb-a1-1",
            roleId: "role-viewer",
            name: "viewer",
            displayName: "只读",
            scopeType: "workspace",
            scopeId: PREVIEW_WORKSPACE_ID,
            scopeName: "预览工作区",
            isSystem: false,
            grantedBy: "3c55d2b0-0000-4000-8000-0000000000b1",
            atomSummary: ["workspace.file.read"],
            atomCount: 1,
            atomsTruncated: false,
        },
        {
            bindingId: "arb-a1-seed",
            roleId: "role-agent-default",
            name: "agent-default",
            displayName: "默认智能体角色",
            scopeType: "workspace",
            scopeId: PREVIEW_WORKSPACE_ID,
            scopeName: "预览工作区",
            isSystem: true,
            grantedBy: "system:seed",
            atomSummary: ["workspace.file.read"],
            atomCount: 1,
            atomsTruncated: false,
        },
    ],
    "7a10c3e0-0000-4000-8000-0000000000a2": [],
};

/** Hard cap per mock agent — used only to demonstrate the 409 ROLE_BINDING_EXCEEDS_CAP state. */
export const mockAgentRoleCapByAgent: Record<string, string[]> = {
    "7a10c3e0-0000-4000-8000-0000000000a1": ["workspace.file.read", "workspace.file.write"],
    "7a10c3e0-0000-4000-8000-0000000000a2": ["workspace.file.write"],
};

/** Rows follow the current `WorkspaceAgentMemory` wire: `pinned`, `updatedAt`, `content`, `origin`
 *  （V106 删掉了 `type` 分类列，来源字段是 `origin`: manual/run）。 */
export const mockMemories: WorkspaceAgentMemory[] = [
    {
        id: "mem-1",
        origin: "manual",
        pinned: true,
        updatedAt: "2026-11-01T09:00:00Z",
        content: "偏好：先用最小改动验证，再谈重构；提交信息写清根因。",
    },
    {
        id: "mem-2",
        origin: "run",
        pinned: false,
        updatedAt: "2026-10-28T14:20:00Z",
        content: "runtime 的影子库在 `<hostRoot>/.xihe-shadow/<rootId>.git`，每个根一份。",
    },
    {
        id: "mem-3",
        origin: "manual",
        pinned: false,
        updatedAt: "2026-10-19T06:45:00Z",
        content: "CP 的 run_checkpoints 一行代表一个 (run, 根)；主根 root_id == workspace_id。",
    },
];

/** `ProviderConnection` rows — status vocabulary is the real `ProviderConnectionStatus`. */
export const mockConnections: ProviderConnection[] = [
    {
        id: "conn-anthropic",
        providerId: "anthropic",
        connectionKey: "anthropic-primary",
        apiTypeId: "anthropic.messages",
        apiTypeVersion: 1,
        operation: "chat",
        label: "生产",
        scope: "WORKSPACE",
        workspaceId: PREVIEW_WORKSPACE_ID,
        baseUrl: "https://api.anthropic.com",
        modelDiscovery: "remote-models",
        manualModels: [],
        hasKey: true,
        maskedKey: "sk-ant-••••7f2c",
        enabled: true,
        status: "READY",
        lastVerifiedAt: "2026-11-03T09:50:00Z",
        lastErrorCode: null,
        revision: 4,
    },
    {
        id: "conn-zhipu",
        providerId: "zhipu",
        connectionKey: "zhipu-glm",
        apiTypeId: "openai.chat-completions",
        apiTypeVersion: 2,
        operation: "chat",
        label: "智谱 GLM",
        scope: "USER",
        ownerId: "3c55d2b0-0000-4000-8000-0000000000b1",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        modelDiscovery: "curated",
        manualModels: ["glm-4.6"],
        hasKey: true,
        maskedKey: "••••1a9d",
        enabled: true,
        status: "INVALID_CREDENTIALS",
        lastVerifiedAt: "2026-11-03T09:41:00Z",
        lastErrorCode: "PROVIDER_CREDENTIAL_INVALID",
        revision: 2,
    },
    {
        id: "conn-local",
        providerId: "custom",
        connectionKey: "local-vllm",
        apiTypeId: "openai.chat-completions",
        apiTypeVersion: 2,
        operation: "chat",
        label: "本地 vLLM",
        scope: "WORKSPACE",
        workspaceId: PREVIEW_WORKSPACE_ID,
        baseUrl: "http://127.0.0.1:8000/v1",
        modelDiscovery: "manual",
        manualModels: ["qwen3-32b"],
        hasKey: false,
        enabled: false,
        status: "UNVERIFIED",
        lastVerifiedAt: null,
        lastErrorCode: null,
        revision: 1,
    },
];

export const mockApiTypes: ApiTypePair[] = [
    { apiTypeId: "anthropic.messages", version: 1, defaultBaseUrl: "https://api.anthropic.com" },
    {
        apiTypeId: "openai.chat-completions",
        version: 2,
        defaultBaseUrl: "https://api.openai.com/v1",
    },
    { apiTypeId: "openai.embeddings", version: 1, defaultBaseUrl: "https://api.openai.com/v1" },
];

/** `ApiRequestTemplate` (services/apiRequestTemplates.ts) — draft / published rows. */
export const mockRequestTemplates: ApiRequestTemplate[] = [
    {
        id: "tpl-msg-1",
        version: 3,
        name: "Anthropic Messages · 工具调用",
        description: "把 xihe 工具面映射到 messages.tools；草稿改了 stop_reason 解析。",
        apiTypeId: "anthropic.messages",
        apiTypeVersion: 1,
        bodySource: '{"model":"{{model}}","messages":{{messages}},"tools":{{tools}}}',
        status: "draft",
    },
    {
        id: "tpl-msg-1",
        version: 2,
        name: "Anthropic Messages · 工具调用",
        apiTypeId: "anthropic.messages",
        apiTypeVersion: 1,
        bodySource: '{"model":"{{model}}","messages":{{messages}}}',
        status: "published",
    },
    {
        id: "tpl-emb-1",
        version: 1,
        name: "Embeddings · 批量",
        description: "批量 96 条一次请求。",
        apiTypeId: "openai.embeddings",
        apiTypeVersion: 1,
        bodySource: '{"model":"{{model}}","input":{{inputs}}}',
        status: "published",
    },
];

/** `CredentialSummary`/`Credential` row (sanitized metadata only — never a value). */
export const mockCredentials: CredentialSummary[] = [
    {
        id: "cred-1",
        label: "Anthropic 生产密钥",
        kind: "token",
        deliveryTier: "lease",
        ownerType: "WORKSPACE",
        ownerId: PREVIEW_WORKSPACE_ID,
        status: "active",
        fingerprint: "sha256:9c1f…47ab",
        revision: 4,
        createdAt: "2026-09-14T03:12:00Z",
        replacedAt: "2026-11-01T07:40:00Z",
        referenceCount: 2,
    },
    {
        id: "cred-2",
        label: "智谱个人密钥",
        kind: "token",
        deliveryTier: "reveal",
        ownerType: "USER",
        ownerId: "3c55d2b0-0000-4000-8000-0000000000b1",
        status: "active",
        fingerprint: "sha256:31be…08d2",
        revision: 2,
        createdAt: "2026-10-02T11:00:00Z",
        replacedAt: null,
        referenceCount: 1,
    },
    {
        id: "cred-3",
        label: "旧 OpenRouter",
        kind: "token",
        deliveryTier: "reveal",
        ownerType: "USER",
        ownerId: "3c55d2b0-0000-4000-8000-0000000000b2",
        status: "disabled",
        fingerprint: "sha256:77af…c015",
        revision: 1,
        createdAt: "2026-08-08T09:30:00Z",
        replacedAt: null,
        referenceCount: 0,
    },
];

export const mockRoles: ApiRole[] = [
    {
        id: "role-instance-admin",
        name: "instance-admin",
        displayName: "实例管理员",
        description: "实例级全部能力；含凭据与角色绑定管理。",
        system: true,
        atoms: [
            {
                name: "instance.settings.write",
                scopeClass: "instance",
                capability: true,
                resource: "settings",
            },
            {
                name: "credentials.manage",
                scopeClass: "both",
                capability: true,
                resource: "credential",
            },
        ],
        bindingCount: 1,
    },
    {
        id: "role-workspace-owner",
        name: "workspace-owner",
        displayName: "工作区所有者",
        description: "工作区内全部能力，不跨工作区。",
        system: false,
        atoms: [
            {
                name: "workspace.file.write",
                scopeClass: "both",
                capability: true,
                resource: "file",
            },
            {
                name: "workspace.agent.manage",
                scopeClass: "both",
                capability: true,
                resource: "agent",
            },
        ],
        bindingCount: 2,
    },
    {
        id: "role-viewer",
        name: "viewer",
        displayName: "只读",
        description: null,
        system: false,
        atoms: [
            { name: "workspace.file.read", scopeClass: "both", capability: true, resource: "file" },
        ],
        bindingCount: 0,
    },
];

export const mockBindings: ApiBindingSet = {
    scopeType: "workspace",
    scopeId: PREVIEW_WORKSPACE_ID,
    bindings: [
        {
            id: "bind-1",
            subjectType: "user",
            subjectId: "3c55d2b0-0000-4000-8000-0000000000b1",
            roleId: "role-workspace-owner",
            roleName: "workspace-owner",
            grantedBy: "system:instance-admin",
            grantedAt: "2026-09-01T00:00:00Z",
        },
        {
            id: "bind-2",
            subjectType: "agent",
            subjectId: "7a10c3e0-0000-4000-8000-0000000000a1",
            roleId: "role-viewer",
            roleName: "viewer",
            grantedBy: "3c55d2b0-0000-4000-8000-0000000000b1",
            grantedAt: "2026-10-21T08:05:00Z",
        },
    ],
};
