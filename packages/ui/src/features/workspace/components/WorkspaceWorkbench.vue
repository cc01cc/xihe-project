<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import { useMediaQuery, useWindowSize } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { toast } from "vue-sonner";
import { FolderTree } from "@lucide/vue";
import {
    DOCK_WIDTH_DEFAULT,
    SPLITTER_REFERENCE_WIDTH,
    TREE_COLLAPSED_WIDTH,
    TREE_WIDTH_DEFAULT,
    TREE_WIDTH_KEYBOARD_STEP,
    TREE_WIDTH_MAX,
    TREE_WIDTH_MIN,
    canOpenDockTab,
    clampDockWidth,
    clampTreeWidth,
    WORKSPACE_LAYOUT_KEY,
    computeWorkbenchSqueeze,
    createWorkspaceLayoutWriter,
    defaultWorkspaceLayout,
    defaultWorkspaceLayoutForViewport,
    deriveDockMode,
    hasWorkspaceLayout,
    isDockTabId,
    readWorkspaceLayout,
    type DockMode,
    type DockTabId,
    type WorkbenchSqueezeDemand,
    type WorkbenchSqueezeResult,
    type WorkspaceLayoutState,
} from "../../../composables/useWorkspaceLayout";
import {
    useSplitterPanelBridge,
    type SplitterPanelExposed,
} from "../../../composables/useSplitterPanelBridge";
import { useSplitterPanelWidthSync } from "../../../composables/useSplitterPanelWidthSync";
import { SplitterGroup, SplitterPanel, SplitterResizeHandle } from "reka-ui";
import { useWorkspaceStore } from "../stores/workspace";
import { useSessionParticipantsStore } from "../stores/sessionParticipants";
import SashGrip from "../../../components/shared/SashGrip.vue";
import WorkspaceToolbar from "./WorkspaceToolbar.vue";
import WorkspaceDock from "./WorkspaceDock.vue";
import WorkspaceContainerTabs from "./WorkspaceContainerTabs.vue";
import WorkspaceContainerSwitcher from "./WorkspaceContainerSwitcher.vue";
import {
    closeWorkspaceTab,
    selectWorkspaceTab,
    workspaceTabBarState,
} from "./workspaceTabBarContext";
import {
    containerOf,
    type ActiveColumn,
    type ContainerId,
    type ContainerMode,
} from "../lib/containers";
import {
    resolveMoveKey,
    resolveNavKey,
    rowsForMode,
    type ContainerRow,
    type ContainerRowKeyPayload,
} from "../lib/containerTabNav";
import WorkspaceDockPanelContent from "./WorkspaceDockPanelContent.vue";
import WorkspaceShellDockview from "./WorkspaceShellDockview.vue";
import FileTreePanel from "./FileTreePanel.vue";
import FileEditor from "./FileEditor.vue";
import {
    DOCK_TAB_LABEL_KEYS,
    shouldOpenAgentsDockFromDeepLink,
    type DockTab,
} from "./workspaceDockTabs";

/**
 * PLAN-0582 S2: the workspace workbench skeleton. It owns the workspace-scoped
 * layout state (file tree collapse + right dock tabs/active/width/collapsed) and
 * renders the three columns; `WorkspaceView` stays a data-assembly layer.
 *
 * Invariants:
 * - one writer: this component is the only place that mutates and persists the
 *   per-workspace layout (`xihe-layout-ws:<workspaceId>`);
 * - dock state is per workspace and survives session switches (ruling: switching
 *   sessions no longer resets the auxiliary panel);
 * - the dock is closed by default and never takes flex space below 1800px
 *   (see `WorkspaceDock`); the file tree yields first, then the nav panel.
 */
const props = defineProps<{
    workspaceId: string;
    sessionId: string | null;
    isMobile: boolean;
    mobileChangesOpen?: boolean;
    mobileAuxTab?: "monitor" | "changes" | "members";
    /**
     * task-369 S1：打开「一个 dockview 实例横跨中栏+右栏」的壳。**默认 false** ——
     * 产品路径仍是手写 dock + reka SplitterGroup，`bl576` / `task353` 的指称物因此保持有效。
     * 注入面复活（PLAN-0756 原设计）：本 prop 或 `globalThis.__xhUseDockview`。
     */
    useDockview?: boolean;
}>();

const emit = defineEmits<{
    agents: [];
    files: [];
    "mobile-toggle-changes": [];
    "mobile-toggle-monitor": [];
    /** BL-317 / D-198：移动端没有 dock，成员面板走 worksheet 的 tab 入口（与 monitor/changes 同形）。 */
    "mobile-toggle-members": [];
    /** PLAN-0623：参与者面板的「提及」冒泡到页面层，由它转给 composer。 */
    mention: [name: string];
}>();

const { t } = useI18n();
const ws = useWorkspaceStore();

/**
 * BL-317 / D-198 —— 移动端成员入口的未读徽标（**只用服务端值**）。
 *
 * 数值来源：`GET …/participants` 响应里的 `readCursor.mentionCount`（store 解析后的 `participants`），
 * 这里只对"本人 HUMAN 行"求和。**前端不累加、不本地持久化、不做增量推断**。
 *
 * 为什么在 workbench 里预热一次：store 平时由面板挂载时拉取，而移动端入口在**打开面板之前**
 * 就要显示徽标；所以只在移动端（`isMobile`）随会话变化预热，桌面不预热（桌面入口在 dock 上，零变化）。
 */
const participantsStore = useSessionParticipantsStore();
watch(
    [() => props.isMobile, () => props.sessionId],
    ([mobile, sessionId]) => {
        if (!mobile || !sessionId) return;
        void participantsStore.load(sessionId);
    },
    { immediate: true },
);

const membersUnread = computed(() =>
    (participantsStore.participants ?? [])
        .filter(
            (participant) =>
                participant.selfOwned === true && participant.principalKind === "HUMAN",
        )
        .reduce(
            (sum, participant) => sum + Math.max(0, participant.readCursor?.mentionCount ?? 0),
            0,
        ),
);

const { width: viewportWidth } = useWindowSize();

/**
 * P1-1 (S2 audit): a workspace that has no stored layout yet opens `monitor` by
 * default on wide screens (≥1800); once the user collapses or switches, the
 * persisted state wins and this default never overrides it again.
 */
function initialLayout(workspaceId: string): WorkspaceLayoutState {
    if (!workspaceId) return defaultWorkspaceLayout();
    // "≥1800 opens the monitor" is a **first-run** policy: it only applies while no
    // geometry is stored. S3b P1-1 (audit): there is deliberately no dismissal latch
    // — a stored `dockCollapsed` is already the user's own choice, and a latch would
    // keep overriding an explicit re-open on every reload.
    if (!hasWorkspaceLayout(workspaceId)) {
        return defaultWorkspaceLayoutForViewport(viewportWidth.value);
    }
    return readWorkspaceLayout(workspaceId);
}

