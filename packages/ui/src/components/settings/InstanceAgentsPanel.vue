<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Bot, Pencil, Plus, Sparkles, Trash2 } from "@lucide/vue";

import { useAuthStore } from "../../stores/auth";
import { useInstanceWriteGate } from "../../composables/useInstanceWriteGate";
import { logger } from "../../lib/logger";
import { ApiError } from "../../composables/api";
import { mappedErrorCopy } from "../../lib/errorMessages";
import {
    createInstanceAgent,
    deleteInstanceAgent,
    listInstanceAgents,
    updateInstanceAgent,
    type InstanceAgent,
    type InstanceAgentUpdateRequest,
} from "../../services/instanceResources";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "../ui/empty";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../ui/alert-dialog";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../ui/dialog";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import SettingsErrorSurface from "./SettingsErrorSurface.vue";
import InstanceAgentSkillsDialog from "../resources/InstanceAgentSkillsDialog.vue";
import AgentModelBindingFields, {
    type AgentModelBindingDraft,
} from "./AgentModelBindingFields.vue";

/**
 * task-165 · 实例层「平台智能体」面板（`/settings/instance/agents`）。
 *
 * <p><b>语义（D-1006 B4）</b>：平台智能体默认全局可见、**无需逐工作区绑定**、仅 instance admin
 * 可建；不做 fork、不收录 `workspace_agents`。所以这里**不提供**「绑定到工作区」动作——
 * 那是工作区自有智能体的事，放这里会造出第二套归属。</p>
 *
 * <p><b>与用户层 `agent-principals` 的区别</b>：那一页是「我的主体身份」（`created_by=self`），
 * 这一页是**全平台可用**的平台智能体。两页文案不得都叫「智能体」而不加限定词——左栏 id 仍是
 * `agents`，但显示名带「平台」前缀（见 `settingsIa.RESOURCE_DEFS` 注释）。</p>
 */
const { t, locale } = useI18n();
const auth = useAuthStore();

/**
 * 写侧（task-69 行 2，PLAN-0767 T3/T4）：CP 写面是**双门** ——
 * `InstanceAgentPrincipalController.java:60-62` 的 `INSTANCE_PRINCIPAL_WRITE_GATE`
 * = `holdsCapabilityAtom('instance:admin')` **and** `holdsActionAtom('MANAGE_AGENT_PRINCIPALS')`
 * （`:94` POST，PATCH/DELETE 同）。两半都要查，只查前半就是「有 cap 无 atom 的人能点、点下去 403」。
 *
 * <p><b>本注释是防删的</b>：`hasInstanceAdminCapability` 单看像 `AGENTS.md` 禁止的
 * `isInstanceAdmin` 角色特判，其实它是 CP 双门**前半段的忠实镜像**（`cap:instance:admin`），
 * 删掉它 = UI 比 CP 宽。</p>
 *
 * <p><b>读侧故意没有判据</b>（这是本卡与行 1 不同之处）：CP 读面是 `@PreAuthorize("isAuthenticated()")`
 * （同文件 `:74-75`，类头 `:33-36`「any authenticated caller sees the same list an instance admin
 * sees」）⇒ 平台智能体列表对**任何登录用户**都可见。此前用能力位把整块面板挡在 403 卡后面，
 * 属 **UI 比 CP 严** —— 藏了用户本来能看的东西（与 R10 同侧，比「宽」更难发现：用户不会报错，只会说看不到）。</p>
 */
/** 动作原子名同时也是按钮禁用理由的文案参数（与 CP 守卫原文一致，便于对账）。 */
const writeAtom = "MANAGE_AGENT_PRINCIPALS";

/**
 * task-420（D-1254）：写门从二态改**三态**（判据在 `useInstanceWriteGate`，此处只消费）。
 * 二态时「投影加载中 / 读取失败」都落进 `!canWrite` 并点名原子 ⇒ 真管理员看到确定性拒绝；
 * 现在只有 `denied`（已读到且确实缺）才点名，`loading` 说加载中、`error` 给重试出口。
 * `canWrite` 语义不变（= CP 双门都过），所以既有 `:disabled="!canWrite"` 一处都不用改。
 */
