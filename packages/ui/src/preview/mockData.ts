/**
 * Mock data for the real-component UI preview (`preview.html`).
 *
 * Every object below is typed against the **product** types (`src/types/*`,
 * `src/composables/api.ts`, `src/services/apiRequestTemplates.ts`) so the shapes
 * cannot drift from the real contract while staying 100% offline: the preview never
 * calls `/api/v1/**`. Field names mirror `docs/api/openapi.yaml`; nothing here is
 * invented locally.
 */
import type {
    AttachmentFile,
    CredentialSummary,
    Message,
    ProviderRequestFingerprintDiffView,
    ProviderRequestFingerprintView,
    Session,
    SessionMonitorResponse,
    ToolCall,
} from "../types";
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
        // PLAN-0689 D-54: simulates the Session PRIMARY participant projection (no longer a Session column).
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
        bound: true,
        disabled: false,
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
        bound: true,
        disabled: false,
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
        bound: false,
        disabled: true,
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

/* ------------------------------------------------------------------ *
 * PLAN-0679 T3.1: provider-request fingerprint block (`SessionMonitorPanel`).
 * Shapes mirror the OpenAPI `ProviderRequestFingerprint*` schemas; the panel receives
 * these through its fetch seam, so the preview stays offline.
 * ------------------------------------------------------------------ */

export const PREVIEW_FINGERPRINT_RUN_ID = "1c9e4a10-0000-4000-8000-0000000000f1";
export const PREVIEW_FINGERPRINT_BASELINE_ID = "1c9e4a10-0000-4000-8000-0000000000f0";

const mockFingerprintDocument = {
    algo: "sha256",
    dispatchAttempt: 1,
    providerStep: 1,
    layers: {
        systemTemplate: {
            hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            bytes: 1180,
        },
        history: {
            hash: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
            count: 6,
            bytes: 4120,
        },
        userInput: {
            hash: "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae551aff4ec4951b",
            bytes: 184,
        },
        toolSchema: {
            hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            count: 5,
            bytes: 940,
        },
        config: {
            hash: "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7",
            bytes: 96,
        },
    },
    outbound: {
        hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        bytes: 6520,
    },
};

const mockFingerprintRequestMeta = {
    apiTypeId: "openai-compatible",
    apiTypeVersion: 3,
    model: "claude-sonnet-4.5",
    messageCount: 7,
    toolCount: 5,
    bytesTotal: 6520,
    dispatchAttempt: 1,
    providerStep: 1,
    roleHistogram: { human: 3, assistant: 2, tool: 2 },
    systemSources: { templateFilled: true },
};

/** Captured single-run envelope (no `against`). */
export const mockProviderFingerprintView: ProviderRequestFingerprintView = {
    runId: PREVIEW_FINGERPRINT_RUN_ID,
    available: true,
    fingerprint: mockFingerprintDocument,
    request: mockFingerprintRequestMeta,
};

/** Two-run layer diff against the previous turn of the same session. */
export const mockProviderFingerprintDiff: ProviderRequestFingerprintDiffView = {
    againstRunId: PREVIEW_FINGERPRINT_BASELINE_ID,
    runId: PREVIEW_FINGERPRINT_RUN_ID,
    status: "comparable",
    against: {
        ...mockFingerprintRequestMeta,
        model: "claude-sonnet-4.5",
        toolCount: 3,
        bytesTotal: 5210,
    },
    current: mockFingerprintRequestMeta,
    layers: {
        systemTemplate: { layer: "systemTemplate", status: "unchanged" },
        history: { layer: "history", status: "changed(sameShape)", countDelta: 0, bytesDelta: 0 },
        userInput: { layer: "userInput", status: "changed(grew)", bytesDelta: 64 },
        toolSchema: { layer: "toolSchema", status: "added", countDelta: 2 },
        config: { layer: "config", status: "unchanged" },
    },
    outbound: { layer: "outbound", status: "changed(grew)", bytesDelta: 1310 },
    dispatchAttempt: { against: 1, current: 1 },
    summary: { changedLayers: ["history", "userInput", "toolSchema"], unavailableLayers: [] },
};

/** Absence is named, never re-encoded (two-level model, design D5). */
export const mockProviderFingerprintNotCaptured: ProviderRequestFingerprintView = {
    runId: PREVIEW_FINGERPRINT_RUN_ID,
    available: false,
    reason: "not_captured",
};

/** Fail-open error marker stored in place of the document (D8, FINGERPRINT_TOO_LARGE). */
export const mockProviderFingerprintError: ProviderRequestFingerprintView = {
    runId: PREVIEW_FINGERPRINT_RUN_ID,
    available: true,
    fingerprint: { status: "error", reasonCode: "FINGERPRINT_TOO_LARGE" },
    request: mockFingerprintRequestMeta,
};
/**
 * task-83 第三腿：`SessionMonitorPanel` 的 fixture（供 preview 挂真面板量行宽）。
 *
 * 取值刻意取**真实量级**：UUID 36 字符、`errorCode` 用真实码、时间戳用 ISO。
 * 理由：这个面板的 `font-mono` 内容主要是 runId / errorCode / revision 这类**长串**，
 * 若 fixture 用短串，量出来的「不折行」是 fixture 的产物，不是产品的事实。
 *
 * `activity[0]` 非空 ⇒ 面板会把 diagnoseRunId 指向它，预览侧因此同时注入
 * `attemptsFetcher`（返回空 attempts），否则它会去打网络。
 */
