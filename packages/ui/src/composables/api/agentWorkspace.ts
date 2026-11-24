/* task-1032：自 composables/api.ts 拆出的 agentWorkspace 段（逐字节搬运）。 */
import { logger } from "../../lib/logger";
import { request } from "./_core";
import { normalizePrincipalHooks, asRecord, catalogLocale, isEnumValue } from "./_normalize";
import type { AgentModelRef, AgentPrincipalHooks } from "./_types";
export interface WorkspaceAgentBinding {
    principalId: string;
    name: string;
    templateId: string | null;
    templateName: string | null;
    createdAt: string;
    /** 工作区绑定的工作区角色；角色绑定的 scope 与主体无关。 */
    permissionsSnapshot: Array<{ actionClass: string; resource?: string }>;
    /**
     * D-1109：这份冻结上限的来源 —— `explicit` = 调用方显式传了数组（`[]` 表示零权限）；
     * `baseline` = 调用方省略字段、由角色基线派生；`null`/缺省 = 该行没有 cap 绑定。
     */
    capSource?: "baseline" | "explicit" | null;
    /** 是否存在该工作区的 cap 绑定；角色绑定可使未绑定行可见。 */
    bound: boolean;
    /** 主体被禁用后不能用于新会话。 */
    disabled: boolean;
    /**
     * task-116：该主体是本工作区的默认智能体（CP `GET /agents` 透出，迁移 V177）。
     * 读面唯一来源是这份列表 —— UI 不缓存、不做乐观默认，取消后再新建必须回到选择框。
     */
    isDefault?: boolean;
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
    /** `null`/缺省 = 不限制可用模型集。 */
    allowedModels?: AgentModelRef[] | null;
    /** PLAN-0625 M3（V96）：hook 订阅；`null`/缺省 = 无订阅（不渲染订阅行）。 */
    hooks?: AgentPrincipalHooks | null;
    /**
     * 主体 `contextPolicy`（CP `AgentPrincipalView`）。UI 只为「启用记忆」开关读写它的
     * `memory.enabled`：PATCH 是**整对象替换**，所以必须与这里的现值合并后再发。
     */
    contextPolicy?: Record<string, unknown> | null;
}
export interface AgentRoleBinding {
    bindingId: string;
    roleId: string;
    name: string;
    displayName?: string | null;
    scopeType: string;
    scopeId?: string | null;
    scopeName?: string | null;
    isSystem: boolean;
    /** 绑定的授予者（wire 已有；UI 只展示短 ID，不请求用户资料）。 */
    grantedBy?: string | null;
    atomSummary: string[];
    atomCount: number;
    atomsTruncated: boolean;
}
export interface WorkspaceAgentPermission {
    actionClass: string;
    resource?: string;
}
export interface WorkspaceAgentEffectiveCap {
    principalId: string;
    workspaceId: string;
    effectiveCap: WorkspaceAgentPermission[];
    capSource: { binding: "binding-snapshot" | "role-binding" };
    /**
     * task-91（Q-112 档 B）：`grantSources` = `grantId → source`（词表 SSOT = `docs/api/openapi.yaml`
     * 的 `EffectiveCapView.provenance.grantSources.additionalProperties.enum`，CP 真身
     * `.../cp/policy/GrantSources.java`）。**键集 == 两个数组的并集**，空集为 `{}`。
     *
     * <p>两种容错口径（都不许静默丢）：**整字段缺失** = 旧 CP 滚动部署窗口 ⇒ 解析为 `{}`（全渲染「来源未知」）；
     * **形状错**（非对象 / 值非 string）⇒ 抛 malformed，不退化成 `{}`。</p>
     */
    provenance: {
        principalGrantIds: string[];
        bindingGrantIds: string[];
        grantSources: Record<string, string>;
    };
    defaultGrants: { readFace: string[] };
    bound: boolean;
}
export interface WorkspaceAgentCapResponse {
    principalId: string;
    workspaceId: string;
    permissions: WorkspaceAgentPermission[];
    /** D-1109：本次写入的来源（`baseline` = 省略字段继承角色基线；`explicit` = 显式数组）。 */
    capSource?: "baseline" | "explicit";
}

