<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
    CircleUser,
    FolderTree,
    LogOut,
    PanelLeftClose,
    PanelLeftOpen,
    Plus,
    Search,
    Settings,
    X,
} from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { toast } from "vue-sonner";
import WorkspaceSessionGroups from "../../features/workspace/chat/components/WorkspaceSessionGroups.vue";
import UserQuestionsEntry from "../../features/workspace/components/UserQuestionsEntry.vue";
// PLAN-0762 T2.1：NavRail 已提升为全局层（components/sidebar/GlobalRail.vue，App.vue 常驻），
// 本组件不再自带 rail —— 它只负责工作区模块的导航面板。
import { workspacePath } from "../../lib/routes";
import { useSessionStore } from "../../stores/session";
import { defaultLayerPath } from "../../lib/settingsIa";

const props = defineProps<{
    /**
     * S5-W2: the shell yielded the navigation panel to protect the workspace main
     * column. Render-only — the stored `open` state is untouched, so widening the
     * window restores the panel exactly as the user left it.
     */
    forceCollapsed?: boolean;
    open: boolean;
    width: number;
    isMobile: boolean;
    /**
     * PLAN-0753 T3: the shell's splitter bridge owns the pointer/keyboard resize;
     * this is render-only state for transition suppression, layer promotion and the
     * live width bubble. Never a width channel of its own.
     */
    resizing?: boolean;
}>();

const emit = defineEmits<{
    "update:open": [value: boolean];
}>();

const router = useRouter(),
    route = useRoute();
const { t } = useI18n();
const auth = useAuthStore();
const sessionStore = useSessionStore();

const workspaceLabel = computed(() => {
    const id = auth.currentWorkspaceId;
    return auth.workspace?.name || (id ? `Workspace ${id.slice(0, 6)}` : t("sidebar.workspace"));
});

const isWorkspacePage = computed(() => {
    const workspaceId = auth.currentWorkspaceId;
    if (!workspaceId) return false;
    if (route?.name === "workspace" || route?.name === "workspace-home") return true;
    return (route?.path ?? "") === workspacePath(workspaceId);
});

const isOpen = computed(() => Boolean(props.open) && !props.forceCollapsed);

/**
 * PLAN-0762 T2.1：全局条移到 App.vue 之后，桌面折叠态不再靠 rail 的展开按钮回归 ——
 * 折叠后本组件渲染一条 56px 的"折叠条"（只含展开控件），宽度由 AppLayout 的
 * SplitterPanel `collapsed-size=RAIL_WIDTH` 决定，语义与原 P-class 修复一致：
 * 面板关闭时仍然有可见、可点的重新打开入口；自动让位（forceCollapsed）不是用户选择，
 * 此时**不**渲染该条。
 */
const showCollapsedStrip = computed(
    () => !props.isMobile && !isOpen.value && !props.forceCollapsed,
);

function expandSidebar() {
    emit("update:open", true);
}

const panelStyle = computed(() => (props.isMobile ? { width: "100%" } : undefined));

/**
 * task-352 / `D-1206`：分组头与会话项各自的「新建」都落到**那个工作区**，不是当前工作区。
 * 路径形式 `/workspace/{id}?newChat=1` 由路由守卫写 tab 上下文，所以这里只负责跳。
 */
function startNewChatInWorkspace(workspaceId: string) {
    void router.push({ path: workspacePath(workspaceId), query: { newChat: "1" } });
}

async function startNewChat() {
    if (!auth.currentWorkspaceId) {
        await auth.hydrateWorkspace();
    }
    if (!auth.currentWorkspaceId) {
        toast.error(t("sidebar.noWorkspace"));
        return;
    }
    const workspaceId = auth.currentWorkspaceId;
    await router.push({ path: workspacePath(workspaceId), query: { newChat: "1" } });
}

function toggleSidebar() {
    emit("update:open", !props.open);
}

