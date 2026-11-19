<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { VueDraggable } from "vue-draggable-plus";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { AppWindow, X } from "@lucide/vue";
// BL-476 L1 pilot: the hand-rolled `role="tablist"` markup is replaced by the
// vendored reka `Tabs` primitives (see src/components/ui/VENDOR.md); reka owns
// role/aria-selected/roving-focus, the bar keeps owning navigation + persistence.
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import {
    registerWorkspaceTabBar,
    workspaceTabBarState,
    type WorkspacePageTab,
} from "./workspaceTabBarContext";
import {
    defaultOpenTabs,
    hasWorkspaceLayoutKey,
    isWorkTabId,
    readWorkspaceLayout,
    sessionIdFromWorkTab,
    workTabIdForSession,
    writeWorkspaceOpenTabs,
    type WorkTabId,
} from "../../../composables/useWorkspaceLayout";
import { useSessionStore } from "../../../stores/session";
import { workspaceChatPath, workspacePath } from "../../../lib/routes";
import { isWorkbenchRoute } from "../../../router/workbenchRoute";

/**
 * C3 (task-217) + task-365 D（D-1220 ①）：行1 页签栏**只显示钉住的会话页签** ——
 * 固定的「会话」页签（workspace-tab-chat）整体删除：它是 fallback 入口，但它永远
 * 存在 ⇒ 行1 永远占着一条 chrome（D-1842 后 = `h-8` = 32px；3.5px 栅格时代的注释写
 * 36px 名义值、实测 31.5px）；「去会话页」与「回工作区页」本就有合法入口
 * （左栏分组里的会话行 / rail 工作台模块）。钉住会话（`session:<id>` work tabs，
 * 持久在 `xihe-layout-ws:<id>.openTabs`）保留 —— 它们是「打开过哪些会话」的指示，
 * 不是行1 的去留判据（整行删除等右侧多页签 + 并行会话替代验证后再裁，D-1136）。
 * 点击页签仍只 `router.push`：深链、前进后退与书签仍是唯一事实。
 */
const props = defineProps<{
    workspaceId: string;
    sessionId: string | null;
}>();

const route = useRoute(),
    router = useRouter(),
    sessionStore = useSessionStore();
const { t } = useI18n();

interface RouteTab {
    id: WorkTabId;
    label: string;
    path: string;
    testid: string;
    closable: boolean;
}

const chatPath = computed(() =>
    props.sessionId
        ? workspaceChatPath(props.workspaceId, props.sessionId)
        : workspacePath(props.workspaceId),
);

function sessionTabLabel(tab: WorkTabId): string {
    const id = sessionIdFromWorkTab(tab);
    const session = sessionStore.sessions.find((item) => item.id === id);
    // A pinned tab whose session is not loaded yet keeps the generic label
    // instead of rendering a raw id.
    return session?.title || t("workspace.tabChatFallback");
}

const openTabs = ref<WorkTabId[]>(
    props.workspaceId ? readWorkspaceLayout(props.workspaceId).openTabs : [],
);

const tabs = computed<RouteTab[]>(() => {
    const list: RouteTab[] = [];
    // task-365 D：固定页签删除后，`tabs` 就是**纯 open set 投影**（PLAN-0753 T5 的
    // 持久顺序语义不变）。越界 id 仍然丢弃：损坏 payload（或历史遗留页签 id）
    // 不得渲染出死页签。
    for (const id of openTabs.value) {
        if (!isWorkTabId(id)) continue;
        list.push({
            id,
            label: sessionTabLabel(id),
            path: workspaceChatPath(props.workspaceId, sessionIdFromWorkTab(id)),
            testid: `workspace-tab-session-${sessionIdFromWorkTab(id)}`,
            closable: true,
        });
    }
    return list;
});

function currentTabId(): WorkTabId | null {
    if (route?.name !== "workspace-chat") return null;
    const sid = route.params.sessionId;
    return typeof sid === "string" && sid ? workTabIdForSession(sid) : null;
}

