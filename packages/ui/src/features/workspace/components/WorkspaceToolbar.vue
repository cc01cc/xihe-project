<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import { useAuthStore } from "../../../stores/auth";
import {
    Activity,
    Bot,
    Code,
    FileDiff,
    FolderOpen,
    FolderTree,
    GitBranch,
    MoreHorizontal,
    PanelLeft,
    Plus,
    Users,
} from "@lucide/vue";
import {
    workspacePath,
    workspaceScheduledTasksPath,
    workspaceSettingsPath,
} from "../../../lib/routes";

/**
 * PLAN-0582 S3a (review P1-1): this row keeps only controls that belong here —
 * the dock toggles and the workspace-level dialog entries. Page tabs moved to
 * `WorkspaceTabBar`, file actions moved to the file-tree panel head, and the
 * workspace name is no longer repeated here (P1-2).
 */
const props = defineProps<{
    workspaceId: string;
    agentPrincipalId?: string | null;
    codeOpen?: boolean;
    changesOpen?: boolean;
    monitorOpen?: boolean;
    membersOpen?: boolean;
    /**
     * BL-317 / D-198：移动端成员入口的未读提及数（**服务端派生**：`readCursor.mentionCount`
     * 只求和，不累加、不持久化）。`0`/缺省 = 不显示徽标。
     */
    membersUnread?: number;
    /** PLAN-0659 T1.4：委派 DAG 面板是否处于当前 dock tab。 */
    delegationOpen?: boolean;
}>();

const emit = defineEmits<{
    importSource: [];
    agents: [];
    addWorkspace: [];
    files: [];
    toggleCode: [];
    toggleChanges: [];
    toggleMonitor: [];
    toggleMembers: [];
    toggleDelegation: [];
}>();

const { t } = useI18n();
const router = useRouter(),
    ws = useWorkspaceStore(),
    auth = useAuthStore();

/** 徽标只做"呈现上限"处理（`@9+`），数值本身来自 props（服务端派生，前端不累加）。 */
const membersBadgeCount = computed(() => {
    const value = props.membersUnread ?? 0;
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
});

const breadcrumb = computed(() => {
    const active = ws.activeFilePath;
    if (!active) return [] as Array<{ label: string; path: string; isLast: boolean }>;
    return active.split("/").map((part, i, arr) => ({
        label: part,
        path: arr.slice(0, i + 1).join("/"),
        isLast: i === arr.length - 1,
    }));
});

function openEnvironment() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    if (id) router.push(`/workspace/${id}/environment`);
}

function openScheduledTasks() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    if (id) router.push(workspaceScheduledTasksPath(id));
}

function openSettings() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    if (id) router.push(workspaceSettingsPath(id));
}

// PLAN-0560 T3.7：移动端工具条收敛为 ＋ 新建对话 + ⋯ 溢出菜单。
const overflowOpen = ref(false);

function newChat() {
    const id = props.workspaceId || auth.currentWorkspaceId;
    overflowOpen.value = false;
    if (id) router.push({ path: workspacePath(id), query: { newChat: "1" } });
}

function overflowNav(navigate: () => void) {
    overflowOpen.value = false;
    navigate();
}
</script>