const layout = ref<WorkspaceLayoutState>(initialLayout(props.workspaceId));
/**
 * task-94 (B)：内层 SplitterGroup 的两道 panel 一律用**百分比**，持久化仍是 px。
 *
 * 依据：`reka-ui@2.11.0 src/Splitter/utils/units.ts:29-38` —— 组内只要有 px 面板且首次测量
 * 拿不到 groupSize，`convertPanelConstraintsToPercent` 就返回 null ⇒ `SplitterGroup.vue:341-343`
 * 直接 return，`layout` 永远是 `[]`；而 `:387-388` 的恢复分支又要求 `prevLayout.length !== 0`
 * ⇒ 永不恢复。layout 空的时候：① `computePanelFlexBoxStyle` 把 `defaultSize` 当 flex-grow、
 * 缺省落 `"1"`（`dist/utils/style.js:45-50`），主列被压成 5px；② 重渲染期
 * `isPanelCollapsed → getPanelSize` 断言（`Panel size not found`）打断渲染 ⇒ dock 状态改了不渲染。
 * 全用 % 之后 `requiresMeasurement` 为 false，layout 一定能从默认值初始化。
 *
 * 换算只在这一处：reka 收/发 %（`treePercentOf` / `treePxOf`），store 与 UI 仍是 px。
 *
 * task-353（D-1207 甲案）：`centerGroupRef` 指向**中栏容器内部**那道 SplitterGroup（改造前指向
 * 工作台根下那道）。**基准宽没变**：两者都是 `WorkspaceDock` 的兄弟、都吃 `flex-1`，量到的宽同值
 * —— 由 bl576 的改前/改后读数证实（`containerWidth` 两次都是 1157.609375）。因此 px↔% 换算
 * 不需要重算，判据③（展开回原宽）不会因搬家而漂。这不是「不必小心」，而是「小心过了、有读数」：
 * 下次再动这层嵌套，必须重跑那条读数。
 */
const centerGroupRef = ref<{ $el?: HTMLElement } | null>(null);
const splitterWidth = ref(0);
let splitterObserver: ResizeObserver | null = null;

function releaseSplitterObserver(): void {
    splitterObserver?.disconnect();
    splitterObserver = null;
}

function treePercentOf(px: number): number {
    const width = splitterWidth.value > 0 ? splitterWidth.value : SPLITTER_REFERENCE_WIDTH;
    return Math.min(100, Math.max(0, (px / width) * 100));
}

function treePxOf(percent: number): number {
    const width = splitterWidth.value > 0 ? splitterWidth.value : SPLITTER_REFERENCE_WIDTH;
    return (percent / 100) * width;
}

const treeDefaultPercent = computed(() => treePercentOf(treeWidth.value));
const treeMinPercent = computed(() => treePercentOf(TREE_WIDTH_MIN));
const treeMaxPercent = computed(() => treePercentOf(TREE_WIDTH_MAX));
const treeCollapsedPercent = computed(() => treePercentOf(TREE_COLLAPSED_WIDTH));
const mainDefaultPercent = computed(() => Math.max(0, 100 - treePercentOf(TREE_WIDTH_DEFAULT)));

onMounted(() => {
    const element = centerGroupRef.value?.$el;
    if (!element || typeof ResizeObserver !== "function") return;
    splitterObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (width > 0) splitterWidth.value = width;
    });
    splitterObserver.observe(element);
});

onBeforeUnmount(releaseSplitterObserver);

let layoutWriter = createWorkspaceLayoutWriter(props.workspaceId || "");

// Switching workspace swaps the whole per-workspace set (V11: "切 workspace 换一套").
watch(
    () => props.workspaceId,
    (workspaceId) => {
        // Persist the outgoing workspace's pending drag before rebinding the writer.
        layoutWriter.flush();
        layoutWriter = createWorkspaceLayoutWriter(workspaceId || "");
        layout.value = initialLayout(workspaceId);
        // P0-1/P1-2 (S2 audit): never carry open file buffers or a stale tree
        // across workspaces. S3a audit P0: this reset must run on mobile too — the
        // mobile sheet renders the tree and the editor, so skipping it would save
        // workspace A's buffer into workspace B. Only the tree prefetch is
        // desktop-only (the mobile sheet loads the tree on demand).
        ws.resetWorkspaceScoped();
        if (props.isMobile) return;
        void ws.loadTree();
    },
);

watch(
    layout,
    (value) => {
        if (!props.workspaceId || props.isMobile) return;
        // P2-9: coalesce drag writes; `flush()` on unmount/switch keeps the last one.
        layoutWriter.schedule(value);
    },
    { deep: true },
);

/**
 * 离散动作（收起/展开树）**立刻**落盘，不等 250ms 去抖（task-2）。
 *
 * 去抖的理由是拖拽期的写放大（P2-9），而折叠是一次点击一次的离散状态：让它排在一个
 * 拖拽用的合并窗口后面，等于给「点了收起但没写盘」留了 250ms 的窗口。实测判据
 * （`e2e/mock/task353-center-container.spec.ts` 的「收起必须写进 treeCollapsed」）正是
 * 点完收起就同步读 localStorage ⇒ 落在窗口内就红（本轮 task-2 的读数：落盘 t≈286ms，
 * 而读发生在 ~200ms）。契约面不变：键、值、单一 writer 都不动，只是把这一笔提前写。
 * 只跟 `layout.treeCollapsed`（用户的持久状态），不跟 `treeCollapsedForSqueeze`
 * （窄视口/挤压的**渲染**态，按 DESIGN 永不落盘）。
 */
watch(
    () => layout.value.treeCollapsed,
    () => layoutWriter.flush(),
    { flush: "post" },
);

onBeforeUnmount(() => layoutWriter.flush());
if (typeof window !== "undefined") {
    // S3b P2 (audit): a reload/close within the coalescing window would drop the last
    // write, which reads as "my close was treated as the default". Mirror the
    // `beforeunload` flush pattern used for the logger (main.ts).
    // BL-379: named handlers so unmount can remove them pairwise — anonymous closures
    // leaked one unremovable listener per mount and pinned the whole instance.
    const flushOnPagehide = (): void => layoutWriter.flush();
    const flushOnHidden = (): void => {
        if (document.visibilityState === "hidden") layoutWriter.flush();
    };
    window.addEventListener("pagehide", flushOnPagehide);
    document.addEventListener("visibilitychange", flushOnHidden);
    onBeforeUnmount(() => {
        window.removeEventListener("pagehide", flushOnPagehide);
        document.removeEventListener("visibilitychange", flushOnHidden);
    });
}

/**
 * Yield order dock → file tree → nav panel (S2 ruling #3). The dock never takes
 * flex space below 1800px (CSS overlay in `WorkspaceDock`), so the first column
 * that has to give room is the file tree: below 1440px it starts collapsed and
 * the user can still expand it manually (a manual choice wins over the default).
 */

const dockOpen = computed(
    () =>
        !layout.value.dockCollapsed &&
        layout.value.dockTabs.length > 0 &&
        layout.value.activeDockTab !== null,
);
const activeDockTab = computed(() => layout.value.activeDockTab);
const codeOpen = computed(() => dockOpen.value && activeDockTab.value === "code");
const changesOpen = computed(() => dockOpen.value && activeDockTab.value === "changes");
const monitorOpen = computed(() => dockOpen.value && activeDockTab.value === "monitor");
/** PLAN-0623 U1：参与者面板与 monitor 同构（按会话挂载），tab 默认不打开。 */
const membersOpen = computed(() => dockOpen.value && activeDockTab.value === "members");
/** PLAN-0659 T1.4：委派 DAG 面板（同样按会话挂载，tab 默认不打开）。 */
const delegationOpen = computed(() => dockOpen.value && activeDockTab.value === "delegation");

/**
 * task-174（S2b）：容器内页签行。**数据来自 `WorkspaceTabBar` 的上下文**（路由仍是唯一
 * writer），容器归属只经 `containerOf` 这一处派生；本组件不读 localStorage、不改布局。
 * 挂载时 claim 顶部全局行，卸载时释放 —— 离开工作台的路由不会因此失去页签入口。
 */
