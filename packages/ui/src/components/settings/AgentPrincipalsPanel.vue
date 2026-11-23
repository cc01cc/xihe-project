<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Bot, Link2, Plus, RefreshCw, Settings2 } from "@lucide/vue";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "../ui/empty";
import { Input } from "../ui/input";
import { api, type AgentPrincipalSummary } from "../../composables/api";
import { bareAtom } from "../../stores/auth";
import { formatDate } from "../../lib/dateFormat";
import { causeErrorToastText } from "../../lib/errorMessages";
import { logger } from "../../lib/logger";
import { principalNameError } from "../../lib/principalName";
import SettingsPermissionGate from "./SettingsPermissionGate.vue";
import AgentPrincipalDetailDrawer, {
    type AgentPrincipalDetail,
} from "./AgentPrincipalDetailDrawer.vue";

/**
 * PLAN-0750 M3 (T3.1 + T3.2)：用户层「智能体主体」。
 *
 * <p>**这是新增的第二个面，不是工作区那个面的复制品**（矩阵 U2：`WorkspaceAgentsPanel` 的
 * 单门保持原样，不改造）。两面的差别是授权来源，不是样式：</p>
 *
 * <ul>
 *   <li><b>创建</b>——走 {@code api.createOwnAgentPrincipal}，即**无工作区上下文**的
 *       `CREATE_OWN_AGENT` 门（矩阵 U1）。刻意**不做**工作区选择器：一旦带上工作区，
 *       CP 会按 `MANAGE_WORKSPACE_AGENTS` 判权，普通账号直接 403。</li>
 *   <li><b>列表</b>——走 {@code api.listMyAgentPrincipals}，即 `GET /agent-principals`
 *       **不带 `?workspaceId=`** 的个人视图（矩阵 R3：CP 只回 `created_by=self`，
 *       不是 `owner_user_id`）。</li>
 *   <li><b>绑定</b>——task-153 S4 起**不在本页**：工作区多选与会话绑定在独立整页
 *       `/settings/agent-principals/:id/bindings`（入口在列表行），列表页只留创建 / 配置 / 停用。
 *       旧的行内绑定小窗与「没有可管理工作区」提示已删除，删除面与证据见
 *       `internal/A03-xihe/evidence/2026-11-21-agent-bindings-unified/task7-s4-s5.md`。</li>
 * </ul>
 */

const { t } = useI18n();

/**
 * 嵌入模式（task-135 J4）：宿主页已经给了段标题时，面板不再自渲染 eyebrow + h1 + desc。
 * 否则页面上的「智能体主体」**出现两次**（用户 2026-11-20 实测截图报的就是这个）：一次是页面 h2，
 * 一次是本面板的 h1。嵌入时标题改由宿主用 #heading 插槽给；右侧刷新/创建入口照旧渲染
 * （可发现性不能跟着标题一起去掉）。默认 false ⇒ 独立挂载（设置域历史形态）行为一字不变。
 */
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

const agents = ref<AgentPrincipalSummary[]>([]);
const loading = ref(true);
const loadError = ref("");

/** `null` = 能力投影还没回来（按钮禁用但**不谎报**无权限）。 */
const capabilityState = ref<"loading" | "ready" | "failed">("loading");
const instanceAtoms = ref<string[]>([]);

const canCreateOwnAgent = computed<boolean | null>(() => {
    if (capabilityState.value === "loading") return null;
    return instanceAtoms.value.includes("CREATE_OWN_AGENT");
});

// ---- create ----------------------------------------------------------------
const createOpen = ref(false);
const name = ref("");
const saving = ref(false);
const formError = ref("");

