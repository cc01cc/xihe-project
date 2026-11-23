<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { LoaderCircle, Plus, RotateCcw, X } from "@lucide/vue";
import {
    api,
    ApiError,
    request,
    type AgentModelRef,
    type AgentPrincipalUpdateBody,
    type AgentPrincipalUpdateView,
    type AgentRoleBinding,
} from "../../composables/api";
import { presentCauseError, type ErrorPresentation } from "../../lib/errorMessages";
// task-92（缺口二，抽屉段）：换页时的整页草稿守卫；与 widget 内 `unsavedConfirmOpen` 共用同一 dirty 真源。
import { useDraftLeaveGuard } from "../../composables/useDraftLeaveGuard";
import { formatDate } from "../../lib/dateFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../ui/alert-dialog";
import { Switch } from "../ui/switch";
import AgentModelBindingFields, {
    type AgentModelBindingDraft,
} from "./AgentModelBindingFields.vue";
import { useConfigStore } from "../../stores/config";
import { chatModelNamesOf } from "../../services/providerConnectionService";
import DelegationPolicyFields from "./DelegationPolicyFields.vue";
import ErrorBlock from "./AgentPrincipalDetailErrorBlock.vue";
import {
    buildDelegationPolicy,
    delegationPolicyDirty,
    delegationPolicyValid,
    parseDelegationPolicy,
    type DelegationPolicyValue,
} from "./delegationPolicyValue";
// components→features 引用有既有先例（InstanceAgentSkillsDialog 复用 agentSkillCandidates）：
// 记忆口径的唯一 SSOT 在 memoryPolicy.ts，不复制第二份判定/合并逻辑。
import {
    mergeMemoryEnabled,
    readMemoryEnabled,
    readMemoryTypesMissing,
} from "../../features/workspace/components/memoryPolicy";

/**
 * task-191：三个层（user / workspace / instance）共用的 **agent 主体详情抽屉**。
 *
 * <p>宿主（AgentPrincipalsPanel / WorkspaceAgentsPanel / InstanceAgentsPanel）把各自列表行
 * 归一化成 {@link AgentPrincipalDetail} 传入；写分区（模型 / 委派预算 / 记忆 / 钩子）按
 * ownership 选门（{@link patchInstancePrincipalDocuments} 或用户前缀），
 * **每个分区只带自己的键**（absent = 不触碰），响应 echo 持久化文档后以响应回填本地与宿主行。</p>
 *
 * <ul>
 *   <li>persona 只读（Q1 裁定：templateId 不在 PATCH body，创建时钉住不可换）；</li>
 *   <li><b>可写分区由宿主给（{@link editableSections}），`readonly` 只是宿主层的短路开关</b>。
 *       旧的「instance 层整体只读」（task-191 Q2）已由 <b>D-1941 作废</b>（task-955：用户
 *       2026-11-24 要求「智能体配置要能配」）⇒ 实例面板现在给 model/delegation/hooks；</li>
 *   <li>INSTANCE 所有者的行**只能**写 `/api/v1/instance/agent-principals/{id}`（见
 *       {@link patchInstancePrincipalDocuments}），user 前缀会被 CP 拒（`AGENT_PRINCIPAL_INSTANCE_OWNED`）；</li>
 *   <li>授权不做客户端判定 —— CP 403（GUARD_* / AGENT_PRINCIPAL_OWNER_MISMATCH）经错误面</li>
 *   <li>映射为可操作文案；S1 无新原子。</li>
 * </ul>
 */

/** 抽屉里可写/可见的分区标识。 */
export type AgentPrincipalDetailSection = "model" | "delegation" | "memory" | "hooks";

/** 宿主行归一化形状：三个列表视图（AgentPrincipalView / WorkspaceAgentView / instance 投影）的交集。 */
export interface AgentPrincipalDetail {
    principalId: string;
    name: string;
    ownership: "USER" | "INSTANCE";
    templateName: string | null;
    createdAt: string;
    disabled: boolean;
    defaultModelProvider: string | null;
    defaultModelName: string | null;
    allowedModels: AgentModelRef[] | null;
    hooks: Record<string, unknown> | null;
    contextPolicy: Record<string, unknown> | null;
    delegationPolicy: Record<string, unknown> | null;
}

const props = withDefaults(
    defineProps<{
        open: boolean;
        /** 目标主体；null = 未选中（宿主用同一 ref 表达「没选中」，与 InstanceAgentSkillsDialog 同形）。 */
        principal: AgentPrincipalDetail | null;
        /** 角色读面的授权上下文（workspace 层传当前工作区；user/instance 层传 null）。 */
        workspaceId?: string | null;
        /** 宿主层整体只读短路（instance 层自 D-1941 起不再使用；写分区走 {@link editableSections}）。 */
        readonly?: boolean;
        /** 宿主没有自己的 disable 入口时才渲染危险区（workspace/instance 面板已有，避免双入口）。 */
        showDanger?: boolean;
        /**
         * 本层可写分区。默认四区全可写（user 层：列表视图 = AgentPrincipalView 全字段）。
         * workspace 层只给 hooks：model/delegation 现值不在 WorkspaceAgentView 上（Java record
         * 实测无此字段），memory 开关已由宿主面板拥有 —— 不在抽屉里开第二个入口。
         * instance 层给 model / delegation / hooks（D-1941；memory 同样由宿主面持有，不开第二入口）。
         */
        editableSections?: AgentPrincipalDetailSection[];
        /** 该层列表投影**不携带**现值的分区（显示为「到用户层配置」，而不是渲染假默认值）。 */
        unknownSections?: AgentPrincipalDetailSection[];
        /**
         * 钩子 advisor 的**已注册 kind** 集合（快照源：CP `HookAdvisorRegistry` 注入的
         * `HookAdvisor` bean，今天只有 `GuardHookAdvisor.KIND`）。R37 判据：下拉只渲染这一组，
         * 不自造选项；CP 注册新 advisor 时宿主注入新集合（默认值就是当前 CP 快照）。
         */
        advisorKinds?: string[];
        /** 钩子 `on` 的**白名单**集合（快照源：CP `HookAdvisorRegistry.ALLOWED_ACTION_CLASSES`）。 */
        advisorEvents?: string[];
    }>(),
    {
        workspaceId: null,
        readonly: false,
        showDanger: false,
        editableSections: () =>
            ["model", "delegation", "memory", "hooks"] as AgentPrincipalDetailSection[],
        unknownSections: () => [] as AgentPrincipalDetailSection[],
        // 快照只能写字面量：`defineProps` 的默认值会被 hoist 到模块外层，不能引用 setup 里的局部常量
        // （vue 编译期硬约束，BaseModal 那类双 script 块才解决）。这两个字面量就是上面注释里的 CP 快照。
        advisorKinds: () => ["guard"] as string[],
        advisorEvents: () => ["approval.ask"] as string[],
    },
);

const emit = defineEmits<{
    "update:open": [value: boolean];
    /** 持久化变更的回执，宿主据此就地更新自己的列表行（不整表重拉）。 */
    changed: [patch: Partial<AgentPrincipalDetail> & { principalId: string }];
}>();

const { t } = useI18n();
const K = "agentPrincipalDetail.";

const configStore = useConfigStore();