const tabBarContext = workspaceTabBarState();
let releaseTabRowClaim: (() => void) | null = null;
onMounted(() => {
    releaseTabRowClaim = tabBarContext.claim();
});
onBeforeUnmount(() => {
    releaseTabRowClaim?.();
    releaseTabRowClaim = null;
});

/** 文件树容器只承载文件树本身（A2 预设两组：左树 / 中内容）。 */
const treeContainerTabs = computed(() => [
    { id: "tree", label: t("workspace.containerTree"), closable: false },
]);

const mainContainerTabs = computed(() =>
    tabBarContext.tabs.value
        .filter((tab) => containerOf(tab.id) === "main")
        .map((tab) => ({ id: tab.id, label: tab.label, closable: tab.closable })),
);
const mainContainerActiveId = computed(() => tabBarContext.activeId.value);

/**
 * task-184（`D-1600` ①②）：**渲染出来的**容器行，顺序 = 渲染顺序。
 *
 * <p>空行在这里自然被 `resolveNavKey`/`focusableRows` 过滤掉（`mainContainerTabs` 为空时中栏不画行），
 * 所以「DOM 顺序 vs 容器常量表」的分叉不会传到键盘判定里。</p>
 */
const containerRows = computed<ContainerRow[]>(() => {
    const rows: ContainerRow[] = [
        { container: "tree", tabs: treeContainerTabs.value, activeId: "tree" },
        { container: "main", tabs: mainContainerTabs.value, activeId: mainContainerActiveId.value },
    ];
    return [...rowsForMode(rows, containerMode.value, layout.value.activeColumn)];
});

/**
 * task-174 / `D-1545`：**形态只决定看得见哪一栏**，不改归属。
 *
 * <p>今天 `single` 只在移动壳（`isMobile`）成立，而移动壳现在渲染的是 `<FileEditor />`
 * （`D-1544` 遗留：真正的窄屏渲染由移动壳卡接通）⇒ 这一层现在是**形状就位、产品面不触发**，
 * 由单测钉住。桌面形态下 `visibleContainers` 返回全部 ⇒ 行为与本卡之前完全一致。</p>
 */
const containerMode = computed<ContainerMode>(() => (props.isMobile ? "single" : "desktop"));

/** 窄屏切换当前显示哪一栏（与布局同源落盘：写的是同一个 `xihe-layout-ws:<id>`）。 */
function setActiveColumn(value: ActiveColumn): void {
    layout.value.activeColumn = value;
}

/**
 * task-184（`D-1600` ③）：键盘命令的**无障碍播报**出口。
 *
 * <p>为什么要有它：本卡的现象就是「按了没反应 ⇒ 分不清『没实现』与『合理 no-op』」。
 * 静默 no-op 会让这条判据永久失效，所以即使动作做不了，也要有一句话说出来。</p>
 */
const containerNavStatus = ref("");

function focusContainerTab(container: ContainerId, tabId: string): void {
    document
        .querySelector<HTMLElement>(
            '[data-testid="workspace-container-tab-' + container + "-" + tabId + '"]',
        )
        ?.focus();
}

function onContainerRowKey(payload: ContainerRowKeyPayload): void {
    if (payload.direction === null) {
        const outcome = resolveNavKey(payload.key, {
            rows: containerRows.value,
            current: payload.container,
            shift: payload.shift,
        });
        // 单行/没有行 ⇒ 什么都不做、也**不 preventDefault**（不夺走浏览器级 F6，`D-1600` ②）。
        if (outcome.kind !== "focus") return;
        payload.event.preventDefault();
        focusContainerTab(outcome.container, outcome.tabId);
        return;
    }
    const outcome = resolveMoveKey(payload.direction, {
        rows: containerRows.value,
        current: payload.container,
    });
    // 先清空再写：重复按同一个键时也要重新播报（aria-live 只在文本变化时说话）。
    containerNavStatus.value = "";
    containerNavStatus.value = t(
        outcome.reason === "no-neighbor"
            ? "workspace.containerMoveNoNeighbor"
            : "workspace.containerMoveModelPending",
    );
}

const dockTabs = computed<DockTab[]>(() =>
    layout.value.dockTabs.map((id) => ({ id, label: t(DOCK_TAB_LABEL_KEYS[id]) })),
);

const narrowViewport = useMediaQuery("(max-width: 1439px)");
const treeExpandedManually = ref(false);

const dockMode = computed<DockMode>(() =>
    layout.value.dockModeManual ? layout.value.dockMode : deriveDockMode(viewportWidth.value),
);

/**
 * S3b P1-2 (audit): the squeeze must consume the tree state **as rendered**. The
 * previous version fed the persisted `treeCollapsed` while the manual expansion
 * short-circuited outside of it, so the computed `mainWidth` assumed a 40px rail
 * that was actually 240px — the toast lied and the 640 floor could be breached.
 */
const treeCollapsedForSqueeze = computed(() =>
    treeExpandedManually.value ? false : layout.value.treeCollapsed || narrowViewport.value,
);

/**
 * S5-W2: the squeeze itself is owned by `useWorkspaceLayout` (single geometry
 * truth: it knows the viewport, the rail/panel offset and therefore whether the
 * navigation panel has to yield). This component only publishes the workbench-side
 * demand and reads the result back. When no layout provider exists (isolated unit
 * tests), it falls back to the same pure function with no nav panel to yield.
 */
const layoutOwner = inject(WORKSPACE_LAYOUT_KEY, null);

/**
 * PLAN-0626 D26-04: in focus mode the main column is not laid out at all (it stays
 * mounted but hidden), so there is nothing to protect. Publishing a demand would let
 * the anti-squeeze rules collapse the tree or force the dock back to floating for a
 * column nobody can see; `null` means "this workbench needs no width arbitration".
 */
/**
 * task-504（A 步，D-1413 同族）：把**实测**工作台行宽喂给挤压模型。
 *
 * 起因：模型原来自己算 `viewportWidth − (rail + navPanel)`，1024 档算 728（⇒ 认为 main 688 ≥ 640，
 * 不让位），而 DOM 里 main 只有 621（⇒ 本该让位）。差 ~67px 来自「viewport ≠ body」与工作台外壳 gutter。
 * 判据：模型输入必须是**实物量**（这个元素的 rect），派生量只能在没有 DOM 时兜底。
 */
const workbenchRootRef = ref<HTMLElement | null>(null);
/**
 * task-504：喂给模型的不是「工作台宽」，而是**外壳开销**（body 内容 − 导航 − 工作台）。
 * 工作台宽依赖导航宽、导航宽又是模型输出 ⇒ 直接喂会振荡（实测等稳定 20s 超时）；开销与导航宽无关。
 */
const chromeOverheadMeasured = ref(0);
let workbenchResizeObserver: ResizeObserver | null = null;

function observeWorkbenchWidth(): void {
    const el = workbenchRootRef.value;
    if (!el || typeof ResizeObserver === "undefined") return;
    workbenchResizeObserver?.disconnect();
    const sync = (): void => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        const bodyWidth = document.body.clientWidth;
        const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 0;
        const workbenchWidth = el.getBoundingClientRect().width;
        const overhead = bodyWidth - sidebarWidth - workbenchWidth;
        // 合理性夹取：滚动条 + 外壳 gutter 量级（0–200）。越界说明还没量全，宁可退回旧口径。
        chromeOverheadMeasured.value = overhead > 0 && overhead < 200 ? Math.round(overhead) : 0;
    };
    sync();
    workbenchResizeObserver = new ResizeObserver(sync);
    workbenchResizeObserver.observe(el);
}