const { canWrite, state: writeGateState, retry: retryWriteGate } = useInstanceWriteGate(writeAtom);

/** 禁用理由随状态走：加载中/读取失败不得冒充「缺原子」（四个写面入口共用同一份）。 */
const writeGateTitle = computed(() => {
    if (writeGateState.value === "allowed") return undefined;
    if (writeGateState.value === "loading") return t("settings.instanceResources.writeGateLoading");
    if (writeGateState.value === "error") return t("settings.instanceResources.writeGateError");
    return t("settings.instanceResources.writeAtomMissing", { atom: writeAtom });
});

const agents = ref<InstanceAgent[]>([]);
const loading = ref(false);
const loadCause = ref<unknown>(null);
const submitting = ref(false);
const actionError = ref<string | null>(null);

const createOpen = ref(false);
const formName = ref("");
const deleteTarget = ref<InstanceAgent | null>(null);

/**
 * task-401 / `D-1248`：模型意图草稿（创建与编辑共用 `AgentModelBindingFields`）。
 *
 * <p>创建：`POST /instance/agent-principals` 的 body 就是 `AgentPrincipalCreateRequest`，早已含
 * 模型三字段 ⇒ 三段全空就一个模型键都不发（沿用平台默认），选满才发。</p>
 *
 * <p>编辑：cp-1 `task-413`（dedd832a5）把三字段接进了同一个 PATCH（`AgentPrincipalUpdateRequest`，
 * present 替换 / absent 保留 / 显式 null 清除，provider 与 name 在合并结果上 both-or-neither）。
 * 名称与说明**仍不在**这个写面上 ⇒ 编辑弹窗只改模型意图，不假装能改名。</p>
 */
function emptyBinding(): AgentModelBindingDraft {
    return { provider: "", connectionId: "", model: "", restrict: false };
}

const createBinding = ref<AgentModelBindingDraft>(emptyBinding());
const editTarget = ref<InstanceAgent | null>(null);
/** task-402：技能面目标（与编辑/删除同一形态：一个 ref 表达「选中了哪一行」）。 */
const skillsTarget = ref<InstanceAgent | null>(null);
const editBinding = ref<AgentModelBindingDraft>(emptyBinding());
const editClear = ref(false);
const editError = ref<string | null>(null);

/** 半组选择不是合法载荷：要么三个都空，要么三个都有。 */
function bindingComplete(binding: AgentModelBindingDraft): boolean {
    const picked = [binding.provider, binding.connectionId, binding.model].filter(Boolean);
    return picked.length === 0 || picked.length === 3;
}

function modelIntentOf(binding: AgentModelBindingDraft) {
    return {
        defaultModelProvider: binding.provider,
        defaultModelName: binding.model,
        // 省略 = 不限制（契约 null = unrestricted）；勾选才是白名单。
        ...(binding.restrict
            ? { allowedModels: [{ provider: binding.provider, model: binding.model }] }
            : {}),
    };
}

/**
 * 编辑载荷：没有可写的改动就回 null（提交禁用）——「不改就不写」，也避开 `minProperties: 1` 的 400。
 * 白名单规则：勾选 = 写新白名单；没勾但**换了模型** = 显式 null 清掉旧白名单（否则旧白名单还指着
 * 旧模型）；没勾且模型没变 = 省略该键（保留存量，不静默清数据）。
 */
