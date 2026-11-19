<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, Maximize2, Minimize2, Plus, X } from "@lucide/vue";
import {
    DOCK_TAB_IDS,
    DOCK_WIDTH_DEFAULT,
    DOCK_WIDTH_KEYBOARD_STEP,
    DOCK_WIDTH_MAX,
    DOCK_WIDTH_MIN,
    clampDockWidth,
} from "../../../composables/useWorkspaceLayout";
import { useLiveResize } from "../../../composables/useLiveResize";
import SashGrip from "../../../components/shared/SashGrip.vue";
// ─────────────────────────────────────────────────────────────────────────────
// dockview 停用（用户 2026-11-10 裁定：保留依赖、不在 MVP 使用）
//
// 停用范围：下面这行 `import WorkspaceDockviewDock` 与模板里的 dockview 渲染分支
// **整段注释**，文件与依赖都保留（`WorkspaceDockviewDock.vue` / `lib/dockview.ts` /
// `styles/dockview-theme.css` / `dockview-vue` + `dockview-core` 依赖 /
// `e2e/mock/pl0756-dockview.spec.ts` 均未删除）。
//
// `useDockview` prop 与 `globalThis.__xhUseDockview` 注入**当前均无效**：
// `dockviewEnabled` 已固定为 false，产品路径只有手写 dock 一条。
//
// 重新启用三步：
//   ① 取消本行 import 与模板中 dockview 渲染分支的注释；
//   ② 接上 dockview 样式表 `import "dockview-vue/dist/styles/dockview.css"`
//      （BL-564：产品侧至今未引，翻旗后布局会无样式，且须排在
//      `styles/dockview-theme.css` 之前）；
//   ③ 定 BL-561 的键盘语义（dock 整体宽度 vs dockview 组边界两套语义先拍板）。
//
// 证据与代价评估见 plans/PLAN-0756-XH-m7m8-dock-layout-deps/evidence/
// dockview-capability-demo.md。
// ─────────────────────────────────────────────────────────────────────────────
// import WorkspaceDockviewDock from "./WorkspaceDockviewDock.vue";
import { DOCK_TAB_LABEL_KEYS, type DockTab } from "./workspaceDockTabs";
import WorkspaceContainerTabs from "./WorkspaceContainerTabs.vue";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import type { ContainerRowKeyPayload } from "../lib/containerTabNav";
import type { DockTabId } from "../../../composables/useWorkspaceLayout";

/**
 * PLAN-0582 S2: the right dock. Presentation only — the open tab set, the active
 * tab, the width and the collapsed flag are owned by `WorkspaceWorkbench`
 * (single writer), so this component never persists anything itself.
 *
 * PLAN-0626 D26-04（现行）：右栏**只有一个形态** —— 行内列；模板里的 `data-dock-mode`
 * 只是投影 `focus ? 'focus' : 'pinned'`（focus = 铺满整行，主列由 workbench 隐藏）。
 * 浮动态（absolute 定位 + 阴影 + 断点派生 + 手选 override）已随 e88bfd492（2026-11-17
 * 「两容器单栏、右栏恒 pinned」）删除 ⇒ 本组件不再有 mode/断点入参，只渲染投影；
 * 「不得回到浮窗」的判据见 `panelClass` 上方那段形态契约说明与 `WorkspaceDock.spec.ts`。
 *
 * PLAN-0626 D26-10: every tab chip is a wrapper holding two sibling controls (the
 * `role=tab` button and its close button). Nothing interactive is nested inside a
 * tab any more, so Enter/Space work through native button semantics instead of
 * hand-rolled keydown handlers (a11y spec §基线 1, `spec/ui/accessibility.md:11-15`).
 */