/** 可用 chat 连接 —— 与 AgentModelBindingFields 同一份来源（不建第二份连接状态）。 */
const chatConnections = computed(() =>
    configStore.providerConnections.filter((item) => item.operation === "chat" && item.enabled),
);

/** 存量 provider+model 能映射到哪条可见 chat 连接；映射不到 = 存量裸串（只警示，不改写）。 */
function resolveConnectionId(provider: string, model: string): string {
    if (!provider || !model) return "";
    const match = chatConnections.value.find(
        (item) =>
            item.providerId === provider &&
            chatModelNamesOf(item, configStore.modelCache.providers).includes(model),
    );
    return match?.id ?? "";
}

// ---- 工作副本与基准（dirty 判定用） --------------------------------------------------------

/** 白名单行草稿：连接 id 只用于在本页挑模型，不上 wire（契约：主体不持有连接）。 */
interface AllowedModelDraft {
    provider: string;
    connectionId: string;
    model: string;
}
interface ModelDraft {
    provider: string;
    /** 本地挑模型用的连接（task-138）；wire 仍然只写 provider + model。 */
    connectionId: string;
    model: string;
    allowedModels: AllowedModelDraft[];
}
interface HookAdvisorDraft {
    kind: string;
    on: string[];
}

const modelDraft = reactive<ModelDraft>({
    provider: "",
    connectionId: "",
    model: "",
    allowedModels: [],
});
const modelBaseline = ref("");
const delegationDraft = ref<DelegationPolicyValue>({ maxCount: null, maxDepth: null });
const delegationBaseline = ref<DelegationPolicyValue>({ maxCount: null, maxDepth: null });
const memoryEnabled = ref(false);
const memoryBaseline = ref(false);
const advisors = ref<HookAdvisorDraft[]>([]);
const advisorsBaseline = ref("");
// 枚举族字段（§17.5）的取值一律来自 CP 契约，不自造下拉项：
// kind/on 的候选集是**集合**（props.advisorKinds / advisorEvents，默认见上方能力面快照），
// 渲染项 == 传入集合 ⇒ CP 注册新 advisor 时界面自动跟着长，用例不写死具体 kind 名字（R37）。
// 未注册的 kind **不再提供入口**：CP `HookAdvisorRegistry` 接受它但 `advisorsFor` 不返回任何
// advisor（只在日志里 warn "configured but currently inert"）⇒ 那是一条存得下、永不触发的订阅，
// 正是「互斥选项语义与能力面不符」（同 R53 族），故原「自定义…」分支与自由输入框一并撤掉。
const advisorKindOptions = computed<readonly string[]>(() => props.advisorKinds);
const advisorEventOptions = computed<readonly string[]>(() => props.advisorEvents);
const newAdvisorKind = ref<string>(props.advisorKinds[0] ?? "");
const newAdvisorEvent = ref<string>(props.advisorEvents[0] ?? "");
const memoryRetryTarget = ref<boolean | null>(null);

const roles = ref<AgentRoleBinding[] | null>(null);
const rolesError = ref<ErrorPresentation | null>(null);
const rolesLoading = ref(false);

const sectionErrors = reactive<{
    model: ErrorPresentation | null;
    delegation: ErrorPresentation | null;
    memory: ErrorPresentation | null;
    hooks: ErrorPresentation | null;
}>({ model: null, delegation: null, memory: null, hooks: null });

const disableConfirmOpen = ref(false);
const disabling = ref(false);
const disableError = ref<ErrorPresentation | null>(null);

const modelSaving = ref(false);
const delegationSaving = ref(false);
const memorySaving = ref(false);
const hooksSaving = ref(false);

function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
    return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** fail-closed：hooks 文档 → advisor 行（非对象/畸形行丢弃，与 CP 解析口径一致）。 */
function parseAdvisors(doc: Record<string, unknown> | null): HookAdvisorDraft[] {
    const raw = doc?.advisors;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        if (!isPlainRecord(entry) || typeof entry.kind !== "string") return [];
        const on = Array.isArray(entry.on)
            ? entry.on.filter((action): action is string => typeof action === "string")
            : [];
        return [{ kind: entry.kind, on }];
    });
}

function snapshotModel(draft: ModelDraft): string {
    // 连接只是挑选态，不进快照 —— 换个等价连接不算脏。
    return JSON.stringify([
        draft.provider.trim(),
        draft.model.trim(),
        draft.allowedModels.map((entry) => ({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        })),
    ]);
}

function resetDrafts() {
    const principal = props.principal;
    // task-921：**不能因为「没有主体」就 early-return**。抽屉是常驻挂载的（`open=false` 时
    // 仍在 setup 里注册路由离开守卫），若基线停在初值 `""` 而工作副本是空对象快照
    // `["","",[]]`，`modelDirty` / `hooksDirty` 会恒为 true ⇒ 离开守卫以为有草稿、挂起导航，
    // 而确认框只在 `DialogContent`（抽屉打开时）里渲染 ⇒ 决策 Promise 永不 settle，整条全局
    // 导航在 /members 上全部失灵。无主体时就按「空主体」重置，工作副本与基线必须相等。
    modelDraft.provider = principal?.defaultModelProvider ?? "";
    modelDraft.model = principal?.defaultModelName ?? "";
    modelDraft.connectionId = resolveConnectionId(modelDraft.provider, modelDraft.model);
    modelDraft.allowedModels = (principal?.allowedModels ?? []).map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        connectionId: resolveConnectionId(entry.provider, entry.model),
    }));
    modelBaseline.value = snapshotModel(modelDraft);
    delegationDraft.value = parseDelegationPolicy(principal?.delegationPolicy ?? null);
    delegationBaseline.value = { ...delegationDraft.value };
    memoryEnabled.value = readMemoryEnabled(principal?.contextPolicy ?? null);
    memoryBaseline.value = memoryEnabled.value;
    advisors.value = parseAdvisors(principal?.hooks ?? null);
    advisorsBaseline.value = JSON.stringify(advisors.value);
    newAdvisorKind.value = advisorKindOptions.value[0] ?? "";
    newAdvisorEvent.value = advisorEventOptions.value[0] ?? "";
    memoryRetryTarget.value = null;
    sectionErrors.model = null;
    sectionErrors.delegation = null;
    sectionErrors.memory = null;
    sectionErrors.hooks = null;
    disableError.value = null;
}

// 打开或切换目标时重置工作副本；await 后回填一律走守卫（vue skill 硬约束：抽屉可能已被关掉）。
watch(
    [() => props.open, () => props.principal?.principalId],
    () => {
        // task-921：关闭态/无主体也要重置一次（见 resetDrafts 注释）——工作副本与基线必须
        // 始终同源，否则 dirty 会在抽屉根本没打开时成立，离开守卫随之悬挂。
        resetDrafts();
        if (props.open && props.principal) {
            loadRoles();
        }
    },
    { immediate: true },
);

// 主体还没绑定工作区 = 空态，不是错误（task-151 ④）；去绑定的入口在设置 › 角色
// （src/router/index.ts:417-419 settings 子路由）。
const ROLES_BIND_HREF = "/settings/presets";
const rolesPrincipalMissing = computed(
    () => (rolesError.value?.code ?? "") === "AGENT_PRINCIPAL_NOT_FOUND",
);