function editPayload(): InstanceAgentUpdateRequest | null {
    if (editClear.value) {
        return { defaultModelProvider: null, defaultModelName: null, allowedModels: null };
    }
    const binding = editBinding.value;
    if (!binding.model || !bindingComplete(binding)) return null;
    const target = editTarget.value;
    const changed =
        binding.provider !== (target?.modelProvider ?? "") ||
        binding.model !== (target?.modelName ?? "");
    // 不改就不写：预填后原样保存会白写一次（还多一条审计），所以「与存量相同且没勾白名单」
    // 视为无改动 ⇒ 提交禁用。勾了白名单就算改动（存量白名单不在列表投影里，无法比对）。
    if (!changed && !binding.restrict) return null;
    return {
        defaultModelProvider: binding.provider,
        defaultModelName: binding.model,
        ...(binding.restrict
            ? { allowedModels: [{ provider: binding.provider, model: binding.model }] }
            : changed
              ? { allowedModels: null }
              : {}),
    };
}

const canSubmitEdit = computed(() => editPayload() !== null);

function openEdit(agent: InstanceAgent): void {
    editTarget.value = agent;
    editBinding.value = emptyBinding();
    editClear.value = false;
    editError.value = null;
}

async function submitEdit(): Promise<void> {
    const target = editTarget.value;
    const payload = editPayload();
    if (!target || !payload || submitting.value) return;
    submitting.value = true;
    editError.value = null;
    try {
        await updateInstanceAgent(target.id, payload);
        editTarget.value = null;
        toast.success(t("settings.instanceResources.agents.updated"));
        await load();
    } catch (cause) {
        // 系统预置（origin=SYSTEM_PRESET）由 CP 回 403 GUARD_MODEL_INTENT_IMMUTABLE ⇒ 本地化点名，
        // 不直显 CP 英文 detail（与凭据/成员面板同口径）。
        const code = cause instanceof ApiError ? cause.problem.code : undefined;
        editError.value =
            code === "GUARD_MODEL_INTENT_IMMUTABLE"
                ? t("settings.instanceResources.agents.presetGuard")
                : (mappedErrorCopy(code) ?? t("settings.instanceResources.actionFailed"));
        logger.warn("Failed to update instance agent model intent", cause);
    } finally {
        submitting.value = false;
    }
}

const countLabel = computed(() =>
    t("settings.instanceResources.agents.count", { count: agents.value.length }),
);

function formatTime(iso: string | null): string {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium" }).format(date);
}

async function load(): Promise<void> {
    loading.value = true;
    loadCause.value = null;
    try {
        const payload = await listInstanceAgents();
        agents.value = payload.agents;
    } catch (cause) {
        loadCause.value = cause;
        logger.warn("Failed to load instance agents", cause);
    } finally {
        loading.value = false;
    }
}

/** 读面只受「已登录」约束（CP `:74-75`），所以不再等能力位到达才取数。 */
watch(
    () => auth.isAuthenticated,
    (authenticated) => {
        if (!authenticated) return;
        // task-401：写面判据是**动作原子** `MANAGE_AGENT_PRINCIPALS`，它来自 `/me/permissions`
        // 投影。资源区这条路由（`/resources/agents?layer=INSTANCE`）上**没有别的组件拉它**
        // （设置区左栏 `SettingsSidebar` 才拉）⇒ 面板不自取就永远停在「缺原子」禁用态，
        // 真管理员也点不动（`D-1136` 死路）。与 `SkillsPanel` / `CredentialsPanel` 同形：
        // 自取投影，幂等 + 单飞由 store 保证。mock e2e 不桩这条端点，验的就是这条自取路径。
        void auth.ensureSelfPermissions();
        void load();
    },
    { immediate: true },
);

function openCreate(): void {
    formName.value = "";
    createBinding.value = emptyBinding();
    actionError.value = null;
    createOpen.value = true;
}

/**
 * task-430：名字契约（openapi `AgentPrincipalCreateRequest.name.pattern`，2026-11-03 裁定）——
 * 字母 / 汉字 / 数字，不能数字开头，不含空格与符号。真 HTTP 实测违者 400 `INVALID_NAME_FORMAT`
 * （探针第一版名字带连字符当场被拒，`.tmp/xh/task-402/probe-report.json`）⇒ 就地提示 + 提交前拦，
 * 不让用户白跑一次必 400 的请求；服务端码仍本地化映射（别的客户端/竞态下仍可能收到）。
 */
