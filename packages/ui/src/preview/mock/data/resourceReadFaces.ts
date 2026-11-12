import type { CredentialEventView, CredentialReference, CredentialSummary } from "../../../types";

/**
 * task-247：`src/preview/mock/api-server.ts` 缺的 5 条资源读面的**夹具**。
 *
 * <p>背景（task-228 §7.3 报备）：资源详情单页 `/resources/<id>/:pk?layer=` 在 preview 车道进不去
 * `ready` —— 它要的三条读面（凭据列表 / 引用 / 审计）与 mcp 工作区层两条读面（stdio 配置 / 会话状态）
 * 在 mock 层没有端点，页面只能落 `error`。当时**没有**为了让页面"看起来没坏"而回空壳 200：空壳会让
 * `ready` 与"夹具缺"长得一样，等于把缺口藏起来。本文件补的是**真形状夹具**。</p>
 *
 * <p>口径（照既有 `data/skills.ts` / `data/instanceResources.ts` 的同一判据）：</p>
 * <ul>
 *   <li>形状逐字照 openapi / CP 响应（`CredentialView` + `referenceCount`、`{references}`、
 *       `{events}`、stdio 的 `{generation,hash,servers}`、mcp 状态的 `{servers,count}`）；</li>
 *   <li>**数量少而真**：2 条凭据（一条有引用+审计、一条两者都空 ⇒ 详情页的"空态"也是真实形态之一）、
 *       1 条 stdio MCP 服务（配置 + 一条 `ready` 会话状态）；</li>
 *   <li>**不伪造"全都有"**：WORKSPACE 层凭据回**合法空集**（mock 工作区确实没有工作区级凭据），
 *       给一条假行会把"该层空态"从预览里抹掉；</li>
 *   <li>值里的 `fingerprint` / 时间戳是**夹具值**，不是任何真实密钥的指纹（该字段本就只做展示）。</li>
 * </ul>
 */

/** 2 条 USER 凭据：一条有引用与审计、一条全空（用来同时看到"区块有内容"与"空态句"）。 */
export const MOCK_CREDENTIALS: CredentialSummary[] = [
    {
        id: "mock-cred-deploy",
        label: "部署令牌",
        kind: "token",
        deliveryTier: "reveal",
        ownerType: "USER",
        ownerId: "mock-user",
        status: "active",
        fingerprint: "fp:6c1a9f",
        revision: 2,
        createdAt: "2026-11-01T09:00:00Z",
        replacedAt: "2026-11-08T10:20:00Z",
        referenceCount: 1,
    },
    {
        id: "mock-cred-archive",
        label: "归档访问密钥",
        kind: "key_pair",
        deliveryTier: "lease",
        ownerType: "USER",
        ownerId: "mock-user",
        status: "active",
        fingerprint: "fp:2d70b4",
        revision: 1,
        createdAt: "2026-11-05T03:00:00Z",
        replacedAt: null,
        referenceCount: 0,
    },
];

/** 引用读面：只在被引用的那条凭据上有内容（另一条走空态句）。 */
const CREDENTIAL_REFERENCES: Record<string, CredentialReference[]> = {
    "mock-cred-deploy": [
        {
            source: "grant",
            subjectType: "agent",
            subjectId: "mock-agent-reviewer",
            actionClass: "credential_use",
            resource: "*",
        },
        {
            source: "workspace_cap",
            subjectType: "workspace",
            subjectId: "mock-ws-main",
            actionClass: "credential_use",
            resource: "*",
        },
    ],
};

/**
 * 审计读面：事件类型用 openapi `getCredentialEvents` 说明里的字面量
 * （created/replaced/deleted/lease_issued/lease_redeemed/revealed），不另造一套事件名。
 */
const CREDENTIAL_EVENTS: Record<string, CredentialEventView[]> = {
    "mock-cred-deploy": [
        {
            id: "mock-ev-deploy-replace",
            eventType: "replaced",
            actor: "mock-user",
            createdAt: "2026-11-08T10:20:00Z",
        },
        {
            id: "mock-ev-deploy-create",
            eventType: "created",
            actor: "mock-user",
            createdAt: "2026-11-01T09:00:00Z",
        },
    ],
};

/** `GET /credentials?ownerType=&ownerId=` 的响应信封（`CredentialList`）。 */
export function mockCredentialList(ownerType: string | null): {
    credentials: CredentialSummary[];
    count: number;
} {
    // 只有 USER 拥有夹具；WORKSPACE 层给合法空集（见文件头判据）。
    if (ownerType === "WORKSPACE") return { credentials: [], count: 0 };
    return { credentials: MOCK_CREDENTIALS, count: MOCK_CREDENTIALS.length };
}

/** `GET /credentials/:id/references`；`null` = 该 id 不存在（调用方回 404，不编空集合）。 */
export function mockCredentialReferences(id: string): CredentialReference[] | null {
    if (!MOCK_CREDENTIALS.some((credential) => credential.id === id)) return null;
    return CREDENTIAL_REFERENCES[id] ?? [];
}

/** `GET /credentials/:id/events?limit=`；`null` = 该 id 不存在。 */
export function mockCredentialEvents(id: string, limit: number): CredentialEventView[] | null {
    if (!MOCK_CREDENTIALS.some((credential) => credential.id === id)) return null;
    return (CREDENTIAL_EVENTS[id] ?? []).slice(0, limit);
}

/**
 * `GET /workspaces/:ws/stdio-servers` 的响应信封：`{generation, hash, servers}`，
 * 条目形状照 CP `ConfigController.plainServers` 原样透出的 stdio 配置对象（`command`/`args`/`env`）。
 */
export function mockStdioServers(): {
    generation: number;
    hash: string;
    servers: Record<string, Record<string, unknown>>;
} {
    return {
        generation: 3,
        hash: "mock-stdio-hash-0001",
        servers: {
            "mock-fs-server": {
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspaces/mock-ws-main"],
                env: {},
            },
        },
    };
}

/**
 * `GET /workspaces/:ws/mcp/servers` 的响应信封：`{servers, count}`，`state` 只用 openapi 列出的
 * 五个字面量（starting/ready/restarting/failed/stopped），这里给最常见的 `ready`。
 */
export function mockMcpServerStatus(): {
    servers: Array<{
        serverId: string;
        state: string;
        attempt: number;
        lastError: string | null;
        sinceMs: number;
        epoch: number;
    }>;
    count: number;
} {
    const servers = [
        {
            serverId: "mock-fs-server",
            state: "ready",
            attempt: 1,
            lastError: null,
            sinceMs: 1_762_000_000_000,
            epoch: 1,
        },
    ];
    return { servers, count: servers.length };
}