function retryRoles() {
    void loadRoles();
}

async function loadRoles() {
    const principalId = props.principal?.principalId;
    if (!principalId) return;
    rolesLoading.value = true;
    rolesError.value = null;
    try {
        const rows = await api.getAgentRoles(props.workspaceId, principalId);
        // 守卫：等待期间可能已切换主体或关闭抽屉。
        if (props.open && props.principal?.principalId === principalId) {
            roles.value = rows;
        }
    } catch (cause) {
        if (props.open && props.principal?.principalId === principalId) {
            roles.value = null;
            rolesError.value = presentCauseError(t, cause, t(K + "rolesLoadFailed"));
        }
    } finally {
        rolesLoading.value = false;
    }
}

// ---- 分区可写性 ---------------------------------------------------------------------------

const canEdit = (section: AgentPrincipalDetailSection): boolean =>
    !props.readonly && props.editableSections.includes(section);

const isUnknown = (section: AgentPrincipalDetailSection): boolean =>
    props.unknownSections.includes(section);

// ---- 分区 dirty / 校验 --------------------------------------------------------------------

const bothOrNeitherError = computed(() => {
    const providerBlank = modelDraft.provider.trim() === "";
    const modelBlank = modelDraft.model.trim() === "";
    return providerBlank !== modelBlank;
});

const allowedModelsInvalid = computed(() =>
    modelDraft.allowedModels.some(
        (entry) => entry.provider.trim() === "" || entry.model.trim() === "",
    ),
);

const modelDirty = computed(() => snapshotModel(modelDraft) !== modelBaseline.value);
const modelValid = computed(() => !bothOrNeitherError.value && !allowedModelsInvalid.value);
const modelSaveBlocked = computed(
    () => props.readonly || !modelDirty.value || !modelValid.value || modelSaving.value,
);

/** 当前 provider 名下的可用 chat 连接（诊断徽标口径，和建会话时后端现查的那组同源）。 */
const modelProviderConnections = computed(() =>
    chatConnections.value.filter((item) => item.providerId === modelDraft.provider.trim()),
);

/**
 * task-138 J2：连接诊断三态。文案对应后端真实后果 —— 建会话时
 * SessionService.bindProviderConnection 按 provider 现查可用 chat 连接：0 条 ⇒ 400
 * PROVIDER_REQUIRED；恰 1 条才自动绑定；≥2 条 ⇒ 400 PROVIDER_CONNECTION_AMBIGUOUS
 * （detail: "Multiple usable chat connections (N); pass providerConnectionId explicitly"）。
 */
const modelDiagnostic = computed<null | {
    state: "none" | "single" | "ambiguous";
    count: number;
    name: string;
}>(() => {
    const provider = modelDraft.provider.trim();
    if (!provider) return null;
    const candidates = modelProviderConnections.value;
    if (candidates.length === 0) return { state: "none", count: 0, name: "" };
    if (candidates.length === 1) {
        const only = candidates[0]!;
        return { state: "single", count: 1, name: only.label || only.connectionKey || provider };
    }
    return { state: "ambiguous", count: candidates.length, name: "" };
});

const modelDiagnosticText = computed(() => {
    const diagnostic = modelDiagnostic.value;
    if (!diagnostic) return "";
    if (diagnostic.state === "single")
        return t(K + "modelDiagnosticSingle", { name: diagnostic.name });
    if (diagnostic.state === "ambiguous") {
        return t(K + "modelDiagnosticAmbiguous", { count: diagnostic.count });
    }
    return t(K + "modelDiagnosticNone", { provider: modelDraft.provider.trim() });
});

/** 存量裸串：有 provider+model 但映射不到任何可见连接 ⇒ 只警示（保留原值可继续保存）。 */
const modelLegacyUnmapped = computed(
    () =>
        Boolean(modelDraft.provider.trim() && modelDraft.model.trim()) &&
        modelDraft.connectionId === "",
);

/** 存量意图：让组件把 provider+model 预填到三段（映射不到就留空，另显示「当前：…」）。 */
const modelIntent = computed(() =>
    props.principal?.defaultModelProvider && props.principal?.defaultModelName
        ? {
              provider: props.principal.defaultModelProvider,
              model: props.principal.defaultModelName,
          }
        : null,
);

/** AgentModelBindingFields 草稿（restrict 在详情抽屉不使用）。 */
const modelBinding = computed<AgentModelBindingDraft>({
    get: () => ({
        provider: modelDraft.provider,
        connectionId: modelDraft.connectionId,
        model: modelDraft.model,
        restrict: false,
    }),
    set: (value) => {
        modelDraft.provider = value.provider;
        modelDraft.connectionId = value.connectionId;
        modelDraft.model = value.model;
    },
});

/** 白名单行 ↔ 组件草稿：连接只用于本页挑模型。 */
function allowedBinding(entry: AllowedModelDraft): AgentModelBindingDraft {
    return {
        provider: entry.provider,
        connectionId: entry.connectionId,
        model: entry.model,
        restrict: false,
    };
}

function applyAllowedModel(index: number, value: AgentModelBindingDraft): void {
    const entry = modelDraft.allowedModels[index];
    if (!entry) return;
    entry.provider = value.provider;
    entry.connectionId = value.connectionId;
    entry.model = value.model;
}

function addAllowedModel(): void {
    modelDraft.allowedModels.push({ provider: "", connectionId: "", model: "" });
}

const delegationDirty = computed(() =>
    delegationPolicyDirty(delegationBaseline.value, delegationDraft.value),
);
/** 校验与子组件用同一纯函数 —— 规则只有一份，不复制第二套。 */
const delegationValid = computed(() => delegationPolicyValid(delegationDraft.value));
const delegationSaveBlocked = computed(
    () =>
        props.readonly ||
        !delegationDirty.value ||
        !delegationValid.value ||
        delegationSaving.value,
);

const memoryDirty = computed(() => memoryEnabled.value !== memoryBaseline.value);

const hooksDirty = computed(() => JSON.stringify(advisors.value) !== advisorsBaseline.value);
const hooksSaveBlocked = computed(() => props.readonly || !hooksDirty.value || hooksSaving.value);

/**
 * task-34：模型 / 委派 / 钩子三段表单**共用一个提交点**（页脚「保存更改」），分区保存键已移除
 * （J1：apd-{model,delegation,hooks}-save 计数必须为 0）。记忆段仍是布尔即时写，不进这个组
 * —— §17.2 布尔控件的提交点就是它自己。
 * 只有「有草稿且校验通过」的段才计入待提交数：非法草稿不拦别的段，但也不被静默发出去。
 */
const pendingSectionCount = computed(() => {
    let count = 0;
    if (modelDirty.value && modelValid.value) count += 1;
    if (delegationDirty.value && delegationValid.value) count += 1;
    if (hooksDirty.value) count += 1;
    return count;
});

const groupSaving = computed(
    () => modelSaving.value || delegationSaving.value || hooksSaving.value,
);

const groupSaveBlocked = computed(
    () => props.readonly || groupSaving.value || pendingSectionCount.value === 0,
);

/** 顺序提交：三段共用同一 view 回填，串行避免后一段拿旧 view 覆盖前一段；每段错误各自落位。 */
async function saveDirtySections(): Promise<void> {
    if (modelDirty.value && modelValid.value) await saveModel();
    if (delegationDirty.value && delegationValid.value) await saveDelegation();
    if (hooksDirty.value) await saveHooks();
}