const NAME_PATTERN = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$/;

/** 空名字不算「格式错」（那是必填判据）；非空才按契约校验。 */
const nameFormatOk = computed(() => {
    const name = formName.value.trim();
    return !name || NAME_PATTERN.test(name);
});

const canSubmit = computed(
    () =>
        Boolean(formName.value.trim()) &&
        nameFormatOk.value &&
        bindingComplete(createBinding.value),
);

async function submitCreate(): Promise<void> {
    if (!canSubmit.value || submitting.value) return;
    submitting.value = true;
    actionError.value = null;
    try {
        await createInstanceAgent({
            name: formName.value.trim(),
            // 留空 = 不写模型意图，由 CP 沿用平台默认 llm-provider 偏好解析（不假装选了）。
            ...(createBinding.value.model ? modelIntentOf(createBinding.value) : {}),
        });
        createOpen.value = false;
        toast.success(t("settings.instanceResources.agents.created"));
        await load();
    } catch (cause) {
        // task-430：名字格式错要点名判据，不直显通用「操作失败」（用户看不出为什么）。
        const code = cause instanceof ApiError ? cause.problem.code : undefined;
        actionError.value =
            code === "INVALID_NAME_FORMAT"
                ? t("settings.instanceResources.agents.nameInvalid")
                : t("settings.instanceResources.actionFailed");
        logger.warn("Failed to create instance agent", cause);
    } finally {
        submitting.value = false;
    }
}

async function confirmDelete(): Promise<void> {
    const target = deleteTarget.value;
    if (!target) return;
    submitting.value = true;
    try {
        await deleteInstanceAgent(target.id);
        deleteTarget.value = null;
        toast.success(t("settings.instanceResources.agents.deleted"));
        await load();
    } catch (cause) {
        actionError.value = t("settings.instanceResources.actionFailed");
        logger.warn("Failed to delete instance agent", cause);
    } finally {
        submitting.value = false;
    }
}
</script>