<template>
    <div class="flex items-center gap-2 px-3 h-10 border-b shrink-0 bg-background/80">
        <button
            class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors md:hidden"
            :title="t('files.titleFiles')"
            :aria-label="t('common.files')"
            data-testid="workspace-toolbar-files-mobile"
            @click="emit('files')"
        >
            <PanelLeft class="size-3.5" />
        </button>
        <button
            type="button"
            data-testid="workspace-toolbar-new-chat-mobile"
            class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors md:hidden"
            :title="t('sidebar.newChat')"
            :aria-label="t('sidebar.newChat')"
            @click="newChat"
        >
            <Plus class="size-3.5" />
        </button>
        <div class="relative md:hidden">
            <button
                type="button"
                data-testid="workspace-toolbar-more-mobile"
                class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
                :title="t('workspace.toolbarMore')"
                :aria-label="t('workspace.toolbarMore')"
                :aria-expanded="overflowOpen"
                @click="overflowOpen = !overflowOpen"
            >
                <MoreHorizontal class="size-3.5" />
            </button>
            <!--
                BL-317（390×844 实测）：菜单原先是 `right-0`，但触发按钮在工具条**左侧**簇里，
                菜单（154px 宽）在 390 下会跑到 x=-61（左侧被裁掉，且页面不产生横向滚动 ⇒
                菜单项点不到）—— 改锚到 `left-0` 后落在 68..222，完整可见。
                只影响移动端（外层是 `md:hidden`），桌面零变化。
            -->
            <div
                v-if="overflowOpen"
                class="absolute left-0 top-full mt-1 z-50 w-44 rounded-md border bg-popover p-1 shadow-md text-sm"
                data-testid="workspace-toolbar-more-menu"
            >
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-agents"
                    @click="overflowNav(() => emit('agents'))"
                >
                    {{ t("workspace.agentManagement") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-changes"
                    @click="overflowNav(() => emit('toggleChanges'))"
                >
                    {{ t("workspace.panelChanges") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent max-md:min-h-[44px]"
                    data-testid="workspace-toolbar-more-monitor"
                    @click="overflowNav(() => emit('toggleMonitor'))"
                >
                    {{ t("workspace.panelMonitor") }}
                </button>
                <!--
                    BL-317 / D-198：移动端成员面板入口。桌面那条 `workspace-toolbar-members`
                    在 `max-md` 下是 hidden（桌面 action cluster），所以移动端必须从这个溢出菜单进；
                    徽标只呈现**服务端**未读数（求和自 store 的 `readCursor.mentionCount`），
                    上限 `@9+`，并带 `aria-label`（不能只靠视觉）。
                -->
                <button
                    type="button"
                    class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-accent max-md:min-h-[44px]"
                    data-testid="workspace-toolbar-more-members"
                    :aria-label="
                        membersBadgeCount > 0
                            ? `${t('workspace.panelMembers')} · ${t('workspace.participantMentionBadge', { count: membersBadgeCount })}`
                            : t('workspace.panelMembers')
                    "
                    @click="overflowNav(() => emit('toggleMembers'))"
                >
                    <span>{{ t("workspace.panelMembers") }}</span>
                    <span
                        v-if="membersBadgeCount > 0"
                        class="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground"
                        data-testid="workspace-toolbar-more-members-badge"
                        aria-hidden="true"
                        >@{{ membersBadgeCount > 9 ? "9+" : membersBadgeCount }}</span
                    >
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-delegation"
                    @click="overflowNav(() => emit('toggleDelegation'))"
                >
                    {{ t("workspace.panelDelegation") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-environment"
                    @click="overflowNav(openEnvironment)"
                >
                    {{ t("workspace.environmentState") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-scheduled"
                    @click="overflowNav(openScheduledTasks)"
                >
                    {{ t("workspace.scheduledTasks.nav") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-settings"
                    @click="overflowNav(openSettings)"
                >
                    {{ t("workspace.settingsTitle") }}
                </button>
                <button
                    type="button"
                    class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                    data-testid="workspace-toolbar-more-add-workspace"
                    @click="overflowNav(() => emit('addWorkspace'))"
                >
                    {{ t("workspace.addWorkspace") }}
                </button>
            </div>
        </div>
        <div
            class="flex min-w-0 items-center gap-1 pr-12 text-xs text-muted-foreground flex-1"
            :title="props.workspaceId"
        >
            <FolderTree class="size-3.5" />
            <template v-if="breadcrumb.length > 0">
                <span v-for="(part, i) in breadcrumb" :key="i" class="flex items-center gap-1">
                    <span v-if="i > 0" class="text-muted-foreground/50">/</span>
                    <span
                        class="hover:text-foreground cursor-pointer"
                        :class="{ 'text-foreground font-medium': part.isLast }"
                    >
                        {{ part.label }}
                    </span>
                </span>
            </template>
            <span v-else class="truncate text-muted-foreground/70">{{
                t("workspace.noActiveFile")
            }}</span>
            <span
                v-if="agentPrincipalId"
                data-testid="workspace-active-agent"
                class="max-w-24 shrink-0 truncate rounded border px-1 py-0.5 text-[10px] text-muted-foreground"
                :title="`${t('workspace.activeAgent')}: ${agentPrincipalId}`"
                :aria-label="`${t('workspace.activeAgent')}: ${agentPrincipalId}`"
            >
                {{ t("workspace.activeAgent") }} · {{ agentPrincipalId.slice(0, 8) }}
            </span>
        </div>

        <div class="flex items-center gap-1 max-md:hidden">
            <button
                type="button"
                data-testid="workspace-toolbar-code"
                class="p-1.5 rounded transition-colors"
                :class="
                    codeOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleCode')"
                :aria-label="t('workspace.toggleCode')"
                :aria-pressed="codeOpen === true"
                @click="emit('toggleCode')"
            >
                <Code class="size-3.5" />
            </button>
            <button
                type="button"
                data-testid="workspace-toolbar-changes"
                class="p-1.5 rounded transition-colors"
                :class="
                    changesOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleDiff')"
                :aria-label="t('workspace.toggleDiff')"
                :aria-pressed="changesOpen === true"
                @click="emit('toggleChanges')"
            >
                <FileDiff class="size-3.5" />
            </button>
            <button
                type="button"
                data-testid="workspace-toolbar-monitor"
                class="p-1.5 rounded transition-colors"
                :class="
                    monitorOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleMonitor')"
                :aria-label="t('workspace.toggleMonitor')"
                :aria-pressed="monitorOpen === true"
                @click="emit('toggleMonitor')"
            >
                <Activity class="size-3.5" />
            </button>
            <!-- PLAN-0623 U1：参与者面板入口（与 monitor 同构；移动端由 dock 溢出菜单进入）。 -->
            <button
                type="button"
                data-testid="workspace-toolbar-members"
                class="p-1.5 rounded transition-colors"
                :class="
                    membersOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleMembers')"
                :aria-label="t('workspace.toggleMembers')"
                :aria-pressed="membersOpen === true"
                @click="emit('toggleMembers')"
            >
                <Users class="size-3.5" />
            </button>
            <!-- PLAN-0659 T1.4：委派 DAG 面板入口（与 monitor/members 同构）。 -->
            <button
                type="button"
                data-testid="workspace-toolbar-delegation"
                class="p-1.5 rounded transition-colors"
                :class="
                    delegationOpen
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                "
                :title="t('workspace.toggleDelegation')"
                :aria-label="t('workspace.toggleDelegation')"
                :aria-pressed="delegationOpen === true"
                @click="emit('toggleDelegation')"
            >
                <GitBranch class="size-3.5" />
            </button>
            <button
                type="button"
                data-testid="workspace-toolbar-agents"
                class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
                :title="t('workspace.agentManagement')"
                @click="emit('agents')"
            >
                <Bot class="size-3.5" aria-hidden="true" />
                {{ t("workspace.agentManagement") }}
            </button>
            <button
                data-testid="workspace-toolbar-add"
                class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
                :title="t('workspace.addWorkspace')"
                :aria-label="t('workspace.addWorkspace')"
                @click="emit('addWorkspace')"
            >
                <Plus class="size-3.5" />
            </button>
            <button
                data-testid="workspace-toolbar-import-source"
                class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
                :title="t('workspace.importSource')"
                :aria-label="t('workspace.importSource')"
                @click="emit('importSource')"
            >
                <FolderOpen class="size-3.5" />
            </button>
        </div>
    </div>
</template>