// task-365 D：固定页签删了，「不在会话路由上」没有替代高亮 —— 不硬造一个（空页签栏
// 直接整体隐藏，见模板 v-if）。会话路由上高亮 = 当前钉住的页签。
const activeId = computed<WorkTabId | null>(() => currentTabId());

// task-110：这条行**只属于工作台页**（workspace / workspace-chat）。判据来自路由表的
// 纯函数 `isWorkbenchRoute`，不在这里另抄一份路由名清单（见 src/router/workbenchRoute.ts）。
const onWorkbenchRoute = computed(() => isWorkbenchRoute(route));

/**
 * Persist the open session set. S3a audit P1-1: the workbench distinguishes
 * "no stored layout yet" (apply the ≥1800 first-run policy) from "user already
 * chose", so a default-valued set must not fabricate the key — but C3 made the
 * default set **empty**, so once a key exists an emptied set must still be
 * written, otherwise the last closed tab would resurrect on reload.
 */
function persistOpenTabs(next: WorkTabId[]): void {
    const defaults = defaultOpenTabs();
    // PLAN-0753 T5: order is user-owned — a persisted order (after a drag/keyboard
    // move) is a real choice and must be kept; the comparison below only asks
    // "is this the default set", which for C3 means "empty".
    const isDefaultSet =
        next.length === defaults.length && defaults.every((id, index) => next[index] === id);
    openTabs.value = next;
    if (!props.workspaceId || (isDefaultSet && !hasWorkspaceLayoutKey(props.workspaceId))) return;
    // Only the tab slice is written: re-writing the whole layout from a
    // default-valued read would clobber the workbench's stored geometry and silently
    // disable the ≥1800 "open monitor on first run" policy (S3a audit P1-1).
    writeWorkspaceOpenTabs(props.workspaceId, next);
}

/** Visiting a session through any means (tab, deep link, history) pins its tab. */
watch(
    () => currentTabId(),
    (tabId) => {
        if (!tabId) return;
        const current = openTabs.value;
        if (current.includes(tabId)) return;
        persistOpenTabs([...current, tabId]);
    },
    { immediate: true },
);

watch(
    () => props.workspaceId,
    (workspaceId) => {
        openTabs.value = workspaceId ? readWorkspaceLayout(workspaceId).openTabs : [];
        const tabId = currentTabId();
        if (tabId && !openTabs.value.includes(tabId)) {
            persistOpenTabs([...openTabs.value, tabId]);
        }
    },
);

/**
 * reka `TabsTrigger` selects on `mousedown` (not `click`), so a real mouse
 * gesture reaches `selectTab` twice: once through the v-model setter and once
 * through the click handler that keeps programmatic `.click()` (jsdom specs,
 * Playwright `click()`) working. Collapse the pair into a single
 * `router.push`; the guard resets when the route actually changes.
 */
const requestedPath = ref<string | null>(null);

watch(
    () => route.fullPath,
    () => {
        requestedPath.value = null;
    },
);

/**
 * task-174（S2b）：容器内页签行 inject 这份上下文来渲染。**行为仍在这里**——
 * 选中/关闭都由本组件既有实现执行，容器只负责画。`claims > 0` 时顶部全局行不渲染。
 */
const tabRowClaims = workspaceTabBarState().claims;

/*
 * task-174（S2b）：把页签快照注册进总线，容器页签行据此渲染；选中/关闭**仍走本组件**
 * 既有实现（路由是唯一 writer）。注销放在卸载时，避免热更新后残留旧闭包。
 */
onBeforeUnmount(
    registerWorkspaceTabBar({
        tabs: computed(() => tabs.value as unknown as WorkspacePageTab[]),
        activeId: computed(() => activeId.value),
        select: (tabId: string) => {
            const tab = tabs.value.find((item) => item.id === tabId);
            if (tab) selectTab(tab);
        },
        close: (tabId: string) => {
            const tab = tabs.value.find((item) => item.id === tabId);
            if (tab) closeTab(tab);
        },
    }),
);

