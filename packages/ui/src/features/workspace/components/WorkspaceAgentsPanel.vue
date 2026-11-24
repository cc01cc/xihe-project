<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { bareAtom } from "../../../stores/auth";
import { mergeMemoryEnabled, readMemoryEnabled, readMemoryTypesMissing } from "./memoryPolicy";
import { formatDateTime } from "../../../lib/dateFormat";
import { logger } from "../../../lib/logger";
import { grantSourceLabelKey } from "../../../i18n/grantSourceLabels";
import {
    ApiError,
    api,
    request,
    type AgentRoleBinding,
    type AgentSkillBinding,
    type ApiPreset,
    type DelegateSpawnSessions,
    type SelfPermissionsView,
    type WorkspaceAgentBinding,
    type WorkspaceAgentEffectiveCap,
    type WorkspaceAgentMemory,
    type WorkspaceAgentPermission,
} from "../../../composables/api";
import { causeErrorToastText, presentCauseError, withErrorCode } from "../../../lib/errorMessages";
import { listInstanceAgents } from "../../../services/instanceResources";
import AgentPrincipalDetailDrawer, {
    type AgentPrincipalDetail,
} from "../../../components/settings/AgentPrincipalDetailDrawer.vue";
import { type AgentSkillCandidate, selectSkillCandidates } from "./agentSkillCandidates";
// 用户裁定（2026-11-03）：二态统一用项目 Switch（reka-ui），不混用 checkbox。
import { Switch } from "../../../components/ui/switch";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../../../components/ui/select";

/**
 * PLAN-0626 M3 (D26-05): the workspace Agent management surface — the same body the old
 * `WorkspaceAgentManagementDialog` rendered, but without a modal of its own.
 *
 * It has exactly two hosts and they are mutually exclusive:
 * - the dock's `agents` tab (desktop, `WorkspaceWorkbench` → `WorkspaceAgentsPanel`);
 * - the mobile modal shell (`WorkspaceAgentManagementDialog`, `v-if="isMobileViewport"`),
 *   because a mobile viewport has no dock at all.
 * Neither host renders the other, so every testid below exists **once** in the DOM — the
 * 2026-11-02 duplicate-mount incident (same testid ×2 → strict-mode violations and
 * long-lived false passes) must not come back. The component owns no `open` prop: mounting
 * *is* opening, which is why the loads moved from `watch(open)` to `onMounted`.
 */
const props = defineProps<{
    workspaceId: string;
    /**
     * task-44（D-1440 / A 方案）：**深链落点要展开目标主体，不是只到面板顶**（卡面判据④）。
     *
     * <p>面板自己不读 URL —— 它有三个宿主（workbench dock 页签、mobile 管理弹窗、
     * `/resources/agents`），其中两个没有路由，让面板去读 `useRoute()` 等于把「谁在导航」
     * 这条知识塞进最里层。所以由宿主把 id 传进来，面板只负责「展开这一行」。</p>
     */
    expandPrincipalId?: string | null;
}>();

const { t } = useI18n();
const actionClasses = ["read", "write", "delete", "exec", "network", "credential"] as const;
const agents = ref<WorkspaceAgentBinding[]>([]);
const loading = ref(false);
const saving = ref(false),
    error = ref(""),
    status = ref(""),
    /**
     * task-116：默认智能体的写入面。`defaultAgentBusy` 记哪个主体在途（只禁用那一行，
     * 不整列锁死）；`defaultAgentError` 只存可读文案 —— 错误码与英文 detail 交 logger 留痕。
     */
    defaultAgentBusy = ref<string | null>(null),
    defaultAgentError = ref("");
/**
 * task-928（用户裁定 2026-11-24）：工作区**只能绑定**智能体主体，不能创建主体 ——
 * 「工作区里创建出来的成员不受组织管理」。候选来自 task-930 的 `?includeBindable=true`；
 * 该读面与绑定写面共用 `MANAGE_WORKSPACE_AGENTS`，缺原子时**整请求 403**（不泄露主体名）。
 *
 * <p>候选行字段是 `ownership`（`USER`/`INSTANCE`），不是 `scope`；`isDefault` 是该面上
 * 结构性派生的值；`disabled` 行带 `bindable=false` + `AGENT_PRINCIPAL_DISABLED`。
 * **403 与「没有候选」是两件事**：前者是权限，后者是状态，绝不能都渲染成空列表。</p>
 */
interface WorkspaceAgentBindableCandidate {
    principalId: string;
    name: string;
    ownership: string;
    disabled: boolean;
    isDefault: boolean;
    bindable: boolean;
    unbindableReason: string | null;
}
const candidates = ref<WorkspaceAgentBindableCandidate[]>([]);
const candidatesState = ref<"loading" | "ready" | "forbidden" | "failed">("loading");
const candidatesErrorCode = ref("");
const permissions = ref<WorkspaceAgentPermission[]>([]),
    editingPrincipalId = ref<string | null>(null),
    // task-469：live 生效权限面（详情/编辑区打开时读一次；与快照并存，见 loadEffectiveCap）。
    effectiveCap = ref<WorkspaceAgentEffectiveCap | null>(null),
    effectiveCapLoading = ref(false),
    effectiveCapError = ref(""),
    /**
     * 47A（D-1109）：上限的**两种来源在 wire 上是不同语义**，所以用三态而不是一个 flag ——
     * `inherit` = **省略** `permissions`（CP 记 `capSource=baseline`）；
     * `explicit` = 传数组，其中 `[]` 是**零权限**而不是「用基线」（46C 已否决）。
     */
    capMode = ref<"inherit" | "explicit">("explicit");
/**
 * task-91（Q-112 档 B）：逐 grant id 的来源标签（消费 task-87 的 `provenance.grantSources`）。
 *
 * <p>id 取两个数组的并集并去重（契约说并集；若漂移成同一 id 出现在两边，也只渲染一次）。
 * **缺键 / 词表外值都不许吞掉这条 grant**：缺键显示「来源未知」，词表外值原样直出再追加
 * 「来源未知」——显示 wire 真值比显示一个猜错的来源诚实。</p>
 */
const effectiveCapProvenanceChips = computed(() => {
    const cap = effectiveCap.value;
    if (!cap) return [];
    const ids = [
        ...new Set([...cap.provenance.principalGrantIds, ...cap.provenance.bindingGrantIds]),
    ];
    const unknown = t("workspace.agentEffectiveCapSource.unknown");
    return ids.map((grantId) => {
        const raw = cap.provenance.grantSources[grantId];
        if (raw === undefined) return { grantId, label: unknown, labelled: false };
        const key = grantSourceLabelKey(raw);
        return key
            ? { grantId, label: t(key), labelled: true }
            : { grantId, label: `${raw} · ${unknown}`, labelled: false };
    });
});
const effectiveCapProvenanceLabelled = computed(() => ({
    labelled: effectiveCapProvenanceChips.value.filter((chip) => chip.labelled).length,
    unknown: effectiveCapProvenanceChips.value.filter((chip) => !chip.labelled).length,
}));
/**
 * PLAN-0629 M1-4 C：只读「记忆」区。同一时刻只展开一个主体的记忆（一次一个请求），
 * 展开状态与数据都留在本组件内——不新建 store、不做缓存，只读面按需拉取。
 */
const memoryPrincipalId = ref<string | null>(null);
const memories = ref<WorkspaceAgentMemory[]>([]);
const memoryState = ref<"idle" | "loading" | "ready" | "failed">("idle");
const memoryError = ref("");
/** 在途请求代号：切主体/收起/关弹窗后，旧响应必须被丢弃（不覆盖新状态）。 */
let memoryRequestGeneration = 0;
/**
 * PLAN-0629 M1-5：记忆写入面状态（不新建 store）。
 *
 * 用户裁定（2026-11-03 v2）：条目不再有 profile/fact 分类；删除=归档（软删）；
 * 二态控件统一用项目 Switch；「启用记忆」写 `contextPolicy.memory.enabled`；
 * 「显示已归档」透传 `?status=`（CP 未提供时优雅降级为只读 active）。
 */
const memoryCreateOpen = ref(false);
const memoryCreateContent = ref("");
const memoryCreatePinned = ref(false);
const memoryEditingId = ref<string | null>(null);
const memoryEditContent = ref("");
const memoryEditPinned = ref(false);
const memoryPendingArchiveId = ref<string | null>(null);
const memoryWriteBusy = ref(false);
const memoryActionError = ref("");
const memoryToggleBusy = ref(false);
const memoryToggleError = ref("");
/** 「显示已归档」开关：默认只看 active。 */
const showArchivedMemories = ref(false);

/**
 * PLAN-0667 M3：角色 / 技能区块（与记忆区同处，按 agent 展开；一次展开同时加载两者）。
 * 写权限沿用 `MANAGE_WORKSPACE_AGENTS`（design §2 决策归属）；无权限只禁用并说明，不报错。
 */
const rbacPrincipalId = ref<string | null>(null);
const agentRoles = ref<AgentRoleBinding[]>([]);
const agentSkills = ref<AgentSkillBinding[]>([]);
const rbacState = ref<"idle" | "loading" | "ready" | "failed">("idle");
const rbacError = ref("");
const roleCandidates = ref<ApiPreset[]>([]);
const skillCandidates = ref<AgentSkillCandidate[]>([]);

function roleChoiceLabel(): string {
    const role = roleCandidates.value.find((candidate) => candidate.id === selectedRoleId.value);
    return role ? role.displayName || role.name : t("workspace.agentRoleSelectPlaceholder");
}

function skillChoiceLabel(): string {
    const skill = skillCandidates.value.find(
        (candidate) => candidate.skillId === selectedSkillId.value,
    );
    return skill ? skill.name : t("workspace.agentSkillSelectPlaceholder");
}

const selectedRoleId = ref("");
const selectedSkillId = ref("");
const rbacBusy = ref(false);
const rbacActionError = ref("");
let rbacGeneration = 0;

/**
 * task-959 / R38：**本工作区的 MCP 可见集**。
 *
 * <p>MCP server 是工作区级资源（`GET /workspaces/{id}/mcp-config`）—— 同一主体在不同工作区
 * 看到的 server 集不同，所以配置入口只在工作区面出现，不塞进跨层的详情抽屉
 * （task-153 C1=B 已裁定「工作区绑定面不进抽屉」）。读面只要求成员身份，写授权仍在
 * 权限原子层（`read × mcp:&lt;serverId&gt;` 是 D-1921 的网关门）；本区不复制判定。</p>
 */
/**
 * task-984：**读面给出的规范 id 是唯一可写值**。原始 key 只用于展示 —— 之前这里把 key 直接
 * 拼成 `mcp:<raw>`，遇到大写/空格/非 ASCII 时被 CP 的 `GrantResourcePattern` 以 400
 * 「the server id is not canonical」拒掉。缺 `canonicalId` 的行一律不可勾选（不静默回退原文）。
 */
interface McpServerOption {
    name: string;
    canonicalId: string | null;
}

const mcpServers = ref<McpServerOption[]>([]);
const mcpState = ref<"idle" | "loading" | "ready" | "failed">("idle");
const mcpError = ref("");
let mcpGeneration = 0;

/** 访问预设（只读模板）：导入的是它**当前的原子集合**，导入后逐项独立可改（R39/D-1936）。 */
const selectedPresetId = ref("");
const presetImportMessage = ref("");

function gatewayActionsHeldByActor(): string[] {
    const held = new Set([...workspaceAtoms.value, ...instanceAtoms.value]);
    return ["read", "write", "delete", "exec", "network", "PLUGIN_INVOKE"].filter((action) =>
        held.has(action),
    );
}

function mcpResource(server: McpServerOption): string | null {
    return server.canonicalId ? `mcp:${server.canonicalId}` : null;
}

function isMcpServerSelectable(server: McpServerOption): boolean {
    return server.canonicalId !== null;
}

function hasMcpGrant(server: McpServerOption): boolean {
    const resource = mcpResource(server);
    return (
        resource !== null &&
        permissions.value.some((permission) => permission.resource === resource)
    );
}

/**
 * 「允许该主体经此 MCP server」= 给操作者自己持有的网关动作各补一条 `mcp:<serverId>` 通道
 * 授权。对象资源仍由下面那组动作勾选单独约束（D-1921 的 AND 门：`action × object` 与
 * `action × mcp:<id>` 必须同时命中）。操作者没持有的动作不会替它授出去。
 */
function toggleMcpGrant(server: McpServerOption, checked: boolean): void {
    const resource = mcpResource(server);
    if (resource === null) return;
    const withoutServer = permissions.value.filter(
        (permission) => permission.resource !== resource,
    );
    if (!checked) {
        permissions.value = withoutServer;
        return;
    }
    const actions = gatewayActionsHeldByActor();
    permissions.value = [
        ...withoutServer,
        ...actions.map((actionClass) => ({ actionClass, resource })),
    ];
}

/** 预设原子 → 权限草稿行：只收可授予工作区、非 capability、非 `$request` 的动作原子。 */
function presetDraftRows(preset: ApiPreset): Array<{ actionClass: string; resource: string }> {
    return preset.atoms.flatMap((atom) => {
        if (atom.capability || atom.agentPrincipalForbidden || atom.scopeClass === "instance") {
            return [];
        }
        if (atom.resource === "$request") return [];
        const actionClass = bareAtom(atom.name);
        return actionClass === null ? [] : [{ actionClass, resource: atom.resource }];
    });
}

/**
 * 导入预设 = 把模板**当时的原子**展开成具体授权行，写进可继续编辑的草稿。
 *
 * <p>用户裁定（R39）：「预设只是一个模板，它并没有任何的约束力」—— 所以这里不绑定角色、
 * 不锁住选项；导入后每一行都能单独删除或改资源。真正落库仍是现有的「保存权限」写门。</p>
 */
