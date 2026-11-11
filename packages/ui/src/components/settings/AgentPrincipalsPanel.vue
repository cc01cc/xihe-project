<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Bot, Link2, Plus, RefreshCw } from "@lucide/vue";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "../ui/empty";
import { Input } from "../ui/input";
import Dialog from "../ui/dialog/Dialog.vue";
import DialogContent from "../ui/dialog/DialogContent.vue";
import DialogHeader from "../ui/dialog/DialogHeader.vue";
import DialogTitle from "../ui/dialog/DialogTitle.vue";
import DialogDescription from "../ui/dialog/DialogDescription.vue";
import DialogFooter from "../ui/dialog/DialogFooter.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { api, type AgentPrincipalSummary, type ApiWorkspace } from "../../composables/api";
import { problemDetailText } from "../../lib/errorMessages";
import { principalNameError } from "../../lib/principalName";
import SettingsPermissionGate from "./SettingsPermissionGate.vue";

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
 *   <li><b>绑定</b>——卡片上的显式动作（T3.2）。绑定是**工作区侧**的管理能力：
 *       只列出发起人真的持 `MANAGE_WORKSPACE_AGENTS` 的工作区；一个都没有时给
 *       **显式提示**（`agent-principals-bind-denied`），而不是渲染一个点了才 403 的按钮。</li>
 * </ul>
 */

const { t } = useI18n();

const agents = ref<AgentPrincipalSummary[]>([]);
const loading = ref(true);
const loadError = ref("");

/** `null` = 能力投影还没回来（按钮禁用但**不谎报**无权限）。 */
const capabilityState = ref<"loading" | "ready" | "failed">("loading");
const instanceAtoms = ref<string[]>([]);
/** principalId → 已绑定的工作区显示名（只含发起人有权管理的工作区）。 */
const bindings = ref<Record<string, string[]>>({});

const workspaces = ref<ApiWorkspace[]>([]);
/** workspaceId → 该工作区里发起人持有的原子名。 */
const workspaceAtoms = ref<Record<string, string[]>>({});

const canCreateOwnAgent = computed<boolean | null>(() => {
    if (capabilityState.value === "loading") return null;
    return instanceAtoms.value.includes("CREATE_OWN_AGENT");
});

/**
 * CP 的 `holdsActionAtom(atom, workspaceId)` 求值是「实例行 ∪ 该工作区的行」，
 * 所以实例级持有 `MANAGE_WORKSPACE_AGENTS` 的人在每个工作区都能管理；工作区级
 * 只对它自己那一个生效。这里照抄同一个判定，不引入第二套规则。
 */
function canManageAgentsIn(workspaceId: string): boolean {
    if (instanceAtoms.value.includes("MANAGE_WORKSPACE_AGENTS")) return true;
    return (workspaceAtoms.value[workspaceId] ?? []).includes("MANAGE_WORKSPACE_AGENTS");
}

const manageableWorkspaces = computed(() =>
    workspaces.value.filter((workspace) => canManageAgentsIn(workspace.id)),
);

const canBind = computed<boolean | null>(() => {
    if (capabilityState.value === "loading") return null;
    return manageableWorkspaces.value.length > 0;
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
        formError.value = problemDetailText(e, t("agentPrincipals.createFailed"));
    } finally {
        saving.value = false;
    }
}

// ---- list ------------------------------------------------------------------
function formatDate(value: string): string {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString();
}

async function loadAgents() {
    loading.value = true;
    loadError.value = "";
    try {
        agents.value = await api.listMyAgentPrincipals();
    } catch (e) {
        loadError.value = problemDetailText(e, t("agentPrincipals.loadFailed"));
    } finally {
        loading.value = false;
    }
}

/**
 * 能力投影 + 工作区清单 + 已有绑定。
 *
 * <p>三个来源各有分工：`GET /me/permissions` 给**原子**（授权判据，不是角色名），
 * `GET /workspaces` 给人读的名字，`GET /workspaces/{id}/agents` 给「这个主体已经属于
 * 哪些工作区」。绑定列表是**尽力而为**的：某个工作区读失败不该让整页变成错误页，
 * 只是那一片不显示"已绑定"。</p>
 */
async function loadCapability() {
    capabilityState.value = "loading";
    try {
        const self = await api.getSelfPermissions();
        instanceAtoms.value = (self.instancePermissions ?? []).map((atom) => atom.actionClass);
        const atomsByWorkspace: Record<string, string[]> = {};
        for (const workspace of self.workspaces ?? []) {
            atomsByWorkspace[workspace.workspaceId] = (workspace.permissions ?? []).map(
                (atom) => atom.actionClass,
            );
        }
        workspaceAtoms.value = atomsByWorkspace;
        capabilityState.value = "ready";
    } catch {
        // fail-closed：原子读不到 ⇒ 不显示创建/绑定入口，但也不断言"你没权限"。
        capabilityState.value = "failed";
        return;
    }

    try {
        workspaces.value = await api.listWorkspaces();
    } catch {
        workspaces.value = [];
    }
    await loadBindings();
}

async function loadBindings() {
    const next: Record<string, string[]> = {};
    await Promise.all(
        manageableWorkspaces.value.map(async (workspace) => {
            try {
                const rows = await api.getWorkspaceAgents(workspace.id);
                for (const row of rows) {
                    const names = next[row.principalId] ?? [];
                    names.push(workspace.name || workspace.id);
                    next[row.principalId] = names;
                }
            } catch {
                // 单工作区不可读不影响其它片；不把"读不到"显示成"未绑定"以外的结论。
            }
        }),
    );
    bindings.value = next;
}