watch(workbenchRootRef, (el) => {
    if (el) observeWorkbenchWidth();
});
onMounted(observeWorkbenchWidth);
onBeforeUnmount(() => {
    workbenchResizeObserver?.disconnect();
    workbenchResizeObserver = null;
});

const demand = computed<WorkbenchSqueezeDemand | null>(() => {
    if (layout.value.dockFocus && dockOpen.value) return null;
    return {
        chromeOverheadMeasured: chromeOverheadMeasured.value,
        treeWidth: layout.value.treeWidth,
        treeCollapsed: treeCollapsedForSqueeze.value,
        dockWidth: layout.value.dockWidth,
        dockOpen: dockOpen.value,
        dockMode: dockMode.value,
        // A manual expansion is an explicit choice: no automatic yielding, the dock
        // goes floating instead (the hard floor still overrides if that is not enough).
        allowTreeYield: !treeExpandedManually.value,
    };
});

watch(demand, (value) => layoutOwner?.setWorkbenchDemand(value), { immediate: true });
onBeforeUnmount(() => layoutOwner?.setWorkbenchDemand(null));

const squeeze = computed<WorkbenchSqueezeResult>(() => {
    if (layoutOwner) return layoutOwner.squeeze.value;
    const offset = viewportWidth.value || 0,
        currentDemand = demand.value;
    if (!currentDemand) {
        // Focus: nothing to squeeze (mirrors the owner's "no demand" result).
        return {
            mainWidth: offset,
            treeYielded: false,
            navYielded: false,
            forceFloating: false,
            treeOverflow: false,
        };
    }
    return computeWorkbenchSqueeze({
        workbenchWidth: offset,
        ...currentDemand,
        navPanelWidth: 0,
    });
});

/** Rendered dock mode: forced floating wins over the user's pinned choice. */
const renderedDockMode = computed<DockMode>(() =>
    squeeze.value.forceFloating ? "floating" : dockMode.value,
);
/** True when the pinned choice is being overruled so the UI can say why. */
const dockModeOverruled = computed(
        () => squeeze.value.forceFloating && dockMode.value === "pinned",
    ),
    /**
     * D26-04: the render projection of the focus flag. It only holds while the dock is
     * actually rendered — a stored `dockFocus` without an open dock cannot hide the main
     * column (that would be an empty workbench).
     */
    dockFocus = computed(() => dockOpen.value && layout.value.dockFocus);

const effectiveTreeCollapsed = computed(
    () => treeCollapsedForSqueeze.value || squeeze.value.treeYielded,
);

const treeWidth = computed(() => layout.value.treeWidth);
const treeBubbleRef = ref<HTMLElement | null>(null);

function setTreeWidth(width: number): void {
    layout.value.treeWidth = clampTreeWidth(width);
}

/**
 * PLAN-0753 T3 —— 文件树列（splitter panel #1）的桥接层，与导航面板同构：reka 拥有
 * 几何与指针拖拽，`@resize` 只喂宽度气泡（命令式文本），存储只经
 * release(`getSize()` 真值)/键盘/双击写入。折叠状态与宽度分开存（PLAN-0582 §1.5-A：
 * 收起不改宽度、展开回原宽），所以 `defaultSize` 是**展开宽**、`collapsedSize` 是 40px
 * rail —— reka 的 `collapsePanel` 只存 `panelSizeBeforeCollapseRef`，展开时恢复原宽。
 * 折叠桥接复用外壳已落地的 `navBridge` 同款 watcher 模式（`effectiveTreeCollapsed`）。
 */
const TREE_RESIZE_HANDLE_ID = "tree-resize-handle";
const treePanelCollapsed = computed(() => effectiveTreeCollapsed.value);
const treePanelEl = ref<SplitterPanelExposed | null>(null);

const treeBridge = useSplitterPanelBridge({
    clamp: clampTreeWidth,
    currentWidth: () => layout.value.treeWidth,
    commit: (width) => setTreeWidth(width),
    defaultWidth: TREE_WIDTH_DEFAULT,
    onKeyResize: (key) => {
        if (key === "ArrowLeft") return treeWidth.value - TREE_WIDTH_KEYBOARD_STEP;
        if (key === "ArrowRight") return treeWidth.value + TREE_WIDTH_KEYBOARD_STEP;
        if (key === "Home") return TREE_WIDTH_MIN;
        if (key === "End") return TREE_WIDTH_MAX;
        return null;
    },
    bubble: treeBubbleRef,
    // task-94 (B)：reka 侧收/发百分比，store 仍是 px。
    sizeUnit: { toPx: treePxOf, fromPx: treePercentOf },
    handleId: TREE_RESIZE_HANDLE_ID,
    isCollapsed: () => treePanelCollapsed.value,
});
const { resizing: treeResizing } = treeBridge;

/**
 * 每个 panel 实例只 bootstrap 一次（task-2 / 原 task-613 的修法）。
 *
 * 为什么必须这道门（根因，[实测] mock lane stack 探针）：Vue 的**函数 ref 在该 vnode 每次
 * patch 时都会被回调**（`@vue/runtime-core` 的 `patch()`：`if (ref != null && parentComponent)
 * setRef(...)`，而 `setRef` 对函数 ref 无条件 `rawRef(value, refs)`），reka 的 SplitterGroup
 * 每写一次 layout 就重渲染（`reka-ui@2.11.0 dist/Splitter/SplitterGroup.js:517` 的
 * `renderSlot(_ctx.$slots, "default", { layout: layout.value })`）⇒ **一次指针拖拽 = 每帧一次
 * patch = 每帧一次本函数**。bootstrap 若跟着每帧跑，就等于对同一实例反复 `resize(存储宽)`
 * （实测栈：`resizePanel` ← `useSplitterPanelBridge.ts` 的 `resizeToWidth` ← 本函数），
 * 把 reka 刚应用的拖拽增量整段撤销：拖拽帧 `prev=[17.28,82.72]` 被写回 `[20.73,79.27]`
 * （= 存储宽 240px / 组宽 1158），于是 rail 恒 240、aria-valuenow 恒 21、release 也写不到新值。
 * 键盘路径不走 patch（reka 的 resizeHandler 是 imperative），所以一直好使 —— 这就是
 * 「键盘通、指针静默失效」的全部差别。
 *
 * 保留 task-551 的语义：bootstrap 仍发生在**ref 投递同刻**（不靠 collapse 变化触发），
 * 所以窄视口首帧即折叠的情形照旧生效；只是「同一实例再次投递」不再重复执行。
 * 实例换了（工作区切换/重挂载，含卸载时的 `null` 投递）会重置这道门。
 */
let bootstrappedTreePanel: unknown = null;