/**
 * PLAN-0753 T3: 指针 / 键盘 / 双击三条 resize 路径整体上移到壳层（AppLayout 的
 * `useSplitterPanelBridge`）——aside 现在是 splitter panel #1，宽度由 reka 的
 * flex-grow 拥有，本组件不再写 `style.width`、也不再 emit `update:width`。
 * 只剩两件 render-only 的事：`resizing` 驱动 will-change / transition 抑制，
 * 以及把气泡元素暴露给桥接做**命令式**文本写入（不建响应式宽度通道）。
 */
const bubbleRef = ref<HTMLElement | null>(null);
defineExpose({ bubbleRef });

async function navigateToWorkspace() {
    if (!auth.currentWorkspaceId) {
        await auth.hydrateWorkspace();
    }
    const workspaceId = auth.currentWorkspaceId;
    if (!workspaceId) {
        toast.error(t("sidebar.noWorkspace"));
        return;
    }
    void router.push(workspacePath(workspaceId));
}

function clearSearch() {
    sessionStore.searchQuery = "";
}

/** task-113：指向最终地址（`lib/settingsIa` 的 SSOT），不再依赖 `/settings/config` 的 redirect。 */
function navigateSettings() {
    void router.push(defaultLayerPath("instance"));
}

function handleLogout() {
    auth.logout();
    void router.push("/login");
}
</script>

