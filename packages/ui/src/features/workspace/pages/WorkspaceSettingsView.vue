<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { LoaderCircle } from "@lucide/vue";
import { useAuthStore } from "../../../stores/auth";
import { useSessionStore } from "../../../stores/session";
import { api, ApiError } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { clearTabWorkspace, writeTabWorkspace } from "../../../lib/workspaceContext";
import { workspacePath } from "../../../lib/routes";
import WorkspaceConfigPanel from "../components/WorkspaceConfigPanel.vue";
import { resourcePath } from "../../../lib/settingsIa";
import Input from "../../../components/ui/input/Input.vue";
import { Button } from "../../../components/ui/button";
import AlertDialog from "../../../components/ui/alert-dialog/AlertDialog.vue";
import AlertDialogContent from "../../../components/ui/alert-dialog/AlertDialogContent.vue";
import AlertDialogHeader from "../../../components/ui/alert-dialog/AlertDialogHeader.vue";
import AlertDialogTitle from "../../../components/ui/alert-dialog/AlertDialogTitle.vue";
import AlertDialogDescription from "../../../components/ui/alert-dialog/AlertDialogDescription.vue";
import AlertDialogFooter from "../../../components/ui/alert-dialog/AlertDialogFooter.vue";
import AlertDialogCancel from "../../../components/ui/alert-dialog/AlertDialogCancel.vue";

// PLAN-0560：每工作区设置页（常规/成员）。
// PLAN-0565：「成员」tab（裁定 #2——EDITOR 只读可见、VIEWER 不渲染）。
//
// task-253（用户 2026-11-10 裁定）：**移除「配置」tab 与域段路由**
// （/workspace/:id/settings/:domain）。全局 config 的 workspace 层已在 UI 侧失效（契约侧由
// task-250 只标 deprecated），工作区内部设置面本轮不重新设计 ⇒ 这里只保留不依赖该层的 tab。
// 删除理由不是「看起来多余」：留着它就会继续 PUT/GET /config/workspace/**，而这层已废弃。
//
// D-1019 / task-209（用户 2026-11-12 裁定「一次性改完、不留旧兼容」）：**再撤掉 `mcp` /
// `credentials` / `knowledge` 三个 tab**。它们与 `/resources/{mcp,credentials}?layer=WORKSPACE`
// 渲染的是**同一个组件**（`WorkspaceMcpPanel` / `CredentialsPanel ownerType=WORKSPACE`，
// 见 PLAN-0772 M2 的资源区搬家）⇒ 留着就是两份入口，且文案与权限各自漂移。
//
// 旧 `?tab=` 的处置：**回落到「常规」并就地告知迁移地址**（不是 404）。理由：①与 task-253
// 的 `?tab=config` 同口径，那条回落行为已被 `e2e/mock/config-settings.spec.ts:194-195` 与
// `e2e/real/approval-policy.spec.ts:128` 当作既有契约在用；②旧链接来自书签/文档/外部引用，
// 回落到一个能解释「东西搬到哪了」的页面比 404 更有用（404 只能让人以为页面坏了）。
// task-236（M4-3）：「成员」已提升为一级页 /workspace/:id/members —— 本页只剩
// 配置 / 常规两个 tab；旧 ?tab=members 深链**重定向**到新页（见下方 watch），不回落不 404。
type SettingsTab = "config" | "general";

/**
 * 已迁到资源区的三个旧 tab。`knowledge` 在资源区是 **G3 缺口页**（CP 无库实体，见
 * `KnowledgeResourceView.vue` 的说明）⇒ 这里只负责"指路"，不承诺新页面有写面。
 */
type LegacyResourceTab = "mcp" | "credentials" | "knowledge";

function legacyResourceTab(q: unknown): LegacyResourceTab | null {
    return q === "mcp" || q === "credentials" || q === "knowledge" ? q : null;
}

const route = useRoute(),
    router = useRouter(),
    auth = useAuthStore(),
    sessionStore = useSessionStore(),
    { t } = useI18n();

const workspaceId = computed(() => String(route.params.workspaceId ?? "").trim());

/** `?tab=` 的唯一解析口径（读与写都走它，避免两处各写一份白名单）。 */
function tabFromQuery(q: unknown): SettingsTab {
    return q === "config" ? "config" : "general";
}
const activeTab = ref<SettingsTab>(tabFromQuery(route.query.tab));

/** 旧资源 tab（若有）：驱动「已迁到资源区」的提示条，并在切页签时自然离开 URL。 */
const legacyTab = ref<LegacyResourceTab | null>(legacyResourceTab(route.query.tab));