const props = withDefaults(
    defineProps<{
        tabs: DockTab[];
        activeTab: string;
        width: number;
        /**
         * task-94 S2 / Q2（Lead 2026-11-17 裁「单栏时右栏占满整行」）：单栏形态下右栏独占整行，
         * 宽度由行决定（`flex-1`），`width`/分隔条/宽度浮标一并退场 —— 整行就是宽度，没有第二栏可拖。
         */
        fill?: boolean;
        /** Width restored by the resizer double-click (P2-1). */
        defaultWidth?: number;
        /** Tabs rendered in the strip before they move into the overflow menu. */
        maxVisibleTabs?: number;
        /**
         * PLAN-0626 D26-04: focus mode renders the dock as the whole workbench row
         * (the main column is hidden by the workbench). It is a rendering projection
         * only: `mode`/`width` keep their user values and reappear on restore.
         */
        focus?: boolean;
        /**
         * PLAN-0756 T1: render the dock area through dockview. Default false keeps the
         * hand-written dock (jsdom integration tests never mount dockview — it needs a
         * real layout engine); e2e turns it on via `globalThis.__xhUseDockview`.
         */
        useDockview?: boolean;
    }>(),
    { maxVisibleTabs: 3, defaultWidth: DOCK_WIDTH_DEFAULT, focus: false, fill: false },
);

const emit = defineEmits<{
    "update:activeTab": [id: string];
    "close-tab": [id: string];
    close: [];
    "update:width": [width: number];
    "toggle-focus": [];
    "row-key": [payload: ContainerRowKeyPayload];
    /** task-97（D-1754 ②）：「+」重开已关闭面板 —— 布局写入在 workbench 的 `openDockTab`。 */
    "reopen-tab": [id: DockTabId];
}>();

const { t } = useI18n();
const overflowOpen = ref(false);
/**
 * task-88 ②（用户 2026-11-20 23:29 裁定）：右栏「+」从「重开已关闭面板」升级为
 * **新建页签 → 选类型**的唯一入口 —— 面板类型不再占顶部导航（那六个图标归 task-137 下线）。
 *
 * <p>候选恒为全部 `DOCK_TAB_IDS`（标签复用既有 `DOCK_TAB_LABEL_KEYS`，不新造 IA）：
 * 已打开的项标 `open`，点击 = 聚焦该页签而不是再开第二个 —— **同类型单例**
 * （Lead 2026-11-20 裁定；不同会话配置可多开是 task-69 三元组/ task-138 的题，本卡不碰）。</p>
 * <p>点击只 emit `reopen-tab`，布局写入仍归调用方的 `openDockTab`（上限/激活/单栏揭示一处）。</p>
 *
 * <p><b>task-140（D-1907 rev7「两容器 + 行为对等」的前置）：它必须是一个真菜单</b> ——
 * 裸 `div` + 一串 `<button>` 既没有 `role=menu/menuitem`、也没有 Esc 关闭与上下键移动，
 * 与主栏将来那个组件选择器不可能对等，138 的动态值域也没有可挂的语义框架。
 * 因此改用栈内既有件 `components/ui/dropdown-menu`（shadcn-vue / reka-ui 原语）——
 * 角色、roving focus、Esc、方向键、按下即打开、点击外部关闭全部由原语提供，
 * 不手搓 keydown（手搓版正是本轮要替换掉的东西）。</p>
 *
 * <p><b>已开项用 `aria-checked`（Lead 2026-11-20 裁定）</b>：「已打开」是开关式状态，
 * 因此项类型必须是 `menuitemcheckbox`（`DropdownMenuCheckboxItem`，reka 自动给
 * `role=menuitemcheckbox` + `aria-checked`）；不能把 `aria-checked` 挂在普通 `menuitem` 上，
 * 那是无效组合。**状态真源仍是 `props.tabs`**：`:model-value` 只读投影，点击只 emit
 * `reopen-tab`，不接 `update:model-value`（否则菜单会自己记一份和第二份真源打架）。</p>
 */
const dockMenuTabs = computed<{ id: DockTabId; open: boolean }[]>(() =>
    DOCK_TAB_IDS.map((id) => ({ id, open: props.tabs.some((tab) => tab.id === id) })),
);
function reopenTab(id: DockTabId): void {
    // 菜单关闭由原语（`DropdownMenuCheckboxItem` 的 select 后 dismiss）负责，
    // 这里只 emit：布局写入归调用方 `openDockTab`（单一 writer 不变）。
    emit("reopen-tab", id);
}
const panelRef = ref<HTMLElement | null>(null);
const bubbleRef = ref<HTMLElement | null>(null);
/**
 * Drag the width without touching Vue: the element width and the bubble text are
 * written imperatively, and `update:width` is emitted once on release (PLAN-0626 P2-9
 * coalescing still owns persistence; it no longer owns the visual update).
 */
