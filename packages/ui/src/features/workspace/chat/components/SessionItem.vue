<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { CircleAlert, MessageSquareText, MoreHorizontal } from "@lucide/vue";
import { useRouter } from "vue-router";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "../../../../components/ui/dropdown-menu";
import { workspaceSettingsPath } from "../../../../lib/routes";
import type { Session } from "../../../../types";
import type { DelegationUsageView } from "../../../../composables/api";

const props = withDefaults(
    defineProps<{
        session: Session;
        isActive: boolean;
        pendingCount?: number;
        forkBusy?: boolean;
        /** PLAN-0655 T1.5: a delegated child session (badge + budget chip). */
        delegated?: boolean;
        /** Read-only budget chip; null until the usage view for this session resolves. */
        delegationUsage?: DelegationUsageView | null;
        /** Rendered indented under its parent row. */
        indent?: boolean;
        /**
         * task-352：其它工作区分组里的会话只能「点进去」，不能就地改名/分叉/删除 ——
         * 这些写入走的是 `X-Workspace-Id` 里的 tab 上下文，就地改会打到当前工作区。
         */
        canMutate?: boolean;
    }>(),
    {
        pendingCount: 0,
        forkBusy: false,
        delegated: false,
        delegationUsage: null,
        indent: false,
        canMutate: true,
    },
);

const emit = defineEmits<{
    select: [id: string];
    rename: [id: string, title: string];
    delete: [id: string];
    fork: [id: string];
}>();

const { t } = useI18n();
const router = useRouter();

/** task-89 ③：行内动作「打开工作区设置」—— 会话属于工作区时才有对象（独立会话没有）。 */
function openWorkspaceSettings() {
    const workspaceId = props.session.workspaceId;
    if (!workspaceId) return;
    void router.push(workspaceSettingsPath(workspaceId));
}

const isRenaming = ref(false);
const renameValue = ref("");
const showContextMenu = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });

function handleClick() {
    emit("select", props.session.id);
}

function handleKeydown(event: KeyboardEvent) {
    if (isRenaming.value) return;
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleClick();
    }
}

function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    contextMenuPosition.value = { x: e.clientX, y: e.clientY };
    showContextMenu.value = true;
}

function startRename() {
    renameValue.value = props.session.title;
    isRenaming.value = true;
    showContextMenu.value = false;
}

function confirmRename() {
    if (renameValue.value.trim()) {
        emit("rename", props.session.id, renameValue.value.trim());
    }
    isRenaming.value = false;
}

function handleDelete() {
    showContextMenu.value = false;
    emit("delete", props.session.id);
}

function handleFork() {
    showContextMenu.value = false;
    emit("fork", props.session.id);
}

function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") confirmRename();
    if (e.key === "Escape") isRenaming.value = false;
}
</script>

