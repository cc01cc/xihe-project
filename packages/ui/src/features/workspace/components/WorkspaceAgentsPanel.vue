<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "../../../stores/auth";
import { principalNameError } from "../../../lib/principalName";
import {
    ApiError,
    api,
    type AgentModelRef,
    type AgentPrincipalCreateResponse,
    type AgentRoleBinding,
    type AgentSkillBinding,
    type AgentSkillSummary,
    type AgentTemplateSummary,
    type ApiRole,
    type SelfPermissionsView,
    type WorkspaceAgentBinding,
    type WorkspaceAgentMemory,
    type WorkspaceAgentPermission,
} from "../../../composables/api";
import { problemDetailText } from "../../../lib/errorMessages";
// 用户裁定（2026-11-03）：二态统一用项目 Switch（reka-ui），不混用 checkbox。
import { Switch } from "../../../components/ui/switch";

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
}>();

const { t } = useI18n();
const authStore = useAuthStore(),
    actionClasses = ["read", "write", "delete", "exec", "network", "credential"] as const;
const agents = ref<WorkspaceAgentBinding[]>([]);
const templates = ref<Array<{ layer: string; template: AgentTemplateSummary }>>([]),
    loading = ref(false);
const saving = ref(false),
    error = ref(""),
    status = ref(""),
    name = ref(""),
    templateId = ref("");
const createdPrincipal = ref<AgentPrincipalCreateResponse | null>(null);
const permissions = ref<WorkspaceAgentPermission[]>([]),
    editingPrincipalId = ref<string | null>(null);
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
const roleCandidates = ref<ApiRole[]>([]);
const skillCandidates = ref<AgentSkillSummary[]>([]);
const selectedRoleId = ref("");
const selectedSkillId = ref("");
const rbacBusy = ref(false);
const rbacActionError = ref("");
let rbacGeneration = 0;

/** 绑定/解绑的可用性：沿用工作区 agent 管理原子；`null` = 能力投影未回（禁用但不谎报）。 */
const canBindRbac = computed<boolean | null>(() => canManageWorkspaceAgents.value);
/** CP 未支持 `?status=` 时降级：开关置灰并说明，列表仍读 active（不报错、不造参数）。 */
const archiveStatusSupported = ref(true);
const unbindConfirmationId = ref<string | null>(null);
const disableConfirmationId = ref<string | null>(null);
/**
 * PLAN-0622：写操作的可用性**只看 CP 权威能力投影** `GET /me/permissions` 的原子：
 * - `CREATE_OWN_AGENT`（user 层）→ 能建 PERSONAL；
 * - `MANAGE_WORKSPACE_AGENTS`（workspace 层、resource=本工作区 UUID）→ 能建 WORKSPACE / 绑定 / 禁用；
 * - `CREATE_ACCOUNT`（instance 层、resource `*`）→ 能建 INSTANCE。
 *
 * `capabilityState`：`loading` 时按钮保持禁用（fail-closed），`failed` 时同样禁用并显示原因——
 * 绝不出现"点了才发现没权限"。
 */
const capabilityState = ref<"loading" | "ready" | "failed">("loading");
const instanceAtoms = ref<string[]>([]);
const workspaceAtoms = ref<string[]>([]);

/**
 * 创建入口是否可用：作用域写面已退出（T5.1），创建走 CP 默认 WORKSPACE；
 * 因此只认工作区级 MANAGE_WORKSPACE_AGENTS，不再让 UI 选择 scope。
 * `null` = 未知（禁用但不算"无权限"）。
 */
const canCreatePrincipal = computed<boolean | null>(() => {
    if (capabilityState.value === "loading") return null;
    if (capabilityState.value === "failed") return false;
    return workspaceAtoms.value.includes("MANAGE_WORKSPACE_AGENTS");
});

/** 绑定 / 编辑 cap / 禁用都需要工作区级 MANAGE_WORKSPACE_AGENTS（个人 agent 的属主另论）。 */
const canManageWorkspaceAgents = computed<boolean | null>(() => {
    if (capabilityState.value === "loading") return null;
    if (capabilityState.value === "failed") return false;
    return workspaceAtoms.value.includes("MANAGE_WORKSPACE_AGENTS");
});

/**
 * PLAN-0629 M1-5：记忆写入要 CP 的 `MEMORY_WRITE` 原子（不是角色名、不借用 agent 管理权限）。
 * `null` = 能力投影还没回来（控件禁用但不谎报无权限）。
 */
const canWriteMemories = computed<boolean | null>(() => {
    if (capabilityState.value === "loading") return null;
    if (capabilityState.value === "failed") return false;
    return workspaceAtoms.value.includes("MEMORY_WRITE");
});

const defaultModelProvider = ref("");
const defaultModelName = ref("");
const allowedModels = ref<AgentModelRef[]>([]);