const { resizingWidth, start: handleResizeStart } = useLiveResize({
    clamp: clampDockWidth,
    currentWidth: () => props.width,
    grow: "left",
    commit: (width) => emit("update:width", width),
    panel: panelRef,
    bubble: bubbleRef,
});

// dockview 停用（用户 2026-11-10 裁定）：固定 false —— `useDockview` prop 与
// `globalThis.__xhUseDockview` 注入当前均无效，见文件顶部「dockview 停用」说明。
const dockviewEnabled = computed(() => false),
    focusLabel = computed(() =>
        props.focus ? t("workspace.dockFocusRestore") : t("workspace.dockFocusExpand"),
    );

/**
 * task-94 S1（`D-1754 ④` 判据 3）：**右栏只有一种形态 —— 行内列**。
 *
 * <p>浮窗分支（`absolute top-0 right-0 z-20 shadow-xl` + `--xh-composer-h` 底部让位 + pin 切换按钮）
 * 整套退场。它存在的唯一理由是「主列 <640 时把右栏叠上去」，而那个出口的现形是 `D-1829`
 * （条目 58B，用户 2026-11-18 裁定）：主列**允许破 640**、两栏恒同行、首次破线一次性提示
 * （task-94 S2 的中间形态「桌面切单栏」随之退场；`fill` prop 今天只服务 focus/兼容面）。
 * 判据 3 原文是「不得是浮窗/overlay」⇒ 不是「默认 pinned、兜底浮窗」，而是**没有那个兜底**。</p>
 *
 * <p>随之退场的还有 two-axis 的第二根：focus（D26-04）仍在，pin/overlay 那根不再存在。</p>
 */
const panelClass = computed(() => {
    if (props.fill) {
        return [
            "flex h-full min-w-0 flex-1 flex-col border-l border-border bg-surface-canvas",
            "relative z-auto shadow-none",
        ];
    }
    // Focus outranks the width: the row has no main column left, so it becomes the only
    // flex child that grows.
    if (props.focus) {
        return [
            "flex h-full min-w-0 flex-1 flex-col border-l border-border bg-surface-canvas",
            "relative z-auto shadow-none",
        ];
    }
    return [
        "flex shrink-0 flex-col border-l border-border bg-surface-canvas",
        "relative z-auto h-full shadow-none",
    ];
});
/**
 * 宽度：单栏（`fill`）与 focus 都由行决定，没有可拖的宽度 ⇒ 不写内联 `width`。
 * （task-442 的 `--xh-composer-h` 底部让位只服务于浮窗态，随 `D-1754 ④` 判据 3 一起退场。）
 */
const panelStyle = computed(() => {
    if (props.focus || props.fill) return undefined;
    return { width: `${props.width}px` } as Record<string, string>;
});

const visibleTabs = computed(() => props.tabs.slice(0, props.maxVisibleTabs));

/**
 * D-1777/D-1778 §8 第 1 步：右栏容器行的页签数据 = 可见 dock 页签（overflow 之外的前
 * maxVisibleTabs 个），与下方 chips 渲染的始终是同一份。
 */
const withClosable = (tab: DockTab) => ({ ...tab, closable: true });
const rowTabs = computed(() => visibleTabs.value.map(withClosable));
const overflowTabs = computed(() => props.tabs.slice(props.maxVisibleTabs));
const hasOverflow = computed(() => overflowTabs.value.length > 0);

/**
 * PLAN-0626 M2 (D26-07 A): sticky panels mount on first activation and are then only
 * hidden, so form state survives a tab switch. The dock still renders the parent's
 * `<template #id>` slots — the validation for "dynamic slot name + v-show" is the
 * `WorkspaceDock` spec, so no component map / registry is introduced (D26-12).
 * The mount policy lives here rather than in the layout composable: it is a rendering
 * concern of this component, not persisted layout state.
 *
 * PLAN-0626 M3: `agents` joins `context` as a sticky panel — it owns a create form (the
 * same reason `context` is sticky), so switching to another tab must not discard it.
 */