export const agentWorkspaceApi = {
    async getWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentBinding[]> {
        const raw = await request<{ agents: Array<Record<string, unknown>> }>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents`,
        );
        // hooks 经 fail-closed 解析（V96：null=无订阅；畸形=视为无订阅 + warn）。
        //
        // `permissionsSnapshot` 在 `WorkspaceAgentView` 里是 required，但**单行**畸形不能让
        // 整张列表失去更新：面板的能力列表读 `.length`，一旦是 undefined，渲染函数抛错 ⇒ Vue
        // 放弃本次更新，DOM 停在上一个「正在加载智能体…」帧，加载结束也永远看不出来。这里把
        // 缺字段降级为「没有冻结上限」并留 warn，让加载终态与失败原因都能被用户看到。
        return raw.agents.map((agent) => {
            const snapshot = agent.permissionsSnapshot;
            if (!Array.isArray(snapshot)) {
                logger.warn("[agents] permissionsSnapshot missing; treated as empty");
            }
            return {
                ...(agent as unknown as WorkspaceAgentBinding),
                permissionsSnapshot: Array.isArray(snapshot)
                    ? (snapshot as WorkspaceAgentBinding["permissionsSnapshot"])
                    : [],
                // task-116：默认标记只认 wire 上的布尔（缺字段/畸形一律 false，不猜）。
                isDefault: agent.isDefault === true,
                hooks: normalizePrincipalHooks(agent.hooks),
                // 「启用记忆」开关要读现值并整对象回写，故这里原样保留 CP 的 contextPolicy。
                contextPolicy: asRecord(agent.contextPolicy) ?? null,
            } as WorkspaceAgentBinding;
        });
    },
    async getAgentRoles(
        workspaceId: string | null | undefined,
        principalId: string,
    ): Promise<AgentRoleBinding[]> {
        const workspaceQuery = workspaceId ? `workspaceId=${encodeURIComponent(workspaceId)}&` : "";
        const raw = await request<{
            items?: Array<Record<string, unknown>>;
            bindings?: Array<Record<string, unknown>>;
        }>(
            `/agent-principals/${encodeURIComponent(principalId)}/presets?${workspaceQuery}locale=${encodeURIComponent(catalogLocale())}`,
        );
        // 实际 CP wire（2026-11-05 联调实测）用 `{bindings:[…]}`；冻结稿写的是 `{items:[…]}`。
        // 两种信封都接受，字段同时兼容 roleName/roleDisplayName 与 name/displayName。
        const rows = raw?.items ?? raw?.bindings;
        if (!Array.isArray(rows)) {
            logger.warn("[agents] role envelope malformed; treated as empty");
            return [];
        }
        return rows.flatMap((row) => {
            const bindingId = typeof row.bindingId === "string" ? row.bindingId : "";
            // task-843: the wire key is `presetId`; `AgentRoleBinding.roleId` is the UI projection.
            const roleId = typeof row.presetId === "string" ? row.presetId : "";
            const name =
                typeof row.roleName === "string"
                    ? row.roleName
                    : typeof row.name === "string"
                      ? row.name
                      : "";
            if (!bindingId || !roleId || !name) return [];
            const rawAtoms = Array.isArray(row.atoms)
                ? row.atoms
                : Array.isArray(row.atomSummary)
                  ? row.atomSummary
                  : [];
            const atoms = rawAtoms.filter((atom): atom is string => typeof atom === "string");
            // D5(b)：UI 只展示前 3 个 + 总数，不铺全集。
            const atomSummary = atoms.slice(0, 3);
            const atomCount =
                typeof row.atomCount === "number" && Number.isFinite(row.atomCount)
                    ? row.atomCount
                    : atoms.length;
            return [
                {
                    bindingId,
                    roleId,
                    name,
                    displayName:
                        typeof row.roleDisplayName === "string"
                            ? row.roleDisplayName
                            : typeof row.displayName === "string"
                              ? row.displayName
                              : null,
                    scopeType: typeof row.scopeType === "string" ? row.scopeType : "",
                    scopeId: typeof row.scopeId === "string" ? row.scopeId : null,
                    scopeName: typeof row.scopeName === "string" ? row.scopeName : null,
                    isSystem: row.isSystem === true,
                    grantedBy: typeof row.grantedBy === "string" ? row.grantedBy : null,
                    atomSummary,
                    atomCount,
                    atomsTruncated: row.atomsTruncated === true || atomCount > atomSummary.length,
                },
            ];
        });
    },
    async bindAgentRole(
        workspaceId: string | null | undefined,
        principalId: string,
        roleId: string,
    ): Promise<void> {
        const workspaceQuery = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
        await request<void>(
            `/agent-principals/${encodeURIComponent(principalId)}/presets${workspaceQuery}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ presetId: roleId }),
            },
        );
    },
    async unbindAgentRole(
        workspaceId: string | null | undefined,
        principalId: string,
        bindingId: string,
    ): Promise<void> {
        const workspaceQuery = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
        await request<void>(
            `/agent-principals/${encodeURIComponent(principalId)}/presets/${encodeURIComponent(bindingId)}${workspaceQuery}`,
            { method: "DELETE" },
        );
    },
    updateWorkspaceAgentCap(
        workspaceId: string,
        principalId: string,
        permissions?: WorkspaceAgentPermission[],
    ): Promise<WorkspaceAgentCapResponse> {
        return request<WorkspaceAgentCapResponse>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}`,
            {
                method: "PUT",
                body: JSON.stringify(permissions === undefined ? {} : { permissions }),
            },
        );
    },
    deleteWorkspaceAgent(workspaceId: string, principalId: string): Promise<void> {
        return request<void>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}`,
            { method: "DELETE" },
        );
    },
    setWorkspaceAgentDefault(workspaceId: string, principalId: string): Promise<void> {
        return request<void>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}/default`,
            { method: "PUT" },
        );
    },
    clearWorkspaceAgentDefault(workspaceId: string, principalId: string): Promise<void> {
        return request<void>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}/default`,
            { method: "DELETE" },
        );
    },
    async getWorkspaceAgentEffectiveCap(
        workspaceId: string,
        principalId: string,
    ): Promise<WorkspaceAgentEffectiveCap> {
        const raw = await request<unknown>(
            `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}/effective-cap`,
        );
        const record = asRecord(raw);
        const capSource = asRecord(record?.capSource);
        const provenance = asRecord(record?.provenance);
        const defaultGrants = asRecord(record?.defaultGrants);
        const binding = capSource?.binding;
        const grantIds = (value: unknown): string[] | null =>
            Array.isArray(value) && value.every((item) => typeof item === "string")
                ? (value as string[])
                : null;
        /**
         * task-91：`grantId → source` 的解析。**必须显式处置**——此前重建对象只带两个数组，
         * CP 发来的 `grantSources` 会被**静默丢弃**（不抛错、不渲染、单测全绿），这是本卡第一优先缺陷。
         * `undefined` ⇒ `{}`（旧 CP 容忍）；`null`/数组/值非 string ⇒ `null` ⇒ 走 malformed。
         */
        const grantSourceMap = (value: unknown): Record<string, string> | null => {
            if (value === undefined) return {};
            if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
            const labels: Record<string, string> = {};
            for (const [grantId, source] of Object.entries(value as Record<string, unknown>)) {
                if (typeof source !== "string") return null;
                labels[grantId] = source;
            }
            return labels;
        };
        const principalGrantIds = grantIds(provenance?.principalGrantIds);
        const bindingGrantIds = grantIds(provenance?.bindingGrantIds);
        const grantSources = grantSourceMap(provenance?.grantSources);
        const readFace = grantIds(defaultGrants?.readFace);
        // `EffectiveCapView` 顶层仍是 **7 个字段**（数清它们就不用再猜；加子字段时此数字不变）：
        // principalId / workspaceId / effectiveCap / capSource / provenance / defaultGrants / bound。
        // `provenance` 的三个子键在此一并校验：principalGrantIds / bindingGrantIds / grantSources
        // —— 所以下面那句报错里的数字说的是**顶层**计数，不是子字段数（文案字节不动）。
        if (
            !record ||
            typeof record.principalId !== "string" ||
            typeof record.workspaceId !== "string" ||
            !Array.isArray(record.effectiveCap) ||
            !isEnumValue(binding, ["binding-snapshot", "role-binding"] as const) ||
            principalGrantIds === null ||
            bindingGrantIds === null ||
            grantSources === null ||
            readFace === null ||
            typeof record.bound !== "boolean"
        ) {
            throw new Error(
                "effective-cap response is malformed (EffectiveCapView requires 7 fields)",
            );
        }
        // 原子逐项校验：`{actionClass, resource?}`（resource 只在存在时给，同 toValue:322-335）。
        const effectiveCap: WorkspaceAgentPermission[] = record.effectiveCap.map((item) => {
            const atom = asRecord(item);
            if (!atom || typeof atom.actionClass !== "string") {
                throw new Error("effective-cap atom is malformed");
            }
            return typeof atom.resource === "string"
                ? { actionClass: atom.actionClass, resource: atom.resource }
                : { actionClass: atom.actionClass };
        });
        return {
            principalId: record.principalId,
            workspaceId: record.workspaceId,
            effectiveCap,
            capSource: { binding },
            provenance: { principalGrantIds, bindingGrantIds, grantSources },
            defaultGrants: { readFace },
            bound: record.bound,
        };
    },
};