export const mockSessionMonitor: SessionMonitorResponse = {
    generatedAt: "2026-11-11T04:30:00.000Z",
    session: {
        id: PREVIEW_SESSION_ID,
        title: "字体栈子集化：等宽第三腿的行宽实量",
        agentPrincipalId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        modelProvider: "openai-compatible",
        modelName: "deepseek-v3.2-exp-20261101",
        providerConnectionId: "conn-0f9e8d7c-6b5a-4f3e-2d1c-0b9a8f7e6d5c",
        connectionRevision: 7,
        createdAt: "2026-11-11T03:10:00.000Z",
        updatedAt: "2026-11-11T04:29:41.000Z",
    },
    activity: [
        {
            runId: "1f0a2b3c-4d5e-4f60-8711-9a0b1c2d3e4f",
            origin: "user_message",
            status: "running",
            createdAt: "2026-11-11T04:29:12.000Z",
            waitingOnRunId: null,
            waitingToolCallId: null,
            leaseExpired: false,
        },
        {
            runId: "2a1b3c4d-5e6f-4071-9822-a0b1c2d3e4f5",
            origin: "tool_call",
            status: "awaiting_approval",
            createdAt: "2026-11-11T04:28:40.000Z",
            waitingOnRunId: "1f0a2b3c-4d5e-4f60-8711-9a0b1c2d3e4f",
            waitingToolCallId: "call_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
            leaseExpired: true,
        },
    ],
    history: {
        windowSize: 20,
        counts: { completed: 18, failed: 2, cancelled: 1 },
        recent: [
            {
                runId: "3b2c4d5e-6f70-4182-9933-b0c1d2e3f4a5",
                origin: "user_message",
                terminalOutcome: "completed",
                errorCode: null,
                createdAt: "2026-11-11T04:10:02.000Z",
                terminalAt: "2026-11-11T04:10:58.000Z",
            },
            {
                runId: "4c3d5e6f-7081-4293-8a44-c1d2e3f4a5b6",
                origin: "tool_call",
                terminalOutcome: "failed",
                errorCode: "PROVIDER_TIMEOUT",
                createdAt: "2026-11-11T04:02:11.000Z",
                terminalAt: "2026-11-11T04:02:44.000Z",
            },
        ],
    },
    readiness: {
        connection: {
            status: "READY",
            lastErrorCode: null,
            lastVerifiedAt: "2026-11-11T04:20:00.000Z",
        },
        agent: {
            status: "ready",
            llmReady: "ready",
            verifiedAt: "2026-11-11T04:20:03.000Z",
            configRevision: "cfg-rev-20261111-0420",
        },
        lastObservedRun: {
            runId: "3b2c4d5e-6f70-4182-9933-b0c1d2e3f4a5",
            terminalOutcome: "completed",
            errorCode: null,
            terminalAt: "2026-11-11T04:10:58.000Z",
        },
    },
    transport: { attemptCount: 12, failedCount: 2, partialCount: 1 },
};

export const LONG_UUID = "9c1f47ab-3d2e-4f81-a6b5-0c7d9e2f4a10";
export const LONG_RUN_ID = "run_9c1f47ab3d2e4f81a6b50c7d9e2f4a10";

// 覆盖「工具卡 / 审批卡 / 原始输出」三类 mono 落点上的**真实长度**：bash 命令行、绝对路径、
// 工具参数 JSON、runId、错误码。取数原则：只用真实形状与真实长度（UUID 36 字符、pnpm 命令、
// POSIX 绝对路径、CP 错误串），不写「看起来很长的假串」—— 假串量出来的折行不代表产品。
// 前 4 张是 POSIX 形态；第 5 张是 Windows 反斜杠形态（边界见该条注释）。
export const mockLongArgsToolCall: ToolCall = {
    id: "tc-long-args",
    runId: LONG_RUN_ID,
    name: "runtime.exec_command",
    arguments: JSON.stringify({
        command:
            "node .tmp/xh/task102/scan-tmp-windows.mjs && rg -n --no-heading -g '*.jsonl' 'tool_call|arguments' H:/zeogit/one/.tmp/xh | head -n 200",
        cwd: "/workspace/A03-xihe/.worktrees/t233-ui-mock/packages/ui",
        timeoutMs: 120000,
        env: { XIHE_E2E_LLM_MODE: "exec_command", XIHE_E2E_SCENARIO: "preview-mono-width-long" },
    }),
    status: "completed",
    result: "scan done: 15317 entries, 3308 files read, 10 hits",
    startedAt: "2026-11-11T05:42:08Z",
    completedAt: "2026-11-11T05:42:19Z",
};