<template>
    <section data-testid="instance-agents-panel" class="space-y-4">
        <!--
            PLAN-0772 M2 / Lead 裁定三：这里的原子名原先是一个**CP 目录里不存在的**幻影原子
            （`PermissionAtomCatalog` 无条目，openapi 也不出现），用户照文案去申请权限会找不到。
            改成 CP 守卫原文：`InstanceAgentPrincipalController.java:60-62` 的
            `INSTANCE_PRINCIPAL_WRITE_GATE = holdsCapabilityAtom('instance:admin') and holdsActionAtom('MANAGE_AGENT_PRINCIPALS')`，
            task-69 后本面板的两面各查一半，别按旧注释理解：
            **读面没有门槛**（CP 是 `isAuthenticated()`，同文件 `:74-75`）；**写面 = `canWrite`**
            = 能力位 `hasInstanceAdminCapability` **and** 原子 `MANAGE_AGENT_PRINCIPALS`，正好是上面那道
            双门的前后半段。文案两个都点名，避免读者以为只要能力位就够。
        -->
        <template v-if="auth.isAuthenticated">
            <header class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                    <h2 class="text-base font-medium" data-testid="instance-agents-heading">
                        {{ t("settings.instanceResources.agents.title") }}
                    </h2>
                    <p class="mt-1 text-xs leading-5 text-muted-foreground">
                        {{ t("settings.instanceResources.agents.subtitle") }}
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs text-muted-foreground">{{ countLabel }}</span>
                    <Button
                        data-testid="instance-agents-create"
                        :disabled="!canWrite"
                        :title="writeGateTitle"
                        @click="openCreate"
                    >
                        <Plus class="size-4" aria-hidden="true" />
                        {{ t("settings.instanceResources.agents.createCta") }}
                    </Button>
                </div>
            </header>

            <!-- 无动作原子 ⇒ **disabled 不隐藏**（先例口径 `components/resources/ResourceLayerTabs.vue:74`）：
                 隐藏会让人以为产品没这个能力，而 CP 说的是「你没这个原子」。 -->
            <p
                v-if="writeGateState !== 'allowed'"
                data-testid="instance-agents-write-disabled"
                :data-gate-state="writeGateState"
                class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            >
                <template v-if="writeGateState === 'loading'">
                    {{ t("settings.instanceResources.writeGateLoading") }}
                </template>
                <template v-else-if="writeGateState === 'error'">
                    {{ t("settings.instanceResources.writeGateError") }}
                    <Button
                        data-testid="instance-agents-write-gate-retry"
                        variant="link"
                        size="sm"
                        class="h-auto p-0 align-baseline text-xs"
                        @click="retryWriteGate"
                    >
                        {{ t("settings.instanceResources.writeGateRetry") }}
                    </Button>
                </template>
                <template v-else>
                    {{ t("settings.instanceResources.writeAtomMissing", { atom: writeAtom }) }}
                </template>
            </p>

            <SettingsErrorSurface :cause="loadCause" :retry="load" />
            <p
                v-if="actionError"
                data-testid="instance-agents-action-error"
                class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
                {{ actionError }}
            </p>

            <div
                v-if="loading"
                data-testid="instance-agents-loading"
                class="space-y-2"
                aria-busy="true"
            >
                <Skeleton v-for="row in 3" :key="row" class="h-11 w-full rounded-md" />
            </div>

            <Empty v-else-if="!agents.length && !loadCause" data-testid="instance-agents-empty">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Bot class="size-4" aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>{{ t("settings.instanceResources.agents.emptyTitle") }}</EmptyTitle>
                    <EmptyDescription>
                        {{ t("settings.instanceResources.agents.emptyBody") }}
                    </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button
                        data-testid="instance-agents-empty-create"
                        :disabled="!canWrite"
                        :title="writeGateTitle"
                        @click="openCreate"
                    >
                        <Plus class="size-4" aria-hidden="true" />
                        {{ t("settings.instanceResources.agents.emptyCta") }}
                    </Button>
                </EmptyContent>
            </Empty>

            <Card v-else-if="agents.length">
                <CardContent class="pt-4">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left text-sm" data-testid="instance-agents-table">
                            <thead class="text-xs text-muted-foreground">
                                <tr>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.columnName") }}
                                    </th>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.agents.columnModel") }}
                                    </th>
                                    <th class="py-1.5">
                                        {{ t("settings.instanceResources.columnCreated") }}
                                    </th>
                                    <th class="py-1.5 text-right">
                                        {{ t("settings.instanceResources.columnActions") }}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="agent in agents"
                                    :key="agent.id"
                                    :data-testid="`instance-agent-row-${agent.id}`"
                                    class="border-t border-border"
                                >
                                    <td class="py-2">
                                        <span class="font-medium">{{ agent.name }}</span>
                                        <Badge
                                            v-if="agent.disabled"
                                            variant="outline"
                                            class="ml-2 font-normal"
                                        >
                                            {{ t("settings.instanceResources.agents.disabled") }}
                                        </Badge>
                                        <p
                                            v-if="agent.description"
                                            class="mt-0.5 max-w-md truncate text-xs text-muted-foreground"
                                        >
                                            {{ agent.description }}
                                        </p>
                                    </td>
                                    <td class="py-2 text-xs text-muted-foreground">
                                        <template v-if="agent.modelName">
                                            {{ agent.modelProvider }} / {{ agent.modelName }}
                                        </template>
                                        <template v-else>—</template>
                                    </td>
                                    <td class="py-2 text-xs text-muted-foreground">
                                        {{ formatTime(agent.createdAt) }}
                                    </td>
                                    <td class="space-x-1 py-2 text-right">
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            :data-testid="`instance-agent-edit-${agent.id}`"
                                            :disabled="!canWrite"
                                            :title="
                                                canWrite
                                                    ? t('settings.instanceResources.agents.editCta')
                                                    : writeGateTitle
                                            "
                                            @click="openEdit(agent)"
                                        >
                                            <Pencil class="size-3.5" aria-hidden="true" />
                                        </Button>
                                        <!-- task-402：技能面入口。写门文案用 420 的 writeGateTitle，
                                             不在这里另写二态（加载中/失败不得冒充缺原子，D-1254）。 -->
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            :data-testid="`instance-agent-skills-${agent.id}`"
                                            :disabled="!canWrite"
                                            :title="
                                                canWrite
                                                    ? t(
                                                          'settings.instanceResources.agents.skillsCta',
                                                      )
                                                    : writeGateTitle
                                            "
                                            @click="skillsTarget = agent"
                                        >
                                            <Sparkles class="size-3.5" aria-hidden="true" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            :data-testid="`instance-agent-delete-${agent.id}`"
                                            :disabled="!canWrite"
                                            :title="
                                                canWrite
                                                    ? t('settings.instanceResources.delete')
                                                    : writeGateTitle
                                            "
                                            @click="deleteTarget = agent"
                                        >
                                            <Trash2 class="size-3.5" aria-hidden="true" />
                                        </Button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>

            <Dialog :open="createOpen" @update:open="(open: boolean) => (createOpen = open)">
                <DialogContent data-testid="instance-agents-create-dialog">
                    <DialogHeader>
                        <DialogTitle>{{
                            t("settings.instanceResources.agents.createTitle")
                        }}</DialogTitle>
                        <DialogDescription>
                            {{ t("settings.instanceResources.agents.createBody") }}
                        </DialogDescription>
                    </DialogHeader>
                    <div class="space-y-3">
                        <div class="space-y-1">
                            <Label for="instance-agent-name">
                                {{ t("settings.instanceResources.agents.fieldName") }}
                            </Label>
                            <Input
                                id="instance-agent-name"
                                v-model="formName"
                                data-testid="instance-agents-form-name"
                                :placeholder="
                                    t('settings.instanceResources.agents.fieldNamePlaceholder')
                                "
                            />
                            <!-- task-430：格式提示常驻（不是等 400 才说）；不合契约时就地变红点名。 -->
                            <p
                                class="text-xs"
                                :class="nameFormatOk ? 'text-muted-foreground' : 'text-destructive'"
                                data-testid="instance-agents-form-name-hint"
                            >
                                {{
                                    nameFormatOk
                                        ? t("settings.instanceResources.agents.nameHint")
                                        : t("settings.instanceResources.agents.nameInvalid")
                                }}
                            </p>
                        </div>
                        <!-- task-430：撤掉「说明」框 —— 契约 AgentPrincipalCreateRequest 没有 description，
                             填了就必 400（真 HTTP 实测）。不摆会 400 的框，与编辑半同口径。 -->

                        <AgentModelBindingFields v-model="createBinding" />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            data-testid="instance-agents-create-cancel"
                            @click="createOpen = false"
                        >
                            {{ t("settings.instanceResources.cancel") }}
                        </Button>
                        <Button
                            :disabled="!canSubmit || submitting"
                            data-testid="instance-agents-create-submit"
                            @click="submitCreate"
                        >
                            {{ t("settings.instanceResources.agents.createSubmit") }}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <!-- task-401 编辑半：只改模型意图（契约 PATCH 不收名称/说明），不建会 400 的假入口。 -->
            <Dialog
                :open="editTarget !== null"
                @update:open="(open: boolean) => !open && (editTarget = null)"
            >
                <DialogContent data-testid="instance-agents-edit-dialog">
                    <DialogHeader>
                        <DialogTitle>{{
                            t("settings.instanceResources.agents.editTitle")
                        }}</DialogTitle>
                        <DialogDescription>
                            {{ t("settings.instanceResources.agents.editBody") }}
                        </DialogDescription>
                    </DialogHeader>
                    <div class="space-y-3">
                        <div class="space-y-1">
                            <Label>{{
                                t("settings.instanceResources.agents.currentIntent")
                            }}</Label>
                            <p class="text-sm" data-testid="instance-agents-edit-current">
                                <template v-if="editTarget?.modelName">
                                    {{ editTarget?.modelProvider }} / {{ editTarget?.modelName }}
                                </template>
                                <template v-else>{{
                                    t("settings.instanceResources.agents.currentIntentNone")
                                }}</template>
                            </p>
                        </div>
                        <AgentModelBindingFields
                            v-model="editBinding"
                            :intent="
                                editTarget
                                    ? {
                                          provider: editTarget.modelProvider ?? '',
                                          model: editTarget.modelName ?? '',
                                      }
                                    : null
                            "
                            field-prefix="instance-agents-edit-form"
                            hint-prefix="instance-agents-edit-model"
                            :disabled="editClear"
                        />
                        <p class="text-xs text-muted-foreground">
                            {{ t("settings.instanceResources.agents.editWhitelistHint") }}
                        </p>
                        <label class="flex items-center gap-2 text-xs">
                            <Checkbox
                                v-model="editClear"
                                data-testid="instance-agents-edit-clear"
                            />
                            {{ t("settings.instanceResources.agents.clearModel") }}
                        </label>
                        <p
                            v-if="!canSubmitEdit"
                            class="text-xs text-muted-foreground"
                            data-testid="instance-agents-edit-nochange"
                        >
                            {{ t("settings.instanceResources.agents.editNoChange") }}
                        </p>
                        <p
                            v-if="editError"
                            class="text-xs text-destructive"
                            data-testid="instance-agents-edit-error"
                        >
                            {{ editError }}
                        </p>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            data-testid="instance-agents-edit-cancel"
                            @click="editTarget = null"
                        >
                            {{ t("settings.instanceResources.cancel") }}
                        </Button>
                        <Button
                            :disabled="!canSubmitEdit || submitting"
                            data-testid="instance-agents-edit-submit"
                            @click="submitEdit"
                        >
                            {{ t("settings.instanceResources.agents.editSubmit") }}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <!-- task-402：实例档技能绑定（列/绑/解绑）。组件自足取数，权限由入口按钮的写门管。 -->
            <InstanceAgentSkillsDialog
                :open="skillsTarget !== null"
                :principal="skillsTarget ? { id: skillsTarget.id, name: skillsTarget.name } : null"
                @update:open="(open: boolean) => !open && (skillsTarget = null)"
            />

            <AlertDialog
                :open="deleteTarget !== null"
                @update:open="(open: boolean) => !open && (deleteTarget = null)"
            >
                <AlertDialogContent data-testid="instance-agent-delete-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {{ t("settings.instanceResources.agents.deleteTitle") }}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {{
                                t("settings.instanceResources.agents.deleteBody", {
                                    name: deleteTarget?.name ?? "",
                                })
                            }}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel data-testid="instance-agent-delete-cancel">
                            {{ t("settings.instanceResources.cancel") }}
                        </AlertDialogCancel>
                        <!--
                            用普通 destructive `Button`，不用 `AlertDialogAction`：后者点下即无条件关闭
                            （动作对象先被清空，异步删除还没发出去），见 `packages/ui/AGENTS.md` §Reka UI 交互陷阱。
                        -->
                        <Button
                            variant="destructive"
                            data-testid="instance-agent-delete-confirm"
                            :disabled="submitting"
                            @click="confirmDelete"
                        >
                            {{ t("settings.instanceResources.delete") }}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </template>
    </section>
</template>