function selectTab(tab: RouteTab): void {
    if (tab.id === activeId.value && route.fullPath === tab.path) return;
    if (requestedPath.value === tab.path) return;
    requestedPath.value = tab.path;
    void router.push(tab.path);
}

/**
 * `Tabs` v-model bridge: reka emits `update:modelValue` on click / arrow keys,
 * the setter only navigates — the route stays the single source of truth, so
 * deep links, back/forward and bookmarks keep working exactly as before.
 */
const activeTab = computed<WorkTabId | undefined>({
    get: () => activeId.value ?? undefined,
    set: (id) => {
        const tab = tabs.value.find((item) => item.id === id);
        if (tab) selectTab(tab);
    },
});

function closeTab(tab: RouteTab): void {
    if (!tab.closable) return;
    const next = openTabs.value.filter((id) => id !== tab.id);
    persistOpenTabs(next);
    // Closing the active tab falls back to the chat tab via a normal navigation.
    if (activeId.value === tab.id) void router.push(chatPath.value);
}

/**
 * PLAN-0753 T5 (M5): the tab order is now user-owned. `tabs` renders the open
 * set in the persisted order (the chat tab stays first because it is the fallback
 * and is not closable); `VueDraggable` owns the drag, and this handler is the
 * **keyboard-equivalent path** — ArrowLeft/ArrowRight on a focused tab moves it
 * one slot (Shift for the start/end), persists the new order and keeps focus.
 *
 * The drag itself reorders the DOM via Sortable; `onUpdate` is wired to the
 * same `persistOpenTabs` so the store and the DOM never diverge (PLAN-0753
 * "拖拽必须有键盘替代：聚焦 + 方向键移动").
 */
function moveTab(id: "chat" | WorkTabId, delta: number): void {
    const list = tabs.value;
    const from = list.findIndex((tab) => tab.id === id);
    if (from < 0) return;
    const to = Math.min(list.length - 1, Math.max(0, from + delta));
    if (to === from) return;
    const nextIds = list.map((tab) => tab.id);
    nextIds.splice(to, 0, nextIds.splice(from, 1)[0]);
    // task-365 D：固定页签删除 ⇒ 拖/键序的就是**整个列表**（不再有「跳过首位」）。
    persistOpenTabs(nextIds as WorkTabId[]);
}

function onDragUpdate(event: { oldIndex?: number; newIndex?: number }): void {
    const { oldIndex, newIndex } = event;
    if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
    const list = tabs.value;
    if (oldIndex >= list.length || newIndex >= list.length) return;
    const nextIds = list.map((tab) => tab.id);
    nextIds.splice(newIndex, 0, nextIds.splice(oldIndex, 1)[0]);
    persistOpenTabs(nextIds as WorkTabId[]);
}

function onTabKeydown(event: KeyboardEvent, tab: RouteTab): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    moveTab(tab.id, event.key === "ArrowLeft" ? -1 : 1);
}
</script>