// task-151 / task-172 §17.4：开关类即时写不算 dirty；表单类（模型 / 委派 / 钩子）有草稿才算。
const unsavedDraft = computed(() => modelDirty.value || delegationDirty.value || hooksDirty.value);

/**
 * task-92（缺口二，抽屉段）：**路由级**离开守卫。
 *
 * <p>与抽屉自己的关闭确认（`closeDrawer` / `apd-unsaved-confirm`）是两件事：那条守「关抽屉」，
 * 这条守「换页/换路由」。原先换页直接卸载抽屉，草稿静默丢失 —— 而 `closeDrawer` 只被
 * `update:open` 调用，路由离开时压根不会经过它。</p>
 *
 * <p>两者共用 {@link unsavedDraft} 一个真源（判据只有一处），但各自持有一个 `open`：关抽屉只弹
 * 「未保存，关不关」，换页只弹「未保存，走不走」，互不串（单测各钉一例）。</p>
 */
const {
    draftLabels: routeLeaveLabels,
    promptOpen: routeLeaveOpen,
    setDrafts: setRouteDrafts,
    keepEditing: keepRouteHere,
    discardDrafts: discardAndLeave,
} = useDraftLeaveGuard();

watch(unsavedDraft, (dirty) => setRouteDrafts(dirty ? [props.principal?.name ?? ""] : []), {
    immediate: true,
});
onBeforeUnmount(() => setRouteDrafts([]));
const unsavedConfirmOpen = ref(false);

const memoryTypesMissing = computed(() => {
    if (!props.principal) return false;
    // 用「合并后的结果」判定提示：开关打开 + types 空数组 ⇒ 提示「开着但不写入」。
    return readMemoryTypesMissing(
        mergeMemoryEnabled(props.principal.contextPolicy, memoryEnabled.value),
    );
});

// ---- 错误面 --------------------------------------------------------------------------------

/**
 * task-45 诊断面：先把错误交给统一入口（拿 copy/错误码/技术详情三态），**再**把这四个码的
 * copy 换成「怎么补救」的具体指引 —— 每个码说的事不一样（模型托管 / 钩子托管 / 记忆策略托管 /
 * 你不是它的创建者），一句通用兜底等于让用户去猜。码与技术详情保持原样（可复制给支持）。
 */
function sectionError(cause: unknown, fallback: string): ErrorPresentation {
    const presentation = presentCauseError(t, cause, fallback);
    const code = cause instanceof ApiError ? cause.problem.code : undefined;
    switch (code) {
        case "GUARD_MODEL_INTENT_IMMUTABLE":
            return { ...presentation, copy: t(K + "guardModelImmutable") };
        case "GUARD_HOOKS_IMMUTABLE":
            return { ...presentation, copy: t(K + "guardHooksImmutable") };
        case "GUARD_CONTEXT_POLICY_IMMUTABLE":
            return { ...presentation, copy: t(K + "guardContextPolicyImmutable") };
        case "AGENT_PRINCIPAL_OWNER_MISMATCH":
            return { ...presentation, copy: t(K + "ownerMismatch") };
        default:
            return presentation;
    }
}

// ---- 分区保存 ------------------------------------------------------------------------------

function principalGuard(principalId: string): boolean {
    return props.open && props.principal?.principalId === principalId;
}

/**
 * 实例层写门（task-955 / D-1941）：为什么不能一律用 {@code api.updateAgentPrincipal} ——
 * 它对 INSTANCE 所有者的行会先撞 CP 的 workspace-context 门，再被
 * `AGENT_PRINCIPAL_INSTANCE_OWNED` 403。实例主体的唯一写门是
 * `PATCH /api/v1/instance/agent-principals/{principalId}`（openapi `:1185`、
 * `InstanceAgentPrincipalController.java:113`）。两条门共用同一个 body 形状
 * （`AgentPrincipalUpdateRequest`：absent = 不触碰、显式 null = 清除）与同一个响应形状
 * （`AgentPrincipalUpdateView`），所以只切换路径，不复制第二套分区语义。
 *
 * <p>两个调用点保持分开（每个保存函数里各写一扇门），不用「选函数」的间接层：
 * `scripts/check-write-invalidate.mjs` 按 `api.<写动词>*` 的**字面调用点**对账，间接层会让
 * 既有基线读数静默消失。</p>
 */