function legacyResourceName(tab: LegacyResourceTab | null): string {
    switch (tab) {
        case "mcp":
            return t("settings.ia.resourceMcp");
        case "credentials":
            return t("settings.ia.resourceCredentials");
        case "knowledge":
            return t("settings.ia.resourceKnowledge");
        default:
            return "";
    }
}

const legacyResourceLink = computed(() => {
    switch (legacyTab.value) {
        case "mcp":
            return `${resourcePath("mcp")}?layer=WORKSPACE`;
        case "credentials":
            return `${resourcePath("credentials")}?layer=WORKSPACE`;
        case "knowledge":
            return `${resourcePath("knowledge")}?layer=WORKSPACE`;
        default:
            return "";
    }
});

// 外部 query 变化要能回到页面状态（深链、浏览器前进/后退、别人贴过来的链接）。
watch(
    () => route.query.tab,
    (q) => {
        // task-236（M4-3）：成员是**一级页**了 —— 旧 ?tab=members 深链直接 replace 过去
        // （单入口：设置页不再留成员 tab；内容同一组件，PLAN-0626 深链契约 = 链接仍可用）。
        if (q === "members") {
            if (workspaceId.value) {
                void router.replace({
                    name: "workspace-members",
                    params: { workspaceId: workspaceId.value },
                });
            }
            return;
        }
        legacyTab.value = legacyResourceTab(q);
        const next = tabFromQuery(q);
        if (next !== activeTab.value) activeTab.value = next;
    },
    { immediate: true },
);

// task-253：域段模式（/workspace/:id/settings/:domain）随工作区配置层一起移除 ——
// 该模式下唯一的域内页签「工具分类」也就没有宿主了（G9/task-153 的工作区入口在本轮消失，
// 已作为「产品面减少」报 Lead 裁定；ToolFacesView 本身与实例层入口不受影响）。
const tabs = computed<{ key: SettingsTab; label: string }[]>(() => {
    const base: { key: SettingsTab; label: string }[] = [
        // PLAN-0773 M4-1（task-190）：配置 tab 回来了 —— 但这次是**按工作区**的层
        // （`ConfigLayer` 新增 `workspace`），不是 task-253 退役的那层废弃全局入口。
        // 域清单不在这里：面板只渲染 `layer="workspace"`，域集由 `LAYER_DOMAINS` 交给它。
        { key: "config", label: t("workspace.settingsTabConfig") },
        { key: "general", label: t("workspace.settingsTabGeneral") },
    ];
    return base;
});

// task-236（M4-3）：成员 tab 已撤（提升为一级页）—— VIEWER 深链 ?tab=members 由上方
// watch 直接重定向到成员页；成员页自己按 canViewMembers 三态决定是否渲染面板
// （BL-344 语义移入 WorkspaceMembersView.vue，本页不再承载）。

const loadError = ref(""),
    loading = ref(false);

function switchTab(tab: SettingsTab) {
    if (activeTab.value === tab) return;
    activeTab.value = tab;
    // PLAN-0772 M2（design.md 决策 9）：页签切换**写回 URL**。改前全仓 6 处读 `?tab=`、只有 2 处写，
    // 本组件一个都不写 ⇒ 「切到 MCP 后复制链接」打开的是常规页（典型的"看着像有深链其实没有"）。
    // `general` 是默认页签，落 URL 时省略它（否则同一页有两个地址）。
    const { tab: _ignored, ...rest } = route.query;
    void router.push({ query: tab === "general" ? rest : { ...rest, tab } });
}

// T3.7 头部动作组：新建对话复用 ?newChat=1 语义（Sidebar.startNewChat 同口径）。
function newChat() {
    if (!workspaceId.value) return;
    void router.push({ path: workspacePath(workspaceId.value), query: { newChat: "1" } });
}

function goEnvironment() {
    if (!workspaceId.value) return;
    void router.push({
        name: "workspace-environment",
        params: { workspaceId: workspaceId.value },
    });
}

function goBackToWorkspace() {
    if (!workspaceId.value) return;
    void router.push(workspacePath(workspaceId.value));
}