<template>
    <!--
        task-365 D：没有钉住页签时整条栏隐藏 —— 空 `h-8` = 32px chrome 只会让人以为「这里该有东西」。
        会话一旦打开（`watch` 钉住）它就回来；不改变 WorkspaceWorkbench 的布局链（它是
        flex 列里的 `shrink-0`，有内容才占高）。
    -->
    <!--
        task-174（S2b）：顶部全局行**只在没有容器认领时**渲染。工作台的树容器/内容容器各自
        挂一条容器内页签行（`WorkspaceContainerTabs`），它们 mount 时 claim ⇒ 这里整条让位。

        task-110（修 S2b 的遗漏）：**claim 只是「容器在不在」的判据，不是「这条行属于哪些路由」的判据**。
        claim 由 `WorkspaceWorkbench` 发出，而它只挂在 workspace / workspace-chat 两页 ⇒ 其余五个
        工作区页（环境/定时任务/资源/设置/成员）没有消费方，却也从来没有 claim，于是这条行在那里
        照样渲染（task-104 实测：正文被下推 32px，点页签还会把用户带离当前页）。S2b 注释当时写的
        「行为与重构前逐字节一致」正是这个缺陷的形态，不是设计意图。
        现在路由门是独立的一层：`onWorkbenchRoute`（路由表 SSOT）**且** 无容器认领才渲染。
    -->
    <nav
        v-if="onWorkbenchRoute && tabs.length > 0 && tabRowClaims === 0"
        data-testid="workspace-tab-bar"
        :aria-label="t('workspace.tabBarLabel')"
        class="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b bg-card px-2"
    >
        <Tabs v-model="activeTab" class="min-w-0 flex-1">
            <TabsList variant="line" class="p-0">
                <!--
                  PLAN-0753 T5: `VueDraggable` wraps the tab rows and owns the mouse
                  drag (Sortable). It renders a plain div, so the reka TabsList
                  markup/aria is unchanged; the drag handle is the whole tab row
                  and onDragUpdate mirrors the DOM reorder into the store.
                -->
                <VueDraggable
                    v-model="openTabs"
                    :animation="150"
                    class="contents"
                    @update="onDragUpdate"
                >
                    <div
                        v-for="tab in tabs"
                        :key="tab.id"
                        class="group inline-flex shrink-0 items-center rounded-md"
                        :class="
                            tab.id === activeId
                                ? 'bg-primary/10 text-primary'
                                : 'text-muted-foreground hover:bg-accent'
                        "
                    >
                        <TabsTrigger
                            :value="tab.id"
                            :data-testid="tab.testid"
                            :data-tab-id="tab.id"
                            :title="tab.label"
                            class="h-auto max-w-52 flex-none rounded-md px-2 py-1 text-xs after:hidden data-active:bg-transparent data-active:text-inherit dark:data-active:border-transparent dark:data-active:bg-transparent"
                            :class="tab.id === activeId ? 'font-medium' : ''"
                            @click="selectTab(tab)"
                            @keydown="onTabKeydown($event, tab)"
                        >
                            <!--
                                task-52 / batch-02 ②（P1，截图 `.tmp/xh/b02-10-chat-full.png`）：
                                侧栏会话行与顶栏页签原本长一个样（同样的圆角+同样的文字），
                                而它们是**两个不同的东西**（一行是会话项、一个是页签），
                                同名不同物 ⇒ 用户点错。这里给页签加一个「窗口」图标做**身份差异**，
                                与侧栏会话行的 `MessageSquareText`（对话气泡）区分开：
                                图标语义即位置语义（页签=窗口、会话=对话）。
                                不改成大写字/加粗：那会与 side-bar 行的字重打架，也让页签看起来像标题。
                            -->
                            <AppWindow
                                data-testid="workspace-tab-identity"
                                class="size-3.5 shrink-0 opacity-60"
                                aria-hidden="true"
                            />
                            <span class="truncate">{{ tab.label }}</span>
                        </TabsTrigger>
                        <!--
                            task-89（触控目标，WCAG 2.2 SC 2.5.8 ≥24×24）：同 `WorkspaceContainerTabs`
                            与 `WorkspaceDock` 的页签关闭键 —— 14×14 + 矩形距 7 ⇒ 真缺陷。
                            `min-h-7 min-w-7` = 7 步 × `--spacing`；D-1842 起 4px 栅格 ⇒ **28px**
                            （3.5px 栅格时代是 24.5px）。三个同类关闭键同批改，避免"同动作不同尺寸"。
                        -->
                        <button
                            v-if="tab.closable"
                            type="button"
                            :data-testid="`workspace-tab-close-${tab.id}`"
                            :aria-label="t('workspace.tabClose')"
                            :title="t('workspace.tabClose')"
                            class="mr-1 inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            @click.stop="closeTab(tab)"
                        >
                            <X class="size-3" aria-hidden="true" />
                        </button>
                    </div>
                </VueDraggable>
            </TabsList>
        </Tabs>
    </nav>
</template>