<template>
    <div
        data-testid="session-item"
        class="group relative flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors"
        :class="[
            isActive
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent/50 text-sidebar-foreground',
        ]"
        :style="indent ? { paddingLeft: '2rem' } : undefined"
        role="button"
        tabindex="0"
        :aria-current="isActive ? 'page' : undefined"
        :aria-label="session.title"
        @click="handleClick"
        @keydown="handleKeydown"
        @contextmenu="canMutate && handleContextMenu($event)"
    >
        <MessageSquareText class="size-4 shrink-0 opacity-70" />
        <div v-if="isRenaming" class="flex-1 min-w-0">
            <input
                v-model="renameValue"
                class="w-full px-2 py-0.5 text-sm rounded border bg-background"
                autofocus
                @blur="confirmRename"
                @keydown.stop="handleRenameKeydown"
                @click.stop
            />
        </div>
        <div v-else class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 min-w-0">
                <span class="truncate text-sm">{{ session.title }}</span>
                <span
                    v-if="delegated"
                    data-testid="session-delegated-badge"
                    class="shrink-0 rounded border px-1 py-px text-xs leading-none text-muted-foreground"
                >
                    {{ t("chat.delegation.badge") }}
                </span>
            </div>
            <p
                v-if="delegated && delegationUsage"
                data-testid="session-delegation-chip"
                class="mt-0.5 truncate text-xs leading-snug text-muted-foreground"
            >
                {{ t("chat.delegation.delegatedTo") }}
                {{ delegationUsage.principalName ?? "—" }} ｜ {{ t("chat.delegation.budgetUsage") }}
                {{ delegationUsage.usedSessions }}/{{ delegationUsage.maxCount }} ｜
                {{ t("chat.delegation.budgetDepth") }} {{ delegationUsage.currentDepth }}/{{
                    delegationUsage.maxDepth
                }}
            </p>
        </div>
        <!--
            task-89 ③：次级动作的**常驻可见**入口（⋯）。此前只有 @contextmenu —— 触摸设备没有右键，
            键盘更是没有；这里同时给 focus-visible 同等的可见性与 32px 级命中区（h-7 w-7）。
        -->
        <DropdownMenu v-if="canMutate">
            <DropdownMenuTrigger as-child>
                <button
                    type="button"
                    data-testid="session-item-more"
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :aria-label="t('sidebar.moreActions')"
                    :title="t('sidebar.moreActions')"
                    @click.stop
                    @keydown.stop
                >
                    <MoreHorizontal class="size-4" aria-hidden="true" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-48" @click.stop>
                <DropdownMenuItem data-testid="session-item-more-rename" @select="startRename">
                    {{ t("sidebar.rename") }}
                </DropdownMenuItem>
                <DropdownMenuItem
                    v-if="isActive"
                    data-testid="session-item-more-fork"
                    :disabled="forkBusy"
                    @select="handleFork"
                >
                    {{ forkBusy ? t("sidebar.forking") : t("sidebar.fork") }}
                </DropdownMenuItem>
                <DropdownMenuItem
                    v-if="session.workspaceId"
                    data-testid="session-item-more-workspace-settings"
                    @select="openWorkspaceSettings"
                >
                    {{ t("sidebar.workspaceSettings") }}
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="session-item-more-delete" @select="handleDelete">
                    {{ t("sidebar.delete") }}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
        <span
            v-if="pendingCount > 0"
            data-testid="session-pending-badge"
            class="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-foreground"
            aria-live="polite"
        >
            <CircleAlert class="size-3" aria-hidden="true" />
            <span>{{ t("sidebar.pendingApprovalBadge") }}</span>
            <span class="tabular-nums">{{ pendingCount }}</span>
        </span>
    </div>

    <Teleport to="body">
        <div v-if="showContextMenu" class="fixed inset-0 z-50" @click="showContextMenu = false">
            <div
                class="absolute w-40 py-1 rounded-lg border bg-popover shadow-lg"
                :style="{ left: contextMenuPosition.x + 'px', top: contextMenuPosition.y + 'px' }"
            >
                <template v-if="canMutate">
                    <button
                        class="w-full px-3 py-1.5 text-left text-sm hover:bg-accent transition-colors"
                        @click="startRename"
                    >
                        {{ t("sidebar.rename") }}
                    </button>
                    <button
                        v-if="isActive"
                        type="button"
                        class="w-full px-3 py-1.5 text-left text-sm hover:bg-accent transition-colors disabled:opacity-50"
                        data-testid="session-item-fork"
                        :disabled="forkBusy"
                        @click.stop="handleFork"
                    >
                        {{ forkBusy ? t("sidebar.forking") : t("sidebar.fork") }}
                    </button>
                    <!--
                        task-109 站点 8：删除的**入口**用中性色，红只留给确认键。
                        DEV-011:155「这个元素如果消失，用户会误操作吗？」——会，所以动作升到 L4；
                        但 L4 的红按 :153「只在【确认时】出现」。确认面已正确（SessionList.vue:343
                        在 BaseModal 内 fill-red）——入口这一侧的红是在给确认面开脱。故转中性。
                    -->
                    <button
                        class="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                        data-testid="session-item-delete"
                        @click="handleDelete"
                    >
                        {{ t("sidebar.delete") }}
                    </button>
                </template>
            </div>
        </div>
    </Teleport>
</template>