async function loadWorkspace() {
    if (!workspaceId.value) {
        await router.replace({ name: "workspace-home" });
        return;
    }
    loading.value = true;
    loadError.value = "";
    try {
        await auth.selectWorkspace(workspaceId.value);
    } catch (cause) {
        const code = cause instanceof ApiError ? cause.problem.code : "";
        if (code === "WORKSPACE_FORBIDDEN" || code === "WORKSPACE_NOT_FOUND") {
            await router.replace({ name: "workspace-home" });
            return;
        }
        const message = cause instanceof Error ? cause.message : t("workspace.settingsLoadFailed");
        logger.error("Load workspace failed", cause);
        loadError.value = message;
        toast.error(message);
        return;
    } finally {
        loading.value = false;
    }
}

async function retryLoad() {
    await loadWorkspace();
}

// T2.6 常规编辑（OWNER）
const editName = ref(""),
    editDescription = ref(""),
    saving = ref(false),
    editError = ref("");

function startEdit() {
    editName.value = auth.workspace?.name ?? "";
    editDescription.value = auth.workspace?.description ?? "";
    editError.value = "";
}

async function handleSave() {
    const ws = auth.workspace;
    if (!ws || saving.value) return;
    saving.value = true;
    editError.value = "";
    try {
        const updated = await api.updateWorkspace(ws.id, {
            name: editName.value.trim() || undefined,
            description: editDescription.value.trim(),
        });
        auth.workspace = updated;
        writeTabWorkspace(updated);
        toast.success(t("workspace.settingsUpdated"));
    } catch (cause) {
        const message =
            cause instanceof ApiError ? cause.message : t("workspace.settingsSaveFailed");
        logger.error("Update workspace failed", cause);
        editError.value = message;
        toast.error(message);
    } finally {
        saving.value = false;
    }
}

// T2.6 删除（OWNER）：逻辑删除 + 名称确认，成功后回 workspace-home。
const confirmDeleteOpen = ref(false),
    deleteConfirmName = ref(""),
    deleting = ref(false),
    deleteError = ref("");

async function handleDelete() {
    const ws = auth.workspace;
    if (!ws || deleting.value) return;
    if (deleteConfirmName.value.trim() !== (ws.name ?? "")) {
        deleteError.value = t("workspace.settingsDeleteNameMismatch");
        return;
    }
    deleting.value = true;
    deleteError.value = "";
    try {
        await api.deleteWorkspace(ws.id);
        auth.workspace = null;
        clearTabWorkspace();
        confirmDeleteOpen.value = false;
        toast.success(t("workspace.settingsDeleted", { name: ws.name }));
        sessionStore.resetForUserSwitch();
        await router.replace({ name: "workspace-home" });
    } catch (cause) {
        const message =
            cause instanceof ApiError ? cause.message : t("workspace.settingsDeleteFailed");
        logger.error("Delete workspace failed", cause);
        deleteError.value = message;
        toast.error(message);
    } finally {
        deleting.value = false;
    }
}

/**
 * task-341 ①：**先取工作区，再初始化编辑态** —— 顺序是承重的，不是风格问题。
 *
 * <p>旧写法 `onMounted(() => { startEdit(); void loadWorkspace(); })` 让 `startEdit()` 先跑且不等加载：
 * `editDescription` 的初值取 `auth.workspace?.description ?? ""`（`:206-210`），而此刻 store 里的
 * workspace 可能只有 `{ id }`（深链/刷新、或 `migrateLegacyWorkspace` 迁出来的 `{ id, name }`）
 * ⇒ 输入框停在空串，且`startEdit` 之后没有任何 watch 重新初始化。`handleSave()` 又**无条件**发送
 * `description`（`name` 有 `|| undefined` 兜底，`description` 没有）⇒ 只改名字点保存就把既有描述清空。
 * 实测读数见 `e2e/mock/task63-wire-field-behavior.spec.ts` 与 `task-63`。</p>
 *
 * <p>为什么不是「保存时判断值有没有变」：那是给症状打补丁 —— 初值错的地方还留着，下一个读
 * `editName`/`editDescription` 的字段（或在别处复用 `startEdit`）会再踩一次。顺序修正只有一处。</p>
 */
onMounted(async () => {
    await loadWorkspace();
    startEdit();
});
</script>