function setTreePanel(el: unknown): void {
    treePanelEl.value = (el as SplitterPanelExposed | null) ?? null;
    if (!el) {
        bootstrappedTreePanel = null;
        return;
    }
    // task-551：`:ref` 在 253ms 就已经投递到组件实例（真栈打点：setTreePanel 多次调用、panelRef 已被赋值），
    // 所以修法就落在**这里**（与 ref 投递同刻），而不是再补一个 watcher。
    // 原来的 `watch(treePanelCollapsed)` 只在 false→true 变化时调 collapse()；而 1180 档该值挂载首帧
    // 就为 true（`narrowViewport` ≤1439 恒真）⇒ 永远没有变化 ⇒ collapse() 一次都不执行
    // （真栈打点 collapse 调用次数 = 0），rail 靠 v-if 已渲染 ⇒ 看着折叠、宽度仍是展开态（220px / main 597）。
    if (el === bootstrappedTreePanel) return;
    bootstrappedTreePanel = el;
    void nextTick(() => {
        // 折叠初始态**不**在这里 collapse()：reka 的 `collapsePanel` 要求 layout 已初始化
        // （`assert(panelSize != null)`），首帧常常还在那个窗口里 —— 原来的「每 patch 重投递」
        // 靠反复重试把这枪补上了，收成 once 之后就没有第二枪（实测：1180 档停在 expanded/220px，
        // task-2 回归读数）。折叠初值改由模板的 `:default-size` 承载：layout 初始化时就取
        // collapsedSize，不需要任何 imperative 调用（task-551 的语义因此**更强**，不再依赖时序）。
        if (treePanelCollapsed.value) return;
        treeBridge.resizeToWidth(treeWidth.value);
    });
}

watch(treePanelEl, (panel) => {
    treeBridge.panelRef.value = panel;
});

/**
 * store → 面板 的**显式**通道（task-2 / 原 task-613 修法的第二半，缺它就会把
 * 「拖拽被撤销」换成「宽度再也改不动」）。
 *
 * 为什么必须显式写：把 `setTreePanel` 收成「每实例一次」之后，「每次 patch 都重投递一次 store 宽」
 * 那条隐式通道没了 —— 而它在修复前是**唯一**把 `treeWidth` 写进 reka layout 的通用通道。其余
 * `resizeToWidth` 调用点各自只管一件事：键盘 `useSplitterPanelBridge.ts:143`、双击 `:155`、
 * 折叠态切换 `本文件:534`、nav 侧 `AppLayout.vue:182`。少了这条通用通道，凡不是这三条动作
 * 来源的宽度变更都会静默失效；最现实的一例就在 release 路径上：`clampTreeWidth` 会**取整**
 * （`useWorkspaceLayout.ts:183-186`），拖到 239.4 时 store 是 240 而面板停在 239.4，没人纠正。
 *
 * 与拖拽**不会打架**，两道判据：
 *   ① 结构判据：拖拽期间 store **根本不写** —— `commit` 只在 `onDragging(false)` / 键盘 / 双击
 *      三处被调（`useSplitterPanelBridge.ts:120/144/156`），`@resize` 只喂宽度气泡
 *      ⇒ 本 watcher 在拖拽帧逻辑上不可能触发。
 *   ② 兜底判据：`treeResizing`（= bridge 的 `draggingActive`）为真时直接 return —— 将来若有人
 *      在拖拽中写 store，也不会回灌成「自我强写」循环（那正是本次 bug 的形态）。
 * 折叠态同样跳过：折叠由 reka 的 `collapse()` 管，写回展开宽会把 40px rail 顶回去。
 *
 * 为什么监听里还有 `splitterWidth`（[实测] 没有它会假绿）：reka 侧收/发的是**百分比**
 * （task-94 B），px→% 用的是 `treePercentOf` 里的组宽；而组宽在挂载期是变长的
 * （宿主链有 `transition-[flex-grow] duration-300`，实测 410→1158）。用未稳的组宽换算出来的 %
 * 在组宽变大后就不再等于存储的 px：实测修掉每帧写回之后，拖到 200px 落盘、reload 起来渲染成
 * **207px**（17.8% × 1162）。所以组宽变化也要按存储 px 重算一次 —— 这同时就是
 * 「持久化是 px」这个契约的落点（窗口变宽时面板保持 px，而不是保持 %）。
 * 组宽只在窗口/容器变化时变，拖拽期不变 ⇒ 不会与拖拽打架；且 apply 只写 layout、不写 store、
 * 不改组宽 ⇒ 没有回灌环。
 */
useSplitterPanelWidthSync({
    width: treeWidth,
    groupSize: splitterWidth,
    isDragging: treeResizing,
    isCollapsed: () => treePanelCollapsed.value,
    apply: (widthPx) => treeBridge.resizeToWidth(widthPx),
});

// `treeCollapsed`（用户/窄视口收起）与 `treeYielded`（挤压让位）都是**渲染**状态：
// 它们走 collapse()/expand()，永不写存储宽度。
watch(
    treePanelCollapsed,
    (collapsed) => {
        if (collapsed) {
            treeBridge.collapse();
            return;
        }
        treeBridge.expand();
        // expand() 恢复 collapse 前宽度；窄视口等显示态变化后补一次 display 夹取（见 ruling ③）。
        treeBridge.resizeToWidth(treeWidth.value);
    },
    { flush: "post" },
);

/**
 * task-369 S1（D-1222）：dockview 壳开关。默认 false ⇒ 产品路径与两条既有判据
 * （`bl576` 的 `[data-panel-group]`、`task353` 的 `workspace-center` 祖先链）都不受影响；
 * 打开后才走「一个实例横跨中栏+右栏、树是可关可重开的面板」的模型。
 */
const dockviewEnabled = computed(
    () =>
        props.useDockview === true ||
        (globalThis as { __xhUseDockview?: boolean }).__xhUseDockview === true,
);

/**
 * 树面板「在不在容器里」。**S1 是组件内临时态**：持久化键仍只有 `xihe-layout-ws:<id>`
 * 那一份（D-1222 ⑥：不许另建一套布局状态）；把它收进既有 layout 对象是 S2 的事
 * （那要动 `useWorkspaceLayout.ts`，不在本卡 write_scopes 内）。
 * 折叠与关闭是**两个动作**（Lead 裁定①）：折叠 ⇒ 40px rail 仍在；关闭 ⇒ 面板与 rail
 * 一起消失，重开走容器组头的「+」（`WorkspaceShellDockview` 的 rightHeaderActions）。
 */
const treeOpen = ref(true);

/** 面板 id → 已本地化标题，喂给 dockview 壳（壳本身不新增 i18n 键）。 */
const dockPanelLabels = computed(() =>
    Object.fromEntries(dockTabs.value.map((tab) => [tab.id, tab.label])),
);

function closeTreePanel(): void {
    treeOpen.value = false;
}

/** 「+」菜单重开：target 由**被点击的组头**决定（中栏组 / dock 组），见壳组件判据③。 */
function reopenPanel(payload: { id: string; target: "center" | "dock" }): void {
    if (payload.id === "tree") {
        treeOpen.value = true;
        return;
    }
    if (isDockTabId(payload.id)) openDockTab(payload.id);
}

/** Pin/unpin is an explicit user choice: it wins over the breakpoint derivation. */
function toggleDockMode(): void {
    layout.value.dockMode = dockMode.value === "pinned" ? "floating" : "pinned";
    layout.value.dockModeManual = true;
}

// §4 rule 3 must not be silent: one toast per transition into forced floating.
// `immediate` matters — a window that is already too narrow on first paint would
// otherwise be forced floating without any explanation.
let squeezeToastShown = false;
watch(
    dockModeOverruled,
    (overruled) => {
        if (overruled && !squeezeToastShown) {
            squeezeToastShown = true;
            toast.warning(t("workspace.squeezeFloatingNotice"));
            return;
        }
        if (!overruled) squeezeToastShown = false;
    },
    { immediate: true },
);