async function patchInstancePrincipalDocuments(
    principalId: string,
    body: AgentPrincipalUpdateBody,
): Promise<AgentPrincipalUpdateView> {
    // 与 api.updateAgentPrincipal 同一口径：`undefined` 键不进 payload（absent = 不触碰）。
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) payload[key] = value;
    }
    return request<AgentPrincipalUpdateView>(
        `/instance/agent-principals/${encodeURIComponent(principalId)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

/** 该主体是否走实例写门（`ownership` 是 CP 的存储列，决定唯一写前缀）。 */
function usesInstanceWriteDoor(): boolean {
    return props.principal?.ownership === "INSTANCE";
}

async function saveModel() {
    const principalId = props.principal?.principalId;
    if (!principalId || modelSaveBlocked.value) return;
    modelSaving.value = true;
    sectionErrors.model = null;
    const baseline = JSON.parse(modelBaseline.value) as [string, string, AgentModelRef[]];
    try {
        const provider = modelDraft.provider.trim();
        const model = modelDraft.model.trim();
        // 连接只要挑模型，落 wire 的仍是 {provider, model}（契约：主体不持有连接）。
        const wireAllowedModels = modelDraft.allowedModels.map((entry) => ({
            provider: entry.provider.trim(),
            model: entry.model.trim(),
        }));
        const body: AgentPrincipalUpdateBody = {
            ...(provider !== baseline[0] ? { defaultModelProvider: provider || null } : {}),
            ...(model !== baseline[1] ? { defaultModelName: model || null } : {}),
            ...(JSON.stringify(wireAllowedModels) !== JSON.stringify(baseline[2])
                ? { allowedModels: wireAllowedModels.length ? wireAllowedModels : null }
                : {}),
        };
        const view = usesInstanceWriteDoor()
            ? await patchInstancePrincipalDocuments(principalId, body)
            : await api.updateAgentPrincipal(principalId, body);
        // 守卫：等待期间可能已关闭抽屉/切换主体 —— 不回填就能把旧抽屉复活（vue skill 硬约束）。
        if (!principalGuard(principalId)) return;
        modelDraft.provider = view.defaultModelProvider ?? "";
        modelDraft.model = view.defaultModelName ?? "";
        modelDraft.connectionId = resolveConnectionId(modelDraft.provider, modelDraft.model);
        modelDraft.allowedModels = (view.allowedModels ?? []).map((entry) => ({
            provider: entry.provider,
            model: entry.model,
            connectionId: resolveConnectionId(entry.provider, entry.model),
        }));
        modelBaseline.value = snapshotModel(modelDraft);
        emit("changed", {
            principalId,
            defaultModelProvider: view.defaultModelProvider,
            defaultModelName: view.defaultModelName,
            allowedModels: view.allowedModels,
        });
        toast.success(t(K + "modelSaved"));
    } catch (cause) {
        if (principalGuard(principalId)) {
            sectionErrors.model = sectionError(cause, t(K + "saveFailed"));
        }
    } finally {
        modelSaving.value = false;
    }
}

function resetModel() {
    const baseline = JSON.parse(modelBaseline.value) as [string, string, AgentModelRef[]];
    modelDraft.provider = baseline[0];
    modelDraft.model = baseline[1];
    modelDraft.connectionId = resolveConnectionId(modelDraft.provider, modelDraft.model);
    modelDraft.allowedModels = baseline[2].map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        connectionId: resolveConnectionId(entry.provider, entry.model),
    }));
    sectionErrors.model = null;
}

async function saveDelegation() {
    const principalId = props.principal?.principalId;
    if (!principalId || delegationSaveBlocked.value) return;
    delegationSaving.value = true;
    sectionErrors.delegation = null;
    try {
        const body: AgentPrincipalUpdateBody = {
            delegationPolicy: buildDelegationPolicy(delegationDraft.value),
        };
        const view = usesInstanceWriteDoor()
            ? await patchInstancePrincipalDocuments(principalId, body)
            : await api.updateAgentPrincipal(principalId, body);
        if (!principalGuard(principalId)) return;
        delegationDraft.value = parseDelegationPolicy(view.delegationPolicy);
        delegationBaseline.value = { ...delegationDraft.value };
        emit("changed", { principalId, delegationPolicy: view.delegationPolicy });
        toast.success(t(K + "delegationSaved"));
    } catch (cause) {
        if (principalGuard(principalId)) {
            sectionErrors.delegation = sectionError(cause, t(K + "saveFailed"));
        }
    } finally {
        delegationSaving.value = false;
    }
}

/**
 * task-151 ①：记忆是**纯布尔**开关，翻转即写，没有保存按钮（§17.2 布尔控件的提交点就是它自己）。
 * 失败必须回滚开关并留下重试入口 —— 否则界面显示的值和库里的值会分叉。
 */
async function commitMemory() {
    const principalId = props.principal?.principalId;
    if (!principalId || props.readonly || memorySaving.value || !memoryDirty.value) return;
    const attempted = memoryEnabled.value;
    memorySaving.value = true;
    sectionErrors.memory = null;
    try {
        // PATCH 是整对象替换 ⇒ 必须与现值合并后发送（memoryPolicy.mergeMemoryEnabled 是唯一口径）。
        const merged = mergeMemoryEnabled(props.principal?.contextPolicy ?? null, attempted);
        const body: AgentPrincipalUpdateBody = { contextPolicy: merged };
        const view = usesInstanceWriteDoor()
            ? await patchInstancePrincipalDocuments(principalId, body)
            : await api.updateAgentPrincipal(principalId, body);
        if (!principalGuard(principalId)) return;
        memoryBaseline.value = attempted;
        memoryRetryTarget.value = null;
        emit("changed", { principalId, contextPolicy: view.contextPolicy });
        toast.success(t(K + "memorySaved"));
    } catch (cause) {
        if (principalGuard(principalId)) {
            memoryEnabled.value = memoryBaseline.value;
            memoryRetryTarget.value = attempted;
            sectionErrors.memory = sectionError(cause, t(K + "saveFailed"));
        }
    } finally {
        memorySaving.value = false;
    }
}

function retryMemory() {
    const target = memoryRetryTarget.value;
    memoryRetryTarget.value = null;
    if (target === null) return;
    memoryEnabled.value = target;
}

// 基线回填与开关写入同 tick ⇒ dirty 立刻归零，watch 不会自激成死循环。
watch(memoryEnabled, () => {
    void commitMemory();
});

function addAdvisor() {
    const kind = newAdvisorKind.value.trim();
    if (!kind) return;
    advisors.value = [...advisors.value, { kind, on: [newAdvisorEvent.value] }];
    newAdvisorKind.value = advisorKindOptions.value[0] ?? "";
    newAdvisorEvent.value = advisorEventOptions.value[0] ?? "";
}

/** 白名单今天只有一个 action，单值选择器与契约（on 是数组）等价 —— 落 wire 仍是数组。 */
function setAdvisorEvent(index: number, action: string) {
    advisors.value = advisors.value.map((advisor, current) =>
        current === index ? { ...advisor, on: [action] } : advisor,
    );
}

function removeAdvisor(index: number) {
    advisors.value = advisors.value.filter((_, current) => current !== index);
}

async function saveHooks() {
    const principalId = props.principal?.principalId;
    if (!principalId || hooksSaveBlocked.value) return;
    hooksSaving.value = true;
    sectionErrors.hooks = null;
    try {
        const body: AgentPrincipalUpdateBody = {
            hooks: advisors.value.length ? { advisors: advisors.value } : null,
        };
        const view = usesInstanceWriteDoor()
            ? await patchInstancePrincipalDocuments(principalId, body)
            : await api.updateAgentPrincipal(principalId, body);
        if (!principalGuard(principalId)) return;
        advisors.value = parseAdvisors(view.hooks);
        advisorsBaseline.value = JSON.stringify(advisors.value);
        emit("changed", { principalId, hooks: view.hooks });
        toast.success(t(K + "hooksSaved"));
    } catch (cause) {
        if (principalGuard(principalId)) {
            sectionErrors.hooks = sectionError(cause, t(K + "saveFailed"));
        }
    } finally {
        hooksSaving.value = false;
    }
}

async function confirmDisable() {
    const principalId = props.principal?.principalId;
    if (!principalId || disabling.value) return;
    disabling.value = true;
    disableError.value = null;
    try {
        await api.disableAgentPrincipal(principalId);
        if (!principalGuard(principalId)) return;
        emit("changed", { principalId, disabled: true });
        toast.success(t(K + "disabled"));
        disableConfirmOpen.value = false;
    } catch (cause) {
        if (principalGuard(principalId)) {
            disableError.value = sectionError(cause, t(K + "disableFailed"));
        }
    } finally {
        disabling.value = false;
    }
}

function closeDrawer() {
    // §17.4 离开策略：表单类草稿未提交时不静默丢弃（开关类即时写，不进 unsavedDraft）。
    if (unsavedDraft.value) {
        unsavedConfirmOpen.value = true;
        return;
    }
    emit("update:open", false);
}

function discardAndClose() {
    unsavedConfirmOpen.value = false;
    emit("update:open", false);
}
</script>

<template>
    <Dialog :open="open" @update:open="(value: boolean) => !value && closeDrawer()">
        <DialogContent
            width="config"
            data-testid="agent-principal-detail-drawer"
            class="max-h-[85vh] overflow-y-auto"
        >
            <DialogHeader>
                <DialogTitle data-testid="agent-principal-detail-title">
                    {{
                        readonly
                            ? t(K + "titleReadonly", { name: principal?.name ?? "" })
                            : t(K + "title", { name: principal?.name ?? "" })
                    }}
                </DialogTitle>
                <DialogDescription>{{ t(K + "desc") }}</DialogDescription>
            </DialogHeader>

            <div v-if="principal" class="space-y-6">
                <!-- 身份（只读） -->
                <section data-testid="apd-identity" class="apd-two-col">
                    <h3 class="text-sm font-medium text-muted-foreground sm:pt-0.5">
                        {{ t(K + "sectionIdentity") }}
                    </h3>
                    <dl class="space-y-1 text-sm">
                        <div class="flex items-center gap-2">
                            <dt class="w-20 shrink-0 text-muted-foreground">
                                {{ t(K + "fieldName") }}
                            </dt>
                            <dd class="flex min-w-0 items-center gap-2">
                                <span class="truncate font-medium">{{ principal.name }}</span>
                                <Badge
                                    v-if="principal.disabled"
                                    variant="outline"
                                    data-testid="apd-disabled-badge"
                                >
                                    {{ t(K + "stateDisabled") }}
                                </Badge>
                                <Badge variant="outline" data-testid="apd-ownership">
                                    {{
                                        t(
                                            principal.ownership === "INSTANCE"
                                                ? K + "ownershipInstance"
                                                : K + "ownershipUser",
                                        )
                                    }}
                                </Badge>
                            </dd>
                        </div>
                        <div class="flex items-center gap-2">
                            <dt class="w-20 shrink-0 text-muted-foreground">
                                {{ t(K + "fieldCreatedAt") }}
                            </dt>
                            <dd>{{ formatDate(principal.createdAt) }}</dd>
                        </div>
                    </dl>

                    <!-- task-151 ④：人设并入身份组（form-contract F4 只允许 6 个顶级语义组），
                         仍是只读（Q1：templateId 创建时钉住）。 -->
                    <div class="space-y-1" data-testid="apd-persona">
                        <p class="text-sm font-medium text-muted-foreground">
                            {{ t(K + "sectionPersona") }}
                        </p>
                        <p class="text-sm">
                            {{
                                principal.templateName
                                    ? principal.templateName
                                    : t(K + "personaFallback")
                            }}
                        </p>
                        <p class="text-xs leading-5 text-muted-foreground">
                            {{ t(K + "personaFrozenNote") }}
                        </p>
                    </div>
                </section>

                <!-- 模型意图（可写；instance 层只读） -->
                <section data-testid="apd-model" class="space-y-2" :data-dirty="modelDirty">
                    <h3 class="text-sm font-medium text-muted-foreground sm:pt-0.5">
                        {{ t(K + "sectionModel") }}
                    </h3>
                    <div class="flex justify-end">
                        <Button
                            v-if="canEdit('model') && modelDirty"
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-testid="apd-model-reset"
                            @click="resetModel"
                        >
                            <RotateCcw class="size-3.5" aria-hidden="true" />
                            {{ t(K + "reset") }}
                        </Button>
                    </div>
                    <div class="space-y-2">
                        <AgentModelBindingFields
                            v-model="modelBinding"
                            field-prefix="apd-model-binding"
                            hint-prefix="apd-model-binding-hint"
                            :intent="modelIntent"
                            :disabled="!canEdit('model')"
                        />
                        <p
                            v-if="modelDiagnostic"
                            class="text-xs"
                            :class="
                                modelDiagnostic.state === 'single'
                                    ? 'text-muted-foreground'
                                    : 'text-destructive'
                            "
                            :data-state="modelDiagnostic.state"
                            data-testid="apd-model-diagnostic"
                        >
                            {{ modelDiagnosticText }}
                        </p>
                        <p
                            v-if="modelLegacyUnmapped"
                            class="text-xs text-amber-600 dark:text-amber-400"
                            data-testid="apd-model-legacy"
                        >
                            {{
                                t(K + "modelLegacyUnmapped", {
                                    provider: modelDraft.provider,
                                    model: modelDraft.model,
                                })
                            }}
                        </p>
                    </div>
                    <p v-if="bothOrNeitherError" class="text-xs text-destructive" role="alert">
                        {{ t(K + "modelBothOrNeither") }}
                    </p>
                    <div class="space-y-2">
                        <p class="text-sm font-medium">{{ t(K + "allowedModels") }}</p>
                        <p class="text-xs text-muted-foreground">
                            {{ t(K + "allowedModelsHint") }}
                        </p>
                        <div
                            v-for="(entry, index) in modelDraft.allowedModels"
                            :key="index"
                            class="space-y-1"
                        >
                            <AgentModelBindingFields
                                :model-value="allowedBinding(entry)"
                                :field-prefix="'apd-allowed-' + index"
                                :hint-prefix="'apd-allowed-hint-' + index"
                                :disabled="!canEdit('model')"
                                hide-restrict
                                @update:model-value="
                                    (value: AgentModelBindingDraft) =>
                                        applyAllowedModel(index, value)
                                "
                            />
                            <Button
                                v-if="canEdit('model')"
                                type="button"
                                variant="ghost"
                                size="sm"
                                :data-testid="'apd-allowed-remove-' + index"
                                @click="modelDraft.allowedModels.splice(index, 1)"
                            >
                                <X class="size-3.5" aria-hidden="true" />
                                {{ t(K + "allowedModelsRemove") }}
                            </Button>
                        </div>
                        <Button
                            v-if="canEdit('model')"
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="apd-allowed-add"
                            @click="addAllowedModel"
                        >
                            <Plus class="size-3.5" aria-hidden="true" />
                            {{ t(K + "allowedModelsAdd") }}
                        </Button>
                    </div>
                    <p
                        v-if="isUnknown('model')"
                        class="text-xs text-muted-foreground"
                        data-testid="apd-model-unknown"
                    >
                        {{ t(K + "unknownSectionHint") }}
                    </p>
                    <span
                        v-if="canEdit('model') && modelDirty"
                        class="text-xs text-amber-600 dark:text-amber-400"
                        data-testid="apd-model-unsaved"
                    >
                        {{ t(K + "unsaved") }}
                    </span>
                    <div v-if="sectionErrors.model" class="space-y-2">
                        <ErrorBlock :presentation="sectionErrors.model" testid="apd-model-error" />
                        <Button
                            v-if="canEdit('model')"
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="apd-model-retry"
                            :disabled="modelSaving"
                            @click="saveModel"
                        >
                            {{ t(K + "retry") }}
                        </Button>
                    </div>
                </section>

                <!-- 委派预算（可写；instance 层只读） -->
                <section
                    data-testid="apd-delegation"
                    class="space-y-2"
                    :data-dirty="delegationDirty"
                >
                    <h3 class="text-sm font-medium text-muted-foreground sm:pt-0.5">
                        {{ t(K + "sectionDelegation") }}
                    </h3>
                    <p
                        v-if="isUnknown('delegation')"
                        class="text-xs text-muted-foreground"
                        data-testid="apd-delegation-unknown"
                    >
                        {{ t(K + "unknownSectionHint") }}
                    </p>
                    <DelegationPolicyFields
                        v-else
                        v-model="delegationDraft"
                        :disabled="!canEdit('delegation')"
                    />
                    <span
                        v-if="canEdit('delegation') && delegationDirty"
                        class="text-xs text-amber-600 dark:text-amber-400"
                        data-testid="apd-delegation-unsaved"
                    >
                        {{ t(K + "unsaved") }}
                    </span>
                    <div v-if="sectionErrors.delegation" class="space-y-2">
                        <ErrorBlock
                            :presentation="sectionErrors.delegation"
                            testid="apd-delegation-error"
                        />
                        <Button
                            v-if="canEdit('delegation')"
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="apd-delegation-retry"
                            :disabled="delegationSaving"
                            @click="saveDelegation"
                        >
                            {{ t(K + "retry") }}
                        </Button>
                    </div>
                </section>

                <!-- 记忆（可写；instance 层只读）。task-151 ①：纯布尔 ⇒ 翻转即写，没有保存按钮。 -->
                <section data-testid="apd-memory" class="space-y-2">
                    <h3 class="text-sm font-medium text-muted-foreground">
                        {{ t(K + "sectionMemory") }}
                    </h3>
                    <div class="flex items-center gap-2">
                        <Switch
                            v-model="memoryEnabled"
                            :disabled="!canEdit('memory') || memorySaving"
                            data-testid="apd-memory-switch"
                        />
                        <span
                            class="text-xs text-muted-foreground"
                            data-testid="apd-memory-instant-hint"
                        >
                            {{ memorySaving ? t(K + "saving") : t(K + "memoryInstantHint") }}
                        </span>
                    </div>
                    <p v-if="memoryTypesMissing" class="text-xs text-muted-foreground">
                        {{ t(K + "memoryTypesMissing") }}
                    </p>
                    <div v-if="sectionErrors.memory" class="space-y-2">
                        <ErrorBlock
                            :presentation="sectionErrors.memory"
                            testid="apd-memory-error"
                        />
                        <Button
                            v-if="canEdit('memory') && memoryRetryTarget !== null"
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="apd-memory-retry"
                            :disabled="memorySaving"
                            @click="retryMemory"
                        >
                            {{ t(K + "retry") }}
                        </Button>
                    </div>
                </section>

                <!-- 钩子订阅（可写）。kind 与 on 都是**枚举族字段**（§17.5）——候选集来自 CP 契约
                     （HookAdvisorRegistry 注册的 advisor / ALLOWED_ACTION_CLASSES 白名单），
                     由 props.advisorKinds / advisorEvents 注入。未注册 kind 不提供入口：那是一类
                     存得下、永不触发的订阅（同 R53 族「可选项掩盖能力面缺失」）。 -->
                <section data-testid="apd-hooks" class="space-y-2" :data-dirty="hooksDirty">
                    <h3 class="text-sm font-medium text-muted-foreground">
                        {{ t(K + "sectionHooks") }}
                    </h3>
                    <p v-if="advisors.length === 0" class="text-sm text-muted-foreground">
                        {{ t(K + "hooksEmpty") }}
                    </p>
                    <ul v-else class="space-y-2" data-testid="apd-hooks-list">
                        <li
                            v-for="(advisor, index) in advisors"
                            :key="index"
                            class="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                        >
                            <span class="font-medium">{{ advisor.kind }}</span>
                            <Select
                                v-if="canEdit('hooks')"
                                :model-value="advisor.on[0] ?? advisorEventOptions[0]"
                                :disabled="hooksSaving"
                                @update:model-value="
                                    (value: unknown) => setAdvisorEvent(index, String(value))
                                "
                            >
                                <SelectTrigger
                                    class="h-8 w-40"
                                    :data-testid="'apd-hooks-event-' + index"
                                    :aria-label="t(K + 'hooksEventLabel')"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem
                                        v-for="action in advisorEventOptions"
                                        :key="action"
                                        :value="action"
                                    >
                                        {{ action }}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <Badge v-else variant="outline">{{ advisor.on.join(" · ") }}</Badge>
                            <Button
                                v-if="canEdit('hooks')"
                                type="button"
                                variant="ghost"
                                size="icon"
                                class="ml-auto shrink-0"
                                :data-testid="'apd-hooks-remove-' + index"
                                :aria-label="t(K + 'hooksRemove')"
                                @click="removeAdvisor(index)"
                            >
                                <X class="size-3.5" aria-hidden="true" />
                            </Button>
                        </li>
                    </ul>
                    <div v-if="canEdit('hooks')" class="space-y-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <Select v-model="newAdvisorKind" :disabled="hooksSaving">
                                <SelectTrigger
                                    class="h-8 w-40"
                                    data-testid="apd-hooks-kind"
                                    :aria-label="t(K + 'hooksKindLabel')"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem
                                        v-for="kind in advisorKindOptions"
                                        :key="kind"
                                        :value="kind"
                                    >
                                        {{ kind }}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <Select v-model="newAdvisorEvent" :disabled="hooksSaving">
                                <SelectTrigger
                                    class="h-8 w-40"
                                    data-testid="apd-hooks-new-event"
                                    :aria-label="t(K + 'hooksEventLabel')"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem
                                        v-for="action in advisorEventOptions"
                                        :key="action"
                                        :value="action"
                                    >
                                        {{ action }}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                data-testid="apd-hooks-add"
                                :disabled="newAdvisorKind.trim() === ''"
                                @click="addAdvisor"
                            >
                                <Plus class="size-3.5" aria-hidden="true" />
                                {{ t(K + "hooksAdd") }}
                            </Button>
                        </div>
                        <span
                            v-if="hooksDirty"
                            class="text-xs text-amber-600 dark:text-amber-400"
                            data-testid="apd-hooks-unsaved"
                        >
                            {{ t(K + "unsaved") }}
                        </span>
                    </div>
                    <div v-if="sectionErrors.hooks" class="space-y-2">
                        <ErrorBlock :presentation="sectionErrors.hooks" testid="apd-hooks-error" />
                        <Button
                            v-if="canEdit('hooks')"
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="apd-hooks-retry"
                            :disabled="hooksSaving"
                            @click="saveHooks"
                        >
                            {{ t(K + "retry") }}
                        </Button>
                    </div>
                </section>

                <!-- 工作区角色（只读；授权在 CP，UI 不复制判定）。task-151 ③：名字从「能力」
                     改为「工作区角色」——它读的是主体绑定的工作区角色（api.getAgentRoles），
                     不是平台能力原子表（DSD-1499）。 -->
                <section data-testid="apd-capabilities" class="space-y-2">
                    <h3 class="text-sm font-medium text-muted-foreground">
                        {{ t(K + "sectionCapabilities") }}
                    </h3>
                    <p
                        v-if="rolesLoading"
                        class="flex items-center gap-2 text-sm text-muted-foreground"
                    >
                        <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
                        {{ t(K + "rolesLoading") }}
                    </p>
                    <template v-else-if="rolesError">
                        <!-- task-151 ④：404 AGENT_PRINCIPAL_NOT_FOUND 是「还没绑角色」的空态，
                             不是错误 —— 红卡会占掉功能位，这里只留一句说明 + 去绑定入口。 -->
                        <p
                            v-if="rolesPrincipalMissing"
                            class="text-sm text-muted-foreground"
                            data-testid="apd-roles-empty"
                        >
                            {{ t(K + "rolesNotBound") }}
                        </p>
                        <ErrorBlock v-else :presentation="rolesError" testid="apd-roles-error" />
                        <div class="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                data-testid="apd-roles-retry"
                                :disabled="rolesLoading"
                                @click="retryRoles"
                            >
                                {{ t(K + "retry") }}
                            </Button>
                            <a
                                v-if="rolesPrincipalMissing"
                                :href="ROLES_BIND_HREF"
                                class="text-xs text-primary underline underline-offset-2"
                                data-testid="apd-roles-bind"
                            >
                                {{ t(K + "rolesBindCta") }}
                            </a>
                        </div>
                    </template>
                    <!-- task-219：「请求成功但列表为空」与上面那个「404 主体不存在」是两个语义，
                         testid 必须分开（apd-roles-none / apd-roles-empty）—— 合并成一个，
                         将来两分支被谁合成一处都没人能发现。 -->
                    <p
                        v-else-if="!roles || roles.length === 0"
                        class="text-sm text-muted-foreground"
                        data-testid="apd-roles-none"
                    >
                        {{ t(K + "rolesEmpty") }}
                    </p>
                    <ul v-else class="space-y-2">
                        <li
                            v-for="role in roles"
                            :key="role.bindingId"
                            class="rounded-md border border-border px-3 py-2 text-sm"
                            :data-testid="'apd-role-' + role.bindingId"
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-medium">{{ role.displayName ?? role.name }}</span>
                                <Badge v-if="role.isSystem" variant="outline">
                                    {{ t(K + "roleSystem") }}
                                </Badge>
                            </div>
                            <p class="mt-1 text-xs text-muted-foreground">
                                {{
                                    t(K + "rolesAtoms", {
                                        atoms: role.atomSummary.join(" / "),
                                        count: role.atomCount,
                                    })
                                }}
                            </p>
                        </li>
                    </ul>
                </section>
                <!-- 危险区：只有宿主没有自己 disable 入口时才渲染（user 层）。
                     task-151 ④：这一块不是语义分区，是页脚动作区 —— 用 div 承接，
                     顶级 <section> 因此只剩 6 组（form-contract F4）。 -->
                <div
                    v-if="showDanger && !readonly && !principal.disabled"
                    data-testid="apd-danger"
                    class="space-y-2 rounded-md border border-destructive/30 p-3"
                >
                    <h3 class="text-sm font-medium text-destructive">
                        {{ t(K + "sectionDanger") }}
                    </h3>
                    <p class="text-xs leading-5 text-muted-foreground">
                        {{ t(K + "disableDesc") }}
                    </p>
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        data-testid="apd-disable"
                        @click="disableConfirmOpen = true"
                    >
                        {{ t(K + "disable") }}
                    </Button>
                    <ErrorBlock
                        v-if="disableError"
                        :presentation="disableError"
                        testid="apd-disable-error"
                    />
                </div>
                <!-- task-34：三段表单（模型 / 委派 / 钩子）的统一提交点。粘在抽屉底部滚到哪都能提交；
                     分区保存键已删，记忆段仍即时写（它不进这个组）。
                     spacer 紧跟其前：粘性条是覆盖式的（sticky bottom-0），滚到底时会盖住最后一节
                     （真栈实测过「工作区角色」标题被盖掉一半），留一条与条等高的空白让覆盖区落在空处。 -->
                <div
                    v-if="canEdit('model') || canEdit('delegation') || canEdit('hooks')"
                    class="h-14"
                    aria-hidden="true"
                    data-testid="apd-save-bar-spacer"
                />
                <div
                    v-if="canEdit('model') || canEdit('delegation') || canEdit('hooks')"
                    class="sticky bottom-0 -mx-6 flex items-center gap-2 border-t border-border bg-background px-6 py-3"
                    data-testid="apd-save-bar"
                >
                    <Button
                        type="button"
                        size="sm"
                        data-testid="apd-save-all"
                        :disabled="groupSaveBlocked"
                        @click="saveDirtySections"
                    >
                        {{ groupSaving ? t(K + "saving") : t(K + "saveAll") }}
                    </Button>
                    <span
                        v-if="pendingSectionCount > 0"
                        class="text-xs text-muted-foreground"
                        data-testid="apd-save-all-hint"
                    >
                        {{ t(K + "saveAllPending", { count: pendingSectionCount }) }}
                    </span>
                </div>
            </div>

            <AlertDialog
                :open="disableConfirmOpen"
                @update:open="(value: boolean) => !value && (disableConfirmOpen = false)"
            >
                <AlertDialogContent
                    data-testid="apd-disable-confirm"
                    class="max-h-[85vh] overflow-y-auto"
                >
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {{ t(K + "disableConfirmTitle", { name: principal?.name ?? "" }) }}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {{ t(K + "disableConfirmDesc") }}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel :disabled="disabling">
                            {{ t(K + "cancel") }}
                        </AlertDialogCancel>
                        <!-- 不用 AlertDialogAction：它无条件关弹窗；失败要留在原地呈现错误面。 -->
                        <Button
                            type="button"
                            variant="destructive"
                            data-testid="apd-disable-confirm-commit"
                            :disabled="disabling"
                            @click="confirmDisable"
                        >
                            {{ disabling ? t(K + "disabling") : t(K + "disable") }}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <!-- task-151 / task-172 §17.4：离开策略 —— 有未保存草稿时关抽屉要先确认。 -->
            <AlertDialog
                :open="unsavedConfirmOpen"
                @update:open="(value: boolean) => !value && (unsavedConfirmOpen = false)"
            >
                <AlertDialogContent data-testid="apd-unsaved-confirm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{{ t(K + "unsavedConfirmTitle") }}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {{ t(K + "unsavedConfirmDesc") }}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel data-testid="apd-unsaved-keep">
                            {{ t(K + "unsavedKeep") }}
                        </AlertDialogCancel>
                        <Button
                            type="button"
                            variant="destructive"
                            data-testid="apd-unsaved-discard"
                            @click="discardAndClose"
                        >
                            {{ t(K + "unsavedDiscard") }}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <!--
                task-92：**换页**用的离开确认。与上面那条（关抽屉）刻意分成两个对话框：
                动作不同（关窗 vs 换页），用户的选择也不同；共用 `unsavedDraft` 一个真源保证
                「有没有草稿」不会两条路径各判一次。两个 testid 各自独立，互不串。
            -->
            <AlertDialog
                :open="routeLeaveOpen"
                @update:open="(value: boolean) => !value && keepRouteHere()"
            >
                <AlertDialogContent data-testid="settings-leave-confirm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{{ t("settings.ia.leaveDraftTitle") }}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {{
                                t("settings.ia.leaveDraftDesc", {
                                    domains: routeLeaveLabels.join(" / "),
                                })
                            }}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel data-testid="settings-leave-keep" @click="keepRouteHere">
                            {{ t("settings.ia.leaveDraftKeep") }}
                        </AlertDialogCancel>
                        <Button
                            type="button"
                            variant="destructive"
                            data-testid="settings-leave-discard"
                            @click="discardAndLeave"
                        >
                            {{ t("settings.ia.leaveDraftDiscard") }}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </DialogContent>
    </Dialog>
</template>

<style scoped>
/* task-137：config 档（768px）下 agent 配置弹窗改成「标签列 + 内容列」两列布局 —— 7.5rem 标签列，
   其余子项统一落第二列；<640px 仍是单列堆叠，与旧 512px 形态一致（不引入新断点语义）。 */
@media (min-width: 40rem) {
    .apd-two-col {
        display: grid;
        grid-template-columns: 7.5rem minmax(0, 1fr);
        column-gap: 1.5rem;
        row-gap: 0.5rem;
    }

    .apd-two-col > :not(h3) {
        grid-column: 2;
    }
}
</style>