/** 允许模型集校验：两项都填、且 (provider, model) 不重复。 */
const allowedModelsError = computed(() => {
    const seen = new Set<string>();
    for (const entry of allowedModels.value) {
        const provider = entry.provider.trim(),
            model = entry.model.trim();
        if (!provider || !model) return t("workspace.agentAllowedModelsIncomplete");
        const key = `${provider}::${model}`;
        if (seen.has(key)) return t("workspace.agentAllowedModelsDuplicate");
        seen.add(key);
    }
    return "";
});

/** 默认模型：要么两项都填，要么都留空（只填一半是配置错误）。 */
const defaultModelError = computed(() => {
    const provider = defaultModelProvider.value.trim(),
        model = defaultModelName.value.trim();
    if (provider === model) return ""; // 都空 / 都非空且相等都是合法态
    if (!provider || !model) return t("workspace.agentDefaultModelIncomplete");
    return "";
});

/** 2026-11-04 用户裁定：主体名不得含空格、不得数字开头，只允许字母/汉字/数字。 */
const agentNameError = computed(() => principalNameError(name.value));

/** 错误码 → 文案。前后空格单独一条提示：CP 权威不 trim，UI 不得静默吞掉。 */
const agentNameErrorMessage = computed(() => {
    switch (agentNameError.value) {
        case "required":
            return t("validation.principalNameRequired");
        case "whitespace":
            return t("validation.principalNameWhitespace");
        case "pattern":
            return t("validation.principalNamePattern");
        default:
            return "";
    }
});

const createBlocked = computed(
    () =>
        !!agentNameError.value ||
        saving.value ||
        !!createdPrincipal.value ||
        canCreatePrincipal.value !== true ||
        !!allowedModelsError.value ||
        !!defaultModelError.value,
);

onMounted(() => {
    // Every open is a fresh mount (dock activation or mobile modal), so the loads run once
    // per open — the same cadence the dialog had via `watch(open)`.
    resetMemoryPanel();
    void loadAgents();
    void loadTemplates();
    void loadCreateCapability();
});

async function loadCreateCapability() {
    capabilityState.value = "loading";
    try {
        const self: SelfPermissionsView = await api.getSelfPermissions();
        instanceAtoms.value = (self.instancePermissions ?? []).map((atom) => atom.actionClass);
        // 实例 `*` 级原子同时覆盖所有工作区（管理员）。
        const workspace = (self.workspaces ?? []).find(
            (item) => item.workspaceId === props.workspaceId,
        );
        const scoped = (workspace?.permissions ?? []).map((atom) => atom.actionClass),
            hasWildcard = (self.instancePermissions ?? []).some((atom) => atom.resource === "*");
        workspaceAtoms.value = scoped.length > 0 ? scoped : hasWildcard ? instanceAtoms.value : [];
        capabilityState.value = "ready";
    } catch (cause) {
        // 投影拿不到就 fail-closed，并保留原因（不静默）。
        capabilityState.value = "failed";
        error.value = cause instanceof ApiError ? cause.message : t("workspace.agentLoadFailed");
    }
}

/** 列表行上的来源标签（本工作区/个人/实例）。 */
function agentSourceLabel(agent: WorkspaceAgentBinding): string {
    const source = agent.source;
    return t(`workspace.agentSource${source[0].toUpperCase()}${source.slice(1)}`);
}

function agentDefaultModel(agent: WorkspaceAgentBinding): string {
    const provider = agent.defaultModelProvider,
        model = agent.defaultModelName;
    if (!provider && !model) return "";
    return `${provider ?? "—"} / ${model ?? "—"}`;
}

/** 个人 agent 的属主本人可以自己禁用；其余行需要工作区级 MANAGE_WORKSPACE_AGENTS。 */
function canDisable(agent: WorkspaceAgentBinding): boolean {
    if (canManageWorkspaceAgents.value === null) return false;
    if (canManageWorkspaceAgents.value) return true;
    if (agent.source !== "personal") return false;
    return Boolean(agent.ownerUserId) && agent.ownerUserId === authStore.user?.id;
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
function addAllowedModel() {
    allowedModels.value = [...allowedModels.value, { provider: "", model: "" }];
}

function removeAllowedModel(index: number) {
    allowedModels.value = allowedModels.value.filter((_, current) => current !== index);
}

function setAllowedModel(index: number, field: "provider" | "model", value: string) {
    allowedModels.value = allowedModels.value.map((entry, current) =>
        current === index ? { ...entry, [field]: value } : entry,
    );
}

async function loadAgents() {
    loading.value = true;
    error.value = "";
    status.value = "";
    try {
        agents.value = await api.getWorkspaceAgents(props.workspaceId);
    } catch (cause) {
        error.value = cause instanceof ApiError ? cause.message : t("workspace.agentLoadFailed");
    } finally {
        loading.value = false;
    }
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
        memoryError.value =
            cause instanceof ApiError && cause.problem.code === "AGENT_PRINCIPAL_NOT_FOUND"
                ? t("workspace.agentMemoryNotFound")
                : cause instanceof ApiError
                  ? cause.message
                  : t("workspace.agentMemoryLoadFailed");
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
        // 候选清单（roles 复用既有 /roles；skills 复用 /skills）——失败只影响"可绑定项"，不影响已绑定列表。
        const [rolesCatalog, skillsCatalog] = await Promise.allSettled([
            api.listRoles(props.workspaceId),
            api.getSkills(),
        ]);
        if (generation !== rbacGeneration) return;
        roleCandidates.value = rolesCatalog.status === "fulfilled" ? rolesCatalog.value : [];
        skillCandidates.value = skillsCatalog.status === "fulfilled" ? skillsCatalog.value : [];
    } catch (cause) {
        if (generation !== rbacGeneration) return;
        rbacError.value = rbacErrorMessage(cause);
        rbacState.value = "failed";
    }
}