// task-589：用户显式展开文件树后主列可能低于硬底线。产品裁定 = **允许破底线 + 给一次可见提示**
// （静默无效是最坏的：点击「展开」后界面毫无变化）。同样按「一次进入」计，不做逐帧刷屏。
let treeOverflowToastShown = false;
watch(
    () => squeeze.value.treeOverflow,
    (overflow) => {
        if (overflow && !treeOverflowToastShown) {
            treeOverflowToastShown = true;
            toast.warning(t("workspace.squeezeTreeOverflowNotice"));
            return;
        }
        if (!overflow) treeOverflowToastShown = false;
    },
    { immediate: true },
);

/**
 * Escape typed into a field belongs to that field (rename, search, composer), not to
 * the dock; an open dialog likewise owns Escape for its own dismissal.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Floating is not a modal (Lead ruling 2026-10-31): no backdrop, dismiss with Esc
// or by clicking the main column instead.
function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // An open dialog closes itself on Escape; do not also collapse the dock behind it.
    if (document.querySelector('[data-testid="modal-backdrop"]')) return;
    // Escape in a text field cancels that field's interaction, not the dock.
    if (isTextEntryTarget(event.target)) return;
    // PLAN-0626 D26-04: focus fills the row, so it needs a keyboard exit even though it
    // is laid out as a flex child (the floating-only rule below would ignore it).
    // Esc restores the previous layout instead of rolling the dock up.
    if (dockFocus.value) {
        exitDockFocus();
        return;
    }
    // A pinned panel is a deliberate layout choice: Escape must not close it, and a
    // squeeze-forced floating panel keeps the same body of behaviour (rendered mode).
    if (!dockOpen.value || renderedDockMode.value !== "floating") return;
    collapseDock();
}

if (typeof window !== "undefined") {
    window.addEventListener("keydown", handleWindowKeydown);
    onBeforeUnmount(() => window.removeEventListener("keydown", handleWindowKeydown));
}

/** Clicking the main column dismisses a floating dock (no overlay to click). */
function handleMainColumnPointerDown(): void {
    if (!dockOpen.value || renderedDockMode.value !== "floating") return;
    collapseDock();
}

function toggleTree(): void {
    // Below 1440px the tree yields by default; an explicit expand is session-scoped
    // and does not overwrite the user's persisted preference.
    if (narrowViewport.value) {
        treeExpandedManually.value = !treeExpandedManually.value;
        return;
    }
    layout.value.treeCollapsed = !layout.value.treeCollapsed;
}

/** Opening a tab that is already open keeps it, activates it and expands the dock. */
function openDockTab(id: DockTabId): void {
    const tabs = layout.value.dockTabs;
    if (!tabs.includes(id)) {
        // PLAN-0626 D26-06: the cap is a visible refusal, never a silent no-op.
        if (!canOpenDockTab(tabs.length)) {
            toast.warning(t("workspace.dockTabsFull"));
            return;
        }
        layout.value.dockTabs = [...tabs, id];
    }
    layout.value.activeDockTab = id;
    layout.value.dockCollapsed = false;
}

/** Toolbar toggles: pressing the active tab collapses the dock but keeps tabs/width. */
function toggleDockTab(id: DockTabId): void {
    if (dockOpen.value && activeDockTab.value === id) {
        layout.value.dockCollapsed = true;
        return;
    }
    openDockTab(id);
}

function setActiveDockTab(id: string): void {
    if (!isDockTabId(id) || !layout.value.dockTabs.includes(id)) return;
    layout.value.activeDockTab = id;
    layout.value.dockCollapsed = false;
}

/**
 * task-44（D-1440 / A 方案）：深链 `/workspace/{id}?agent=<principalId>` 的落地端。
 *
 * <p>为什么落点不是 `/workspace/{id}/agents`：**那个路由不存在**（`router/index.ts` 的
 * `/workspace/:workspaceId` 子路由里没有它）。智能体面板的真实宿主是 dock 的 `agents`
 * 页签，而页签状态归 `useWorkspaceLayout`（每个工作区一份、落 localStorage）—— 没有任何
 * URL 面能表达"打开哪个页签"。所以深链要落地，只能在这里把两者接起来：**URL 说目标主体，
 * 布局承担"哪个页签"**。为对齐卡面去新建一个空路由是被明令禁止的。</p>
 *
 * <p>手机视口没有 dock（那里由 `WorkspaceAgentManagementDialog` 承载），所以不碰布局 ——
 * 静默 return 是**有意的**：在手机上强行改桌面布局会把用户的页签集合写坏。</p>
 */
const route = useRoute();
const deepLinkAgentId = computed<string | null>(() => {
    const value = route.query.agent;
    return typeof value === "string" && value.length > 0 ? value : null;
});

watch(
    deepLinkAgentId,
    (principalId) => {
        if (!shouldOpenAgentsDockFromDeepLink(principalId, props.isMobile)) return;
        openDockTab("agents");
    },
    { immediate: true },
);

/**
 * Closing the last tab collapses the dock (ruling: closing the last one rolls it up).
 *
 * PLAN-0626 D26-13: closing the *active* tab activates its **nearest neighbour** (right
 * first, then left) — the browser-tab convention. Falling back to the first tab made
 * "close the 5th of 6" snap the dock back to the far left of the strip.
 */
function closeDockTab(id: string): void {
    const tabs = layout.value.dockTabs,
        // An unknown id stays a no-op (the dock renders string-generic ids).
        closingIndex = isDockTabId(id) ? tabs.indexOf(id) : -1,
        remaining = tabs.filter((tab) => tab !== id);
    if (closingIndex < 0) return;
    layout.value.dockTabs = remaining;
    if (layout.value.activeDockTab === id) {
        // After the filter `remaining[closingIndex]` is the tab that used to sit on the
        // right of the closed one; it is absent only when the closed tab was last.
        layout.value.activeDockTab = remaining[closingIndex] ?? remaining[closingIndex - 1] ?? null;
    }
    if (remaining.length === 0) {
        layout.value.dockCollapsed = true;
        layout.value.dockFocus = false;
    }
}

/** Collapse keeps the tab set and the width: collapse and width are independent. */
function collapseDock(): void {
    // Collapsing is itself the stored truth: `initialLayout` only applies the
    // "≥1800 opens the monitor" default while no geometry exists (S3b P1-1).
    layout.value.dockCollapsed = true;
    // D26-05/D26-04: collapsing the dock also leaves focus — one action, never a
    // half state where "focused" survives a hidden panel.
    layout.value.dockFocus = false;
}

/**
 * PLAN-0626 D26-04: expand/restore the dock across the whole workbench row.
 * Orthogonal to pinned/floating and to the width: both keep their values and simply
 * become visible again on restore.
 */
function toggleDockFocus(): void {
    if (!dockOpen.value) return;
    layout.value.dockFocus = !layout.value.dockFocus;
}

/** Esc/restore path: leaves focus only (never collapses the dock). */
function exitDockFocus(): void {
    layout.value.dockFocus = false;
}

function setDockWidth(width: number): void {
    layout.value.dockWidth = clampDockWidth(width);
}

function handleToggleCode(): void {
    if (props.isMobile) return;
    toggleDockTab("code");
}

function handleToggleChanges(): void {
    if (props.isMobile) {
        emit("mobile-toggle-changes");
        return;
    }
    toggleDockTab("changes");
}

function handleToggleMonitor(): void {
    if (props.isMobile) {
        emit("mobile-toggle-monitor");
        return;
    }
    toggleDockTab("monitor");
}