const stickyPanels = ref<string[]>([]),
    stickyTabIds: ReadonlySet<string> = new Set(["context", "agents"]),
    activeIsSticky = computed(() => stickyTabIds.has(props.activeTab));

function rememberStickyPanel(id: string): void {
    if (!stickyTabIds.has(id) || stickyPanels.value.includes(id)) return;
    stickyPanels.value = [...stickyPanels.value, id];
}

watch(
    () => props.activeTab,
    (id) => rememberStickyPanel(id),
    { immediate: true },
);
// A closed tab must not keep a hidden panel (and its watchers) alive.
watch(
    () => props.tabs.map((tab) => tab.id),
    (ids) => {
        const alive = stickyPanels.value.filter((id) => ids.includes(id));
        if (alive.length !== stickyPanels.value.length) stickyPanels.value = alive;
    },
);

function selectTab(id: string) {
    overflowOpen.value = false;
    emit("update:activeTab", id);
}

function closeTab(id: string) {
    overflowOpen.value = false;
    emit("close-tab", id);
}

/**
 * Middle click closes a tab (ruling from the S2 brief). `auxclick` covers mouse
 * middle button; `button === 1` guards against right-click click events.
 */
function handleTabAuxClick(event: MouseEvent, id: string) {
    if (event.button !== 1) return;
    event.preventDefault();
    closeTab(id);
}

/** P2-1: double-clicking the handle restores the default width. */
function resetWidth() {
    emit("update:width", clampDockWidth(props.defaultWidth));
}

function handleResizeKeydown(event: KeyboardEvent) {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = props.width + DOCK_WIDTH_KEYBOARD_STEP;
    else if (event.key === "ArrowRight") next = props.width - DOCK_WIDTH_KEYBOARD_STEP;
    else if (event.key === "Home") next = DOCK_WIDTH_MIN;
    else if (event.key === "End") next = DOCK_WIDTH_MAX;
    if (next === null) return;
    event.preventDefault();
    emit("update:width", clampDockWidth(next));
}
</script>