export const mockLongOutputToolCall: ToolCall = {
    id: "tc-long-output",
    runId: LONG_RUN_ID,
    name: "workspace.read_file",
    arguments: JSON.stringify({
        path: "/workspace/A03-xihe/packages/ui/src/preview/mockData.ts",
        offset: 1,
        limit: 2000,
    }),
    status: "completed",
    result: "   1: /**\n   2:  * Mock data for the real-component UI preview (preview.html).\n   3:  *\n   4:  * Every object below is typed against the product types (src/types/*) so the shapes\n   5:  * cannot drift from the real contract while staying 100% offline.\n   6:  */\n   7: import type { AttachmentFile, CredentialSummary, Message, Session } from '../types';\n",
    startedAt: "2026-11-11T05:43:02Z",
    completedAt: "2026-11-11T05:43:05Z",
};

export const mockLongErrorToolCall: ToolCall = {
    id: "tc-long-error",
    runId: LONG_RUN_ID,
    name: "runtime.apply_patch",
    arguments: JSON.stringify({
        patch: "*** Begin Patch\n*** Update File: packages/ui/src/preview/mockData.ts\n@@ export const mockSuccessToolCall @@\n+export const mockLongArgsToolCall: ToolCall = { id: 'tc-long-args' };\n*** End Patch",
    }),
    status: "failed",
    error: "Error: apply_patch rejected (E_PATCH_CONTEXT_MISMATCH): hunk at packages/ui/src/preview/mockData.ts:215 no longer matches; expected context 'export const mockSuccessToolCall' but found 'export const mockLongArgsToolCall'. Retry with a narrower hunk or re-read the file before patching.",
    startedAt: "2026-11-11T05:44:10Z",
    completedAt: "2026-11-11T05:44:12Z",
};

export const mockLongRefusalToolCall: ToolCall = {
    id: "tc-long-refusal",
    runId: LONG_RUN_ID,
    name: "delegate.spawn_worker",
    arguments: JSON.stringify({
        role: "reviewer",
        budget: { max_turns: 24, max_elapsed_seconds: 900, max_tokens: 250000 },
        workspaceId: LONG_UUID,
        correlationId: LONG_RUN_ID,
    }),
    status: "completed",
    refusalCode: "DELEGATION_LIMIT_EXCEEDED",
    startedAt: "2026-11-11T05:45:00Z",
    completedAt: "2026-11-11T05:45:01Z",
};

// Windows 反斜杠形态：**形态样本，不是本产品记录**。内容照抄本地会话转储里的真实工具调用
// （Codex 的 shell 工具审批 JSON；只取内容、不写指针 —— 转储在 gitignored 的 .tmp 下，随时会消失）。
// 它证明：本机真实 tool arguments 里盘符路径就长这样（exe 绝对路径 + 混用分隔符的长命令 + cwd）。
// 它不证明：XH 自己的 exec_command 会产生同样的字段名/字段序 —— 本产品的 Windows 样本仍缺。
export const mockLongWindowsPathToolCall: ToolCall = {
    id: "tc-long-winpath",
    runId: LONG_RUN_ID,
    name: "runtime.exec_command",
    arguments: JSON.stringify({
        command: [
            "C:\\Users\\zeoneo\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\pwsh.exe",
            "-Command",
            "node Temp/xh-series-watchdog.mjs H:/zeogit/one/A03-xihe/.local/worktrees/api-request-rag/packages/agent 120000 uv run --no-sync pytest tests/unit/test_approval_tool.py tests/unit/test_mcp_client.py -q",
        ],
        cwd: "H:\\zeogit\\one",
        environment_id: "local",
    }),
    status: "completed",
    result: "exit 0",
    startedAt: "2026-11-11T05:46:00Z",
    completedAt: "2026-11-11T05:46:09Z",
};

// 正对照（task-102 压力腿可见性）：**单行**超长参数 JSON —— 没有硬换行，折行完全由字宽决定。
// 用途：证明 1.5× 字距压力腿对「break-all 的 pre 块」真的会增行；若这张都不增行，
// 就说明压力腿对这类块失明，chat-long 的「0」必须改写成 n/a。
export const mockLongWrapProbeToolCall: ToolCall = {
    id: "tc-long-wrapprobe",
    runId: LONG_RUN_ID,
    name: "runtime.exec_command",
    arguments: JSON.stringify({
        command:
            "rg -n --no-heading --color never -g '*.ts' -g '*.vue' -g '!node_modules' -e 'data-mono-probe' -e 'measure-mono-width' -e 'letter-spacing' A03-xihe/packages/ui/src A03-xihe/packages/ui/e2e internal/A03-xihe/scripts | sort -u",
        cwd: "/workspace/A03-xihe/packages/ui",
    }),
    status: "completed",
    result: "exit 0",
    startedAt: "2026-11-11T05:50:00Z",
    completedAt: "2026-11-11T05:50:03Z",
};

// 聚合导出：preview 区块一次性渲染全部长串卡；以后加卡只改这一处。
export const mockLongToolCalls: ToolCall[] = [
    mockLongArgsToolCall,
    mockLongOutputToolCall,
    mockLongErrorToolCall,
    mockLongRefusalToolCall,
    mockLongWindowsPathToolCall,
    mockLongWrapProbeToolCall,
];