/**
 * BL-317 / D-198：成员面板的移动端入口。
 *
 * 桌面走 dock 的 `members` 标签（`toggleDockTab`）；移动端没有 dock，同一个工具栏按钮改为
 * 通知页面打开 aux sheet 的 `members` 页 —— 与 `handleToggleChanges`/`handleToggleMonitor` 同形，
 * 页面侧负责"再点一次收起"的语义。
 */
function handleToggleMembers(): void {
    if (props.isMobile) {
        emit("mobile-toggle-members");
        return;
    }
    toggleDockTab("members");
}

// PLAN-0365 (root cause B): selecting a file must surface the editor. The editor
// now lives in the dock's `code` tab, which is closed by default.
watch(
    () => ws.activeFilePath,
    (path) => {
        if (!path || props.isMobile) return;
        openDockTab("code");
    },
);

/**
 * PLAN-0626 M2: the chat column is rendered by the page (this component's `#center`
 * slot), so the "open the settings panel" entry has to reach the dock from outside.
 * The page calls this through a template ref — the same shape it already uses in the
 * opposite direction (`ChatPanel` exposes `insertMention`).
 */
defineExpose({ openDockTab });
</script>

<template>
    <div class="flex h-full min-w-0 flex-1 flex-col">
        <!--
            task-184（D-1600 ③）：键盘命令的无障碍播报出口。
            「按了没反应」与「合理 no-op」在屏幕阅读器里必须可区分 ⇒ 动作做不了时也要有一句话。
        -->
        <p
            role="status"
            aria-live="polite"
            data-testid="workspace-container-nav-status"
            class="sr-only"
        >
            {{ containerNavStatus }}
        </p>
        <WorkspaceToolbar
            :workspace-id="workspaceId"
            :code-open="isMobile ? false : codeOpen"
            :changes-open="
                isMobile ? (mobileChangesOpen ?? false) && mobileAuxTab === 'changes' : changesOpen
            "
            :monitor-open="
                isMobile ? (mobileChangesOpen ?? false) && mobileAuxTab === 'monitor' : monitorOpen
            "
            :members-open="isMobile ? false : membersOpen"
            :members-unread="membersUnread"
            :delegation-open="isMobile ? false : delegationOpen"
            @agents="emit('agents')"
            @files="emit('files')"
            @toggle-code="handleToggleCode"
            @toggle-changes="handleToggleChanges"
            @toggle-monitor="handleToggleMonitor"
            @toggle-members="handleToggleMembers"
            @toggle-delegation="toggleDockTab('delegation')"
        />

        <!-- Mobile keeps the editor-first body with files/chat as sheets (ruling #9). -->
        <div v-if="isMobile" class="flex min-h-0 min-w-0 flex-1 flex-col">
            <FileEditor />
        </div>

        <!--
            D-1207 甲案（task-353）：文件树不再是工作台的第三列，而是**中栏容器内部**的可折叠 panel。
            中栏容器 = `[data-testid="workspace-center"]` —— 判据①的指称物（D-1190 同族：没有名字的
            节点没法被断言）。内层 SplitterGroup 的两道 panel 仍是 [文件树 | 主区]，**与改造前同序**，
            因此几何（`treeWidth` px）、折叠语义与持久化键一个都不用改。
            PLAN-0753 T3 的 handle 净零宽约定（`-ml-1 w-1` ⇒ 主列起始位不变）照旧。
        -->
        <div
            v-else
            ref="workbenchRootRef"
            class="relative flex min-h-0 min-w-0 flex-1"
            data-testid="workspace-workbench"
        >
            <!--
                task-369 S1（D-1222）：dockview 壳 —— **一个实例横跨中栏+右栏**，树是它的面板，
                可关（面板与 rail 一起消失）、可从容器组头的「+」重开、投哪个容器由点哪个组头决定。
                只在 `dockviewEnabled` 时渲染；默认路径仍是下面的 reka SplitterGroup + 手写 dock，
                因此 `bl576` / `task353` 两条判据的指称物不受影响。
                树 rail 标记与 legacy 分支同形（testid 不变）；S1 无拖拽 ⇒ 不需要宽度气泡。
                S2 应把这段 rail 与 legacy 抽成共用件（现在两处同形，改一处必须改两处）。
            -->
            <div
                v-if="dockviewEnabled"
                data-testid="workspace-center"
                class="flex min-h-0 min-w-0 flex-1"
            >
                <WorkspaceShellDockview
                    :dock-tabs="layout.dockTabs"
                    :active-dock-tab="activeDockTab"
                    :tree-open="treeOpen"
                    :tree-collapsed="effectiveTreeCollapsed"
                    :tree-width="treeWidth"
                    :dock-width="layout.dockWidth"
                    :labels="dockPanelLabels"
                    :tree-label="t('workspace.expandFiles')"
                    :sash-label="t('workspace.treeResize')"
                    @update:active-dock-tab="setActiveDockTab"
                    @close-tab="closeDockTab"
                    @close-tree="closeTreePanel"
                    @reopen-panel="reopenPanel"
                    @resize-tree="setTreeWidth"
                >
                    <template #tree>
                        <div
                            data-testid="workspace-file-rail"
                            class="relative flex h-full flex-col border-r border-border bg-surface-canvas"
                        >
                            <!-- task-174（S2b）：树容器自己的页签行（容器子件，不再全局）。 -->
                            <WorkspaceContainerTabs
                                container-id="tree"
                                :tabs="treeContainerTabs"
                                :active-id="'tree'"
                                @row-key="onContainerRowKey"
                            />
                            <div
                                v-if="effectiveTreeCollapsed"
                                class="flex flex-col items-center gap-1 py-2"
                            >
                                <button
                                    type="button"
                                    data-testid="workspace-tree-expand"
                                    class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    :title="t('workspace.expandFiles')"
                                    :aria-label="t('workspace.expandFiles')"
                                    :aria-pressed="false"
                                    @click="toggleTree"
                                >
                                    <FolderTree class="size-4" aria-hidden="true" />
                                </button>
                            </div>
                            <div
                                v-else
                                class="flex h-full min-h-0 flex-1 flex-col"
                                data-testid="workspace-file-tree"
                            >
                                <FileTreePanel @collapse="toggleTree" />
                            </div>
                        </div>
                    </template>
                    <template #center>
                        <div
                            data-testid="workspace-main"
                            class="flex min-w-0 flex-1 flex-col bg-card"
                            @mousedown="handleMainColumnPointerDown"
                        >
                            <slot name="center" />
                        </div>
                    </template>
                    <template v-for="tab in dockTabs" :key="tab.id" #[tab.id]>
                        <WorkspaceDockPanelContent
                            :id="tab.id"
                            :session-id="sessionId"
                            :workspace-id="workspaceId"
                            @close="collapseDock"
                            @mention="emit('mention', $event)"
                        />
                    </template>
                </WorkspaceShellDockview>
            </div>
            <div v-else data-testid="workspace-center" class="flex min-h-0 min-w-0 flex-1 flex-col">
                <!--
                    task-174 / D-1545：窄屏「两栏仍然是两栏，同时只显示单栏、可以切换」的切换控件。
                    只在 single 形态渲染（今天即移动壳）；桌面形态不出现，不影响现有布局。
                -->
                <WorkspaceContainerSwitcher
                    v-if="containerMode === 'single'"
                    :active-column="layout.activeColumn"
                    @update:active-column="setActiveColumn"
                />
                <SplitterGroup
                    ref="centerGroupRef"
                    direction="horizontal"
                    class="flex min-h-0 min-w-0 flex-1"
                    @keydown.capture="treeBridge.onKeydownCapture"
                >
                    <!-- Left column: the file tree. S3b: draggable 200-320 + keyboard + dblclick. -->
                    <SplitterPanel
                        :ref="setTreePanel"
                        as-child
                        size-unit="%"
                        collapsible
                        :default-size="
                            treePanelCollapsed ? treeCollapsedPercent : treeDefaultPercent
                        "
                        :min-size="treeMinPercent"
                        :max-size="treeMaxPercent"
                        :collapsed-size="treeCollapsedPercent"
                        @resize="treeBridge.onResize"
                    >
                        <div
                            data-testid="workspace-file-rail"
                            class="relative flex h-full shrink-0 flex-col border-r border-border bg-surface-canvas"
                            :class="{
                                'is-resizing': treeResizing,
                            }"
                        >
                            <!-- task-174（S2b）：树容器自己的页签行（容器子件，不再全局）。 -->
                            <WorkspaceContainerTabs
                                container-id="tree"
                                :tabs="treeContainerTabs"
                                :active-id="'tree'"
                                @row-key="onContainerRowKey"
                            />
                            <div
                                v-if="effectiveTreeCollapsed"
                                class="flex flex-col items-center gap-1 py-2"
                            >
                                <button
                                    type="button"
                                    data-testid="workspace-tree-expand"
                                    class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    :title="t('workspace.expandFiles')"
                                    :aria-label="t('workspace.expandFiles')"
                                    :aria-pressed="false"
                                    @click="toggleTree"
                                >
                                    <FolderTree class="size-4" aria-hidden="true" />
                                </button>
                            </div>
                            <div
                                v-else
                                class="flex h-full min-h-0 flex-1 flex-col"
                                data-testid="workspace-file-tree"
                            >
                                <!-- S3a: tree panel head (workspace name / file actions / collapse). -->
                                <FileTreePanel @collapse="toggleTree" />
                            </div>

                            <!--
                            PLAN-0753 T3: 宽度气泡的显隐由桥接 `resizing` 驱动，文本由桥接在
                            `@resize` 里命令式写入（textContent）——不建响应式宽度通道。
                        -->
                            <span
                                v-if="treeResizing"
                                ref="treeBubbleRef"
                                data-testid="tree-resize-bubble"
                                aria-hidden="true"
                                class="pointer-events-none absolute -right-1 top-1/2 z-30 translate-x-full -translate-y-1/2 rounded bg-foreground/85 px-1.5 py-0.5 text-xs tabular-nums text-background"
                            />
                        </div>
                    </SplitterPanel>
                    <!-- testid/aria 走 fallthrough（与导航 handle 同口径）；⋮ 抓手是 SashGrip 子件（PLAN-0762 M4）。 -->
                    <SplitterResizeHandle
                        v-if="!treePanelCollapsed"
                        id="tree-resize-handle"
                        data-testid="tree-resizer"
                        aria-orientation="vertical"
                        :aria-label="t('workspace.treeResize')"
                        :aria-valuenow="treeWidth"
                        :aria-valuemin="TREE_WIDTH_MIN"
                        :aria-valuemax="TREE_WIDTH_MAX"
                        class="group/sash relative z-10 -ml-1 w-1 cursor-col-resize transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                        @dragging="treeBridge.onDragging"
                        @dblclick="treeBridge.onDblclick"
                    >
                        <SashGrip testid="tree-resizer-grip" />
                    </SplitterResizeHandle>

                    <!--
                Center: the routed main content (chat / environment / settings).
                D26-04: focus hides this column with `v-show` (never `v-if`) — unmounting
                ChatPanel would drop its SSE subscription and the streaming state mid-run
                (`useSSE.ts:555-557`), so the column stays mounted and merely stops taking
                layout space.
            -->
                    <!-- task-94 (B)：主列也用 %（组里只要还剩一个 px 面板，layout 就可能永不初始化）。 -->
                    <SplitterPanel
                        class="flex min-w-0"
                        size-unit="%"
                        :default-size="mainDefaultPercent"
                    >
                        <div
                            v-show="!dockFocus"
                            data-testid="workspace-main"
                            class="flex min-w-0 flex-1 flex-col bg-card"
                            :data-main-hidden="dockFocus ? 'true' : 'false'"
                            @mousedown="handleMainColumnPointerDown"
                        >
                            <!-- task-174（S2b）：内容容器页签行（页面/会话页签归这里）。 -->
                            <WorkspaceContainerTabs
                                container-id="main"
                                :tabs="mainContainerTabs"
                                :active-id="mainContainerActiveId"
                                @select="selectWorkspaceTab($event)"
                                @close="closeWorkspaceTab($event)"
                                @row-key="onContainerRowKey"
                            />
                            <slot name="center" />
                        </div>
                    </SplitterPanel>
                </SplitterGroup>
            </div>
            <WorkspaceDock
                v-if="dockOpen && activeDockTab"
                :tabs="dockTabs"
                :active-tab="activeDockTab"
                :width="layout.dockWidth"
                :mode="renderedDockMode"
                :default-width="DOCK_WIDTH_DEFAULT"
                :focus="dockFocus"
                @update:active-tab="setActiveDockTab"
                @close-tab="closeDockTab"
                @close="collapseDock"
                @update:width="setDockWidth"
                @toggle-mode="toggleDockMode"
                @toggle-focus="toggleDockFocus"
            >
                <template #code>
                    <WorkspaceDockPanelContent
                        id="code"
                        :session-id="sessionId"
                        :workspace-id="workspaceId"
                        @close="collapseDock"
                        @mention="emit('mention', $event)"
                    />
                </template>
                <template #changes>
                    <WorkspaceDockPanelContent
                        id="changes"
                        :session-id="sessionId"
                        :workspace-id="workspaceId"
                        @close="collapseDock"
                        @mention="emit('mention', $event)"
                    />
                </template>
                <template #monitor>
                    <WorkspaceDockPanelContent
                        id="monitor"
                        :session-id="sessionId"
                        :workspace-id="workspaceId"
                        @close="collapseDock"
                        @mention="emit('mention', $event)"
                    />
                </template>
                <template #members>
                    <WorkspaceDockPanelContent
                        id="members"
                        :session-id="sessionId"
                        :workspace-id="workspaceId"
                        @close="collapseDock"
                        @mention="emit('mention', $event)"
                    />
                </template>
                <template #context>
                    <WorkspaceDockPanelContent
                        id="context"
                        :session-id="sessionId"
                        :workspace-id="workspaceId"
                        @close="collapseDock"
                        @mention="emit('mention', $event)"
                    />
                </template>
                <template #delegation>
                    <WorkspaceDockPanelContent
                        id="delegation"
                        :session-id="sessionId"
                        :workspace-id="workspaceId"
                        @close="collapseDock"
                        @mention="emit('mention', $event)"
                    />
                </template>
                <template #agents>
                    <WorkspaceDockPanelContent
                        id="agents"
                        :session-id="sessionId"
                        :workspace-id="workspaceId"
                        :agent-id="deepLinkAgentId"
                        @close="collapseDock"
                        @mention="emit('mention', $event)"
                    />
                </template>
            </WorkspaceDock>
        </div>
    </div>
</template>

<style scoped>
/*
 * Resize-follow fix for the file rail: same contract as the dock/sidebar — the rail
 * follows the pointer via a direct width write and its content stops hit-testing.
 */
.is-resizing {
    will-change: width;
}

.is-resizing :deep(*) {
    pointer-events: none;
}
</style>