<template>
    <aside
        ref="panelRef"
        data-testid="workspace-aux-panel"
        :data-dock-mode="focus ? 'focus' : 'pinned'"
        :data-dock-focus="focus ? 'true' : 'false'"
        :aria-label="t('workspace.dockTabs')"
        :class="[panelClass, { 'is-resizing': resizingWidth !== null }]"
        :style="panelStyle"
    >
        <!-- Focus fills the row, so a resize handle (and its width) has no meaning. -->
        <!--
            PLAN-0762 M4 (T4.1)：⋮ 抓手走 SashGrip（与 reka 两处同一定义）。本 handle 是手写的，
            所以 `data-state` 得自己给 —— 取值与 reka `SplitterResizeHandle` 同口径
            （`inactive | drag`，悬停由 CSS `group-hover` 覆盖），抓手的显示规则因此三处一致。
            热区仍是 `w-1`（4px），改宽度会让"拖不动"变成新 bug，禁止。
        -->
        <div
            v-if="!focus && !fill"
            role="separator"
            aria-orientation="vertical"
            :aria-label="t('workspace.dockResize')"
            :aria-valuenow="width"
            :aria-valuemin="DOCK_WIDTH_MIN"
            :aria-valuemax="DOCK_WIDTH_MAX"
            tabindex="0"
            data-testid="dock-resizer"
            :data-state="resizingWidth !== null ? 'drag' : 'inactive'"
            class="group/sash absolute left-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            @dblclick="resetWidth"
            @mousedown="handleResizeStart"
            @keydown="handleResizeKeydown"
        >
            <SashGrip testid="dock-resizer-grip" />
        </div>

        <!-- P2-2: the live width bubble; display-only, never persisted. -->
        <span
            v-if="resizingWidth !== null"
            ref="bubbleRef"
            data-testid="dock-resize-bubble"
            aria-hidden="true"
            class="pointer-events-none absolute left-0 top-1/2 z-30 -translate-x-full -translate-y-1/2 rounded bg-foreground/85 px-1.5 py-0.5 text-xs tabular-nums text-background"
        >
            {{ resizingWidth }}px
        </span>

        <!--
            D-1777/D-1778 §8 第 1 步（task-65 A 段）：右栏容器的页签行 = WorkspaceContainerTabs
            container-id="right"。页签数据 = 本组件既有的 visibleTabs（dock tab 数据，不新造 IA）；
            页签/close 的 testid 沿用 dock-tab-* / dock-tab-close-* 既有契约（66+ 消费点不得改名），
            close-active-only 保留「只有 active 页签有 close」的 dock 语义。
            overflow 触发器与 mode/focus/close 三个动作收进行的 #actions 槽（行尾）。
        -->
        <WorkspaceContainerTabs
            v-if="!dockviewEnabled"
            container-id="right"
            :tabs="rowTabs"
            :active-id="activeTab || null"
            allow-empty
            testid-prefix="dock-tab-"
            close-testid-prefix="dock-tab-close-"
            close-active-only
            @select="selectTab"
            @close="closeTab"
            @row-key="(payload) => emit('row-key', payload)"
            @tab-auxclick="(id, event) => handleTabAuxClick(event, id)"
        >
            <template #actions>
                <!--
                    task-97（D-1754 ②）：右栏「+」= 重开已关闭面板，**簇内首项**（紧贴页签右侧、
                    窗口控件之前；浏览器 tab strip 的 + 语义）。点击走 `reopen-tab` emit，
                    由 workbench 的 `openDockTab` 统一写布局（上限/激活/单栏揭示不在这里重复）。
                -->
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <button
                            type="button"
                            data-testid="workspace-container-plus-right"
                            class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            :aria-label="t('workspace.containerPlusNew')"
                            :title="t('workspace.containerPlusNew')"
                        >
                            <Plus class="size-3.5" aria-hidden="true" />
                        </button>
                    </DropdownMenuTrigger>
                    <!--
                        `data-testid` 一律留在原处（`dock-reopen-menu` / `dock-reopen-item-<id>`）：
                        66+ 既有消费点与 e2e（`task97-container-plus`、`d1907-redlines` 探针）按
                        testid 定位，改名只是无收益漂移。菜单内容经 `DropdownMenuPortal` 落到 body
                        （原语行为）⇒ 单测要查 `document`，不能再 `wrapper.get`。
                    -->
                    <DropdownMenuContent align="end" data-testid="dock-reopen-menu" class="w-44">
                        <DropdownMenuCheckboxItem
                            v-for="entry in dockMenuTabs"
                            :key="entry.id"
                            :data-testid="`dock-reopen-item-${entry.id}`"
                            :model-value="entry.open"
                            class="justify-start gap-2"
                            @select="reopenTab(entry.id)"
                        >
                            <span class="min-w-0 flex-1 truncate">{{
                                t(DOCK_TAB_LABEL_KEYS[entry.id])
                            }}</span>
                            <span
                                v-if="entry.open"
                                class="shrink-0 text-xs text-muted-foreground"
                                >{{ t("workspace.dockTabOpen") }}</span
                            >
                        </DropdownMenuCheckboxItem>
                    </DropdownMenuContent>
                </DropdownMenu>

                <div v-if="hasOverflow" class="relative shrink-0">
                    <button
                        type="button"
                        data-testid="dock-overflow-trigger"
                        class="inline-flex items-center gap-0.5 rounded px-1.5 py-1 text-muted-foreground transition-colors hover:bg-accent"
                        :aria-label="t('workspace.dockOverflow')"
                        :title="t('workspace.dockOverflow')"
                        :aria-expanded="overflowOpen"
                        @click="overflowOpen = !overflowOpen"
                    >
                        <ChevronDown class="size-3.5" aria-hidden="true" />
                        <span class="tabular-nums">{{ overflowTabs.length }}</span>
                    </button>
                    <div
                        v-if="overflowOpen"
                        data-testid="dock-overflow-menu"
                        class="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border bg-popover p-1 text-sm shadow-md"
                    >
                        <div
                            v-for="tab in overflowTabs"
                            :key="tab.id"
                            class="flex w-full items-center justify-between gap-1 rounded hover:bg-accent"
                        >
                            <button
                                type="button"
                                :data-testid="`dock-overflow-item-${tab.id}`"
                                class="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                @click="selectTab(tab.id)"
                            >
                                {{ tab.label }}
                            </button>
                            <button
                                type="button"
                                :data-testid="`dock-overflow-close-${tab.id}`"
                                :aria-label="t('workspace.dockCloseTab')"
                                :title="t('workspace.dockCloseTab')"
                                class="mr-1 inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                @click.stop="closeTab(tab.id)"
                            >
                                <X class="size-3" aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                </div>

                <!-- task-94 S1：pin/浮窗切换按钮随浮窗退场（判据 3）——右栏没有第二种形态可切。 -->
                <!--
                    PLAN-0626 D26-04: expand/restore。task-94 S1 之后只剩「宽度」这一根轴
                    （pin = dock vs overlay 那根随浮窗退场），focus 仍与宽度独立。
                -->
                <button
                    type="button"
                    data-testid="dock-focus-toggle"
                    class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :class="focus ? 'text-primary' : ''"
                    :aria-pressed="focus"
                    :aria-label="focusLabel"
                    :title="`${focusLabel} · ${t('workspace.dockFocusHint')}`"
                    @click="emit('toggle-focus')"
                >
                    <Minimize2 v-if="focus" class="size-3.5" aria-hidden="true" />
                    <Maximize2 v-else class="size-3.5" aria-hidden="true" />
                </button>
                <button
                    type="button"
                    data-testid="workspace-aux-close"
                    class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :aria-label="t('workspace.closePanel')"
                    :title="t('workspace.closePanel')"
                    @click="emit('close')"
                >
                    <X class="size-3.5" aria-hidden="true" />
                </button>
            </template>
        </WorkspaceContainerTabs>

        <!--
            PLAN-0756 T1 dockview 渲染分支 —— 停用（用户 2026-11-10 裁定：保留依赖、
            MVP 不使用）。恢复见 `<script setup>` 顶部「dockview 停用」三步；当前
            `dockviewEnabled` 恒 false，产品路径只有下面这条手写 dock 分支。

        <div class="dockview-host min-h-0 flex-1 overflow-hidden">
            <WorkspaceDockviewDock
                :tabs="tabs"
                :active-tab="activeTab"
                :mode="mode"
                @update:active-tab="selectTab"
                @close-tab="closeTab"
            >
                <template v-for="tab in tabs" :key="tab.id" #[tab.id]>
                    <slot :name="tab.id" />
                </template>
            </WorkspaceDockviewDock>
        </div>
        -->
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <!--
                task-88 ②：0 页签是**可达态**（折叠再展开、或上一次会话把页签全关掉），
                此时右栏要有空态而不是一片空白：告诉用户去哪儿新建，行尾「+」就紧挨着它。
            -->
            <div
                v-if="tabs.length === 0"
                data-testid="dock-empty-state"
                class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"
            >
                <p class="max-w-64">{{ t("workspace.dockEmptyHint") }}</p>
            </div>
            <template v-else>
                <!-- Sticky panels: mounted on first activation, then hidden but alive. -->
                <div
                    v-for="id in stickyPanels"
                    :key="id"
                    v-show="id === activeTab"
                    :data-testid="`dock-sticky-panel-${id}`"
                    class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                >
                    <slot :name="id" />
                </div>
                <!-- Checkers: single active panel, unmounted while inactive (D26-07 A). -->
                <div
                    v-if="!activeIsSticky"
                    data-testid="dock-active-panel"
                    class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                >
                    <slot :name="activeTab" />
                </div>
            </template>
        </div>
    </aside>
</template>

<style scoped>
/*
 * Resize-follow fix (PLAN-0626 P2-9 follow-up): while the pointer owns the width,
 * promote the panel to its own compositing layer and stop the children from
 * hit-testing, so the tab strip / agent panels cannot force reflow per mousemove.
 */
.is-resizing {
    will-change: width;
}

.is-resizing :deep(*) {
    pointer-events: none;
}
</style>