<template>
    <aside
        data-testid="sidebar"
        :aria-hidden="isMobile && !open ? 'true' : undefined"
        :inert="isMobile && !open ? true : undefined"
        class="flex h-full overflow-hidden bg-surface-canvas border-r border-sidebar-border"
        :class="[
            isMobile ? 'fixed left-0 top-0 z-40' : 'relative min-w-0',
            { 'shadow-lg': isMobile && open, 'is-resizing': resizing },
            resizing
                ? 'transition-none'
                : isMobile
                  ? 'transition-[width] duration-300'
                  : 'transition-[flex-grow] duration-300',
        ]"
    >
        <!-- 桌面折叠态：56px 折叠条（只含展开控件）。全局条在 App.vue，不在这里。 -->
        <div
            v-if="showCollapsedStrip"
            data-testid="sidebar-collapsed-strip"
            class="flex h-full w-full flex-col items-center justify-start py-3"
        >
            <button
                type="button"
                data-testid="sidebar-expand"
                :aria-label="t('sidebar.expand')"
                :title="t('sidebar.expand')"
                class="rounded-md p-1.5 text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="expandSidebar"
            >
                <PanelLeftOpen class="size-4" aria-hidden="true" />
            </button>
        </div>
        <!-- 桌面：panel #1 的剩余宽度全部归导航面板（全局条不在其中）。折叠态改渲染上面的折叠条。 -->
        <div
            v-else
            id="sidebar-panel"
            data-testid="sidebar-panel"
            :aria-hidden="!isMobile && !open ? 'true' : undefined"
            :inert="!isMobile && !open ? true : undefined"
            class="relative flex h-full min-w-0 flex-col overflow-hidden"
            :class="isMobile ? undefined : 'flex-1'"
            :style="panelStyle"
        >
            <div class="flex h-14 shrink-0 items-center gap-1 px-2">
                <button
                    type="button"
                    data-testid="sidebar-workspace"
                    class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-base transition-colors"
                    :class="
                        isWorkspacePage
                            ? 'bg-primary/10 font-semibold text-primary'
                            : 'text-sidebar-foreground hover:bg-sidebar-accent'
                    "
                    :aria-current="isWorkspacePage ? 'page' : undefined"
                    :title="workspaceLabel"
                    @click="navigateToWorkspace"
                >
                    <FolderTree class="size-4 shrink-0" aria-hidden="true" />
                    <span class="truncate font-semibold">{{ workspaceLabel }}</span>
                </button>
                <button
                    type="button"
                    :data-testid="isMobile ? 'sidebar-close' : 'sidebar-collapse'"
                    :aria-label="t('sidebar.collapse')"
                    :title="t('sidebar.collapse')"
                    :aria-expanded="open"
                    class="shrink-0 rounded-md p-1.5 text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="toggleSidebar"
                >
                    <PanelLeftClose class="size-4" aria-hidden="true" />
                </button>
            </div>

            <div class="px-3 pb-2">
                <button
                    data-testid="sidebar-new-chat"
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="startNewChat"
                >
                    <Plus class="size-4" aria-hidden="true" />
                    {{ t("sidebar.newChat") }}
                </button>
            </div>

            <!-- PLAN-0660 T5.21（B-7 全局导航入口）：有欠答时才占位，零态不渲染（见组件头注释）。 -->
            <div class="px-3 pb-2">
                <UserQuestionsEntry />
            </div>

            <div class="px-3 pb-2">
                <div class="relative">
                    <Search
                        class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <input
                        v-model="sessionStore.searchQuery"
                        data-testid="sidebar-session-search"
                        type="text"
                        autocomplete="off"
                        class="w-full rounded-md border border-sidebar-border bg-background py-1.5 pl-7 pr-7 text-sm text-sidebar-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        :placeholder="t('sidebar.search')"
                        :aria-label="t('sidebar.search')"
                    />
                    <button
                        v-if="sessionStore.searchQuery"
                        type="button"
                        data-testid="sidebar-search-clear"
                        class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent"
                        :aria-label="t('sidebar.clearSearch')"
                        :title="t('sidebar.clearSearch')"
                        @click="clearSearch"
                    >
                        <X class="size-3.5" aria-hidden="true" />
                    </button>
                </div>
            </div>

            <WorkspaceSessionGroups @new-session="startNewChatInWorkspace" />

            <div
                v-if="isMobile"
                class="shrink-0 space-y-1 border-t border-sidebar-border px-3 py-3"
            >
                <!-- task-36 ③ 的移动端紧凑语言开关：**已移除**（D-899，用户「语言切换放到设置里吧」；
                     Lead 裁定不分 rail/抽屉：移动端保留 = 两个入口）。移动端同走
                     设置页 · 用户层 · user-preference（/settings/user/user-preference）。 -->
                <div class="flex items-center gap-2 px-3 py-2 text-sm text-sidebar-foreground/70">
                    <CircleUser class="size-4" aria-hidden="true" />
                    <span class="truncate">{{ auth.userName }}</span>
                </div>
                <button
                    data-testid="sidebar-settings"
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    @click="navigateSettings"
                >
                    <Settings class="size-4" aria-hidden="true" />
                    {{ t("sidebar.settings") }}
                </button>
                <button
                    data-testid="sidebar-logout"
                    class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    @click="handleLogout"
                >
                    <LogOut class="size-4" aria-hidden="true" />
                    {{ t("sidebar.logout") }}
                </button>
            </div>

            <!--
                PLAN-0753 T3: 宽度气泡的显隐由壳层桥接的 `resizing` 驱动，文本由桥接在
                `@resize` 里**命令式**写入（textContent）——不建响应式宽度通道。
            -->
            <span
                v-if="resizing"
                ref="bubbleRef"
                data-testid="sidebar-resize-bubble"
                aria-hidden="true"
                class="pointer-events-none absolute -right-1 top-1/2 z-30 translate-x-full -translate-y-1/2 rounded bg-foreground/85 px-1.5 py-0.5 text-xs tabular-nums text-background"
            />
        </div>
    </aside>
</template>

<style scoped>
/*
 * PLAN-0753 T3: reka 拥有 panel 宽度（flex-grow），拖拽期间抑制 transition 并把
 * 子节点设为 pointer-events: none —— 内容不会跟着每次 pointermove 重排，手感与
 * PLAN-0626 的"跟手不走响应式"一致。will-change 指向实际被动画的属性。
 */
.is-resizing {
    will-change: flex-grow;
}

.is-resizing :deep(*) {
    pointer-events: none;
}
</style>