function importPresetAtoms(): void {
    const preset = roleCandidates.value.find(
        (candidate) => candidate.id === selectedPresetId.value,
    );
    presetImportMessage.value = "";
    if (!preset) return;
    const keyOf = (permission: { actionClass: string; resource?: string }) =>
        `${bareAtom(permission.actionClass) ?? permission.actionClass}|${permission.resource ?? "*"}`;
    const seen = new Set(permissions.value.map(keyOf));
    const added = presetDraftRows(preset).filter((row) => {
        const key = keyOf(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    permissions.value = [...permissions.value, ...added];
    capMode.value = "explicit";
    presetImportMessage.value = t("workspace.agentPresetImportDone", { count: added.length });
}

async function loadMcpServers() {
    const generation = ++mcpGeneration;
    mcpState.value = "loading";
    mcpError.value = "";
    try {
        const doc = await api.getMcpConfig(props.workspaceId);
        if (generation !== mcpGeneration) return;
        let servers = doc.mcpServers;
        if (typeof servers === "string") {
            const parsed: unknown = servers.trim() === "" ? {} : JSON.parse(servers);
            servers = isPlainObject(parsed) ? (parsed as Record<string, unknown>) : {};
        }
        const canonicalIds = isPlainObject(doc.canonicalIds) ? doc.canonicalIds : {};
        mcpServers.value =
            servers && typeof servers === "object" && !Array.isArray(servers)
                ? Object.keys(servers)
                      .filter((name) => name.trim() !== "")
                      .map((name) => {
                          const canonical = canonicalIds[name];
                          return {
                              name,
                              canonicalId:
                                  typeof canonical === "string" && canonical.trim() !== ""
                                      ? canonical
                                      : null,
                          };
                      })
                : [];
        mcpState.value = "ready";
    } catch (cause) {
        if (generation !== mcpGeneration) return;
        mcpState.value = "failed";
        mcpError.value = presentCauseError(t, cause, t("workspace.agentMcpFailed")).copy;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * task-134（D-1785）：**委派的子会话**（面板第四小节，只读）。
 *
 * <p>数字只能来自 CP 的 workspace 级权威读面。拿 `GET /sessions` 再在前端筛是**静默偏低**：
 * 那个列表是调用者的可见集（owner / 受邀 HUMAN），多人工作区里「别人会话中该主体派出的子会话」
 * 根本不在里面 —— 于是界面会显示 0 而事实不是 0（D-1782 的第三级错）。</p>
 *
 * <p>两条独立不变量（Lead 2026-11-17 裁定）：**计数面不看可读性**（否则少报）；
 * **内容面只给可读行的 title**（PLAN-0668 D1b，管理者无内容读）。所以数字一律取 `counts`，
 * **不用 `sessions.length`**（会被 limit 截断），不可读行只显示「该会话对你不可见」。</p>
 *
 * <p>失败面也是判据：403 必须显式说「无权查看」，失败说「取不到」——**都不许回落成 0**。
 * 本区自己一份展开状态（`spawnPrincipalId`），不借用 `rbacPrincipalId`。</p>
 */
const spawnPrincipalId = ref<string | null>(null);
const spawnSessions = ref<DelegateSpawnSessions | null>(null);
const spawnState = ref<"idle" | "loading" | "ready" | "forbidden" | "failed">("idle");
const spawnError = ref("");
const spawnIncludeArchived = ref(false);
/** 在途请求代号：切主体/收起后旧响应必须作废（不覆盖新状态）。 */
let spawnGeneration = 0;

function toggleSpawnSessions(principalId: string): void {
    if (spawnPrincipalId.value === principalId) {
        spawnPrincipalId.value = null;
        spawnSessions.value = null;
        spawnState.value = "idle";
        spawnGeneration += 1;
        return;
    }
    spawnPrincipalId.value = principalId;
    spawnSessions.value = null;
    spawnIncludeArchived.value = false;
    void loadSpawnSessions(principalId);
}

async function loadSpawnSessions(principalId: string): Promise<void> {
    const generation = ++spawnGeneration;
    spawnState.value = "loading";
    spawnError.value = "";
    try {
        const result = await api.listWorkspaceAgentSpawnSessions(props.workspaceId, principalId, {
            includeArchived: spawnIncludeArchived.value,
        });
        if (generation !== spawnGeneration || spawnPrincipalId.value !== principalId) return;
        spawnSessions.value = result;
        spawnState.value = "ready";
    } catch (cause) {
        if (generation !== spawnGeneration || spawnPrincipalId.value !== principalId) return;
        spawnSessions.value = null;
        // 403 是权限面的结论（VIEWER 没有成员名册读面）：说「无权查看」，绝不说「0 个」。
        if (cause instanceof ApiError && cause.problem.status === 403) {
            spawnState.value = "forbidden";
            return;
        }
        spawnState.value = "failed";
        spawnError.value = presentCauseError(
            t,
            cause,
            t("workspace.agentDelegatedUnavailable"),
        ).copy;
        logger.warn("[agents] delegated child sessions load failed", { principalId, cause });
    }
}

function toggleSpawnArchived(principalId: string): void {
    spawnIncludeArchived.value = !spawnIncludeArchived.value;
    void loadSpawnSessions(principalId);
}

/** 折叠态摘要：只显示**已读到**的数字，没读过就留空（不编 0）。 */
function spawnSummary(principalId: string): string {
    if (spawnPrincipalId.value !== principalId || !spawnSessions.value) return "";
    return t("workspace.agentDelegatedCount", { count: spawnSessions.value.counts.all });
}

/** 有读不到的行 ⇒ 明写「只显示数量」，而不是让列表看起来"只有这些"。 */
const spawnHasRedacted = computed<boolean>(() =>
    (spawnSessions.value?.sessions ?? []).some((row) => !row.readable),
);

/** 绑定/解绑的可用性：沿用工作区 agent 管理原子；`null` = 能力投影未回（禁用但不谎报）。 */
const canBindRbac = computed<boolean | null>(() => canManageWorkspaceAgents.value);
/** CP 未支持 `?status=` 时降级：开关置灰并说明，列表仍读 active（不报错、不造参数）。 */
const archiveStatusSupported = ref(true);
const unbindConfirmationId = ref<string | null>(null);
const disableConfirmationId = ref<string | null>(null);
/**
 * PLAN-0622：写操作的可用性**只看 CP 权威能力投影** `GET /me/permissions` 的原子：
 * - `MANAGE_WORKSPACE_AGENTS`（workspace 层、resource=本工作区 UUID）→ 能绑定 / 解绑 / 改上限 / 禁用；
 * - `CREATE_ACCOUNT`（instance 层、resource `*`）→ 能建 INSTANCE。
 * （BL-312：原 `CREATE_OWN_AGENT`（user 层 → PERSONAL）原子已随 2026-11-09 裁定移除，
 * 创建门不再有 user 层通道。）
 *
 * `capabilityState`：`loading` 时按钮保持禁用（fail-closed），`failed` 时同样禁用并显示原因——
 * 绝不出现"点了才发现没权限"。
 */
const capabilityState = ref<"loading" | "ready" | "failed">("loading");
const instanceAtoms = ref<string[]>([]);
const workspaceAtoms = ref<string[]>([]);

/** 绑定 / 编辑 cap / 禁用都需要工作区级 MANAGE_WORKSPACE_AGENTS（个人 agent 的属主另论）。 */
const canManageWorkspaceAgents = computed<boolean | null>(() => {
    if (capabilityState.value !== "ready") return null;
    return workspaceAtoms.value.includes("MANAGE_WORKSPACE_AGENTS");
});

/** 当前默认主体 id（空串 = 列表里没有默认值 ⇒ 显示「还没有默认」提示）。 */
const defaultAgentId = computed<string>(
    () => agents.value.find((agent) => agent.isDefault === true)?.principalId ?? "",
);

/**
 * PLAN-0629 M1-5：记忆写入要 CP 的 `MEMORY_WRITE` 原子（不是角色名、不借用 agent 管理权限）。
 * `null` = 能力投影还没回来（控件禁用但不谎报无权限）。
 */
const canWriteMemories = computed<boolean | null>(() => {
    if (capabilityState.value !== "ready") return null;
    return workspaceAtoms.value.includes("MEMORY_WRITE");
});

/**
 * task-928 / 卡面要求 2：显式勾选权限**提交前**就要本地预判。
 *
 * <p>勾选集 ⊄ 操作者自己持有的原子 ⇒ 立即提示并禁用保存，不再"先点、再吃服务端 403"。
 * 本地预判只是提前挡明显越权的提交；CP 仍是最终授权方（它还要看资源与上限），所以这里
 * **不替 CP 放行**，只替它拦下最贵的一类往返。</p>
 */
const explicitCapExceedsActor = computed<string[]>(() => {
    if (capMode.value !== "explicit") return [];
    const held = new Set([...workspaceAtoms.value, ...instanceAtoms.value]);
    return permissions.value
        .map((permission) => bareAtom(permission.actionClass))
        .filter((atom): atom is string => atom !== null && !held.has(atom));
});
const capExceedsActorError = computed(() =>
    explicitCapExceedsActor.value.length > 0 ? t("workspace.agentCapExceedsActor") : "",
);

onMounted(() => {
    // Every open is a fresh mount (dock activation or mobile modal), so the loads run once
    // per open — the same cadence the dialog had via `watch(open)`.
    resetMemoryPanel();
    void refreshAgentsAndCandidates();
    void loadCapabilityProjection();
    // task-959：MCP 可见集是工作区级读面（成员即可读），与 agent 列表并行加载。
    void loadMcpServers();
});

async function loadCapabilityProjection() {
    capabilityState.value = "loading";
    try {
        const self: SelfPermissionsView = await api.getSelfPermissions();
        instanceAtoms.value = (self.instancePermissions ?? [])
            .map((atom) => bareAtom(atom.actionClass))
            .filter((value): value is string => value !== null);
        // 实例 `*` 级原子同时覆盖所有工作区（管理员）。
        const workspace = (self.workspaces ?? []).find(
            (item) => item.workspaceId === props.workspaceId,
        );
        const scoped = (workspace?.permissions ?? [])
                .map((atom) => bareAtom(atom.actionClass))
                .filter((value): value is string => value !== null),
            hasWildcard = (self.instancePermissions ?? []).some((atom) => atom.resource === "*");
        workspaceAtoms.value = scoped.length > 0 ? scoped : hasWildcard ? instanceAtoms.value : [];
        capabilityState.value = "ready";
    } catch (cause) {
        // 投影拿不到就 fail-closed，并保留原因（不静默）。
        capabilityState.value = "failed";
        logger.warn("Load agent capability failed", cause);
        error.value = causeErrorToastText(t, cause, t("workspace.agentLoadFailed"));
    }
}

function agentDefaultModel(agent: WorkspaceAgentBinding): string {
    const provider = agent.defaultModelProvider,
        model = agent.defaultModelName;
    if (!provider && !model) return "";
    return `${provider ?? "—"} / ${model ?? "—"}`;
}

/** 可操作性来自能力投影；CP 对每次写入作最终授权。 */
function canDisable(): boolean {
    return canManageWorkspaceAgents.value === true;
}

/**
 * 只读展示 hook 订阅：advisor kind 列表（kind 是开放串，UI 不解释 config）。
 * 形状解析只在 `api.ts#normalizePrincipalHooks`；这里只做展示聚合。
 */
function hookKinds(agent: WorkspaceAgentBinding): string[] {
    return (agent.hooks?.advisors ?? []).map((advisor) => advisor.kind);
}

/** 订阅的动作类并集（跨 advisor 去重保序）——wire 里在 `advisors[].on`，不在顶层。 */
function hookActionClasses(agent: WorkspaceAgentBinding): string[] {
    const seen = new Set<string>();
    for (const advisor of agent.hooks?.advisors ?? []) {
        for (const actionClass of advisor.on) {
            if (actionClass !== "") seen.add(actionClass);
        }
    }
    return [...seen];
}

async function loadAgents() {
    loading.value = true;
    error.value = "";
    status.value = "";
    try {
        agents.value = await api.getWorkspaceAgents(props.workspaceId);
    } catch (cause) {
        logger.warn("Load workspace agents failed", cause);
        error.value = causeErrorToastText(t, cause, t("workspace.agentLoadFailed"));
    } finally {
        loading.value = false;
    }
}

/**
 * task-928 / task-930：可绑定候选读面。
 *
 * <p>与列表读面**分开**调用（列表只要成员身份，候选要 `MANAGE_WORKSPACE_AGENTS`）：
 * 合成一个请求会让普通成员连"本工作区已绑定了谁"都看不到 —— 带标志时缺原子是**整请求 403**。</p>
 *
 * <p>三种终态必须分开：`forbidden` = 缺少权限（给权限文案），`ready + 空数组` = 状态
 * （给明确空态，不是死路），`failed` = 读取失败。把前两者混成"空列表"是这张卡要挡的
 * 假绿形态。</p>
 */
async function loadCandidates() {
    candidatesState.value = "loading";
    candidatesErrorCode.value = "";
    try {
        const raw = await request<{ bindableCandidates?: Array<Record<string, unknown>> }>(
            `/workspaces/${encodeURIComponent(props.workspaceId)}/agents?includeBindable=true`,
        );
        // 已绑定行不得重复出现在候选里：CP 已按「可见池 − 可达集」扣除，这里再按已绑定行
        // 去一次重（列表里未绑定的自有主体仍可用于行级绑定，故只排 bound===true）。
        const boundIds = new Set(
            agents.value.filter((agent) => agent.bound === true).map((agent) => agent.principalId),
        );
        candidates.value = (raw.bindableCandidates ?? []).flatMap((row) => {
            const principalId = typeof row.principalId === "string" ? row.principalId : "";
            if (!principalId || boundIds.has(principalId)) return [];
            return [
                {
                    principalId,
                    name: typeof row.name === "string" && row.name ? row.name : principalId,
                    ownership: typeof row.ownership === "string" ? row.ownership : "",
                    disabled: row.disabled === true,
                    isDefault: row.isDefault === true,
                    bindable: row.bindable === true,
                    unbindableReason:
                        typeof row.unbindableReason === "string" ? row.unbindableReason : null,
                } satisfies WorkspaceAgentBindableCandidate,
            ];
        });
        candidatesState.value = "ready";
    } catch (cause) {
        const code = cause instanceof ApiError ? (cause.problem?.code ?? "") : "";
        if (cause instanceof ApiError && cause.problem?.status === 403) {
            candidates.value = [];
            candidatesState.value = "forbidden";
            candidatesErrorCode.value = code;
            return;
        }
        logger.warn("Load bindable agent candidates failed", cause);
        candidates.value = [];
        candidatesState.value = "failed";
        candidatesErrorCode.value = code;
    }
}

/** 列表与候选必须**先后**读：候选去重依赖已绑定集合，并发读会让去重拿到空列表。 */
async function refreshAgentsAndCandidates() {
    await loadAgents();
    await loadCandidates();
}

/**
 * PLAN-0629 M1-4 C：记忆只读区。
 * - `type`/`pinned`/`updatedAt` 全部照服务端显示（CP 已按 pinned + profile 排序，UI 不重排）；
 * - 404 `AGENT_PRINCIPAL_NOT_FOUND` = 不可见或不存在（CP 故意不区分）⇒ 给可读文案，不当作崩溃；
 * - 收起 / 切主体 / 关弹窗都作废在途响应，避免旧数据回填。
 */
function resetMemoryPanel() {
    memoryRequestGeneration += 1;
    memoryPrincipalId.value = null;
    memories.value = [];
    memoryState.value = "idle";
    memoryError.value = "";
    clearMemoryWriteDrafts();
}

/** 来源 chip：只有 CP 透出受支持的 `origin` 才渲染（缺字段不显示、不猜默认）。 */
function memoryOriginLabel(origin: WorkspaceAgentMemory["origin"]): string {
    return origin === "run"
        ? t("workspace.agentMemoryOriginRun")
        : t("workspace.agentMemoryOriginManual");
}

async function loadMemories(principalId: string) {
    const generation = ++memoryRequestGeneration;
    memoryState.value = "loading";
    memoryError.value = "";
    const status = showArchivedMemories.value ? "all" : undefined;
    try {
        const rows = status
            ? await api.getWorkspaceAgentMemories(props.workspaceId, principalId, status)
            : await api.getWorkspaceAgentMemories(props.workspaceId, principalId);
        if (generation !== memoryRequestGeneration) return;
        // CP 未支持归档参数时会 400/404；那不是"列表坏了"，而是降级为只读 active。
        if (status) archiveStatusSupported.value = true;
        memories.value = rows;
        memoryState.value = "ready";
    } catch (cause) {
        if (generation !== memoryRequestGeneration) return;
        if (status && cause instanceof ApiError) {
            archiveStatusSupported.value = false;
            showArchivedMemories.value = false;
            void loadMemories(principalId);
            return;
        }
        logger.warn("Load agent memories failed", cause);
        memoryError.value =
            cause instanceof ApiError && cause.problem.code === "AGENT_PRINCIPAL_NOT_FOUND"
                ? withErrorCode(t("workspace.agentMemoryNotFound"), cause.problem.code)
                : causeErrorToastText(t, cause, t("workspace.agentMemoryLoadFailed"));
        memoryState.value = "failed";
    }
}

/** 「显示已归档」：切到 all（含已归档），关回 active。 */
function toggleShowArchived(agent: WorkspaceAgentBinding) {
    if (!archiveStatusSupported.value) return;
    showArchivedMemories.value = !showArchivedMemories.value;
    void loadMemories(agent.principalId);
}

/** 当前展开主体（用于「启用记忆」开关与「显示已归档」）。 */
const memoryAgent = computed<WorkspaceAgentBinding | null>(
    () => agents.value.find((entry) => entry.principalId === memoryPrincipalId.value) ?? null,
);

/**
 * PLAN-0667 M3：展开/收起角色与技能区块（同一主体共用一个展开态）。
 * 展开时并行加载绑定列表与候选清单；候选加载失败不阻塞列表展示（只是绑定入口禁用）。
 */
function toggleRbac(agent: WorkspaceAgentBinding) {
    if (rbacPrincipalId.value === agent.principalId) {
        rbacPrincipalId.value = null;
        return;
    }
    rbacPrincipalId.value = agent.principalId;
    void loadRbac(agent.principalId);
}

async function loadRbac(principalId: string) {
    const generation = ++rbacGeneration;
    rbacState.value = "loading";
    rbacError.value = "";
    rbacActionError.value = "";
    try {
        const [roles, skills] = await Promise.all([
            api.getAgentRoles(props.workspaceId, principalId),
            api.getAgentSkills(props.workspaceId, principalId),
        ]);
        if (generation !== rbacGeneration) return;
        agentRoles.value = roles;
        agentSkills.value = skills;
        rbacState.value = "ready";
        // 候选清单（预设复用既有 /presets；skills 复用 instance + 本工作区两条既有列表）——
        // 任一条失败只影响对应来源的"可绑定项"，不影响已绑定列表。
        const [presetsCatalog, instanceSkillsCatalog, workspaceSkillsCatalog] =
            await Promise.allSettled([
                api.listPresets(props.workspaceId),
                api.getSkills(),
                api.getWorkspaceSkills(props.workspaceId),
            ]);
        if (generation !== rbacGeneration) return;
        // task-471（436 切片 A）：只留原子可授予智能体主体的授权预设。服务端 listPresets 只对
        // **工作区层**调用方剔除含禁用原子的预设，持 MANAGE_ROLES 的**管理员视图**返回全量
        // （契约原文 "Ignored by the MANAGE_ROLES admin view"）⇒ 过滤在消费侧做。
        // 放在赋值处而不是模板：roleChoiceLabel 也消费 roleCandidates，且 selectedRoleId 只能
        // 来自过滤后的选项，两处同源才不会出现「选中项不在候选里」的标签丢失。
        roleCandidates.value =
            presetsCatalog.status === "fulfilled"
                ? presetsCatalog.value.filter(
                      (role) => !role.atoms.some((atom) => atom.agentPrincipalForbidden),
                  )
                : [];
        const definitions = [
            ...(instanceSkillsCatalog.status === "fulfilled" ? instanceSkillsCatalog.value : []),
            ...(workspaceSkillsCatalog.status === "fulfilled" ? workspaceSkillsCatalog.value : []),
        ];
        skillCandidates.value = selectSkillCandidates(definitions, {
            scopeType: "workspace",
            scopeId: props.workspaceId,
        });
    } catch (cause) {
        if (generation !== rbacGeneration) return;
        rbacError.value = rbacErrorMessage(cause);
        rbacState.value = "failed";
    }
}

/**
 * 409 三类码给本地化文案；404 不当崩溃；其它码落通用文案。两类都附稳定错误码，
 * CP 的英文 detail 只进 logger（不回到用户面）。
 */
function rbacErrorMessage(cause: unknown): string {
    logger.warn("Workspace agent RBAC error", cause);
    if (cause instanceof ApiError) {
        const code = cause.problem.code;
        if (code === "AGENT_PRINCIPAL_FORBIDDEN_ATOMS") {
            return withErrorCode(t("workspace.agentRoleForbiddenAtoms"), code);
        }
        switch (code) {
            case "ROLE_BINDING_EXCEEDS_CAP":
                return withErrorCode(t("workspace.agentRoleExceedsCap"), code);
            case "ROLE_BINDING_EXISTS":
                return withErrorCode(t("workspace.agentRoleBindingExists"), code);
            case "ROLE_BINDING_IMMUTABLE":
                return withErrorCode(t("workspace.agentRoleBindingImmutable"), code);
            case "AGENT_PRINCIPAL_NOT_FOUND":
            case "SKILL_NOT_FOUND":
            case "ROLE_NOT_FOUND":
                return withErrorCode(t("workspace.agentRbacNotFound"), code);
            default:
                return withErrorCode(t("workspace.agentRbacFailed"), code);
        }
    }
    return t("workspace.agentRbacFailed");
}

async function bindSelectedRole(agent: WorkspaceAgentBinding) {
    if (!selectedRoleId.value || rbacBusy.value) return;
    rbacBusy.value = true;
    rbacActionError.value = "";
    try {
        await api.bindAgentRole(props.workspaceId, agent.principalId, selectedRoleId.value);
        selectedRoleId.value = "";
        await loadRbac(agent.principalId);
    } catch (cause) {
        rbacActionError.value = rbacErrorMessage(cause);
    } finally {
        rbacBusy.value = false;
    }
}

async function unbindRole(agent: WorkspaceAgentBinding, binding: AgentRoleBinding) {
    if (binding.isSystem || rbacBusy.value) return;
    rbacBusy.value = true;
    rbacActionError.value = "";
    try {
        await api.unbindAgentRole(props.workspaceId, agent.principalId, binding.bindingId);
        await loadRbac(agent.principalId);
    } catch (cause) {
        rbacActionError.value = rbacErrorMessage(cause);
    } finally {
        rbacBusy.value = false;
    }
}

async function bindSelectedSkill(agent: WorkspaceAgentBinding) {
    if (!selectedSkillId.value || rbacBusy.value) return;
    rbacBusy.value = true;
    rbacActionError.value = "";
    try {
        await api.bindAgentSkill(props.workspaceId, agent.principalId, selectedSkillId.value);
        selectedSkillId.value = "";
        await loadRbac(agent.principalId);
    } catch (cause) {
        rbacActionError.value = rbacErrorMessage(cause);
    } finally {
        rbacBusy.value = false;
    }
}

async function unbindSkill(agent: WorkspaceAgentBinding, binding: AgentSkillBinding) {
    if (rbacBusy.value) return;
    rbacBusy.value = true;
    rbacActionError.value = "";
    try {
        await api.unbindAgentSkill(props.workspaceId, agent.principalId, binding.bindingId);
        await loadRbac(agent.principalId);
    } catch (cause) {
        rbacActionError.value = rbacErrorMessage(cause);
    } finally {
        rbacBusy.value = false;
    }
}

/**
 * 记忆是否注入上下文：判据在 `memoryPolicy.ts#readMemoryEnabled`（**只有 `enabled === true`
 * 才算开**，`null` = 契约明写的 "memory off"）。
 *
 * <p>旧实现是 `enabled !== false` + 注释「缺省=启用」，与契约的「缺省 false」正好相反：
 * 新主体 CP 判关、UI 画开（`task-58`）。口径搬进纯函数是为了让这条有一个**能被变异咬住**的
 * 判据 —— 内联写法改回去，`memoryEnabled` 的用例不会红（`task-44` M4 的教训）。</p>
 */
const memoryEnabled = computed<boolean>(() =>
    readMemoryEnabled(memoryAgent.value?.contextPolicy ?? null),
);

/** 开着但 `types` 为空：契约说这不写入 ⇒ 照实提示，不把开关画成"关"（那会变成点了没反应）。 */
const memoryTypesMissing = computed<boolean>(() =>
    readMemoryTypesMissing(memoryAgent.value?.contextPolicy ?? null),
);

/**
 * 「启用记忆」开关：`PATCH /agent-principals/{id}` 的 `contextPolicy` 是**整对象替换**，
 * 所以先与现值合并再回写；失败时保持原状态并就地报错（不静默、不乐观翻转）。
 */
async function toggleMemoryEnabled(agent: WorkspaceAgentBinding, next: boolean) {
    if (memoryToggleBusy.value) return;
    memoryToggleBusy.value = true;
    memoryToggleError.value = "";
    try {
        // 合并规则在纯函数里（整对象替换 ⇒ 只改 memory.enabled，writeMode/passive/types 全保留）。
        const merged = mergeMemoryEnabled(agent.contextPolicy ?? null, next);
        await api.updateAgentPrincipalContextPolicy(agent.principalId, merged);
        // BL-364/365：不可变更新。原先直接给入参对象的 `contextPolicy` 赋值，就地改写父层/store
        // 交来的对象 ⇒ 测试夹具与所有持有同一引用的消费方都会被污染（BL-359 实测）。
        // 注：注释里不要写成 `xxx.field = yyy` 的形式，GREP 门按文本匹配会把它当命中。
        const index = agents.value.findIndex((entry) => entry.principalId === agent.principalId);
        if (index >= 0) {
            const nextAgents = [...agents.value];
            nextAgents[index] = { ...agents.value[index]!, contextPolicy: merged };
            agents.value = nextAgents;
        }
    } catch (cause) {
        logger.warn("Toggle agent memory failed", cause);
        memoryToggleError.value = causeErrorToastText(
            t,
            cause,
            t("workspace.agentMemoryToggleFailed"),
        );
    } finally {
        memoryToggleBusy.value = false;
    }
}

function toggleMemories(agent: WorkspaceAgentBinding) {
    if (memoryPrincipalId.value === agent.principalId) {
        resetMemoryPanel();
        return;
    }
    resetMemoryPanel();
    memoryPrincipalId.value = agent.principalId;
    void loadMemories(agent.principalId);
}

/**
 * PLAN-0629 M1-5：记忆写入（新增 / 行内编辑 / 删除）。
 *
 * 三条纪律：
 * - **成功后重读列表**（权威源是 CP 读取面），不用写响应体推断状态；
 * - 失败一律落到 `memoryActionError`（就地可见，不静默、不"看起来成功了"）；
 * - 写权限取 `MEMORY_WRITE` 原子，UI 不复制 CP 的授权判定。
 */
function clearMemoryWriteDrafts() {
    memoryCreateOpen.value = false;
    memoryCreateContent.value = "";
    memoryCreatePinned.value = false;
    memoryEditingId.value = null;
    memoryEditContent.value = "";
    memoryEditPinned.value = false;
    memoryPendingArchiveId.value = null;
    memoryActionError.value = "";
}

function memoryFailureCopy(cause: unknown): string {
    if (cause instanceof ApiError) {
        const code = cause.problem.code;
        if (code === "MEMORY_WRITE_FORBIDDEN" || code === "FORBIDDEN") {
            return withErrorCode(t("workspace.agentMemoryWriteForbidden"), code);
        }
        if (code === "AGENT_PRINCIPAL_NOT_FOUND") {
            return withErrorCode(t("workspace.agentMemoryNotFound"), code);
        }
        logger.warn("Agent memory write failed", cause);
        return withErrorCode(t("workspace.agentMemoryWriteFailed"), code);
    }
    return t("workspace.agentMemoryWriteFailed");
}

function openMemoryCreate() {
    memoryActionError.value = "";
    memoryEditingId.value = null;
    memoryPendingArchiveId.value = null;
    memoryCreateOpen.value = true;
}

function cancelMemoryCreate() {
    memoryCreateOpen.value = false;
    memoryCreateContent.value = "";
    memoryCreatePinned.value = false;
    memoryActionError.value = "";
}

async function submitMemoryCreate(principalId: string) {
    if (memoryWriteBusy.value || !memoryCreateContent.value.trim()) return;
    memoryWriteBusy.value = true;
    memoryActionError.value = "";
    try {
        await api.createAgentMemory(props.workspaceId, principalId, {
            content: memoryCreateContent.value.trim(),
            pinned: memoryCreatePinned.value,
        });
        cancelMemoryCreate();
        await loadMemories(principalId);
    } catch (cause) {
        memoryActionError.value = memoryFailureCopy(cause);
    } finally {
        memoryWriteBusy.value = false;
    }
}

function startEditMemory(memory: WorkspaceAgentMemory) {
    memoryActionError.value = "";
    memoryCreateOpen.value = false;
    memoryPendingArchiveId.value = null;
    memoryEditingId.value = memory.id;
    memoryEditContent.value = memory.content;
    memoryEditPinned.value = memory.pinned;
}

function cancelEditMemory() {
    memoryEditingId.value = null;
    memoryEditContent.value = "";
    memoryActionError.value = "";
}

async function saveEditMemory(principalId: string, memoryId: string) {
    if (memoryWriteBusy.value || !memoryEditContent.value.trim()) return;
    memoryWriteBusy.value = true;
    memoryActionError.value = "";
    try {
        await api.updateAgentMemory(props.workspaceId, principalId, memoryId, {
            content: memoryEditContent.value.trim(),
            pinned: memoryEditPinned.value,
        });
        cancelEditMemory();
        await loadMemories(principalId);
    } catch (cause) {
        memoryActionError.value = memoryFailureCopy(cause);
    } finally {
        memoryWriteBusy.value = false;
    }
}

function requestArchiveMemory(memoryId: string) {
    memoryActionError.value = "";
    memoryCreateOpen.value = false;
    memoryEditingId.value = null;
    memoryPendingArchiveId.value = memoryId;
}

function cancelArchiveMemory() {
    memoryPendingArchiveId.value = null;
    memoryActionError.value = "";
}

/** 归档 = 软删（CP 侧 `status=retired`）；界面不出现"永久删除"字样。 */
async function confirmArchiveMemory(principalId: string, memoryId: string) {
    if (memoryWriteBusy.value) return;
    memoryWriteBusy.value = true;
    memoryActionError.value = "";
    try {
        await api.deleteAgentMemory(props.workspaceId, principalId, memoryId);
        memoryPendingArchiveId.value = null;
        await loadMemories(principalId);
    } catch (cause) {
        memoryActionError.value = memoryFailureCopy(cause);
    } finally {
        memoryWriteBusy.value = false;
    }
}

/**
 * task-949 / R78：canonical 原子名只用于 API 与审计，**界面上屏必须是可读词**。
 * 冻结快照（`permissionsSnapshot` / 生效上限 / hook 订阅）里可能是 `action:read`、
 * `cap:instance:admin`、`MANAGE_WORKSPACE_MCP` 这类内部拼写 —— 直接渲染等于把内部词汇
 * 交给用户（与「实现约束被当产品设计」同族）。
 *
 * 映射是**穷举 + fail-safe**：认识的原子给本地化名；不认识的一律收敛成「其他权限」，
 * 绝不回落到裸名（`actionLabel` 旧实现里的 `return bare` 就是 R78 的根源）。
 */
const ATOM_LABEL_KEYS: Record<string, string> = {
    // 六个动作类（既有键，保留兼容）
    read: "agentActionRead",
    write: "agentActionWrite",
    delete: "agentActionDelete",
    exec: "agentActionExec",
    network: "agentActionNetwork",
    credential: "agentActionCredential",
    // 凭据细分（ToolFaceRegistry 的 canonical 拼写）
    credential_use: "agentActionCredentialUse",
    credential_reveal: "agentActionCredentialReveal",
    credential_manage: "agentActionCredentialManage",
    clone: "agentActionClone",
    approve: "agentActionApprove",
    // 大写能力原子
    CREATE_ACCOUNT: "agentAtomCreateAccount",
    CREATE_TEMPLATE: "agentAtomCreateTemplate",
    MANAGE_WORKSPACE_AGENTS: "agentAtomManageWorkspaceAgents",
    SPAWN_AGENT: "agentAtomSpawnAgent",
    CREATE_SCHEDULED_TASK: "agentAtomCreateScheduledTask",
    MANAGE_SCHEDULED_TASK: "agentAtomManageScheduledTask",
    MANAGE_ROLES: "agentAtomManageRoles",
    GRANT_ANY_ATOM: "agentAtomGrantAnyAtom",
    CREATE_OWN_AGENT: "agentAtomCreateOwnAgent",
    MEMORY_WRITE: "agentAtomMemoryWrite",
    MEMORY_WRITE_SELF: "agentAtomMemoryWriteSelf",
    MANAGE_AGENT_PRINCIPALS: "agentAtomManageAgentPrincipals",
    MANAGE_WORKSPACE_MEMBERS: "agentAtomManageWorkspaceMembers",
    READ_INSTANCE_CONTENT: "agentAtomReadInstanceContent",
    WRITE_INSTANCE_CONTENT: "agentAtomWriteInstanceContent",
    VIEW_SECRET_CONTENT: "agentAtomViewSecretContent",
    MANAGE_SKILL_LIBRARY: "agentAtomManageSkillLibrary",
    MANAGE_PERSONAL_SKILLS: "agentAtomManagePersonalSkills",
    MANAGE_PROVIDER_CONNECTIONS: "agentAtomManageProviderConnections",
    USE_WORKSPACE_RUNTIME: "agentAtomUseWorkspaceRuntime",
    MANAGE_WORKSPACE_RUNTIME: "agentAtomManageWorkspaceRuntime",
    MANAGE_WORKSPACE_POLICY: "agentAtomManageWorkspacePolicy",
    TEAM_TASK_MANAGE: "agentAtomTeamTaskManage",
    "session:permission:configure": "agentAtomSessionPermissionConfigure",
    MANAGE_WORKSPACE_DEFAULT_CONFIG: "agentAtomManageWorkspaceDefaultConfig",
    WRITE_WORKSPACE_CONTENT: "agentAtomWriteWorkspaceContent",
    MANAGE_WORKSPACE_MCP: "agentAtomManageWorkspaceMcp",
    PLUGIN_MANAGE: "agentAtomPluginManage",
    PLUGIN_BIND: "agentAtomPluginBind",
    PLUGIN_INVOKE: "agentAtomPluginInvoke",
    PLUGIN_DATA: "agentAtomPluginData",
    MANAGE_ORG_UNITS: "agentAtomManageOrgUnits",
    MANAGE_ORG_UNIT_MEMBERS: "agentAtomManageOrgUnitMembers",
    READ_ORG_UNIT_MEMBERS: "agentAtomReadOrgUnitMembers",
};

/** `cap:` 角色/超管原子（不是动作，不能落进动作标签族）。 */
const CAP_LABEL_KEYS: Record<string, string> = {
    "cap:instance:super": "agentAtomCapInstanceSuper",
    "cap:instance:admin": "agentAtomCapInstanceAdmin",
    "cap:workspace:admin": "agentAtomCapWorkspaceAdmin",
};

function localizedLabel(key: string, fallbackKey: string): string {
    const full = `workspace.${key}`;
    const label = t(full);
    return label === full ? t(fallbackKey) : label;
}

function atomDisplayLabel(actionClass: string): string {
    const raw = actionClass.trim();
    if (raw === "") return t("workspace.agentAtomOther");
    // 工作区 MCP 资源（`mcp:<serverId>`）不是权限原子：给「工具名」而不是 canonical 拼写。
    if (raw.startsWith("mcp:")) {
        const server = raw.slice("mcp:".length).trim();
        return server === ""
            ? t("workspace.agentAtomOther")
            : t("workspace.agentAtomWorkspaceMcp", { server });
    }
    const capKey = CAP_LABEL_KEYS[raw];
    if (capKey) return localizedLabel(capKey, "workspace.agentAtomOther");
    const bare = bareAtom(raw);
    if (bare === null) {
        // `cap:` 家族里未登记的项，同样不裸显。
        return t("workspace.agentAtomOther");
    }
    const key = ATOM_LABEL_KEYS[bare];
    return key ? localizedLabel(key, "workspace.agentAtomOther") : t("workspace.agentAtomOther");
}

/**
 * hook 订阅的 `on` 是**开放的动作类**（`advisors[].on`，见 `hookKinds` 注释），不等同于权限原子：
 * 认识的走本地化；`approval.ask` 这类小写工具类名保持原样（它们不是 canonical 原子，
 * 也不是「实现约束」，硬翻译反而看不出订阅的是哪个工具动作）。canonical 前缀与大写原子
 * 在快照面一律走 `atomDisplayLabel`，不经过这里。
 */
function hookActionLabel(actionClass: string): string {
    const bare = bareAtom(actionClass) ?? actionClass;
    const known = ATOM_LABEL_KEYS[bare];
    if (known) return localizedLabel(known, "workspace.agentAtomOther");
    return /^[a-z][a-z0-9_.]*$/.test(bare) ? bare : t("workspace.agentAtomOther");
}

function hasPermission(actionClass: string): boolean {
    return permissions.value.some((permission) => permission.actionClass === actionClass);
}

function permissionResource(actionClass: string): string {
    return (
        permissions.value.find((permission) => permission.actionClass === actionClass)?.resource ??
        "*"
    );
}

function togglePermission(actionClass: string, checked: boolean) {
    if (!checked) {
        permissions.value = permissions.value.filter(
            (permission) => permission.actionClass !== actionClass,
        );
        return;
    }
    if (!hasPermission(actionClass)) {
        permissions.value = [...permissions.value, { actionClass, resource: "*" }];
    }
}

function setPermissionResource(actionClass: string, resource: string) {
    const index = permissions.value.findIndex(
        (permission) => permission.actionClass === actionClass,
    );
    const next = resource.trim() || "*";
    if (index >= 0) {
        permissions.value[index] = { ...permissions.value[index]!, resource: next };
        return;
    }
    permissions.value = [...permissions.value, { actionClass, resource: next }];
}

/**
 * PLAN-0585 M2 / F-02: a missing grant must read as an actionable localized hint that points at
 * the admin grant panel, never as the CP's raw English detail (`CREATE_ACCOUNT permission is
 * required`). task-855: failures render localized copy + stable code; the CP `detail` is
 * diagnostic only (logger), including 409 cap/atom refusals.
 */
function agentErrorMessage(cause: unknown, forbiddenKey: string, fallbackKey: string): string {
    if (cause instanceof ApiError && cause.problem.code === "FORBIDDEN") {
        return withErrorCode(t(forbiddenKey), cause.problem.code);
    }
    logger.warn("Workspace agent action failed", cause);
    const code = cause instanceof ApiError ? cause.problem?.code : undefined;
    return withErrorCode(t(fallbackKey), code);
}

/**
 * task-116（方案 A）：默认智能体写入。**不做乐观更新** —— 成功后重读列表，标记只认服务端
 * （验收③「刷新后仍在」就是把这条当判据）；失败保留原状态，把可读文案放进
 * `defaultAgentError`，错误码与英文 detail 只进 `logger.warn`（瞬时面纪律）。
 */
async function setDefaultAgent(agent: WorkspaceAgentBinding): Promise<void> {
    if (saving.value || canManageWorkspaceAgents.value !== true) return;
    defaultAgentError.value = "";
    defaultAgentBusy.value = agent.principalId;
    try {
        await api.setWorkspaceAgentDefault(props.workspaceId, agent.principalId);
        await loadAgents();
    } catch (cause) {
        logger.warn("Set default Workspace Agent failed", cause);
        defaultAgentError.value = presentCauseError(
            t,
            cause,
            t("workspaceAgents.setDefaultFailed"),
        ).copy;
    } finally {
        defaultAgentBusy.value = null;
    }
}

async function clearDefaultAgent(agent: WorkspaceAgentBinding): Promise<void> {
    if (saving.value || canManageWorkspaceAgents.value !== true) return;
    defaultAgentError.value = "";
    defaultAgentBusy.value = agent.principalId;
    try {
        await api.clearWorkspaceAgentDefault(props.workspaceId, agent.principalId);
        await loadAgents();
    } catch (cause) {
        logger.warn("Clear default Workspace Agent failed", cause);
        defaultAgentError.value = presentCauseError(
            t,
            cause,
            t("workspaceAgents.clearDefaultFailed"),
        ).copy;
    } finally {
        defaultAgentBusy.value = null;
    }
}

/** PLAN-0622：禁用是两步确认（第一步只换文案），并要求调用方先看清后果。 */
async function disableAgent(agent: WorkspaceAgentBinding) {
    if (!canDisable() || saving.value) return;
    if (disableConfirmationId.value !== agent.principalId) {
        disableConfirmationId.value = agent.principalId;
        unbindConfirmationId.value = null;
        return;
    }
    saving.value = true;
    error.value = "";
    try {
        await api.disableAgentPrincipal(agent.principalId);
        disableConfirmationId.value = null;
        await loadAgents();
        status.value = t("workspace.agentDisabledSuccess");
    } catch (cause) {
        error.value = agentErrorMessage(
            cause,
            "workspace.agentDisableForbidden",
            "workspace.agentDisableFailed",
        );
    } finally {
        saving.value = false;
    }
}

/**
 * 绑定一个主体到本工作区 —— **幂等** `setWorkspaceCap` 且**省略** `permissions`。
 *
 * <p>47A（D-1109）：省略保护第三参 ⇒ CP 记 `capSource='baseline'`（跟随角色基线）。
 * 旧口径是把当时的快照原样 PUT 回去（恒 explicit，一次绑定就把上限冻死），已被 47A 取代；
 * 要显式冻结或显式零权限，走「编辑工作区角色」的两个态，不在绑定这一步替用户拍。</p>
 *
 * <p>task-928：行级绑定（列表里**未绑定**的自有主体）与候选区绑定**共用这一条** ——
 * 两条入口若各写一份 PUT，迟早会漂成两种 capSource。绑定后同时重读列表与候选，
 * 成功绑上的行不会仍留在候选里。</p>
 */
async function bindPrincipal(principalId: string) {
    if (saving.value || canManageWorkspaceAgents.value !== true) return;
    saving.value = true;
    error.value = "";
    try {
        await api.updateWorkspaceAgentCap(props.workspaceId, principalId, undefined);
        await refreshAgentsAndCandidates();
        status.value = t("workspace.agentBound");
    } catch (cause) {
        error.value = agentErrorMessage(
            cause,
            "workspace.agentBindForbidden",
            "workspace.agentBindFailed",
        );
    } finally {
        saving.value = false;
    }
}

function bindExistingAgent(agent: WorkspaceAgentBinding) {
    return bindPrincipal(agent.principalId);
}

/**
 * task-928：候选行绑定。`bindable=false`（例如 `AGENT_PRINCIPAL_DISABLED`）时**不可点**，
 * 原因直接显示在行上 —— 不让用户点完再吃 409。
 */
function bindCandidate(candidate: WorkspaceAgentBindableCandidate) {
    if (!candidate.bindable) return;
    return bindPrincipal(candidate.principalId);
}

function startEditing(agent: WorkspaceAgentBinding) {
    if (canManageWorkspaceAgents.value !== true) return;
    editingPrincipalId.value = agent.principalId;
    // task-904: CP stores/returns canonical `action:` names; the editor compares bare names.
    // Filter `cap:` rows: this surface edits action permissions only.
    permissions.value = agent.permissionsSnapshot.flatMap((permission) => {
        const actionClass = bareAtom(permission.actionClass);
        return actionClass === null ? [] : [{ ...permission, actionClass }];
    });
    // 47A：回显以 CP 记的 `capSource` 为准（`baseline` ⇒ 继承态）；更早的响应没有该字段时按显式处理。
    capMode.value = agent.capSource === "baseline" ? "inherit" : "explicit";
    error.value = "";
    selectedPresetId.value = "";
    presetImportMessage.value = "";
    // task-469（417 P1-6）：打开编辑区时读**一次** live 生效权限（不是每行一次请求）。
    void loadEffectiveCap(agent.principalId);
    // task-959：访问预设候选按需补齐（与 RBAC 区共用 `/presets` 读面，失败不阻塞编辑）。
    void loadPresetCandidates();
}

/** 两个入口（RBAC 展开 / 权限编辑）都要预设候选；只读模板，失败时留空并单独呈现。 */
async function loadPresetCandidates(): Promise<void> {
    if (roleCandidates.value.length > 0) return;
    try {
        const presets = await api.listPresets(props.workspaceId);
        // 与 RBAC 区同一过滤口径：agent 主体不可授予的原子整行剔除。
        roleCandidates.value = presets.filter(
            (preset) => !preset.atoms.some((atom) => atom.agentPrincipalForbidden),
        );
    } catch (cause) {
        logger.warn("Load workspace presets for agent config failed", cause);
    }
}

/**
 * task-469（417 P1-6）：**当前生效权限（LIVE）**，与列表的冻结上限快照**并存且各自标注**。
 *
 * <p>契约 `EffectiveCapView`（openapi:6994）明写 effectiveCap 是 LIVE `resolveCapFor` 求值、
 * **NOT the stored permissionsSnapshot** ⇒ 两者语义不同：快照回答「CP 记录的冻结上限是什么」，
 * 本面回答「它现在实际能做什么」。**不拿 live 覆盖快照**（覆盖会把两种语义混成一句话，D-1281）。</p>
 *
 * <p>失败**显式呈现**（`workspace-agent-effective-cap-error`），**不静默回落到快照** —— 回落会让
 * 「读了 live」与「显示快照」在界面上分不开。也不写面板级 `error`（那是列表加载失败的位置，
 * 混用会让只读面失败看起来像列表坏了）。</p>
 */
async function loadEffectiveCap(principalId: string) {
    effectiveCapLoading.value = true;
    effectiveCapError.value = "";
    effectiveCap.value = null;
    try {
        const view = await api.getWorkspaceAgentEffectiveCap(props.workspaceId, principalId);
        // 竞态守卫：读回来时若已切到别的主体或已关闭编辑区，丢弃这次结果，不覆盖当前面。
        if (editingPrincipalId.value !== principalId) return;
        effectiveCap.value = view;
    } catch (cause) {
        if (editingPrincipalId.value !== principalId) return;
        effectiveCapError.value = agentErrorMessage(
            cause,
            "workspace.agentEffectiveCapForbidden",
            "workspace.agentEffectiveCapError",
        );
    } finally {
        if (editingPrincipalId.value === principalId) effectiveCapLoading.value = false;
    }
}

// 关闭编辑区（保存成功 :1006 / 取消按钮）时清掉 live 面，避免下次打开先闪上一次的主体的权限。
watch(editingPrincipalId, (id) => {
    if (id !== null) return;
    effectiveCap.value = null;
    effectiveCapError.value = "";
    effectiveCapLoading.value = false;
});

/**
 * task-44（D-1440 / A 方案）：把「深链带进来的主体」展开成用户点一下会得到的样子。
 *
 * <p>三件事都要做，因为卡面的三个区块分布在三处：记忆段（`memoryPrincipalId`）、
 * 角色 / 技能段（`rbacPrincipalId`）、权限编辑区（`editingPrincipalId`，**仅管理者**，
 * 与 `startEditing` 同一道门 —— 深链不得成为绕过写面门禁的入口）。</p>
 *
 * <p>三条纪律：①**只展开一次**（记 `appliedExpandId`）：用户手动收起后，列表刷新不该把
 * 控制权抢回去；②列表还没到 / 该主体不在本工作区 ⇒ **什么都不做**（不猜、不造，等下一次
 * 列表刷新再试）；③展开后滚到该行，否则「落地在面板顶」正是判据④要挡的形态。</p>
 */
const appliedExpandId = ref<string | null>(null);
/**
 * 权限编辑区单独记一个 id：它的门（`MANAGE_WORKSPACE_AGENTS`）和列表是**两条并行加载的
 * 异步线**，谁先到不确定。合成一个 id 会出现「权限先到 ⇒ 编辑区不展开、之后再也不补」的
 * 顺序依赖 —— 那种 bug 只在慢机器上现形，所以这里让两段各自幂等。
 */
const appliedCapExpandId = ref<string | null>(null);

async function applyExpandRequest() {
    const target = props.expandPrincipalId ?? null;
    if (target === null) return;
    const agent = agents.value.find((entry) => entry.principalId === target);
    // 主体不在本工作区（或列表还没到）：不猜、不造 —— 等下一次列表刷新再来一次。
    if (!agent) return;
    if (appliedExpandId.value !== target) {
        appliedExpandId.value = target;
        if (memoryPrincipalId.value !== target) {
            resetMemoryPanel();
            memoryPrincipalId.value = target;
            void loadMemories(target);
        }
        if (rbacPrincipalId.value !== target) {
            rbacPrincipalId.value = target;
            void loadRbac(target);
        }
        await nextTick();
        const row = document.querySelector(`[data-testid="workspace-agent-${target}"]`);
        // jsdom 没有 scrollIntoView：判据是「真实浏览器里滚到位」，不是「单测里调到了」。
        row?.scrollIntoView?.({ block: "center" });
    }
    // 深链**不得**绕过写面门禁：只有真持 MANAGE_WORKSPACE_AGENTS 才展开权限编辑区。
    if (
        canManageWorkspaceAgents.value === true &&
        appliedCapExpandId.value !== target &&
        editingPrincipalId.value !== target
    ) {
        appliedCapExpandId.value = target;
        startEditing(agent);
    }
}

watch(
    [() => props.expandPrincipalId, agents, canManageWorkspaceAgents],
    () => void applyExpandRequest(),
    { flush: "post", immediate: true },
);

async function saveCap(agent: WorkspaceAgentBinding) {
    if (saving.value || canManageWorkspaceAgents.value !== true) return;
    saving.value = true;
    error.value = "";
    try {
        // 47A：三态 → 三种请求体。继承 = **不传**该字段；显式（含零权限 `[]`）= 传数组。
        // 不要合并成一个 flag —— `[]` 与「未传」在 wire 上是不同的两件事。
        await api.updateWorkspaceAgentCap(
            props.workspaceId,
            agent.principalId,
            capMode.value === "inherit" ? undefined : permissions.value,
        );
        editingPrincipalId.value = null;
        await loadAgents();
        status.value = t("workspace.agentCapSaved");
    } catch (cause) {
        // D-160 ③：403 双侧点名（principal-exceeding/actor-exceeding）必须原样到 UI ——
        // 与 create/bind 同口径（FORBIDDEN 走可操作文案，其余保留 CP detail）。
        error.value = agentErrorMessage(
            cause,
            "workspace.agentBindForbidden",
            "workspace.agentSaveFailed",
        );
    } finally {
        saving.value = false;
    }
}

async function unbind(agent: WorkspaceAgentBinding) {
    if (unbindConfirmationId.value !== agent.principalId || saving.value) {
        unbindConfirmationId.value = agent.principalId;
        return;
    }
    saving.value = true;
    error.value = "";
    try {
        await api.deleteWorkspaceAgent(props.workspaceId, agent.principalId);
        unbindConfirmationId.value = null;
        // task-928：解绑后该主体要重新出现在候选里 —— 只刷列表会让候选区停在旧集合。
        await refreshAgentsAndCandidates();
        status.value = t("workspace.agentUnboundSuccess");
    } catch (cause) {
        logger.warn("Delete workspace agent failed", cause);
        error.value = causeErrorToastText(t, cause, t("workspace.agentUnbindFailed"));
    } finally {
        saving.value = false;
    }
}

// ---- 主体详情抽屉（task-191） ----------------------------------------------------------
// 本层 wire（WorkspaceAgentView / WorkspaceAgentController.toView）**只携带**
// hooks / contextPolicy：默认模型与委派预算不在列表投影上 ⇒ 抽屉里这两个分区显示
// 「到用户层配置」而不是渲染假默认值；memory 开关归本面板（已有），抽屉不再开第二入口。
const principalDetailTarget = ref<WorkspaceAgentBinding | null>(null);
const principalDetailOpen = ref(false);

/**
 * task-972：`WorkspaceAgentView` **不携带** `ownership`（列在 CP 的 `agent_principals` 上，
 * 但工作区列表投影没有它），而抽屉的写门必须按主体所有权分流 —— INSTANCE 行只能走
 * `PATCH /api/v1/instance/agent-principals/{id}`，user 前缀会先 409 `WORKSPACE_CONTEXT_REQUIRED`
 * 再 403 `AGENT_PRINCIPAL_INSTANCE_OWNED`。实例主体读面对所有已认证调用者开放且只返回
 * `ownership=INSTANCE` 的行（openapi `getInstanceAgentPrincipals`），所以用它的 id 集合补齐
 * 本面板缺失的这一维；不在集合里的行保持原来的 user 写门。
 */
const instancePrincipalIds = ref<ReadonlySet<string>>(new Set());
let instancePrincipalsPromise: Promise<void> | null = null;
let instancePrincipalsLoaded = false;

async function loadInstancePrincipalIds(): Promise<void> {
    if (instancePrincipalsLoaded) return;
    if (instancePrincipalsPromise) return instancePrincipalsPromise;
    instancePrincipalsPromise = listInstanceAgents()
        .then(({ agents: instanceAgents }) => {
            instancePrincipalIds.value = new Set(
                instanceAgents.map((agent) => agent.id).filter((id) => id !== ""),
            );
            instancePrincipalsLoaded = true;
        })
        .catch((cause) => {
            // 读面不可用时不把「未知」当成 USER：本卡只修正常路径，失败仍保留旧的 user 写门，
            // 并把原因留痕；下一次打开抽屉会重试。
            logger.warn("[agents] instance principal ownership probe failed", cause);
        })
        .finally(() => {
            instancePrincipalsPromise = null;
        });
    return instancePrincipalsPromise;
}

const principalDetail = computed<AgentPrincipalDetail | null>(() => {
    const agent = principalDetailTarget.value;
    if (!agent) return null;
    return {
        principalId: agent.principalId,
        name: agent.name,
        ownership: instancePrincipalIds.value.has(agent.principalId) ? "INSTANCE" : "USER",
        templateName: agent.templateName,
        createdAt: agent.createdAt,
        disabled: agent.disabled,
        defaultModelProvider: agent.defaultModelProvider ?? null,
        defaultModelName: agent.defaultModelName ?? null,
        allowedModels: agent.allowedModels ?? null,
        hooks: agent.hooks ?? null,
        contextPolicy: agent.contextPolicy ?? null,
        delegationPolicy: null,
    };
});

async function openPrincipalDetail(agent: WorkspaceAgentBinding): Promise<void> {
    // 所有权探针必须在打开前落地：抽屉的 `saveHooks` 在读 `props.principal.ownership` 时就选门，
    // 晚到的归属会让那一次保存仍打到 user 前缀。
    await loadInstancePrincipalIds();
    principalDetailTarget.value = agent;
    principalDetailOpen.value = true;
}

function onPrincipalDetailChanged(patch: Partial<AgentPrincipalDetail> & { principalId: string }) {
    const index = agents.value.findIndex((item) => item.principalId === patch.principalId);
    if (index < 0) return;
    // hooks/contextPolicy 的行类型是窄化的文档形状，而抽屉按宽 Record 回传 —— 同一 wire 文档，
    // 这里收窄 cast 而不是放宽行类型（行类型的窄形状是列表渲染的既有口径）。
    const merge = (row: WorkspaceAgentBinding): WorkspaceAgentBinding => ({
        ...row,
        ...patch,
        hooks:
            patch.hooks === undefined ? row.hooks : (patch.hooks as WorkspaceAgentBinding["hooks"]),
        contextPolicy:
            patch.contextPolicy === undefined
                ? row.contextPolicy
                : (patch.contextPolicy as WorkspaceAgentBinding["contextPolicy"]),
    });
    agents.value[index] = merge(agents.value[index]!);
    if (principalDetailTarget.value?.principalId === patch.principalId) {
        principalDetailTarget.value = merge(principalDetailTarget.value);
    }
}
</script>

<template>
    <!--
        The testid keeps its historical name (`…-dialog`): three e2e specs and the visual
        baseline address this surface by it, and D26-09 keeps testids stable across the
        relocation. It is now the panel body, not a modal.
    -->
    <section
        data-testid="workspace-agent-management-dialog"
        :aria-label="t('workspace.agentManagement')"
        class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-3"
    >
        <p class="text-sm text-muted-foreground">
            {{ t("workspace.agentManagementDescription") }}
        </p>

        <!--
            task-928（用户裁定 2026-11-24）：工作区**只绑不建** —— 主体创建的唯一入口在组织侧
            （「设置 → 智能体主体」）。候选来自 task-930 的 `?includeBindable=true`；
            绑定 = 幂等 setWorkspaceCap 且省略 permissions（capSource=baseline）。
        -->
        <section class="space-y-3 rounded-lg border p-3" data-testid="agent-bindable-candidates">
            <div>
                <h3 class="text-sm font-semibold">
                    {{ t("workspace.agentCandidatesTitle") }}
                </h3>
                <p class="mt-1 text-xs text-muted-foreground">
                    {{ t("workspace.agentCandidatesHint") }}
                </p>
                <router-link
                    to="/settings/instance/agent-principals"
                    data-testid="agent-principals-page-link"
                    class="mt-1 inline-block text-xs text-primary underline"
                >
                    {{ t("workspace.agentCandidatesCreateLink") }}
                </router-link>
            </div>
            <p
                v-if="candidatesState === 'loading'"
                class="text-xs text-muted-foreground"
                role="status"
            >
                {{ t("workspace.agentCandidatesLoading") }}
            </p>
            <!-- 403（缺 MANAGE_WORKSPACE_AGENTS）与「没有候选」是两件事：
                 前者是权限，后者是状态；都不能渲染成空列表。 -->
            <p
                v-else-if="candidatesState === 'forbidden'"
                data-testid="agent-candidates-forbidden"
                class="rounded-md border border-amber-500/40 px-2 py-1 text-xs text-amber-700"
            >
                {{ withErrorCode(t("workspace.agentCandidatesForbidden"), candidatesErrorCode) }}
            </p>
            <p
                v-else-if="candidatesState === 'failed'"
                data-testid="agent-candidates-failed"
                class="text-xs text-destructive"
            >
                {{ withErrorCode(t("workspace.agentCandidatesFailed"), candidatesErrorCode) }}
            </p>
            <p
                v-else-if="candidates.length === 0"
                data-testid="agent-candidates-empty"
                class="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
            >
                {{ t("workspace.agentCandidatesEmpty") }}
            </p>
            <ul v-else class="space-y-2" data-testid="agent-candidates-list">
                <li
                    v-for="candidate in candidates"
                    :key="candidate.principalId"
                    :data-testid="`agent-candidate-${candidate.principalId}`"
                    class="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
                >
                    <div class="min-w-0">
                        <p class="truncate text-sm font-medium">{{ candidate.name }}</p>
                        <p
                            class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                        >
                            <span
                                :data-testid="`agent-candidate-ownership-${candidate.principalId}`"
                            >
                                {{
                                    candidate.ownership === "INSTANCE"
                                        ? t("agentPrincipalDetail.ownershipInstance")
                                        : t("agentPrincipalDetail.ownershipUser")
                                }}
                            </span>
                            <!-- disabled 行带 bindable=false + AGENT_PRINCIPAL_DISABLED：不可选并给原因。 -->
                            <span
                                v-if="!candidate.bindable"
                                class="rounded border border-destructive/40 px-1.5 py-0.5 text-destructive"
                                :data-testid="`agent-candidate-unbindable-${candidate.principalId}`"
                            >
                                {{
                                    candidate.unbindableReason === "AGENT_PRINCIPAL_DISABLED"
                                        ? t("workspace.agentCandidateDisabled")
                                        : t("workspace.agentCandidateUnbindable")
                                }}
                            </span>
                        </p>
                    </div>
                    <button
                        type="button"
                        class="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                        :data-testid="`agent-candidate-bind-${candidate.principalId}`"
                        :disabled="
                            saving || canManageWorkspaceAgents !== true || !candidate.bindable
                        "
                        @click="bindCandidate(candidate)"
                    >
                        {{ t("workspace.bindAgent") }}
                    </button>
                </li>
            </ul>
        </section>

        <section class="space-y-3" aria-labelledby="workspace-agent-list-title">
            <div class="flex items-center justify-between">
                <h3 id="workspace-agent-list-title" class="text-sm font-semibold">
                    {{ t("workspace.boundAgents") }}
                </h3>
                <button
                    type="button"
                    data-testid="workspace-agent-refresh"
                    class="text-xs text-muted-foreground underline"
                    :disabled="loading"
                    @click="refreshAgentsAndCandidates"
                >
                    {{ t("workspace.refreshAgents") }}
                </button>
            </div>
            <!-- task-417 P1-6（408 盘点）：下面每行的能力徽标是 **CP 记录的冻结上限快照**，不是当前生效权限。
                 列表读面给 permissionsSnapshot + capSource（WorkspaceAgentController:294-297）。
                 **task-469 更新**：原注释「真源 resolveCapFor 没有公开读面」**已过期** —— cp-2 task-448
                 落了 `GET /workspaces/{ws}/agents/{pid}/effective-cap`（WorkspaceAgentController:84，
                 契约 EffectiveCapView / openapi:6994）。现在**详情/编辑区打开时读一次 live** 并单独标注
                 （见下方 workspace-agent-effective-cap）；**列表仍用快照**（避免每行一次请求），
                 两者并存不互相覆盖。UI 仍不得拿快照声称「这就是它现在的权限」。 -->
            <p
                class="text-xs text-muted-foreground"
                data-testid="workspace-agent-cap-snapshot-hint"
            >
                {{ t("workspace.agentCapSnapshotHint") }}
            </p>
            <!-- task-116：工作区还没有默认值时明说会发生什么（新建会话会先问），别让用户以为坏了。 -->
            <p
                v-if="!loading && !defaultAgentId"
                class="text-xs text-muted-foreground"
                data-testid="workspace-agent-default-hint"
            >
                {{ t("workspaceAgents.noDefaultHint") }}
            </p>
            <p
                v-if="defaultAgentError"
                role="alert"
                class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
                data-testid="workspace-agent-default-error"
            >
                {{ defaultAgentError }}
            </p>
            <p v-if="loading" class="text-sm text-muted-foreground" role="status">
                {{ t("workspace.loadingAgents") }}
            </p>
            <p
                v-else-if="agents.length === 0"
                class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
            >
                {{ t("workspace.noBoundAgent") }}
            </p>
            <article
                v-for="agent in agents"
                :key="agent.principalId"
                class="space-y-3 rounded-lg border p-3"
                :data-testid="`workspace-agent-${agent.principalId}`"
            >
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <h4 class="truncate text-sm font-semibold">{{ agent.name }}</h4>
                        <p class="mt-1 flex flex-wrap items-center gap-1.5">
                            <!-- PLAN-0622 D26：未绑定的行必须显式标注，否则用户以为它已经能用。 -->
                            <span
                                v-if="agent.bound === false"
                                class="rounded border border-amber-500/40 px-1.5 py-0.5 text-xs text-amber-600"
                                :data-testid="`agent-unbound-badge-${agent.principalId}`"
                            >
                                {{ t("workspace.agentUnboundBadge") }}
                            </span>
                            <span
                                v-if="agent.disabled"
                                class="rounded border border-destructive/40 px-1.5 py-0.5 text-xs text-destructive"
                                :data-testid="`agent-disabled-badge-${agent.principalId}`"
                            >
                                {{ t("workspace.agentDisabledBadge") }}
                            </span>
                            <!-- task-116：默认标记来自列表读面（isDefault），不是本地选中态。 -->
                            <span
                                v-if="agent.isDefault === true"
                                class="rounded border border-primary/40 px-1.5 py-0.5 text-xs text-primary"
                                :data-testid="`workspace-agent-default-badge-${agent.principalId}`"
                            >
                                {{ t("workspaceAgents.defaultBadge") }}
                            </span>
                        </p>
                        <p
                            v-if="agentDefaultModel(agent)"
                            class="mt-1 text-xs text-muted-foreground"
                            :data-testid="`agent-default-model-${agent.principalId}`"
                        >
                            {{ t("workspace.agentDefaultModelLabel") }}:
                            {{ agentDefaultModel(agent) }}
                        </p>
                        <!-- PLAN-0625 M3：hook 订阅只读展示（null/无订阅 ⇒ 整行不渲染）。 -->
                        <p
                            v-if="hookKinds(agent).length > 0"
                            class="mt-1 text-xs text-muted-foreground"
                            :data-testid="`agent-hooks-${agent.principalId}`"
                        >
                            {{ t("workspace.agentHooksLabel") }}:
                            {{ hookKinds(agent).join("、") }}
                            <template v-if="hookActionClasses(agent).length">
                                · {{ hookActionClasses(agent).map(hookActionLabel).join("、") }}
                            </template>
                        </p>
                        <p class="mt-1 break-all font-mono text-xs text-muted-foreground">
                            {{ agent.principalId }}
                        </p>
                        <p class="mt-1 text-xs text-muted-foreground">
                            {{ agent.templateName ?? t("workspace.defaultAgentTemplate") }} ·
                            {{ t("workspace.agentTemplateId") }}: {{ agent.templateId ?? "—" }} ·
                            {{ t("workspace.agentWorkspaceId") }}: {{ workspaceId }} ·
                            {{ formatDateTime(agent.createdAt) }}
                        </p>
                    </div>
                    <div class="flex shrink-0 flex-col items-end gap-1">
                        <button
                            type="button"
                            class="rounded-md border px-2 py-1 text-xs"
                            :data-testid="`workspace-agent-details-${agent.principalId}`"
                            @click="openPrincipalDetail(agent)"
                        >
                            {{ t("agentPrincipalDetail.details") }}
                        </button>
                        <!-- task-116：默认智能体的唯一写入口就在行内；已有默认时给「取消」，
                             否则给「设为默认」。无权限时保持可见但禁用，并写明原因（fail-closed）。
                             task-949 / R77：未绑定行不能成为默认主体 ⇒ 整组默认动作只对已绑定行渲染。 -->
                        <button
                            v-if="agent.bound !== false && agent.isDefault === true"
                            type="button"
                            class="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                            :data-testid="`workspace-agent-default-clear-${agent.principalId}`"
                            :disabled="
                                saving ||
                                canManageWorkspaceAgents !== true ||
                                defaultAgentBusy === agent.principalId
                            "
                            @click="clearDefaultAgent(agent)"
                        >
                            {{ t("workspaceAgents.clearDefault") }}
                        </button>
                        <button
                            v-else-if="agent.bound !== false"
                            type="button"
                            class="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                            :data-testid="`workspace-agent-default-set-${agent.principalId}`"
                            :disabled="
                                saving ||
                                canManageWorkspaceAgents !== true ||
                                defaultAgentBusy === agent.principalId
                            "
                            @click="setDefaultAgent(agent)"
                        >
                            {{ t("workspaceAgents.setDefault") }}
                        </button>
                        <p
                            v-if="agent.bound !== false && canManageWorkspaceAgents !== true"
                            class="max-w-[12rem] text-right text-xs text-muted-foreground"
                            :data-testid="`workspace-agent-default-disabled-${agent.principalId}`"
                        >
                            {{ t("workspaceAgents.actionDisabled") }}
                        </p>
                        <!--
                            task-949 / R77：行状态与动作集合互斥 —— 已绑定行只给
                            「详情 / 默认 / 编辑上限 / 解绑 / 禁用」，绑定按钮只属于未绑定行。
                          `bound === false` 是唯一可绑定状态；`undefined`（读面未透出）按已绑定处理，
                          避免把已绑定主体再显示一次「绑定到此工作区」。
                        -->
                        <button
                            v-if="agent.bound === false"
                            type="button"
                            class="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                            :data-testid="`agent-bind-row-${agent.principalId}`"
                            :disabled="saving || canManageWorkspaceAgents !== true"
                            @click="bindExistingAgent(agent)"
                        >
                            {{ t("workspace.bindAgent") }}
                        </button>
                        <button
                            v-if="agent.bound !== false"
                            type="button"
                            class="rounded-md border px-2 py-1 text-xs"
                            :data-testid="`workspace-agent-unbind-${agent.principalId}`"
                            @click="unbind(agent)"
                        >
                            {{
                                unbindConfirmationId === agent.principalId
                                    ? t("workspace.confirmAgentUnbind")
                                    : t("workspace.unbindAgent")
                            }}
                        </button>
                        <!-- PLAN-0622：禁用需二次确认；无权限/投影未就绪时**点击前**就禁用。 -->
                        <button
                            type="button"
                            class="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                            :class="
                                disableConfirmationId === agent.principalId
                                    ? 'text-destructive'
                                    : 'text-muted-foreground hover:text-foreground'
                            "
                            :data-testid="`workspace-agent-disable-${agent.principalId}`"
                            :disabled="saving || !canDisable() || agent.disabled === true"
                            @click="disableAgent(agent)"
                        >
                            {{
                                disableConfirmationId === agent.principalId
                                    ? t("workspace.confirmAgentDisable")
                                    : t("workspace.disableAgent")
                            }}
                        </button>
                        <p class="max-w-[12rem] text-right text-xs text-muted-foreground">
                            {{ t("workspace.agentDisableConsequence") }}
                        </p>
                    </div>
                </div>
                <div
                    v-if="editingPrincipalId !== agent.principalId"
                    class="space-y-1"
                    data-testid="workspace-agent-cap"
                >
                    <!-- task-417 P1-6：标题明写这是快照；来源用 CP 自己的 capSource（D-1109），
                         **不由数组长度猜语义** —— baseline 的空数组是「跟随角色基线」，不是「无工具权限」。 -->
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span
                            class="text-xs font-medium text-muted-foreground"
                            data-testid="workspace-agent-cap-label"
                        >
                            {{ t("workspace.agentCapSnapshotLabel") }}
                        </span>
                        <span
                            v-if="agent.capSource"
                            class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
                            :data-testid="`workspace-agent-cap-source-${agent.principalId}`"
                        >
                            {{
                                agent.capSource === "baseline"
                                    ? t("workspace.agentCapInherit")
                                    : t("workspace.agentCapExplicit")
                            }}
                        </span>
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                        <span
                            v-for="permission in agent.permissionsSnapshot"
                            :key="`${permission.actionClass}:${permission.resource ?? '*'}`"
                            class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                            {{ atomDisplayLabel(permission.actionClass) }} ·
                            {{ permission.resource ?? "*" }}
                        </span>
                        <span
                            v-if="
                                agent.permissionsSnapshot.length === 0 &&
                                agent.capSource !== 'baseline'
                            "
                            class="text-xs text-muted-foreground"
                            data-testid="workspace-agent-cap-empty"
                        >
                            {{ t("workspace.noAgentCapabilities") }}
                        </span>
                        <!--
                            task-959 / R38：MCP 是工作区级资源而不是主体的跨层属性，所以它出现在
                            「本工作区」这一行；读面 = `GET /workspaces/{id}/mcp-config`（成员可读）。
                            实体授权仍走权限原子的 `read × mcp:<serverId>`（D-1921 网关门）。
                        -->
                        <div
                            class="flex w-full flex-wrap items-center gap-1.5 text-xs"
                            data-testid="workspace-agent-mcp"
                        >
                            <span class="font-medium text-muted-foreground">
                                {{ t("workspace.agentMcpTitle") }}
                            </span>
                            <span v-if="mcpState === 'loading'" class="text-muted-foreground">
                                {{ t("workspace.agentMcpLoading") }}
                            </span>
                            <span v-else-if="mcpState === 'failed'" class="text-destructive">
                                {{ mcpError }}
                            </span>
                            <span
                                v-else-if="mcpServers.length === 0"
                                class="text-muted-foreground"
                                data-testid="workspace-agent-mcp-empty"
                            >
                                {{ t("workspace.agentMcpEmpty") }}
                            </span>
                            <template v-else>
                                <span
                                    v-for="server in mcpServers"
                                    :key="server.name"
                                    class="rounded border px-1.5 py-0.5 text-muted-foreground"
                                    :data-testid="`workspace-agent-mcp-server-${server.name}`"
                                >
                                    {{ server.name }}
                                </span>
                            </template>
                            <router-link
                                :to="{
                                    name: 'workspace-settings',
                                    params: { workspaceId: props.workspaceId },
                                    query: { tab: 'mcp' },
                                }"
                                class="ml-auto text-xs underline"
                                data-testid="workspace-agent-mcp-manage"
                            >
                                {{ t("workspace.agentMcpManage") }}
                            </router-link>
                        </div>
                        <button
                            type="button"
                            class="ml-auto text-xs underline disabled:opacity-50"
                            :data-testid="`workspace-agent-edit-cap-${agent.principalId}`"
                            :disabled="saving || canManageWorkspaceAgents !== true"
                            @click="startEditing(agent)"
                        >
                            {{ t("workspace.editAgentCap") }}
                        </button>
                    </div>
                </div>
                <div v-else class="space-y-2 border-t pt-3">
                    <!-- task-469（417 P1-6）：**当前生效权限（实时）**。与列表的冻结上限快照并存、
                         各自标注，不互相覆盖（契约 EffectiveCapView：LIVE resolveCapFor，NOT snapshot）。
                         打开编辑区读一次；失败显式呈现，不静默回落到快照（D-1281）。 -->
                    <div class="space-y-1" data-testid="workspace-agent-effective-cap">
                        <div class="flex flex-wrap items-center gap-1.5">
                            <span
                                class="text-xs font-medium"
                                data-testid="workspace-agent-effective-cap-label"
                            >
                                {{ t("workspace.agentEffectiveCapLabel") }}
                            </span>
                            <span
                                v-if="effectiveCap"
                                class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
                                :data-testid="`workspace-agent-effective-cap-binding-${agent.principalId}`"
                            >
                                {{
                                    effectiveCap.capSource.binding === "binding-snapshot"
                                        ? t("workspace.agentEffectiveCapBindingSnapshot")
                                        : t("workspace.agentEffectiveCapBindingRole")
                                }}
                            </span>
                            <span
                                v-if="effectiveCap"
                                class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
                                :data-testid="`workspace-agent-effective-cap-bound-${agent.principalId}`"
                            >
                                {{
                                    effectiveCap.bound
                                        ? t("workspace.agentEffectiveCapBound")
                                        : t("workspace.agentEffectiveCapUnbound")
                                }}
                            </span>
                        </div>
                        <p
                            class="text-xs text-muted-foreground"
                            data-testid="workspace-agent-effective-cap-hint"
                        >
                            {{ t("workspace.agentEffectiveCapHint") }}
                        </p>
                        <p
                            v-if="effectiveCapLoading"
                            role="status"
                            class="text-xs text-muted-foreground"
                            data-testid="workspace-agent-effective-cap-loading"
                        >
                            {{ t("workspace.agentEffectiveCapLoading") }}
                        </p>
                        <p
                            v-else-if="effectiveCapError"
                            role="alert"
                            class="text-xs text-destructive"
                            data-testid="workspace-agent-effective-cap-error"
                        >
                            {{ effectiveCapError }}
                        </p>
                        <template v-else-if="effectiveCap">
                            <div
                                class="flex flex-wrap gap-1.5"
                                data-testid="workspace-agent-effective-cap-atoms"
                            >
                                <span
                                    v-for="permission in effectiveCap.effectiveCap"
                                    :key="`${permission.actionClass}:${permission.resource ?? '*'}`"
                                    class="rounded border px-1.5 py-0.5 text-xs"
                                >
                                    {{ atomDisplayLabel(permission.actionClass) }} ·
                                    {{ permission.resource ?? "*" }}
                                </span>
                                <span
                                    v-if="effectiveCap.effectiveCap.length === 0"
                                    class="text-xs text-muted-foreground"
                                    data-testid="workspace-agent-effective-cap-empty"
                                >
                                    {{ t("workspace.agentEffectiveCapEmpty") }}
                                </span>
                            </div>
                            <!-- provenance：命中来源的 grant 行 id（不是原子名）。计数 + 逐个 id 都给，
                                 因为「哪几行授权造成了这个结果」正是本面相对快照的新信息。 -->
                            <p
                                class="text-xs text-muted-foreground"
                                data-testid="workspace-agent-effective-cap-provenance"
                            >
                                {{ t("workspace.agentEffectiveCapProvenancePrincipal") }}
                                {{ effectiveCap.provenance.principalGrantIds.length }} ·
                                {{ t("workspace.agentEffectiveCapProvenanceBinding") }}
                                {{ effectiveCap.provenance.bindingGrantIds.length }} ·
                                {{
                                    t(
                                        "workspace.agentEffectiveCapProvenanceLabelled",
                                        effectiveCapProvenanceLabelled,
                                    )
                                }}
                            </p>
                            <div
                                class="flex flex-wrap gap-1"
                                data-testid="workspace-agent-effective-cap-provenance-ids"
                            >
                                <code
                                    v-for="chip in effectiveCapProvenanceChips"
                                    :key="chip.grantId"
                                    class="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
                                >
                                    {{ chip.grantId }}
                                    <span
                                        class="ml-1 opacity-80"
                                        data-testid="workspace-agent-effective-cap-provenance-source"
                                    >
                                        {{ chip.label }}
                                    </span>
                                </code>
                            </div>
                            <p
                                class="text-xs text-muted-foreground"
                                data-testid="workspace-agent-effective-cap-read-face"
                            >
                                {{ t("workspace.agentEffectiveCapReadFace") }}
                            </p>
                        </template>
                    </div>
                    <!-- 47A（D-1109）：两态在 UI 上必须可区分，且请求体按态分支（见 saveCap）——
                         继承 = 省略 permissions（baseline）；显式 = 传数组（其中 [] = 零权限）。 -->
                    <p class="text-xs text-muted-foreground">{{ t("workspace.agentCapNote") }}</p>
                    <div class="flex flex-wrap items-center gap-3" data-testid="agent-cap-mode">
                        <label class="flex items-center gap-1.5 text-xs">
                            <input
                                v-model="capMode"
                                type="radio"
                                value="inherit"
                                :data-testid="`workspace-agent-cap-mode-inherit-${agent.principalId}`"
                            />
                            {{ t("workspace.agentCapInherit") }}
                        </label>
                        <label class="flex items-center gap-1.5 text-xs">
                            <input
                                v-model="capMode"
                                type="radio"
                                value="explicit"
                                :data-testid="`workspace-agent-cap-mode-explicit-${agent.principalId}`"
                            />
                            {{ t("workspace.agentCapExplicit") }}
                        </label>
                    </div>
                    <p
                        v-if="capMode === 'inherit'"
                        :data-testid="`workspace-agent-cap-inherit-hint-${agent.principalId}`"
                        class="text-xs text-muted-foreground"
                    >
                        {{ t("workspace.agentCapInheritHint") }}
                    </p>
                    <template v-else>
                        <div
                            v-for="actionClass in actionClasses"
                            :key="actionClass"
                            class="grid grid-cols-[1fr_1fr] items-center gap-2"
                        >
                            <label class="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    :checked="hasPermission(actionClass)"
                                    :data-testid="`agent-cap-${actionClass}`"
                                    @change="
                                        togglePermission(
                                            actionClass,
                                            ($event.target as HTMLInputElement).checked,
                                        )
                                    "
                                />
                                {{ atomDisplayLabel(actionClass) }}
                            </label>
                            <input
                                v-if="hasPermission(actionClass)"
                                :value="permissionResource(actionClass)"
                                :data-testid="`agent-resource-${actionClass}`"
                                :aria-label="
                                    t('workspace.agentResourceFor', {
                                        action: atomDisplayLabel(actionClass),
                                    })
                                "
                                class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                                @input="
                                    setPermissionResource(
                                        actionClass,
                                        ($event.target as HTMLInputElement).value,
                                    )
                                "
                            />
                        </div>
                        <p class="text-xs text-muted-foreground">
                            {{ t("workspace.agentCapZeroHint") }}
                        </p>
                        <!-- task-928：勾选集超出操作者自己持有的原子 ⇒ 提交前提示并禁用保存。 -->
                        <p
                            v-if="capExceedsActorError"
                            class="text-xs text-destructive"
                            :data-testid="`workspace-agent-cap-exceeds-${agent.principalId}`"
                        >
                            {{ capExceedsActorError }}
                        </p>

                        <!-- task-959 / R38：访问预设入口 —— 导的是**当时原子**，不是约束。
                             导入后仍是草稿，可逐项删除/改资源，最后统一走「保存权限」。 -->
                        <div class="space-y-2 border-t pt-3" data-testid="agent-preset-import">
                            <p class="text-xs font-medium">
                                {{ t("workspace.agentPresetImportTitle") }}
                            </p>
                            <p class="text-xs text-muted-foreground">
                                {{ t("workspace.agentPresetImportHint") }}
                            </p>
                            <p
                                v-if="roleCandidates.length === 0"
                                class="text-xs text-muted-foreground"
                                data-testid="agent-preset-import-empty"
                            >
                                {{ t("workspace.agentPresetImportEmpty") }}
                            </p>
                            <div v-else class="flex flex-wrap items-center gap-2">
                                <Select v-model="selectedPresetId">
                                    <SelectTrigger
                                        class="h-8 w-56"
                                        data-testid="agent-preset-import-select"
                                        :aria-label="t('workspace.agentPresetImportTitle')"
                                    >
                                        <SelectValue
                                            :placeholder="
                                                t('workspace.agentPresetImportPlaceholder')
                                            "
                                        />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem
                                            v-for="preset in roleCandidates"
                                            :key="preset.id"
                                            :value="preset.id"
                                        >
                                            {{ preset.displayName || preset.name }}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                                <button
                                    type="button"
                                    class="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                                    data-testid="agent-preset-import-apply"
                                    :disabled="selectedPresetId === ''"
                                    @click="importPresetAtoms"
                                >
                                    {{ t("workspace.agentPresetImportApply") }}
                                </button>
                            </div>
                            <p
                                v-if="presetImportMessage"
                                class="text-xs text-muted-foreground"
                                data-testid="agent-preset-import-message"
                            >
                                {{ presetImportMessage }}
                            </p>
                        </div>

                        <!-- task-959 / R38：按工作区维度授 MCP 网关通道。
                             勾选 = 为操作者自己持有的网关动作补 `mcp:<serverId>`；对象资源另由上方
                             动作勾选约束（D-1921 的 AND 门）。 -->
                        <div class="space-y-2 border-t pt-3" data-testid="agent-mcp-config">
                            <p class="text-xs font-medium">
                                {{ t("workspace.agentMcpGrantTitle") }}
                            </p>
                            <p class="text-xs text-muted-foreground">
                                {{ t("workspace.agentMcpGrantHint") }}
                            </p>
                            <p v-if="mcpState === 'loading'" class="text-xs text-muted-foreground">
                                {{ t("workspace.agentMcpLoading") }}
                            </p>
                            <p
                                v-else-if="mcpState === 'failed'"
                                class="text-xs text-destructive"
                                data-testid="agent-mcp-config-failed"
                            >
                                {{ mcpError }}
                            </p>
                            <p
                                v-else-if="mcpServers.length === 0"
                                class="text-xs text-muted-foreground"
                                data-testid="agent-mcp-config-empty"
                            >
                                {{ t("workspace.agentMcpEmpty") }}
                            </p>
                            <ul v-else class="space-y-1.5" data-testid="agent-mcp-config-list">
                                <li
                                    v-for="server in mcpServers"
                                    :key="server.name"
                                    class="flex items-center gap-2 text-sm"
                                >
                                    <input
                                        type="checkbox"
                                        :checked="hasMcpGrant(server)"
                                        :disabled="
                                            capabilityState !== 'ready' ||
                                            !isMcpServerSelectable(server)
                                        "
                                        :data-testid="`agent-mcp-grant-${server.name}`"
                                        @change="
                                            toggleMcpGrant(
                                                server,
                                                ($event.target as HTMLInputElement).checked,
                                            )
                                        "
                                    />
                                    <span class="font-mono text-xs">{{ server.name }}</span>
                                    <span
                                        v-if="!isMcpServerSelectable(server)"
                                        class="text-xs text-destructive"
                                        :data-testid="`agent-mcp-grant-unavailable-${server.name}`"
                                    >
                                        {{ t("workspace.agentMcpCanonicalMissing") }}
                                    </span>
                                </li>
                            </ul>
                        </div>
                    </template>
                    <div class="flex justify-end gap-2">
                        <button
                            type="button"
                            class="rounded-md border px-2 py-1 text-xs"
                            @click="editingPrincipalId = null"
                        >
                            {{ t("workspace.cancel") }}
                        </button>
                        <button
                            type="button"
                            :data-testid="`workspace-agent-save-cap-${agent.principalId}`"
                            class="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                            :disabled="
                                saving ||
                                canManageWorkspaceAgents !== true ||
                                !!capExceedsActorError
                            "
                            @click="saveCap(agent)"
                        >
                            {{ t("workspace.saveAgentCap") }}
                        </button>
                    </div>
                </div>
                <!-- PLAN-0629 M1-4 C：只读记忆。写入（M1-5/M2）不在这里，故显式说明只读，
                         否则用户会把它当"存不进去的 bug"。 -->
                <div class="border-t pt-3" data-testid="agent-memory-section">
                    <div class="flex items-center gap-2">
                        <button
                            type="button"
                            class="flex flex-1 items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                            :data-testid="`agent-memory-toggle-${agent.principalId}`"
                            :aria-expanded="memoryPrincipalId === agent.principalId"
                            :aria-controls="`agent-memory-panel-${agent.principalId}`"
                            @click="toggleMemories(agent)"
                        >
                            <span>{{ t("workspace.agentMemoryTitle") }}</span>
                            <span class="text-xs text-muted-foreground">{{
                                canWriteMemories === true
                                    ? t("workspace.agentMemoryWritableBadge")
                                    : canWriteMemories === false
                                      ? t("workspace.agentMemoryReadonlyBadge")
                                      : capabilityState === "loading"
                                        ? t("workspace.agentPermissionLoading")
                                        : t("workspace.agentPermissionUnavailable")
                            }}</span>
                        </button>
                        <!-- 启用记忆：与设置页同一个 Switch（reka-ui），不混用 checkbox。 -->
                        <label
                            v-if="canWriteMemories === true"
                            class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                        >
                            <Switch
                                :model-value="memoryEnabled"
                                :disabled="memoryToggleBusy"
                                :data-testid="`agent-memory-enabled-${agent.principalId}`"
                                @update:model-value="
                                    (next: boolean) => toggleMemoryEnabled(agent, next)
                                "
                            />
                            {{ t("workspace.agentMemoryEnabledToggle") }}
                        </label>
                    </div>
                    <!--
                        契约：`types: []` 等价"记忆实际不写入" ⇒ 开关开着也不生效。
                        照实提示，**不**把开关画成"关" —— 那样用户点了没反应，是另一种谎。

                        **必须在这一行 flex 之外**：上面那行是 `flex items-center`，把这段放进
                        去会跟 `flex-1` 的折叠按钮抢宽度（窄档折行、按钮文字被挤）。
                    -->
                    <p
                        v-if="memoryTypesMissing && canWriteMemories === true"
                        class="mt-1 text-xs text-amber-600 dark:text-amber-500"
                        :data-testid="`agent-memory-no-types-${agent.principalId}`"
                    >
                        {{ t("workspace.agentMemoryNoTypes") }}
                    </p>
                    <div
                        v-if="memoryPrincipalId === agent.principalId"
                        :id="`agent-memory-panel-${agent.principalId}`"
                        class="mt-2 space-y-2"
                        :data-testid="`agent-memory-panel-${agent.principalId}`"
                    >
                        <!-- PLAN-0629 M1-5：有 MEMORY_WRITE 时把只读提示换成写入入口；
                             没有权限时保留只读提示（不留任何看起来能用的控件）。 -->
                        <p
                            v-if="canWriteMemories !== true"
                            class="text-xs text-muted-foreground"
                            data-testid="agent-memory-readonly-hint"
                        >
                            {{
                                canWriteMemories === false
                                    ? t("workspace.agentMemoryReadonlyHint")
                                    : capabilityState === "loading"
                                      ? t("workspace.agentPermissionLoading")
                                      : t("workspace.agentPermissionUnavailable")
                            }}
                        </p>
                        <div v-else class="space-y-2">
                            <div class="flex items-center justify-between gap-2">
                                <label
                                    class="flex items-center gap-1.5 text-xs text-muted-foreground"
                                >
                                    <Switch
                                        :model-value="showArchivedMemories"
                                        :disabled="!archiveStatusSupported"
                                        :data-testid="`agent-memory-show-archived-${agent.principalId}`"
                                        @update:model-value="toggleShowArchived(agent)"
                                    />
                                    {{ t("workspace.agentMemoryShowArchived") }}
                                </label>
                                <button
                                    type="button"
                                    class="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                                    :data-testid="`agent-memory-create-open-${agent.principalId}`"
                                    :disabled="memoryWriteBusy || !memoryEnabled"
                                    @click="openMemoryCreate"
                                >
                                    {{ t("workspace.agentMemoryCreateOpen") }}
                                </button>
                            </div>
                            <p
                                v-if="!archiveStatusSupported"
                                class="text-xs text-muted-foreground"
                                :data-testid="`agent-memory-archived-unsupported-${agent.principalId}`"
                            >
                                {{ t("workspace.agentMemoryArchivedUnsupported") }}
                            </p>
                            <div
                                v-if="memoryCreateOpen"
                                class="space-y-2 rounded-md border p-2"
                                :data-testid="`agent-memory-create-form-${agent.principalId}`"
                            >
                                <label class="block text-xs text-muted-foreground">
                                    {{ t("workspace.agentMemoryContentLabel") }}
                                    <textarea
                                        v-model="memoryCreateContent"
                                        class="mt-1 w-full rounded-md border px-2 py-1 text-xs"
                                        rows="3"
                                        :data-testid="`agent-memory-create-content-${agent.principalId}`"
                                    />
                                </label>
                                <div class="flex flex-wrap items-center gap-3">
                                    <label
                                        class="flex items-center gap-1.5 text-xs text-muted-foreground"
                                    >
                                        <Switch
                                            :model-value="memoryCreatePinned"
                                            :data-testid="`agent-memory-create-pinned-${agent.principalId}`"
                                            @update:model-value="
                                                (next: boolean) => (memoryCreatePinned = next)
                                            "
                                        />
                                        {{ t("workspace.agentMemoryPinnedToggle") }}
                                    </label>
                                    <div class="ml-auto flex gap-2">
                                        <button
                                            type="button"
                                            class="rounded-md border px-2 py-1 text-xs"
                                            :data-testid="`agent-memory-create-cancel-${agent.principalId}`"
                                            @click="cancelMemoryCreate"
                                        >
                                            {{ t("workspace.cancel") }}
                                        </button>
                                        <button
                                            type="button"
                                            class="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                                            :data-testid="`agent-memory-create-save-${agent.principalId}`"
                                            :disabled="
                                                memoryWriteBusy || !memoryCreateContent.trim()
                                            "
                                            @click="submitMemoryCreate(agent.principalId)"
                                        >
                                            {{ t("workspace.agentMemorySave") }}
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <p
                                v-if="memoryActionError"
                                role="alert"
                                class="text-xs text-destructive"
                                data-testid="agent-memory-action-error"
                            >
                                {{ memoryActionError }}
                            </p>
                            <p
                                v-if="memoryToggleError"
                                role="alert"
                                class="text-xs text-destructive"
                                data-testid="agent-memory-toggle-error"
                            >
                                {{ memoryToggleError }}
                            </p>
                        </div>
                        <p
                            v-if="!memoryEnabled"
                            class="text-xs text-muted-foreground"
                            data-testid="agent-memory-disabled-hint"
                        >
                            {{ t("workspace.agentMemoryDisabledHint") }}
                        </p>
                        <p
                            v-if="memoryState === 'loading'"
                            role="status"
                            class="text-xs text-muted-foreground"
                            data-testid="agent-memory-loading"
                        >
                            {{ t("workspace.agentMemoryLoading") }}
                        </p>
                        <div
                            v-else-if="memoryState === 'failed'"
                            class="space-y-1"
                            data-testid="agent-memory-failed"
                        >
                            <p role="alert" class="text-xs text-destructive">
                                {{ memoryError }}
                            </p>
                            <button
                                type="button"
                                class="rounded-md border px-2 py-1 text-xs"
                                :data-testid="`agent-memory-retry-${agent.principalId}`"
                                @click="loadMemories(agent.principalId)"
                            >
                                {{ t("workspace.agentMemoryRetry") }}
                            </button>
                        </div>
                        <div v-else-if="memories.length === 0" class="space-y-2">
                            <p
                                class="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
                                data-testid="agent-memory-empty"
                            >
                                {{ t("workspace.agentMemoryEmpty") }}
                            </p>
                            <!-- 空态要给下一步动作，而不是只有一行灰字（用户裁定 v2）。 -->
                            <div v-if="canWriteMemories === true" class="flex justify-center">
                                <button
                                    type="button"
                                    class="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground"
                                    :data-testid="`agent-memory-empty-cta-${agent.principalId}`"
                                    @click="openMemoryCreate"
                                >
                                    {{ t("workspace.agentMemoryEmptyCta") }}
                                </button>
                            </div>
                        </div>
                        <ul
                            v-else
                            class="space-y-2"
                            :class="memoryEnabled ? '' : 'opacity-60'"
                            data-testid="agent-memory-list"
                        >
                            <li
                                v-for="memory in memories"
                                :key="memory.id"
                                class="rounded-md border p-2"
                                :data-testid="`agent-memory-item-${memory.id}`"
                            >
                                <div class="flex flex-wrap items-center gap-1.5 text-xs">
                                    <!-- 来源 chip：CP 未透出 origin 时不渲染（不回落到默认值）。 -->
                                    <span
                                        v-if="memory.origin"
                                        class="rounded border px-1.5 py-0.5 text-muted-foreground"
                                        :data-testid="`agent-memory-origin-${memory.id}`"
                                        :data-memory-origin="memory.origin"
                                    >
                                        {{ memoryOriginLabel(memory.origin) }}
                                    </span>
                                    <!-- pinned 是 CP 的值，UI 只照显示（不猜默认、不重排）。 -->
                                    <span
                                        v-if="memory.pinned"
                                        class="rounded border border-amber-500/40 px-1.5 py-0.5 text-amber-600"
                                        :data-testid="`agent-memory-pinned-${memory.id}`"
                                    >
                                        {{ t("workspace.agentMemoryPinned") }}
                                    </span>
                                    <span
                                        class="text-muted-foreground"
                                        :data-testid="`agent-memory-updated-${memory.id}`"
                                    >
                                        {{ t("workspace.agentMemoryUpdatedAt") }}:
                                        {{ formatDateTime(memory.updatedAt) }}
                                    </span>
                                    <!-- PLAN-0629 M1-5：行内操作只在有 MEMORY_WRITE 时出现。 -->
                                    <span
                                        v-if="
                                            canWriteMemories === true &&
                                            memoryEditingId !== memory.id
                                        "
                                        class="ml-auto flex gap-2"
                                    >
                                        <button
                                            type="button"
                                            class="rounded-md border px-2 py-0.5 text-xs"
                                            :data-testid="`agent-memory-edit-${memory.id}`"
                                            :disabled="memoryWriteBusy"
                                            @click="startEditMemory(memory)"
                                        >
                                            {{ t("workspace.agentMemoryEdit") }}
                                        </button>
                                        <button
                                            type="button"
                                            class="rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                                            :data-testid="`agent-memory-archive-${memory.id}`"
                                            :disabled="memoryWriteBusy || !memoryEnabled"
                                            @click="requestArchiveMemory(memory.id)"
                                        >
                                            {{ t("workspace.agentMemoryArchive") }}
                                        </button>
                                    </span>
                                </div>
                                <div
                                    v-if="memoryEditingId === memory.id"
                                    class="mt-2 space-y-2"
                                    :data-testid="`agent-memory-edit-form-${memory.id}`"
                                >
                                    <textarea
                                        v-model="memoryEditContent"
                                        class="w-full rounded-md border px-2 py-1 text-xs"
                                        rows="3"
                                        :data-testid="`agent-memory-edit-content-${memory.id}`"
                                    />
                                    <div class="flex flex-wrap items-center gap-3 text-xs">
                                        <label
                                            class="flex items-center gap-1.5 text-muted-foreground"
                                        >
                                            <Switch
                                                :model-value="memoryEditPinned"
                                                :data-testid="`agent-memory-edit-pinned-${memory.id}`"
                                                @update:model-value="
                                                    (next: boolean) => (memoryEditPinned = next)
                                                "
                                            />
                                            {{ t("workspace.agentMemoryPinnedToggle") }}
                                        </label>
                                        <div class="ml-auto flex gap-2">
                                            <button
                                                type="button"
                                                class="rounded-md border px-2 py-1 text-xs"
                                                :data-testid="`agent-memory-edit-cancel-${memory.id}`"
                                                @click="cancelEditMemory"
                                            >
                                                {{ t("workspace.cancel") }}
                                            </button>
                                            <button
                                                type="button"
                                                class="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                                                :data-testid="`agent-memory-edit-save-${memory.id}`"
                                                :disabled="
                                                    memoryWriteBusy || !memoryEditContent.trim()
                                                "
                                                @click="
                                                    saveEditMemory(agent.principalId, memory.id)
                                                "
                                            >
                                                {{ t("workspace.agentMemorySave") }}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                                <div
                                    v-if="memoryPendingArchiveId === memory.id"
                                    class="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-background px-2 py-1 text-xs"
                                    :data-testid="`agent-memory-archive-confirm-${memory.id}`"
                                >
                                    <span>{{ t("workspace.agentMemoryArchiveConfirm") }}</span>
                                    <span class="flex gap-2">
                                        <button
                                            type="button"
                                            class="rounded-md border px-2 py-0.5 text-xs"
                                            :data-testid="`agent-memory-archive-cancel-${memory.id}`"
                                            @click="cancelArchiveMemory"
                                        >
                                            {{ t("workspace.cancel") }}
                                        </button>
                                        <button
                                            type="button"
                                            class="rounded-md border border-destructive/50 px-2 py-0.5 text-xs text-destructive disabled:opacity-50"
                                            :data-testid="`agent-memory-archive-confirm-button-${memory.id}`"
                                            :disabled="memoryWriteBusy"
                                            @click="
                                                confirmArchiveMemory(agent.principalId, memory.id)
                                            "
                                        >
                                            {{ t("workspace.agentMemoryArchiveConfirmAction") }}
                                        </button>
                                    </span>
                                </div>
                                <p
                                    v-if="memoryEditingId !== memory.id"
                                    class="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs"
                                    :data-testid="`agent-memory-content-${memory.id}`"
                                >
                                    {{ memory.content }}
                                </p>
                            </li>
                        </ul>
                    </div>
                </div>
                <!-- PLAN-0667 M3：角色绑定（名称 / 作用域 / isSystem / 派生原子摘要；D5(b) 只给摘要） -->
                <div class="border-t pt-3" data-testid="agent-roles-section">
                    <div class="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            class="flex items-center gap-1 text-xs font-medium"
                            :data-testid="`agent-roles-toggle-${agent.principalId}`"
                            :aria-expanded="rbacPrincipalId === agent.principalId"
                            :aria-controls="`agent-roles-panel-${agent.principalId}`"
                            @click="toggleRbac(agent)"
                        >
                            <span aria-hidden="true">{{
                                rbacPrincipalId === agent.principalId ? "▾" : "▸"
                            }}</span>
                            <span>{{ t("workspace.agentRolesTitle") }}</span>
                        </button>
                        <span
                            v-if="canBindRbac !== true"
                            class="rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                            {{
                                canBindRbac === false
                                    ? t("workspace.agentRbacReadonlyBadge")
                                    : capabilityState === "loading"
                                      ? t("workspace.agentPermissionLoading")
                                      : t("workspace.agentPermissionUnavailable")
                            }}
                        </span>
                    </div>
                    <div
                        v-if="rbacPrincipalId === agent.principalId"
                        :id="`agent-roles-panel-${agent.principalId}`"
                        class="mt-2 space-y-2"
                        :data-testid="`agent-roles-panel-${agent.principalId}`"
                    >
                        <p
                            v-if="rbacState === 'loading'"
                            role="status"
                            class="text-xs text-muted-foreground"
                            data-testid="agent-rbac-loading"
                        >
                            {{ t("workspace.agentRbacLoading") }}
                        </p>
                        <div
                            v-else-if="rbacState === 'failed'"
                            class="space-y-1"
                            data-testid="agent-rbac-failed"
                        >
                            <p role="alert" class="text-xs text-destructive">{{ rbacError }}</p>
                            <button
                                type="button"
                                class="rounded-md border px-2 py-1 text-xs"
                                data-testid="agent-rbac-retry"
                                @click="loadRbac(agent.principalId)"
                            >
                                {{ t("workspace.agentRbacRetry") }}
                            </button>
                        </div>
                        <template v-else>
                            <p
                                v-if="agentRoles.length === 0"
                                class="rounded-md border border-dashed p-2 text-xs text-muted-foreground"
                                data-testid="agent-roles-empty"
                            >
                                {{ t("workspace.agentRolesEmpty") }}
                            </p>
                            <ul v-else class="space-y-1.5" data-testid="agent-roles-list">
                                <li
                                    v-for="binding in agentRoles"
                                    :key="binding.bindingId"
                                    class="rounded-md border p-2"
                                    :data-testid="`agent-role-item-${binding.bindingId}`"
                                >
                                    <div class="flex flex-wrap items-center gap-1.5 text-xs">
                                        <span class="text-xs font-medium">{{
                                            binding.displayName || binding.name
                                        }}</span>
                                        <span
                                            v-if="binding.scopeName || binding.scopeType"
                                            class="rounded-full border px-1.5 py-0.5 text-muted-foreground"
                                            :data-testid="`agent-role-scope-${binding.bindingId}`"
                                        >
                                            {{ binding.scopeName || binding.scopeType }}
                                        </span>
                                        <span
                                            v-if="binding.isSystem"
                                            class="rounded-full border px-1.5 py-0.5 text-muted-foreground"
                                            :data-testid="`agent-role-system-${binding.bindingId}`"
                                        >
                                            {{ t("workspace.agentRoleSystemBadge") }}
                                        </span>
                                        <button
                                            v-if="!binding.isSystem"
                                            type="button"
                                            class="ml-auto rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
                                            :disabled="rbacBusy || canBindRbac !== true"
                                            :data-testid="`agent-role-unbind-${binding.bindingId}`"
                                            @click="unbindRole(agent, binding)"
                                        >
                                            {{ t("workspace.agentRbacUnbind") }}
                                        </button>
                                    </div>
                                    <p
                                        v-if="binding.atomSummary.length > 0"
                                        class="mt-1 text-xs text-muted-foreground"
                                        :data-testid="`agent-role-atoms-${binding.bindingId}`"
                                    >
                                        {{
                                            t("workspace.agentRoleAtomsSummary", {
                                                atoms: binding.atomSummary.join(" · "),
                                                count: binding.atomCount,
                                            })
                                        }}
                                    </p>
                                    <p
                                        v-if="binding.grantedBy"
                                        class="mt-0.5 text-xs text-muted-foreground"
                                        :data-testid="`agent-role-granted-by-${binding.bindingId}`"
                                    >
                                        {{
                                            t("workspace.agentRoleGrantedBy", {
                                                id: binding.grantedBy.slice(0, 8),
                                            })
                                        }}
                                    </p>
                                </li>
                            </ul>
                            <p
                                class="mt-1 text-xs text-muted-foreground"
                                :data-testid="`agent-role-cap-hint-${agent.principalId}`"
                            >
                                {{ t("workspace.agentRoleCapHint") }}
                            </p>
                            <div
                                v-if="canBindRbac === true"
                                class="flex flex-wrap items-center gap-2"
                            >
                                <Select
                                    :model-value="selectedRoleId"
                                    @update:model-value="
                                        (value) => (selectedRoleId = String(value))
                                    "
                                >
                                    <SelectTrigger
                                        class="h-7 rounded-md border bg-background px-2 text-xs"
                                        :data-testid="`agent-role-select-${agent.principalId}`"
                                    >
                                        <SelectValue>{{ roleChoiceLabel() }}</SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem
                                            v-for="role in roleCandidates"
                                            :key="role.id"
                                            :value="role.id"
                                        >
                                            {{ role.displayName || role.name }}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                                <button
                                    type="button"
                                    class="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                                    :disabled="rbacBusy || !selectedRoleId"
                                    :data-testid="`agent-role-bind-${agent.principalId}`"
                                    @click="bindSelectedRole(agent)"
                                >
                                    {{ t("workspace.agentRbacBind") }}
                                </button>
                            </div>
                            <p
                                v-else
                                class="text-xs text-muted-foreground"
                                data-testid="agent-rbac-readonly-hint"
                            >
                                {{
                                    canBindRbac === false
                                        ? t("workspace.agentRbacReadonlyHint")
                                        : capabilityState === "loading"
                                          ? t("workspace.agentPermissionLoading")
                                          : t("workspace.agentPermissionUnavailable")
                                }}
                            </p>
                            <p
                                v-if="rbacActionError"
                                role="alert"
                                class="text-xs text-destructive"
                                data-testid="agent-rbac-action-error"
                            >
                                {{ rbacActionError }}
                            </p>
                        </template>
                    </div>
                </div>
                <!-- PLAN-0667 M3：技能绑定（principal 级，design D3(a)） -->
                <div class="border-t pt-3" data-testid="agent-skills-section">
                    <div class="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            class="flex items-center gap-1 text-xs font-medium"
                            :data-testid="`agent-skills-toggle-${agent.principalId}`"
                            :aria-expanded="rbacPrincipalId === agent.principalId"
                            @click="toggleRbac(agent)"
                        >
                            <span aria-hidden="true">{{
                                rbacPrincipalId === agent.principalId ? "▾" : "▸"
                            }}</span>
                            <span>{{ t("workspace.agentSkillsTitle") }}</span>
                        </button>
                        <span
                            v-if="canBindRbac === false"
                            class="rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                            {{ t("workspace.agentRbacReadonlyBadge") }}
                        </span>
                    </div>
                    <div
                        v-if="rbacPrincipalId === agent.principalId"
                        class="mt-2 space-y-2"
                        :data-testid="`agent-skills-panel-${agent.principalId}`"
                    >
                        <template v-if="rbacState === 'ready'">
                            <p
                                v-if="agentSkills.length === 0"
                                class="rounded-md border border-dashed p-2 text-xs text-muted-foreground"
                                data-testid="agent-skills-empty"
                            >
                                {{ t("workspace.agentSkillsEmpty") }}
                            </p>
                            <ul v-else class="space-y-1.5" data-testid="agent-skills-list">
                                <li
                                    v-for="binding in agentSkills"
                                    :key="binding.bindingId"
                                    class="flex flex-wrap items-center gap-1.5 rounded-md border p-2 text-xs"
                                    :data-testid="`agent-skill-item-${binding.bindingId}`"
                                >
                                    <span class="text-xs font-medium">{{ binding.name }}</span>
                                    <span
                                        v-if="binding.scopeType"
                                        class="rounded-full border px-1.5 py-0.5 text-xs"
                                        :class="
                                            binding.scopeType === 'workspace'
                                                ? 'bg-muted'
                                                : 'text-muted-foreground'
                                        "
                                        :title="binding.scopeName ?? undefined"
                                        :data-testid="`agent-skill-scope-${binding.scopeType}`"
                                    >
                                        {{
                                            t(
                                                binding.scopeType === "workspace"
                                                    ? "workspace.agentSkillScopeWorkspace"
                                                    : "workspace.agentSkillScopeInstance",
                                            )
                                        }}
                                    </span>
                                    <span
                                        v-if="binding.sourceType"
                                        class="rounded border px-1 py-0.5 text-xs text-muted-foreground"
                                        :data-testid="`agent-skill-source-${binding.bindingId}`"
                                        >{{
                                            t(
                                                binding.sourceType === "workspace"
                                                    ? "workspace.agentSkillSourceWorkspace"
                                                    : "workspace.agentSkillSourceInstance",
                                            )
                                        }}</span
                                    >
                                    <span v-if="binding.sourceName" class="text-muted-foreground">{{
                                        binding.sourceName
                                    }}</span>
                                    <span
                                        v-if="binding.tokenEstimate != null"
                                        class="text-muted-foreground"
                                        >{{
                                            t("workspace.agentSkillTokens", {
                                                tokens: binding.tokenEstimate,
                                            })
                                        }}</span
                                    >
                                    <button
                                        type="button"
                                        class="ml-auto rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
                                        :disabled="rbacBusy || canBindRbac !== true"
                                        :data-testid="`agent-skill-unbind-${binding.bindingId}`"
                                        @click="unbindSkill(agent, binding)"
                                    >
                                        {{ t("workspace.agentRbacUnbind") }}
                                    </button>
                                </li>
                            </ul>
                            <div
                                v-if="canBindRbac === true"
                                class="flex flex-wrap items-center gap-2"
                            >
                                <Select
                                    :model-value="selectedSkillId"
                                    @update:model-value="
                                        (value) => (selectedSkillId = String(value))
                                    "
                                >
                                    <SelectTrigger
                                        class="h-7 rounded-md border bg-background px-2 text-xs"
                                        :data-testid="`agent-skill-select-${agent.principalId}`"
                                    >
                                        <SelectValue>{{ skillChoiceLabel() }}</SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem
                                            v-for="skill in skillCandidates"
                                            :key="skill.skillId"
                                            :value="skill.skillId"
                                        >
                                            {{ skill.name }}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                                <button
                                    type="button"
                                    class="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                                    :disabled="rbacBusy || !selectedSkillId"
                                    :data-testid="`agent-skill-bind-${agent.principalId}`"
                                    @click="bindSelectedSkill(agent)"
                                >
                                    {{ t("workspace.agentRbacBind") }}
                                </button>
                            </div>
                            <p v-else class="text-xs text-muted-foreground">
                                {{
                                    canBindRbac === false
                                        ? t("workspace.agentRbacReadonlyHint")
                                        : capabilityState === "loading"
                                          ? t("workspace.agentPermissionLoading")
                                          : t("workspace.agentPermissionUnavailable")
                                }}
                            </p>
                        </template>
                    </div>
                </div>
                <div class="border-t pt-3" data-testid="agent-delegated-section">
                    <button
                        type="button"
                        class="flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs"
                        :aria-expanded="spawnPrincipalId === agent.principalId"
                        :aria-controls="`agent-delegated-panel-${agent.principalId}`"
                        :data-testid="`agent-delegated-toggle-${agent.principalId}`"
                        @click="toggleSpawnSessions(agent.principalId)"
                    >
                        <span class="font-medium">{{ t("workspace.agentDelegatedTitle") }}</span>
                        <span class="text-muted-foreground">{{
                            spawnSummary(agent.principalId)
                        }}</span>
                    </button>
                    <div
                        v-if="spawnPrincipalId === agent.principalId"
                        :id="`agent-delegated-panel-${agent.principalId}`"
                        class="mt-2 space-y-2"
                        :data-testid="`agent-delegated-panel-${agent.principalId}`"
                    >
                        <p
                            v-if="spawnState === 'loading'"
                            class="text-xs text-muted-foreground"
                            data-testid="agent-delegated-loading"
                        >
                            {{ t("workspace.agentDelegatedLoading") }}
                        </p>
                        <p
                            v-else-if="spawnState === 'forbidden'"
                            class="rounded-md border border-dashed p-2 text-xs text-muted-foreground"
                            :data-testid="`agent-delegated-forbidden-${agent.principalId}`"
                        >
                            {{ t("workspace.agentDelegatedForbidden") }}
                        </p>
                        <p
                            v-else-if="spawnState === 'failed'"
                            class="rounded-md border border-destructive/40 p-2 text-xs text-destructive"
                            data-testid="agent-delegated-failed"
                        >
                            {{ spawnError || t("workspace.agentDelegatedUnavailable") }}
                        </p>
                        <template v-else-if="spawnState === 'ready' && spawnSessions">
                            <div class="flex flex-wrap items-center gap-2 text-xs">
                                <span
                                    class="font-medium"
                                    :data-testid="`agent-delegated-count-${agent.principalId}`"
                                >
                                    {{
                                        t("workspace.agentDelegatedCount", {
                                            count: spawnSessions.counts.all,
                                        })
                                    }}
                                </span>
                                <span
                                    v-if="spawnSessions.counts.direct > 0"
                                    class="text-muted-foreground"
                                    :data-testid="`agent-delegated-direct-${agent.principalId}`"
                                >
                                    {{
                                        t("workspace.agentDelegatedDirectCount", {
                                            count: spawnSessions.counts.direct,
                                        })
                                    }}
                                </span>
                                <span v-if="spawnSessions.truncated" class="text-muted-foreground">
                                    {{
                                        t("workspace.agentDelegatedTruncated", {
                                            limit: spawnSessions.limit,
                                        })
                                    }}
                                </span>
                                <button
                                    type="button"
                                    class="rounded-full border px-1.5 py-0.5 text-xs"
                                    :data-testid="`agent-delegated-archived-toggle-${agent.principalId}`"
                                    @click="toggleSpawnArchived(agent.principalId)"
                                >
                                    {{
                                        spawnIncludeArchived
                                            ? t("workspace.agentDelegatedExcludeArchived")
                                            : t("workspace.agentDelegatedIncludeArchived")
                                    }}
                                </button>
                            </div>
                            <p
                                v-if="!spawnIncludeArchived"
                                class="text-xs text-muted-foreground"
                                data-testid="agent-delegated-archived-note"
                            >
                                {{ t("workspace.agentDelegatedArchivedNote") }}
                            </p>
                            <p
                                v-if="spawnHasRedacted"
                                class="text-xs text-muted-foreground"
                                :data-testid="`agent-delegated-redacted-${agent.principalId}`"
                            >
                                {{ t("workspace.agentDelegatedRedactedHint") }}
                            </p>
                            <p
                                v-if="spawnSessions.counts.all === 0"
                                class="rounded-md border border-dashed p-2 text-xs text-muted-foreground"
                                data-testid="agent-delegated-empty"
                            >
                                {{ t("workspace.agentDelegatedEmpty") }}
                            </p>
                            <ul v-else class="space-y-1.5" data-testid="agent-delegated-list">
                                <li
                                    v-for="row in spawnSessions.sessions"
                                    :key="row.id"
                                    class="flex flex-wrap items-center gap-1.5 rounded-md border p-2 text-xs"
                                    :data-testid="`agent-delegated-row-${row.id}`"
                                >
                                    <span class="text-xs font-medium">
                                        {{
                                            row.readable
                                                ? row.title || t("workspace.agentDelegatedUntitled")
                                                : t("workspace.agentDelegatedTitleHidden")
                                        }}
                                    </span>
                                    <span class="rounded-full border px-1.5 py-0.5 text-xs">
                                        {{
                                            t("workspace.agentDelegatedDepth", {
                                                depth: row.depth,
                                            })
                                        }}
                                    </span>
                                    <span
                                        v-if="row.archived"
                                        class="rounded-full border px-1.5 py-0.5 text-xs"
                                        :data-testid="`agent-delegated-row-archived-${row.id}`"
                                    >
                                        {{ t("workspace.agentDelegatedArchived") }}
                                    </span>
                                    <span
                                        v-if="row.runStatus"
                                        class="text-xs text-muted-foreground"
                                        :data-testid="`agent-delegated-row-status-${row.id}`"
                                    >
                                        {{
                                            t("workspace.agentDelegatedRunStatus", {
                                                status: row.runStatus,
                                            })
                                        }}
                                    </span>
                                </li>
                            </ul>
                        </template>
                    </div>
                </div>
            </article>
        </section>

        <p
            v-if="error"
            role="alert"
            data-testid="agent-error"
            class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
        >
            {{ error }}
        </p>
        <p v-if="status" role="status" class="text-sm text-emerald-700 dark:text-emerald-300">
            {{ status }}
        </p>
    </section>

    <AgentPrincipalDetailDrawer
        v-model:open="principalDetailOpen"
        :principal="principalDetail"
        :workspace-id="workspaceId"
        :editable-sections="['hooks']"
        :unknown-sections="['model', 'delegation']"
        @changed="onPrincipalDetailChanged"
    />
</template>