/** 409 三类码给可读文案；404 不当崩溃；其它沿用 CP problem message。 */
function rbacErrorMessage(cause: unknown): string {
    if (cause instanceof ApiError) {
        // BL-288：可行动 detail（具体原子名/条数/上限）优先；无 detail 才回退本地化文案。
        const detail = problemDetailText(cause, "");
        if (detail) return detail;
        switch (cause.problem.code) {
            case "AGENT_PRINCIPAL_FORBIDDEN_ATOMS":
                return t("workspace.agentRoleForbiddenAtoms");
            case "ROLE_BINDING_EXCEEDS_CAP":
                return t("workspace.agentRoleExceedsCap");
            case "ROLE_BINDING_EXISTS":
                return t("workspace.agentRoleBindingExists");
            case "ROLE_BINDING_IMMUTABLE":
                return t("workspace.agentRoleBindingImmutable");
            case "AGENT_PRINCIPAL_NOT_FOUND":
            case "SKILL_NOT_FOUND":
            case "ROLE_NOT_FOUND":
                return t("workspace.agentRbacNotFound");
            default:
                return cause.message;
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

/** 记忆是否注入上下文：`contextPolicy.memory.enabled !== false`（缺省=启用，UI 不自造默认）。 */
const memoryEnabled = computed<boolean>(() => {
    const policy = memoryAgent.value?.contextPolicy ?? null;
    const memory = policy?.memory;
    if (!memory || typeof memory !== "object") return true;
    return (memory as Record<string, unknown>).enabled !== false;
});

/**
 * 「启用记忆」开关：`PATCH /agent-principals/{id}` 的 `contextPolicy` 是**整对象替换**，
 * 所以先与现值合并再回写；失败时保持原状态并就地报错（不静默、不乐观翻转）。
 */
async function toggleMemoryEnabled(agent: WorkspaceAgentBinding, next: boolean) {
    if (memoryToggleBusy.value) return;
    memoryToggleBusy.value = true;
    memoryToggleError.value = "";
    const base = (agent.contextPolicy ?? {}) as Record<string, unknown>;
    const currentMemory =
        base.memory && typeof base.memory === "object"
            ? (base.memory as Record<string, unknown>)
            : {};
    try {
        const merged = { ...base, memory: { ...currentMemory, enabled: next } };
        await api.updateAgentPrincipalContextPolicy(agent.principalId, merged);
        agent.contextPolicy = merged;
    } catch (cause) {
        memoryToggleError.value =
            cause instanceof ApiError ? cause.message : t("workspace.agentMemoryToggleFailed");
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
        if (cause.problem.code === "MEMORY_WRITE_FORBIDDEN" || cause.problem.code === "FORBIDDEN") {
            return t("workspace.agentMemoryWriteForbidden");
        }
        if (cause.problem.code === "AGENT_PRINCIPAL_NOT_FOUND") {
            return t("workspace.agentMemoryNotFound");
        }
        // CP 的 ProblemDetails 文案优先（它带具体原因），但只在已有码时使用。
        return cause.message;
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

async function loadTemplates() {
    templates.value = [];
    try {
        const layers = authStore.isAdmin
            ? (["instance", "user", "workspace"] as const)
            : (["user", "workspace"] as const);
        const results = await Promise.all(
            layers.map((layer) => api.getAgentTemplates(layer, props.workspaceId)),
        );
        templates.value = results.flatMap((result) =>
            result.templates.map((template) => ({ layer: result.layer, template })),
        );
    } catch (cause) {
        error.value =
            cause instanceof ApiError ? cause.message : t("workspace.agentTemplateLoadFailed");
    }
}

function actionLabel(actionClass: string): string {
    const key = `workspace.agentAction${actionClass[0]?.toUpperCase()}${actionClass.slice(1)}`;
    const label = t(key);
    return label === key ? actionClass : label;
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
    const current = permissions.value.filter(
        (permission) => permission.actionClass !== actionClass,
    );
    if (checked) current.push({ actionClass, resource: "*" });
    permissions.value = current;
}

function setPermissionResource(actionClass: string, resource: string) {
    permissions.value = permissions.value.map((permission) =>
        permission.actionClass === actionClass
            ? { ...permission, resource: resource.trim() || "*" }
            : permission,
    );
}

/**
 * PLAN-0585 M2 / F-02: a missing grant must read as an actionable localized hint that points at
 * the admin grant panel, never as the CP's raw English detail (`CREATE_ACCOUNT permission is
 * required`).
 */
function agentErrorMessage(cause: unknown, forbiddenKey: string, fallbackKey: string): string {
    if (cause instanceof ApiError && cause.problem.code === "FORBIDDEN") {
        return t(forbiddenKey);
    }
    return t(fallbackKey);
}

async function createPrincipal() {
    if (createBlocked.value) return;
    saving.value = true;
    error.value = "";
    try {
        const allowed = allowedModels.value
            .map((entry) => ({ provider: entry.provider.trim(), model: entry.model.trim() }))
            .filter((entry) => entry.provider && entry.model);
        createdPrincipal.value = await api.createAgentPrincipal({
            name: name.value.trim(),
            ...(templateId.value ? { templateId: templateId.value } : {}),
            ...(defaultModelProvider.value.trim()
                ? { defaultModelProvider: defaultModelProvider.value.trim() }
                : {}),
            ...(defaultModelName.value.trim()
                ? { defaultModelName: defaultModelName.value.trim() }
                : {}),
            ...(allowed.length > 0 ? { allowedModels: allowed } : {}),
        });
        name.value = "";
        templateId.value = "";
        defaultModelProvider.value = "";
        defaultModelName.value = "";
        allowedModels.value = [];
        permissions.value = [];
        // 真栈 bug（2026-11-02）：创建成功后必须重新拉列表，否则用户要关掉重开面板才看到新主体
        // （bind/unbind/disable 三处都调了 loadAgents，创建这处漏了）。放在 status 之前，
        // 因为 loadAgents 会清空 status。
        await loadAgents();
        status.value = t("workspace.agentPrincipalCreated");
    } catch (cause) {
        error.value = agentErrorMessage(
            cause,
            "workspace.agentCreateForbidden",
            "workspace.agentCreateFailed",
        );
    } finally {
        saving.value = false;
    }
}

/** PLAN-0622：禁用是两步确认（第一步只换文案），并要求调用方先看清后果。 */
async function disableAgent(agent: WorkspaceAgentBinding) {
    if (!canDisable(agent) || saving.value) return;
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
 * 真栈 S2 bug（2026-11-02）：`GET /workspaces/{ws}/agents` 会返回调用者自己的 PERSONAL/INSTANCE
 * 主体（含**未绑定**的），但未绑定时建会话会被 CP 403 拒绝（"not bound"）。原先 bind 入口只在
 * "刚创建"区块里，关掉重开就没了 —— 用户视角是死路。这里给**每一行**一个绑定入口：PUT 是幂等
 * 的 setWorkspaceCap，已绑定行重存当前快照也不会产生副作用。
 */
async function bindExistingAgent(agent: WorkspaceAgentBinding) {
    if (saving.value || canManageWorkspaceAgents.value !== true) return;
    saving.value = true;
    error.value = "";
    try {
        await api.updateWorkspaceAgentCap(
            props.workspaceId,
            agent.principalId,
            agent.permissionsSnapshot ?? [],
        );
        await loadAgents();
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

async function bindCreatedPrincipal() {
    const principal = createdPrincipal.value;
    if (!principal || saving.value) return;
    saving.value = true;
    error.value = "";
    try {
        await api.updateWorkspaceAgentCap(
            props.workspaceId,
            principal.principalId,
            permissions.value,
        );
        createdPrincipal.value = null;
        permissions.value = [];
        await loadAgents();
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

function startEditing(agent: WorkspaceAgentBinding) {
    editingPrincipalId.value = agent.principalId;
    permissions.value = agent.permissionsSnapshot.map((permission) => ({ ...permission }));
    error.value = "";
}

async function saveCap(agent: WorkspaceAgentBinding) {
    if (saving.value) return;
    saving.value = true;
    error.value = "";
    try {
        await api.updateWorkspaceAgentCap(props.workspaceId, agent.principalId, permissions.value);
        editingPrincipalId.value = null;
        await loadAgents();
        status.value = t("workspace.agentCapSaved");
    } catch (cause) {
        error.value = cause instanceof ApiError ? cause.message : t("workspace.agentSaveFailed");
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
        await loadAgents();
        status.value = t("workspace.agentUnboundSuccess");
    } catch (cause) {
        error.value = cause instanceof ApiError ? cause.message : t("workspace.agentUnbindFailed");
    } finally {
        saving.value = false;
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

        <form
            class="space-y-3 rounded-lg border p-3"
            data-testid="agent-principal-create-form"
            @submit.prevent="createPrincipal"
        >
            <div>
                <h3 class="text-sm font-semibold">{{ t("workspace.createAgentPrincipal") }}</h3>
                <p class="mt-1 text-xs text-muted-foreground">
                    {{ t("workspace.agentCreatePermissionNote") }}
                </p>
                <!-- PLAN-0610 W5c: the principal-grant page is retired. Granting
                         CREATE_ACCOUNT / MANAGE_WORKSPACE_AGENTS now means binding a role that carries
                         those atoms, so the affordance points at the role/binding surface (F-02: an
                         admin must never hit a dead end).
                         PLAN-0621 F-01：没有 CREATE_ACCOUNT 的普通用户同样要看到这条路（原先只有
                         admin 能看到链接），并且创建按钮在**点击之前**就禁用——不要让人点完才吃 403。 -->
                <router-link
                    v-if="authStore.isAdmin || canCreatePrincipal === false"
                    to="/settings/roles"
                    data-testid="agent-grant-panel-link"
                    class="mt-1 inline-block text-xs text-link underline"
                >
                    {{ t("workspace.agentGrantPanelLink") }}
                </router-link>
                <p
                    v-if="canCreatePrincipal === false"
                    data-testid="agent-create-forbidden-hint"
                    class="mt-1 text-xs text-muted-foreground"
                >
                    {{ t("workspace.agentCreateForbidden") }}
                </p>
            </div>
            <label class="block space-y-1 text-sm">
                <span>{{ t("workspace.agentName") }}</span>
                <input
                    v-model="name"
                    required
                    maxlength="120"
                    data-testid="agent-principal-name"
                    class="w-full rounded-md border bg-background px-3 py-2"
                    :aria-invalid="agentNameError ? 'true' : undefined"
                    :aria-describedby="agentNameError ? 'agent-principal-name-error' : undefined"
                />
                <span
                    v-if="agentNameError"
                    id="agent-principal-name-error"
                    class="block text-xs text-destructive"
                    data-testid="agent-principal-name-error"
                >
                    {{ agentNameErrorMessage }}
                </span>
                <span v-else class="block text-xs text-muted-foreground">
                    {{ t("validation.nameAllowed") }}
                </span>
            </label>
            <label class="block space-y-1 text-sm">
                <span>{{ t("workspace.agentTemplateChoice") }}</span>
                <select
                    v-model="templateId"
                    data-testid="agent-principal-template"
                    class="w-full rounded-md border bg-background px-3 py-2"
                >
                    <option value="">{{ t("workspace.defaultAgentTemplate") }}</option>
                    <option
                        v-for="item in templates"
                        :key="`${item.layer}:${item.template.id}`"
                        :value="item.template.id"
                    >
                        {{ item.template.name }} · {{ item.layer }}
                    </option>
                </select>
                <span v-if="templateId" class="block text-xs text-muted-foreground">
                    {{
                        templates.find((item) => item.template.id === templateId)?.template
                            .roleId ?? t("workspace.defaultAgentTemplate")
                    }}
                    ·
                    {{
                        templates.find((item) => item.template.id === templateId)?.template.toolMode
                    }}
                    ·
                    {{
                        templates.find((item) => item.template.id === templateId)?.template
                            .provider ?? t("settings.notSet")
                    }}
                    /
                    {{
                        templates.find((item) => item.template.id === templateId)?.template.model ??
                        t("settings.notSet")
                    }}
                </span>
            </label>
            <div class="grid grid-cols-2 gap-2">
                <label class="block space-y-1 text-sm">
                    <span>{{ t("workspace.agentDefaultModelProvider") }}</span>
                    <input
                        v-model="defaultModelProvider"
                        data-testid="agent-default-model-provider"
                        :placeholder="t('workspace.agentModelProviderPlaceholder')"
                        class="w-full rounded-md border bg-background px-3 py-2"
                    />
                </label>
                <label class="block space-y-1 text-sm">
                    <span>{{ t("workspace.agentDefaultModelName") }}</span>
                    <input
                        v-model="defaultModelName"
                        data-testid="agent-default-model-name"
                        :placeholder="t('workspace.agentModelNamePlaceholder')"
                        class="w-full rounded-md border bg-background px-3 py-2"
                    />
                </label>
            </div>
            <p
                v-if="defaultModelError"
                data-testid="agent-default-model-error"
                class="text-xs text-destructive"
            >
                {{ defaultModelError }}
            </p>
            <div class="space-y-2">
                <div class="flex items-center justify-between">
                    <span class="text-sm">{{ t("workspace.agentAllowedModels") }}</span>
                    <button
                        type="button"
                        data-testid="agent-allowed-model-add"
                        class="text-xs underline"
                        @click="addAllowedModel"
                    >
                        {{ t("workspace.agentAllowedModelAdd") }}
                    </button>
                </div>
                <p class="text-xs text-muted-foreground">
                    {{ t("workspace.agentAllowedModelsHint") }}
                </p>
                <div
                    v-for="(entry, index) in allowedModels"
                    :key="`allowed-${index}`"
                    class="grid grid-cols-[1fr_1fr_auto] items-center gap-2"
                >
                    <input
                        :value="entry.provider"
                        :data-testid="`agent-allowed-model-provider-${index}`"
                        :placeholder="t('workspace.agentModelProviderPlaceholder')"
                        :aria-label="t('workspace.agentAllowedModelProviderAria')"
                        class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                        @input="
                            setAllowedModel(
                                index,
                                'provider',
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                    <input
                        :value="entry.model"
                        :data-testid="`agent-allowed-model-name-${index}`"
                        :placeholder="t('workspace.agentModelNamePlaceholder')"
                        :aria-label="t('workspace.agentAllowedModelNameAria')"
                        class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                        @input="
                            setAllowedModel(
                                index,
                                'model',
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                    <button
                        type="button"
                        :data-testid="`agent-allowed-model-remove-${index}`"
                        :aria-label="t('workspace.agentAllowedModelRemove')"
                        class="rounded-md border px-2 py-1 text-xs"
                        @click="removeAllowedModel(index)"
                    >
                        ×
                    </button>
                </div>
                <p
                    v-if="allowedModelsError"
                    data-testid="agent-allowed-model-error"
                    class="text-xs text-destructive"
                >
                    {{ allowedModelsError }}
                </p>
            </div>
            <button
                type="submit"
                data-testid="agent-principal-create"
                class="rounded-md bg-action px-3 py-2 text-sm text-action-foreground disabled:opacity-50"
                :disabled="createBlocked"
            >
                {{ t("workspace.createAgentPrincipal") }}
            </button>
        </form>

        <section
            v-if="createdPrincipal"
            class="space-y-3 rounded-lg border border-amber-500/40 p-3"
            data-testid="unbound-agent-principal"
        >
            <div>
                <h3 class="text-sm font-semibold">{{ t("workspace.agentCreatedUnbound") }}</h3>
                <p class="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {{ createdPrincipal.principalId }}
                </p>
                <p class="mt-1 text-xs text-muted-foreground">
                    {{ createdPrincipal.templateName ?? t("workspace.defaultAgentTemplate") }} ·
                    {{ t("workspace.agentTemplateId") }}: {{ createdPrincipal.templateId ?? "—" }} ·
                    {{ t("workspace.agentCreatedAt") }}:
                    {{ new Date(createdPrincipal.createdAt).toLocaleString() }}
                </p>
            </div>
            <p class="text-xs text-muted-foreground">{{ t("workspace.agentCapNote") }}</p>
            <div class="space-y-2">
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
                        {{ actionLabel(actionClass) }}
                    </label>
                    <input
                        v-if="hasPermission(actionClass)"
                        :value="permissionResource(actionClass)"
                        :data-testid="`agent-resource-${actionClass}`"
                        :aria-label="
                            t('workspace.agentResourceFor', {
                                action: actionLabel(actionClass),
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
            </div>
            <button
                type="button"
                data-testid="agent-principal-bind"
                class="rounded-md bg-action px-3 py-2 text-sm text-action-foreground disabled:opacity-50"
                :disabled="saving || canManageWorkspaceAgents !== true"
                @click="bindCreatedPrincipal"
            >
                {{ t("workspace.bindAgent") }}
            </button>
            <p
                v-if="canManageWorkspaceAgents === false"
                data-testid="agent-bind-forbidden-hint"
                class="text-xs text-muted-foreground"
            >
                {{ t("workspace.agentBindForbidden") }}
            </p>
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
                    @click="loadAgents"
                >
                    {{ t("workspace.refreshAgents") }}
                </button>
            </div>
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
                            <!-- PLAN-0622：来源与 scope 徽标（本工作区/个人/实例）。 -->
                            <span
                                class="rounded border px-1.5 py-0.5 text-[11px]"
                                :data-testid="`agent-scope-badge-${agent.principalId}`"
                                :data-agent-scope="agent.source"
                            >
                                {{ agentSourceLabel(agent) }}
                            </span>
                            <!-- PLAN-0622 D26：未绑定的行必须显式标注，否则用户以为它已经能用。 -->
                            <span
                                v-if="agent.bound === false"
                                class="rounded border border-amber-500/40 px-1.5 py-0.5 text-[11px] text-amber-600"
                                :data-testid="`agent-unbound-badge-${agent.principalId}`"
                            >
                                {{ t("workspace.agentUnboundBadge") }}
                            </span>
                            <span
                                v-if="agent.disabled"
                                class="rounded border border-destructive/40 px-1.5 py-0.5 text-[11px] text-destructive"
                                :data-testid="`agent-disabled-badge-${agent.principalId}`"
                            >
                                {{ t("workspace.agentDisabledBadge") }}
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
                                · {{ hookActionClasses(agent).join(", ") }}
                            </template>
                        </p>
                        <p class="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                            {{ agent.principalId }}
                        </p>
                        <p class="mt-1 text-xs text-muted-foreground">
                            {{ agent.templateName ?? t("workspace.defaultAgentTemplate") }} ·
                            {{ t("workspace.agentTemplateId") }}: {{ agent.templateId ?? "—" }} ·
                            {{ t("workspace.agentWorkspaceId") }}: {{ workspaceId }} ·
                            {{ new Date(agent.createdAt).toLocaleString() }}
                        </p>
                    </div>
                    <div class="flex shrink-0 flex-col items-end gap-1">
                        <!-- 真栈 S2 bug：已有 agent 也必须能在这里绑定到本工作区（幂等 PUT）。 -->
                        <button
                            type="button"
                            class="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                            :data-testid="`agent-bind-row-${agent.principalId}`"
                            :disabled="saving || canManageWorkspaceAgents !== true"
                            @click="bindExistingAgent(agent)"
                        >
                            {{ t("workspace.bindAgent") }}
                        </button>
                        <button
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
                            class="rounded-md border px-2 py-1 text-xs text-destructive disabled:opacity-50"
                            :data-testid="`workspace-agent-disable-${agent.principalId}`"
                            :disabled="saving || !canDisable(agent) || agent.disabled === true"
                            @click="disableAgent(agent)"
                        >
                            {{
                                disableConfirmationId === agent.principalId
                                    ? t("workspace.confirmAgentDisable")
                                    : t("workspace.disableAgent")
                            }}
                        </button>
                        <p class="max-w-[12rem] text-right text-[11px] text-muted-foreground">
                            {{ t("workspace.agentDisableConsequence") }}
                        </p>
                    </div>
                </div>
                <div
                    v-if="editingPrincipalId !== agent.principalId"
                    class="flex flex-wrap gap-1.5"
                    data-testid="workspace-agent-cap"
                >
                    <span
                        v-for="permission in agent.permissionsSnapshot"
                        :key="`${permission.actionClass}:${permission.resource ?? '*'}`"
                        class="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                        {{ actionLabel(permission.actionClass) }} ·
                        {{ permission.resource ?? "*" }}
                    </span>
                    <span
                        v-if="agent.permissionsSnapshot.length === 0"
                        class="text-xs text-muted-foreground"
                    >
                        {{ t("workspace.noAgentCapabilities") }}
                    </span>
                    <button
                        type="button"
                        class="ml-auto text-xs underline"
                        :data-testid="`workspace-agent-edit-cap-${agent.principalId}`"
                        @click="startEditing(agent)"
                    >
                        {{ t("workspace.editAgentCap") }}
                    </button>
                </div>
                <div v-else class="space-y-2 border-t pt-3">
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
                            {{ actionLabel(actionClass) }}
                        </label>
                        <input
                            v-if="hasPermission(actionClass)"
                            :value="permissionResource(actionClass)"
                            :data-testid="`agent-resource-${actionClass}`"
                            :aria-label="
                                t('workspace.agentResourceFor', {
                                    action: actionLabel(actionClass),
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
                            class="rounded-md bg-action px-2 py-1 text-xs text-action-foreground"
                            :disabled="saving || canManageWorkspaceAgents !== true"
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
                            <span class="text-[11px] text-muted-foreground">{{
                                canWriteMemories === true
                                    ? t("workspace.agentMemoryWritableBadge")
                                    : t("workspace.agentMemoryReadonlyBadge")
                            }}</span>
                        </button>
                        <!-- 启用记忆：与设置页同一个 Switch（reka-ui），不混用 checkbox。 -->
                        <label
                            v-if="canWriteMemories === true"
                            class="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
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
                            class="text-[11px] text-muted-foreground"
                            data-testid="agent-memory-readonly-hint"
                        >
                            {{ t("workspace.agentMemoryReadonlyHint") }}
                        </p>
                        <div v-else class="space-y-2">
                            <div class="flex items-center justify-between gap-2">
                                <label
                                    class="flex items-center gap-1.5 text-[11px] text-muted-foreground"
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
                                    class="rounded-md bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50"
                                    :data-testid="`agent-memory-create-open-${agent.principalId}`"
                                    :disabled="memoryWriteBusy || !memoryEnabled"
                                    @click="openMemoryCreate"
                                >
                                    {{ t("workspace.agentMemoryCreateOpen") }}
                                </button>
                            </div>
                            <p
                                v-if="!archiveStatusSupported"
                                class="text-[11px] text-muted-foreground"
                                :data-testid="`agent-memory-archived-unsupported-${agent.principalId}`"
                            >
                                {{ t("workspace.agentMemoryArchivedUnsupported") }}
                            </p>
                            <div
                                v-if="memoryCreateOpen"
                                class="space-y-2 rounded-md border p-2"
                                :data-testid="`agent-memory-create-form-${agent.principalId}`"
                            >
                                <label class="block text-[11px] text-muted-foreground">
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
                                        class="flex items-center gap-1.5 text-[11px] text-muted-foreground"
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
                                            class="rounded-md bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50"
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
                            class="text-[11px] text-muted-foreground"
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
                                    class="rounded-md bg-action px-3 py-1 text-xs text-action-foreground"
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
                                <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
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
                                        {{ new Date(memory.updatedAt).toLocaleString() }}
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
                                            class="rounded-md border border-destructive/50 px-2 py-0.5 text-xs text-destructive disabled:opacity-50"
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
                                    <div class="flex flex-wrap items-center gap-3 text-[11px]">
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
                                                class="rounded-md bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50"
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
                                    class="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px]"
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
                            v-if="canBindRbac === false"
                            class="rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                            {{ t("workspace.agentRbacReadonlyBadge") }}
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
                                    <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
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
                                        class="mt-1 text-[11px] text-muted-foreground"
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
                                        class="mt-0.5 text-[11px] text-muted-foreground"
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
                                class="mt-1 text-[11px] text-muted-foreground"
                                :data-testid="`agent-role-cap-hint-${agent.principalId}`"
                            >
                                {{ t("workspace.agentRoleCapHint") }}
                            </p>
                            <div
                                v-if="canBindRbac === true"
                                class="flex flex-wrap items-center gap-2"
                            >
                                <select
                                    v-model="selectedRoleId"
                                    class="h-7 rounded-md border bg-background px-2 text-xs"
                                    :data-testid="`agent-role-select-${agent.principalId}`"
                                >
                                    <option value="">
                                        {{ t("workspace.agentRoleSelectPlaceholder") }}
                                    </option>
                                    <option
                                        v-for="role in roleCandidates"
                                        :key="role.id"
                                        :value="role.id"
                                    >
                                        {{ role.displayName || role.name }}
                                    </option>
                                </select>
                                <button
                                    type="button"
                                    class="rounded-md bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50"
                                    :disabled="rbacBusy || !selectedRoleId"
                                    :data-testid="`agent-role-bind-${agent.principalId}`"
                                    @click="bindSelectedRole(agent)"
                                >
                                    {{ t("workspace.agentRbacBind") }}
                                </button>
                            </div>
                            <p
                                v-else-if="canBindRbac === false"
                                class="text-[11px] text-muted-foreground"
                                data-testid="agent-rbac-readonly-hint"
                            >
                                {{ t("workspace.agentRbacReadonlyHint") }}
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
                            class="rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground"
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
                                    class="flex flex-wrap items-center gap-1.5 rounded-md border p-2 text-[11px]"
                                    :data-testid="`agent-skill-item-${binding.bindingId}`"
                                >
                                    <span class="text-xs font-medium">{{ binding.name }}</span>
                                    <span
                                        v-if="binding.sourceType"
                                        class="rounded border px-1 py-0.5 text-[10px] text-muted-foreground"
                                        :data-testid="`agent-skill-source-${binding.bindingId}`"
                                        >{{
                                            t(
                                                binding.sourceType === "workspace"
                                                    ? "workspace.agentSkillSourceWorkspace"
                                                    : "workspace.agentSkillSourcePersonal",
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
                                <select
                                    v-model="selectedSkillId"
                                    class="h-7 rounded-md border bg-background px-2 text-xs"
                                    :data-testid="`agent-skill-select-${agent.principalId}`"
                                >
                                    <option value="">
                                        {{ t("workspace.agentSkillSelectPlaceholder") }}
                                    </option>
                                    <option
                                        v-for="skill in skillCandidates"
                                        :key="skill.skillId"
                                        :value="skill.skillId"
                                    >
                                        {{ skill.name }}
                                    </option>
                                </select>
                                <button
                                    type="button"
                                    class="rounded-md bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50"
                                    :disabled="rbacBusy || !selectedSkillId"
                                    :data-testid="`agent-skill-bind-${agent.principalId}`"
                                    @click="bindSelectedSkill(agent)"
                                >
                                    {{ t("workspace.agentRbacBind") }}
                                </button>
                            </div>
                            <p
                                v-else-if="canBindRbac === false"
                                class="text-[11px] text-muted-foreground"
                            >
                                {{ t("workspace.agentRbacReadonlyHint") }}
                            </p>
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
</template>