// ---- bind (T3.2) -----------------------------------------------------------
const bindTarget = ref<AgentPrincipalSummary | null>(null);
const bindWorkspaceId = ref("");
const binding = ref(false);
const bindError = ref("");

function openBind(agent: AgentPrincipalSummary) {
    bindTarget.value = agent;
    // 预选第一个可管理工作区：大多数账号只有一个，预选省一次点击；多工作区时仍可改。
    bindWorkspaceId.value = manageableWorkspaces.value[0]?.id ?? "";
    bindError.value = "";
}

function closeBind() {
    bindTarget.value = null;
    bindError.value = "";
}

const bindBlocked = computed(
    () => !bindWorkspaceId.value || binding.value || canBind.value !== true,
);

async function submitBind() {
    if (bindBlocked.value || !bindTarget.value) return;
    const target = bindTarget.value;
    const workspaceId = bindWorkspaceId.value;
    binding.value = true;
    bindError.value = "";
    try {
        // 空 cap = 绑定但不授予任何工具权限（CP 仍按工作区原子判权；提权在工作区设置里做）。
        await api.updateWorkspaceAgentCap(workspaceId, target.principalId, []);
        const workspaceName =
            workspaces.value.find((workspace) => workspace.id === workspaceId)?.name || workspaceId;
        toast.success(t("agentPrincipals.bindSuccess", { workspace: workspaceName }));
        const names = bindings.value[target.principalId] ?? [];
        if (!names.includes(workspaceName)) names.push(workspaceName);
        bindings.value = { ...bindings.value, [target.principalId]: names };
        bindTarget.value = null;
    } catch (e) {
        bindError.value = problemDetailText(e, t("agentPrincipals.bindFailed"));
    } finally {
        binding.value = false;
    }
}

function boundLabel(principalId: string): string {
    const names = bindings.value[principalId] ?? [];
    if (names.length === 0) return t("agentPrincipals.unbound");
    return t("agentPrincipals.boundTo", { workspaces: names.join(" / ") });
}

async function refresh() {
    await Promise.all([loadAgents(), loadCapability()]);
}

onMounted(refresh);
</script>

<template>
    <div data-testid="agent-principals-panel">
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
                <p class="mb-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
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
                class="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive"
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
            class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
            {{ loadError }}
        </div>

        <!-- 绑定权限：一个可管理工作区都没有时**显式说明**，不渲染点了才 403 的按钮。 -->
        <p
            v-if="canBind === false"
            data-testid="agent-principals-bind-denied"
            class="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
        >
            {{ t("agentPrincipals.bindNoPermission") }}
        </p>

        <section class="min-w-0 rounded-lg border border-border bg-card">
            <div class="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 class="text-sm font-medium" data-testid="agent-principals-list-heading">
                    {{ t("agentPrincipals.heading") }}
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
                        <p
                            class="mt-1 text-xs text-muted-foreground"
                            :data-testid="`agent-principals-bound-${agent.principalId}`"
                        >
                            {{ boundLabel(agent.principalId) }}
                        </p>
                    </div>
                    <Button
                        v-if="canBind === true"
                        type="button"
                        variant="outline"
                        size="sm"
                        class="shrink-0"
                        :data-testid="`agent-principals-bind-${agent.principalId}`"
                        @click="openBind(agent)"
                    >
                        <Link2 aria-hidden="true" />
                        {{ t("agentPrincipals.bind") }}
                    </Button>
                </li>
            </ul>
        </section>

        <Dialog
            :open="bindTarget !== null"
            @update:open="(value: boolean) => !value && closeBind()"
        >
            <DialogContent data-testid="agent-principals-bind-dialog" class="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {{ t("agentPrincipals.bindTitle", { name: bindTarget?.name ?? "" }) }}
                    </DialogTitle>
                    <DialogDescription>{{ t("agentPrincipals.bindDesc") }}</DialogDescription>
                </DialogHeader>
                <div class="space-y-3">
                    <div class="space-y-1.5">
                        <label class="text-sm font-medium" for="agent-principals-bind-workspace">{{
                            t("agentPrincipals.bindWorkspace")
                        }}</label>
                        <Select
                            :model-value="bindWorkspaceId"
                            @update:model-value="(value) => (bindWorkspaceId = String(value))"
                        >
                            <SelectTrigger
                                id="agent-principals-bind-workspace"
                                data-testid="agent-principals-bind-select"
                                class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                            >
                                <SelectValue :placeholder="t('agentPrincipals.bindWorkspace')" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    v-for="workspace in manageableWorkspaces"
                                    :key="workspace.id"
                                    :value="workspace.id"
                                >
                                    {{ workspace.name || workspace.id }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <p
                        v-if="bindError"
                        data-testid="agent-principals-bind-error"
                        class="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive"
                    >
                        {{ bindError }}
                    </p>
                </div>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="agent-principals-bind-cancel"
                        @click="closeBind"
                    >
                        {{ t("agentPrincipals.close") }}
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        data-testid="agent-principals-bind-submit"
                        :disabled="bindBlocked"
                        @click="submitBind"
                    >
                        {{
                            binding ? t("agentPrincipals.binding") : t("agentPrincipals.bindSubmit")
                        }}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </div>
</template>