/** 2026-11-04 用户裁定：主体名不得含空格、不得数字开头，只允许字母/汉字/数字。 */
const nameError = computed(() => principalNameError(name.value));
const nameErrorMessage = computed(() => {
    switch (nameError.value) {
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
    () => !!nameError.value || saving.value || canCreateOwnAgent.value !== true,
);

function openCreate() {
    name.value = "";
    formError.value = "";
    createOpen.value = true;
}

function cancelCreate() {
    createOpen.value = false;
    formError.value = "";
}

async function submitCreate() {
    if (createBlocked.value) return;
    saving.value = true;
    formError.value = "";
    const submitted = name.value;
    try {
        // 关键：无 workspaceId、无工作区选择（矩阵 U1 / R4）。请求携带的空
        // `X-Workspace-Id` 由 api.createOwnAgentPrincipal 负责，调用方不需要知道。
        await api.createOwnAgentPrincipal({ name: submitted });
        toast.success(t("agentPrincipals.created", { name: submitted }));
        createOpen.value = false;
        name.value = "";
        await loadAgents();
    } catch (e) {
        logger.warn("Create agent principal failed", e);
        formError.value = causeErrorToastText(t, e, t("agentPrincipals.createFailed"));
    } finally {
        saving.value = false;
    }
}

// ---- list ------------------------------------------------------------------
// 列表里的「创建日期」只到天；解析失败与缺值同走 `DATE_FALLBACK`（占位只在入口定义一次）。

async function loadAgents() {
    loading.value = true;
    loadError.value = "";
    try {
        agents.value = await api.listMyAgentPrincipals();
    } catch (e) {
        logger.warn("Load agent principals failed", e);
        loadError.value = causeErrorToastText(t, e, t("agentPrincipals.loadFailed"));
    } finally {
        loading.value = false;
    }
}

/**
 * 能力投影（只取实例级原子）。
 *
 * <p>task-153 S4：本页只剩「创建」。绑定面（工作区多选 / 会话绑定）在独立整页，读态语义由
 * `useAgentBindings` 一条路径负责 —— 本页不再自己拉 `/workspaces` 与
 * `/workspaces/{id}/agents`，旧实现「先置 ready 再取清单、清单失败置空」的同型缺陷
 * 因此整段消失（task-41 修的是 `useAgentBindings`，本页这份是删而不是修）。</p>
 */
async function loadCapability() {
    capabilityState.value = "loading";
    try {
        const self = await api.getSelfPermissions();
        instanceAtoms.value = (self.instancePermissions ?? [])
            .map((atom) => bareAtom(atom.actionClass))
            .filter((value): value is string => value !== null);
        capabilityState.value = "ready";
    } catch {
        // fail-closed：原子读不到 ⇒ 不显示创建入口，但也不断言"你没权限"。
        capabilityState.value = "failed";
    }
}

// ---- 详情配置（task-191；Q1 persona 只读、Q2 instance 只读不涉及本层） --------------------
const detailTarget = ref<AgentPrincipalSummary | null>(null);
const detailOpen = ref(false);

/** 归一化成抽屉需要的行形状：本层 = AgentPrincipalView（全字段，含 hooks/contextPolicy/delegationPolicy）。 */
const detailPrincipal = computed<AgentPrincipalDetail | null>(() => {
    const agent = detailTarget.value;
    if (!agent) return null;
    return {
        principalId: agent.principalId,
        name: agent.name,
        ownership: agent.ownership ?? "USER",
        templateName: agent.templateName,
        createdAt: agent.createdAt,
        disabled: agent.disabled,
        defaultModelProvider: agent.defaultModelProvider ?? null,
        defaultModelName: agent.defaultModelName ?? null,
        allowedModels: agent.allowedModels ?? null,
        hooks: agent.hooks ?? null,
        contextPolicy: agent.contextPolicy ?? null,
        delegationPolicy: agent.delegationPolicy ?? null,
    };
});

function openDetail(agent: AgentPrincipalSummary) {
    detailTarget.value = agent;
    detailOpen.value = true;
}

/** 持久化回执就地更新列表行（不整表重拉 —— 抽屉响应 echo 的就是持久化值）。 */
function onDetailChanged(patch: Partial<AgentPrincipalDetail> & { principalId: string }) {
    const index = agents.value.findIndex((item) => item.principalId === patch.principalId);
    if (index < 0) return;
    agents.value[index] = { ...agents.value[index]!, ...patch };
    // detailTarget 持有的是旧行对象 —— 同步刷新，抽屉内禁用徽标/危险区才即时。
    if (detailTarget.value?.principalId === patch.principalId) {
        detailTarget.value = { ...detailTarget.value, ...patch };
    }
}

async function refresh() {
    await Promise.all([loadAgents(), loadCapability()]);
}

onMounted(refresh);
</script>

<template>
    <div data-testid="agent-principals-panel">
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
            <!-- task-135：嵌入模式下标题由宿主插槽给（页面已有 h2），面板只保留动作区。 -->
            <div v-if="props.embedded" class="min-w-0">
                <slot name="heading" />
            </div>
            <div v-else>
                <p class="mb-1 text-xs tracking-widest text-muted-foreground">
                    {{ t("settings.eyebrow.agentPrincipals") }}
                </p>
                <h1
                    data-testid="agent-principals-heading"
                    class="text-xl font-semibold tracking-tight"
                >
                    {{ t("agentPrincipals.heading") }}
                </h1>
                <p class="mt-1 text-sm text-muted-foreground">{{ t("agentPrincipals.desc") }}</p>
            </div>
            <div class="flex items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="agent-principals-refresh"
                    :disabled="loading"
                    @click="refresh"
                >
                    <RefreshCw aria-hidden="true" />
                    {{ t("agentPrincipals.refresh") }}
                </Button>
                <Button
                    v-if="canCreateOwnAgent === true"
                    type="button"
                    size="sm"
                    data-testid="agent-principals-create-button"
                    @click="openCreate"
                >
                    <Plus aria-hidden="true" />
                    {{ t("agentPrincipals.create") }}
                </Button>
            </div>
        </header>

        <!-- 无 CREATE_OWN_AGENT ⇒ 这是**授权**问题，不是"后端缺口"（SettingsPermissionGate 区分两者）。 -->
        <div
            v-if="canCreateOwnAgent === false"
            data-testid="agent-principals-create-denied"
            class="mb-4"
        >
            <SettingsPermissionGate variant="atom-denied" atom="CREATE_OWN_AGENT" />
        </div>

        <!-- 创建表单：**没有工作区选择器**（矩阵 U1）。 -->
        <form
            v-if="createOpen && canCreateOwnAgent === true"
            data-testid="agent-principals-create-form"
            class="mb-6 space-y-3 rounded-lg border border-border bg-card p-4"
            @submit.prevent="submitCreate"
        >
            <div class="space-y-1.5">
                <label class="text-sm font-medium" for="my-agent-name">{{
                    t("agentPrincipals.name")
                }}</label>
                <Input
                    id="my-agent-name"
                    v-model="name"
                    data-testid="agent-principals-create-name"
                    :placeholder="t('agentPrincipals.namePlaceholder')"
                    :maxlength="128"
                    autocomplete="off"
                />
                <p
                    v-if="nameErrorMessage"
                    data-testid="agent-principals-create-name-error"
                    class="text-xs text-destructive"
                >
                    {{ nameErrorMessage }}
                </p>
            </div>
            <p
                v-if="formError"
                data-testid="agent-principals-create-error"
                class="rounded-md border border-destructive/30 bg-background p-2 text-sm text-destructive"
            >
                {{ formError }}
            </p>
            <div class="flex items-center gap-2">
                <Button
                    type="submit"
                    size="sm"
                    data-testid="agent-principals-create-submit"
                    :disabled="createBlocked"
                >
                    {{ saving ? t("agentPrincipals.creating") : t("agentPrincipals.submit") }}
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="agent-principals-create-cancel"
                    @click="cancelCreate"
                >
                    {{ t("agentPrincipals.cancel") }}
                </Button>
            </div>
        </form>

        <div
            v-if="loadError"
            data-testid="agent-principals-error"
            class="mb-4 rounded-md border border-destructive/30 bg-background p-3 text-sm text-destructive"
        >
            {{ loadError }}
        </div>

        <section class="min-w-0 rounded-lg border border-border bg-card">
            <div class="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 class="text-sm font-medium" data-testid="agent-principals-list-heading">
                    {{ t("agentPrincipals.listHeading") }}
                </h2>
                <span class="text-xs text-muted-foreground">{{ agents.length }}</span>
            </div>
            <div v-if="loading" class="p-4 text-sm text-muted-foreground">
                {{ t("agentPrincipals.loading") }}
            </div>
            <Empty v-else-if="agents.length === 0" data-testid="agent-principals-empty" class="p-8">
                <!-- 创建表单在上方常驻 ⇒ 这里不重复给按钮（PLAN-0762 T1.4）。 -->
                <EmptyHeader class="gap-1">
                    <EmptyMedia variant="icon">
                        <Bot class="size-4" aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyDescription>{{ t("agentPrincipals.empty") }}</EmptyDescription>
                </EmptyHeader>
            </Empty>
            <ul v-else data-testid="agent-principals-list" class="divide-y divide-border">
                <li
                    v-for="agent in agents"
                    :key="agent.principalId"
                    :data-testid="`agent-principals-row-${agent.principalId}`"
                    class="flex flex-wrap items-start justify-between gap-3 px-4 py-3 hover:bg-muted/50"
                >
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            <Bot
                                class="size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                            />
                            <span
                                class="truncate text-sm font-medium"
                                :data-testid="`agent-principals-row-name-${agent.principalId}`"
                            >
                                {{ agent.name }}
                            </span>
                            <Badge
                                v-if="agent.disabled"
                                variant="outline"
                                data-testid="agent-principals-row-disabled"
                            >
                                {{ t("agentPrincipals.disabledBadge") }}
                            </Badge>
                        </div>
                        <p class="mt-1 text-xs text-muted-foreground">
                            {{ agent.templateName || t("agentPrincipals.templateFallback") }} ·
                            {{
                                t("agentPrincipals.createdAt", {
                                    date: formatDate(agent.createdAt),
                                })
                            }}
                        </p>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                        <!--
                            task-153 S1 + S4：绑定整页的**唯一**入口（位于列表行）。
                            S4 删掉行内绑定小窗后，本行只剩这一处绑定入口，不再有第二个同动作入口。
                            刻意**不按** MANAGE_WORKSPACE_AGENTS 门控：这一页是读 + 写两面，没有原子的人
                            进去也能看到「你没有可管理的工作区智能体权限」这句实话，比"按钮消失、不知道
                            为什么"好。链接走**路由名**而不是手拼路径，路径只在一处（router/index.ts）定义；
                            也不需要主体名（task-195 前 name 读面缺失，靠 id 就能进 ⇒ 不等 195）。
                        -->
                        <Button as-child variant="outline" size="sm">
                            <RouterLink
                                :to="{
                                    name: 'settings-agent-principal-bindings',
                                    params: { id: agent.principalId },
                                }"
                                :data-testid="`agent-principals-bindings-${agent.principalId}`"
                            >
                                <Link2 aria-hidden="true" />
                                {{ t("agentBindings.openPage") }}
                            </RouterLink>
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            :data-testid="`agent-principals-configure-${agent.principalId}`"
                            @click="openDetail(agent)"
                        >
                            <Settings2 aria-hidden="true" />
                            {{ t("agentPrincipalDetail.configure") }}
                        </Button>
                    </div>
                </li>
            </ul>
        </section>

        <AgentPrincipalDetailDrawer
            v-model:open="detailOpen"
            :principal="detailPrincipal"
            :workspace-id="null"
            show-danger
            @changed="onDetailChanged"
        />
    </div>
</template>