<template>
    <section class="min-h-full" data-testid="workspace-settings-page">
        <!-- task-253：工作区设置不再是「设置区的一层」（全局设置只有实例/用户两层），
             所以不再复用 SettingsLayerHeader 的「设置 › 工作区层」面包屑，页面自带标题头。
             工作区配置 tab 与域段路由同时移除 —— 那块面走的是已废弃的 /config/workspace/**。 -->
        <header
            data-testid="workspace-settings-header"
            class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur"
        >
            <div class="mx-auto w-full max-w-6xl px-6 pt-4 pb-3">
                <h1
                    data-testid="workspace-settings-title"
                    class="text-2xl leading-tight font-semibold tracking-tight"
                >
                    {{ t("workspace.settingsTitle") }}
                </h1>
                <p class="mt-1 max-w-3xl text-sm text-muted-foreground">
                    {{ t("workspace.settingsDesc") }}
                </p>
            </div>
        </header>
        <div>
            <div class="mx-auto w-full max-w-6xl px-6 py-6">
                <div
                    class="flex flex-wrap items-center gap-2 mb-4"
                    data-testid="ws-settings-actions"
                >
                    <Button size="sm" data-testid="ws-settings-new-chat" @click="newChat">
                        {{ t("sidebar.newChat") }}
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        data-testid="ws-settings-environment"
                        @click="goEnvironment"
                    >
                        {{ t("workspace.settingsGoEnvironment") }}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        data-testid="ws-settings-back"
                        @click="goBackToWorkspace"
                    >
                        {{ t("workspace.settingsBack") }}
                    </Button>
                </div>

                <div
                    v-if="loadError"
                    class="mb-3 flex flex-wrap items-center gap-2 px-3 py-2 text-sm bg-red-100 text-red-800 rounded"
                    data-testid="workspace-settings-error"
                >
                    <span>{{ t("common.error") }}: {{ loadError }}</span>
                    <Button
                        variant="outline"
                        size="sm"
                        data-testid="ws-settings-retry"
                        :disabled="loading"
                        @click="() => void retryLoad()"
                    >
                        <LoaderCircle
                            v-if="loading"
                            class="mr-1 inline-block size-3 animate-spin"
                        />
                        {{ t("workspace.settingsRetry") }}
                    </Button>
                </div>

                <template v-else>
                    <div class="flex gap-1 border-b mb-4">
                        <button
                            v-for="tab in tabs"
                            :key="tab.key"
                            :data-testid="`ws-settings-tab-${tab.key}`"
                            class="px-4 py-2 text-sm border-b-2 transition-colors"
                            :class="
                                activeTab === tab.key
                                    ? 'border-primary text-foreground font-medium'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            "
                            @click="switchTab(tab.key)"
                        >
                            {{ tab.label }}
                        </button>
                    </div>

                    <!--
                        D-1019 / task-209：旧 `?tab=mcp|credentials|knowledge` 的落点。
                        不做 404、也不静默：回落到「常规」后就说明东西搬去哪了，并给一条能直接点过去
                        的链接（`/resources/<id>?layer=WORKSPACE`）。提示条纯静态，不额外发请求。
                    -->
                    <div
                        v-if="legacyTab"
                        data-testid="ws-settings-resource-moved"
                        class="mb-4 rounded-lg border bg-muted/40 px-4 py-3 text-sm"
                    >
                        <p class="font-medium">
                            {{ t("workspace.settingsResourceMovedTitle") }}
                        </p>
                        <p class="mt-1 text-muted-foreground">
                            {{
                                t("workspace.settingsResourceMovedBody", {
                                    name: legacyResourceName(legacyTab),
                                })
                            }}
                        </p>
                        <Button as-child variant="outline" size="sm" class="mt-2">
                            <RouterLink
                                :to="legacyResourceLink"
                                data-testid="ws-settings-resource-moved-action"
                            >
                                {{ t("workspace.settingsResourceMovedAction") }}
                            </RouterLink>
                        </Button>
                    </div>

                    <WorkspaceConfigPanel v-if="activeTab === 'config'" />

                    <div v-if="activeTab === 'general'" data-testid="ws-settings-general">
                        <div class="border rounded-lg mb-2 overflow-hidden">
                            <div class="px-4 py-3 text-sm font-medium bg-muted/30">
                                {{ t("workspace.settingsGeneralTitle") }}
                            </div>

                            <div
                                v-if="auth.canManageWorkspace"
                                class="px-4 py-3 space-y-3 text-sm"
                                data-testid="ws-settings-edit"
                            >
                                <div class="grid gap-2">
                                    <label class="text-sm font-medium" for="ws-settings-name-input">
                                        {{ t("workspace.settingsName") }}
                                    </label>
                                    <Input
                                        id="ws-settings-name-input"
                                        v-model="editName"
                                        maxlength="120"
                                        data-testid="ws-settings-name-input"
                                    />
                                </div>
                                <div class="grid gap-2">
                                    <label
                                        class="text-sm font-medium"
                                        for="ws-settings-description-input"
                                    >
                                        {{ t("workspace.settingsDescription") }}
                                    </label>
                                    <Input
                                        id="ws-settings-description-input"
                                        v-model="editDescription"
                                        maxlength="500"
                                        data-testid="ws-settings-description-input"
                                    />
                                </div>
                                <div class="grid gap-2 sm:grid-cols-2">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsId")
                                    }}</span>
                                    <span class="font-mono text-xs break-all">{{
                                        workspaceId
                                    }}</span>
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsStorageRef")
                                    }}</span>
                                    <span class="font-mono text-xs break-all">
                                        {{ auth.workspace?.storageRef || "—" }}
                                    </span>
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsExecutionMode")
                                    }}</span>
                                    <span class="flex items-center gap-2">
                                        {{ auth.workspace?.executionMode || "—" }}
                                        <RouterLink
                                            class="text-xs text-primary underline"
                                            :to="{
                                                name: 'workspace-environment',
                                                params: { workspaceId },
                                            }"
                                            data-testid="ws-settings-go-environment"
                                        >
                                            {{ t("workspace.settingsGoEnvironment") }}
                                        </RouterLink>
                                    </span>
                                </div>
                                <p v-if="editError" class="text-sm text-destructive">
                                    {{ editError }}
                                </p>
                                <div class="flex flex-wrap gap-2">
                                    <Button
                                        :disabled="saving"
                                        data-testid="ws-settings-save"
                                        @click="() => void handleSave()"
                                    >
                                        <LoaderCircle
                                            v-if="saving"
                                            class="mr-1 inline-block size-3 animate-spin"
                                        />
                                        {{ saving ? t("common.saving") : t("common.save") }}
                                    </Button>
                                    <Button
                                        variant="destructive"
                                        data-testid="ws-settings-delete"
                                        @click="confirmDeleteOpen = true"
                                    >
                                        {{ t("workspace.settingsDeleteTitle") }}
                                    </Button>
                                </div>
                            </div>

                            <div v-else class="px-4 py-3 space-y-2 text-sm">
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsName")
                                    }}</span>
                                    <span data-testid="ws-settings-name">{{
                                        auth.workspace?.name ?? "—"
                                    }}</span>
                                </div>
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsDescription")
                                    }}</span>
                                    <span>{{ auth.workspace?.description || "—" }}</span>
                                </div>
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsId")
                                    }}</span>
                                    <span class="font-mono text-xs break-all">{{
                                        workspaceId
                                    }}</span>
                                </div>
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsStorageRef")
                                    }}</span>
                                    <span class="font-mono text-xs break-all">{{
                                        auth.workspace?.storageRef || "—"
                                    }}</span>
                                </div>
                                <div class="flex justify-between gap-3">
                                    <span class="text-muted-foreground">{{
                                        t("workspace.settingsExecutionMode")
                                    }}</span>
                                    <span>{{ auth.workspace?.executionMode || "—" }}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </template>
            </div>
        </div>

        <AlertDialog :open="confirmDeleteOpen" @update:open="(v) => (confirmDeleteOpen = v)">
            <AlertDialogContent data-testid="workspace-delete-confirm">
                <AlertDialogHeader>
                    <AlertDialogTitle class="text-destructive">
                        {{ t("workspace.settingsDeleteConfirmTitle") }}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {{
                            t("workspace.settingsDeleteConfirmDesc", { name: auth.workspace?.name })
                        }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <div
                    class="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-6 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
                >
                    · {{ t("workspace.settingsDeleteImpactRuntime") }}<br />
                    · {{ t("workspace.settingsDeleteImpactStorage") }}<br />
                    · {{ t("workspace.settingsDeleteImpactSessions") }}
                </div>
                <div class="grid gap-2">
                    <label class="text-sm font-medium" for="ws-delete-confirm-input">
                        {{ t("workspace.settingsDeleteInputLabel") }}
                    </label>
                    <Input
                        id="ws-delete-confirm-input"
                        v-model="deleteConfirmName"
                        :placeholder="auth.workspace?.name ?? ''"
                        data-testid="ws-delete-confirm-input"
                    />
                    <p v-if="deleteError" class="text-sm text-destructive">{{ deleteError }}</p>
                </div>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <Button
                        variant="destructive"
                        :disabled="deleting"
                        data-testid="ws-delete-confirm-btn"
                        @click="() => void handleDelete()"
                    >
                        <LoaderCircle
                            v-if="deleting"
                            class="mr-1 inline-block size-3 animate-spin"
                        />
                        {{ t("workspace.settingsDeleteConfirmBtn") }}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </section>
</template>
