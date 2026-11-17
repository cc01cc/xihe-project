<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useWindowSize } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { FolderTree, Plus } from "@lucide/vue";
import {
    DOCK_WIDTH_DEFAULT,
    TREE_COLLAPSED_WIDTH,
    canOpenDockTab,
    clampDockWidth,
    clampTreeWidth,
    WORKSPACE_LAYOUT_KEY,
    computeWorkbenchSqueeze,
    createWorkspaceLayoutWriter,
    defaultWorkspaceLayout,
    defaultWorkspaceLayoutForViewport,
    hasWorkspaceLayout,
    isDockTabId,
    readWorkspaceLayout,
    type DockTabId,
    type WorkbenchSqueezeDemand,
    type WorkbenchSqueezeResult,
    type WorkspaceLayoutState,
} from "../../../composables/useWorkspaceLayout";
import { workspacePath } from "../../../lib/routes";
import { useWorkspaceStore } from "../stores/workspace";
import { useSessionParticipantsStore } from "../stores/sessionParticipants";
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
    visibleContainers,
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
 * renders the two containers (main + right; D-1777/D-1778, task-65 A 段); `WorkspaceView` stays a data-assembly layer.
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

/**
 * task-174 / `D-1545`：**形态只决定看得见哪一栏**，不改归属。
 *
 * <p>今天 `single` 只在移动壳（`isMobile`）成立，而移动壳现在渲染的是 `<FileEditor />`
 * （`D-1544` 遗留：真正的窄屏渲染由移动壳卡接通）⇒ 这一层现在是**形状就位、产品面不触发**，
 * 由单测钉住。桌面形态下 `visibleContainers` 返回全部 ⇒ 行为与本卡之前完全一致。</p>
 */
const containerMode = computed<ContainerMode>(() =>
    props.isMobile || forceSingleColumn.value ? "single" : "desktop",
);

/**
 * task-94 S4（`D-1545`）：单栏时**只渲染当前那一栏**，另一栏仍在（切换器一键回来）。
 * 判据来源是 `visibleContainers`（`containers.ts` 的纯函数，已有单测），这里不另写一份可见性规则。
 */
/**
 * task-94 S4 修正（Lead 2026-11-17 20:10 评审）：**「收起后必须看得见东西」是状态约束，不是动作副作用**。
 *
 * <p>上一版把它写成 `collapseDock()` 里的一行 `activeColumn = "main"`，于是每个不走
 * `collapseDock()` 的收起路径都漏一次 —— 评审当天就有两处（`toggleDockTab` 的「再按一次活动页签」、
 * `closeDockTab` 的「关掉最后一个页签」）。症状是**白屏**：单栏 + 当前栏是 right + 右栏因
 * `dockOpen=false` 不渲染，而中栏又被 `visibleContainers` 判成不可见 ⇒ 整行只剩顶部切换器。</p>
 *
 * <p>改成派生后只有一个判定点，未来新增的收起路径**自动被覆盖**；且用户的栏偏好不再被抹掉
 * （收起 → 显示中栏；重开右栏 ⇒ 回到右栏，而不是每次都重置成 main）。</p>
 */
const effectiveActiveColumn = computed<ActiveColumn>(() =>
    containerMode.value === "single" && !dockOpen.value && layout.value.activeColumn === "right"
        ? "main"
        : layout.value.activeColumn,
);
const visibleColumns = computed<readonly ContainerId[]>(() =>
    visibleContainers(containerMode.value, effectiveActiveColumn.value),
);
const mainVisible = computed(() => visibleColumns.value.includes("main"));
const rightVisible = computed(() => visibleColumns.value.includes("right"));

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
    // D-1777/D-1778：右栏行页签 testid 沿用既有 dock-tab-* 契约（66+ 消费点，不得改名），
    // 所以在行内按 data-tab-id 找；main 行仍走 workspace-container-tab-<container>-<id>。
    // task-144 ①（P0，a11y）：**选择器必须落在页签本体上**。`data-tab-id` 与 `role="tab"`
    // 挂在**同一个** `TabsTrigger`（`WorkspaceContainerTabs.vue:157-166`）⇒ 旧的
    // `[data-tab-id="X"] [role="tab"]`（后代选择器）恒匹配 0 个，`.focus()` 无声 no-op：
    // F6 的右栏一半完全不通且控制台干净（真浏览器实测：修前 activeElement 停在
    // `workspace-container-tab-main-*`，右栏行选择器命中 0 / 新选择器命中 1）。
    const selector =
        container === "right"
            ? '[data-testid="workspace-container-tabs"][data-container="right"] [data-tab-id="' +
              tabId +
              '"]'
            : '[data-testid="workspace-container-tab-' + container + "-" + tabId + '"]';
    document.querySelector<HTMLElement>(selector)?.focus();
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

/**
 * task-94 S2：树**不再是行内列**（它是右栏的 `files` 页签），所以「挤压模型要吃树的渲染态」
 * 这一层整条退场，随之退场三个启发式：
 *
 * - `treeCollapsedForSqueeze`（喂给模型的树态）—— 模型里没有树项，无输入可喂；
 * - `treeExpandedManually`（手工展开盖过自动让位）—— 没有自动让位可盖；
 * - `narrowViewport ⇒ 树自动折叠`（「树是独立列、窄屏先让它让位」时代的规则）—— 树已在右栏里，
 *   窄屏腾空间改由**单栏切换**做（`forceSingleColumn`）。折叠现在只跟用户的 `treeCollapsed`。
 *
 * <p>留着会怎样：窄屏下这个启发式把 `treeCollapsed` 伪造成「折叠」，用户在单栏里打开右栏看到的
 * 是一条 40px rail 而不是树 —— 即 task-144 ③ 修掉的「折叠吞掉右栏」换一个入口再来一次。</p>
 */

/**
 * S5-W2: the squeeze itself is owned by `useWorkspaceLayout` (single geometry
 * truth: it knows the viewport, the rail/panel offset and therefore whether the
 * navigation panel has to yield). This component only publishes the workbench-side
 * demand and reads the result back. When no layout provider exists (isolated unit
 * tests), it falls back to the same pure function with no nav panel to yield.
 */
const layoutOwner = inject(WORKSPACE_LAYOUT_KEY, null);

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

/**
 * D-1777/D-1778（task-65 A 段）：右栏容器行页签 = dock 页签（含 files 树面板）。
 * 与 WorkspaceDock 的 chips 同一份数据（Q2：复用既有 dock tab 数据，不新造 IA）。
 */
const rightContainerTabs = computed(() =>
    dockTabs.value.map((tab) => ({ id: tab.id, label: tab.label, closable: true })),
);

/** files（目录树）面板开没开：树是右栏的一个 dock 页签（D-1777/D-1778 第 10 行 (a)）。 */
const filesPanelOpen = computed(() => layout.value.dockTabs.includes("files"));

/**
 * 右栏行渲染与否（F6 的可遍历行必须真的渲染了，containerTabNav 的约定）。
 *
 * <p>**task-144 ③**（Lead 2026-11-17 批）：折叠 `treeCollapsed` **不再移走整行** ——
 * 行是否存在只由 `dockOpen` 决定。</p>
 *
 * <p>为什么改：此前 rail 被提到整栏位置、与 `WorkspaceDock` 做 `v-if`/`v-else-if` 互斥 ⇒
 * 折叠树把**整个右栏**（行 + monitor/code/changes/members/context/agents/delegation）换成 40px rail。
 * 真浏览器实测（1920×1080，手写路径，dockTabs=[files,monitor,code]）折叠后：
 * `workspace-container-tabs[data-container="right"]` false、`workspace-aux-panel` false、
 * `dock-active-panel` false、`dock-tab-code|monitor` 命中 **0** ⇒「折叠树」等于「右栏消失」，
 * BL-561 的另一半页签全部不可达。</p>
 *
 * <p>折叠现在的落点 = `files` 的**面板体**（`#files` slot 里的 `workspace-file-rail`，40px，
 * 见模板）。语义是「这个面板收起来」，不是「把右栏还给主列」；真正腾空间的是单栏切换
 * （task-94 S4），两件事不混。**已知取舍（裁定接受）**：折叠**不回收列宽**，右栏仍是 `dockWidth`。</p>
 */
const rightRowRendered = computed(() => dockOpen.value && rightVisible.value);

/**
 * task-184（D-1600 ①②）：渲染出来的容器行，顺序 = 渲染顺序。
 * D-1777/D-1778：行集合 = {main, right}；右栏行在 dock 渲染时恒存在（折叠只收 files 面板体，
 * task-144 ③ —— 折叠态按 F6 仍能落到右栏行激活页签，真浏览器实测 activeElement=dock-tab-monitor）。
 */
const containerRows = computed<ContainerRow[]>(() => {
    const rows: ContainerRow[] = [
        { container: "main", tabs: mainContainerTabs.value, activeId: mainContainerActiveId.value },
    ];
    if (rightRowRendered.value) {
        rows.push({
            container: "right",
            tabs: rightContainerTabs.value,
            activeId: activeDockTab.value,
        });
    }
    return [...rowsForMode(rows, containerMode.value, layout.value.activeColumn)];
});
onMounted(observeWorkbenchWidth);
onBeforeUnmount(() => {
    workbenchResizeObserver?.disconnect();
    workbenchResizeObserver = null;
});

/**
 * task-158：**焦点态也必须发布 demand** —— 焦点只改「谁占满这一行」，不改「这一行有多宽」。
 *
 * <p>旧行为是 focus 时 `return null`，理由是 D26-04 时代「主列不参与布局 ⇒ 没有东西要保护」。
 * 但模型除「保护主列」之外还输出**导航面板是否让位**，那是行宽的分配决定、与主列可见性无关；
 * 整段释放会连让位一起撤销。1440 档实测（2026-11-17，ui-41）：进 focus 前导航已让位
 * （渲染 57.03、模型 `navYielded=true`），释放后回涨 **280.36px**（57.03 → 337.39）⇒
 * 被「放大」的右栏反而少了同样多的宽度（1316.97 → 1036.61）。按钮叫「放大面板」，
 * 却把面板压窄 —— 这是方向反了。</p>
 *
 * <p>⇒ 焦点与常态发布**同一个** demand：模型输入不变 ⇒ `navYielded` / `navPanelWidth` /
 * `forceSingleColumn` 都不变 ⇒ 行宽与形态在焦点前后逐项相等。1920 档本来零变化（导航从未
 * 让位），修后仍零变化，它就是「这条规则没有额外副作用」的对照组。</p>
 */

/** What the workbench needs from the geometry owner — **focus-independent** (task-158). */
const demand = computed<WorkbenchSqueezeDemand>(() => ({
    chromeOverheadMeasured: chromeOverheadMeasured.value,
    dockWidth: layout.value.dockWidth,
    dockOpen: dockOpen.value,
}));

watch(demand, (value) => layoutOwner?.setWorkbenchDemand(value), { immediate: true });
onBeforeUnmount(() => layoutOwner?.setWorkbenchDemand(null));

/**
 * 无 provider 的兜底（隔离单测）：同一个纯函数，但没有导航面板可让（`navPanelWidth: 0`）。
 * task-158 起这里不再有「焦点态免挤压」的分支 —— demand 已与焦点无关，兜底自然同口径。
 */
const squeeze = computed<WorkbenchSqueezeResult>(() =>
    computeWorkbenchSqueeze({
        workbenchWidth: viewportWidth.value || 0,
        ...demand.value,
        navPanelWidth: 0,
    }),
);

/**
 * D26-04: the render projection of the focus flag. It only holds while the dock is
 * actually rendered — a stored `dockFocus` without an open dock cannot hide the main
 * column (that would be an empty workbench).
 */
const dockFocus = computed(() => dockOpen.value && layout.value.dockFocus);

/**
 * task-94 S2 / S4：**单栏判定由挤压模型给出，不由视口数字给出**（Lead 2026-11-17：
 * 「1280 切单栏」是口语，实施必须换算成约束式 `主列会 <640 就切`，否则换个 dock 宽就错）。
 *
 * <p>等价阈值实测：会话列 260 ⇒ 1382；会话列 280 ⇒ 1402；随 dock 宽 320–480 移动
 * （见 `internal/A03-xihe/evidence/2026-11-17-task94-dock-tree/README.md` §5）。</p>
 */
const forceSingleColumn = computed(() => squeeze.value.forceSingleColumn);

/** 折叠只跟用户的持久值（S2：树不再进挤压模型，也没有窄屏自动折叠）。 */
const effectiveTreeCollapsed = computed(() => layout.value.treeCollapsed);

const treeWidth = computed(() => layout.value.treeWidth);

function setTreeWidth(width: number): void {
    layout.value.treeWidth = clampTreeWidth(width);
}

/**



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

/**
 * task-94 S1/S2：两条一次性提示随各自的机制退场，**不是被静音** —— 它们提示的两件事都不再发生：
 *
 * - 「右栏被挤压成浮窗」提示（task-162 ②：locale 键已删）：浮窗没了，挤压的出口改成单栏，
 *   单栏切换器本身就是可见的状态指示（用户在右栏 / 在中栏，一眼可见，不需要 toast 解释）；
 * - 「树展开后主列破 640」提示（task-162 ②：locale 键已删）：树不再占行宽 ⇒ 破不了。
 */
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

/**
 * Escape 只剩一件事：退出 focus（D26-04）。**「关闭浮窗」那条规则随浮窗退场**（task-94 S1）——
 * pinned 右栏是用户的持久选择，Escape 不该关它；旧代码那条分支在 pinned 下本来就是 no-op，
 * 留着它只会让人以为「还有浮窗形态」。
 */
function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // An open dialog closes itself on Escape; do not also collapse the dock behind it.
    if (document.querySelector('[data-testid="modal-backdrop"]')) return;
    // Escape in a text field cancels that field's interaction, not the dock.
    if (isTextEntryTarget(event.target)) return;
    // PLAN-0626 D26-04: focus fills the row, so it needs a keyboard exit.
    if (dockFocus.value) exitDockFocus();
}

if (typeof window !== "undefined") {
    window.addEventListener("keydown", handleWindowKeydown);
    onBeforeUnmount(() => window.removeEventListener("keydown", handleWindowKeydown));
}

/**
 * 折叠 = 这个面板收起来（不是把右栏还给主列，也不是关掉 files 页签）。
 * task-94 S2：窄屏自动折叠的启发式退场 —— 窄屏腾空间现在由单栏切换做，折叠只跟用户点的那一下。
 */
function toggleTree(): void {
    layout.value.treeCollapsed = !layout.value.treeCollapsed;
}

/**
 * task-94 S4（`D-1545`）：单栏形态下「右栏可见」= 当前那一栏就是右栏。
 *
 * <p>没有这一步，窄屏点工具栏上的 files/code 会**什么都不发生**（右栏是渲染了，但被单栏规则挡在
 * 视口外）—— 那正是本卡要治的「按了没反应」。所以凡是「用户要右栏」的动作，都先把活跃栏切过去。</p>
 */
function revealRightColumn(): void {
    if (containerMode.value === "single") layout.value.activeColumn = "right";
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
    revealRightColumn();
}

/**
 * task-97（D-1754 ②）：main 行「+」= 新建会话。与工具栏 `WorkspaceToolbar.newChat()` 同一机制
 * （`?newChat=1` 由 `WorkspaceView` 的 watcher 消费并创建会话），不新造第二条新建路径。
 */
function openNewMainTab(): void {
    router.push({ path: workspacePath(props.workspaceId), query: { newChat: "1" } });
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
    revealRightColumn();
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
const router = useRouter();
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
    // 单栏下「收起后看得见中栏」由 *effectiveActiveColumn* 派生兜住（见该 computed 的注释）——
    // 这里**不写** activeColumn，用户的栏偏好要留着：重开右栏就回到右栏。
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
    // task-94 S4：focus 是「右栏占满整行」，所以它必须让右栏成为当前栏（单栏形态下尤其）。
    if (!layout.value.dockFocus) revealRightColumn();
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
            :files-open="isMobile ? false : dockOpen && filesPanelOpen"
            @toggle-files="toggleDockTab('files')"
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
        D-1777/D-1778（task-65 A 段）：两栏各自是一个容器 —— 中栏（main，会话页签 + 路由内容）
        与右栏（right，dock 页签行 + 面板身体）。**目录树是右栏的 files 面板**（不占独立容器行、
        不参与容器级页签之外的特殊通道）；树宽 = 右栏 dock 宽（splitter 语义已退场，第 10 行 (a) 的已接受代价）。
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
                <!-- task-162 ③：单栏投影（D-1545 同构）—— 只接这两个派生 prop，单一 writer 不变。 -->
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
                    :container-mode="containerMode"
                    :active-column="effectiveActiveColumn"
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
                                container-id="right"
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
                        >
                            <slot name="center" />
                        </div>
                    </template>
                    <template v-for="tab in dockTabs" :key="tab.id" #[tab.id]>
                        <WorkspaceDockPanelContent
                            :id="tab.id"
                            :session-id="sessionId"
                            :workspace-id="workspaceId"
                            @collapse-tree="toggleTree"
                            @close="collapseDock"
                            @mention="emit('mention', $event)"
                        />
                    </template>
                </WorkspaceShellDockview>
            </div>
            <!--
                task-81（D-1796 同族）：focus 时**中栏整列退场**，不只是把里面那一列藏起来。

                原来的写法只给 `workspace-main` 加了 `v-show="!dockFocus"`，而
                `workspace-center`（它的祖父，两个 `flex-1` 包装层之一）**照样 `flex-grow:1`**
                ⇒ 一个内容全空的盒子仍跟右栏各拿 50%。实测（1920×1080，focus 态）：
                `center 758.30 + dock 759.31 = workbench 1517.61`，即 `dock/workbench = 0.5003`
                —— 用户看到的就是「放大面板只占半页」的 758px 空白。
                把中栏设成 `display:none`（只改 DOM 的对照实验）⇒ 右栏立刻吃满 100.0%（三档视口全中）。

                **必须是 v-show 不能是 v-if**：D26-04 要求 ChatPanel 保持挂载 —— 卸载它会丢掉
                SSE 订阅与流式状态（`useSSE.ts:555-557`）。这里只是让整列不参与布局。
                `workspace-main` 自己那条 `v-show` 保留：单测与 e2e 断的就是它的 `style.display`。
            -->
            <div
                v-else
                v-show="!dockFocus"
                data-testid="workspace-center"
                class="flex min-h-0 min-w-0 flex-1 flex-col"
            >
                <!--
                    task-174 / D-1545：窄屏「两栏仍然是两栏，同时只显示单栏、可以切换」的切换控件。
                    只在 single 形态渲染（今天即移动壳）；桌面形态不出现，不影响现有布局。
                -->
                <WorkspaceContainerSwitcher
                    v-if="containerMode === 'single'"
                    :active-column="effectiveActiveColumn"
                    @update:active-column="setActiveColumn"
                />
                <!--
                D-1777/D-1778：中栏容器 = 会话页签行 + 路由内容。**树列已搬走**（右栏 files 面板）。
            -->
                <div class="flex min-h-0 min-w-0 flex-1">
                    <!--
                    D26-04: focus hides this column with v-show (never v-if) — unmounting
                    ChatPanel would drop its SSE subscription and the streaming state mid-run,
                    so the column stays mounted and merely stops taking layout space.
                -->
                    <div
                        v-show="!dockFocus && mainVisible"
                        data-testid="workspace-main"
                        class="flex min-w-0 flex-1 flex-col bg-card"
                        :data-main-hidden="dockFocus ? 'true' : 'false'"
                        :data-main-column-visible="mainVisible ? 'true' : 'false'"
                    >
                        <!--
                            task-174（S2b）：内容容器页签行（页面/会话页签归这里）。
                            task-155：maxVisibleTabs=8 —— 溢出策略上限（照右栏 WorkspaceDock 形态）。
                            依据：1920 视口约 11 页签溢出 ⇒ 8 留余量；窄视口溢出由下拉兜
                            （固定上限、不做动态测量）；不传 = 旧行为（右栏/树行不传）。
                        -->
                        <WorkspaceContainerTabs
                            container-id="main"
                            :tabs="mainContainerTabs"
                            :active-id="mainContainerActiveId"
                            allow-empty
                            :max-visible-tabs="8"
                            @select="selectWorkspaceTab($event)"
                            @close="closeWorkspaceTab($event)"
                            @row-key="onContainerRowKey"
                        >
                            <!--
                                task-97（D-1754 ②）：main 行「+」= 新建会话，落在行尾 actions 槽的
                                簇内首项（紧贴页签右侧）。0 页签时行仍渲染（allowEmpty，D-1757 裁③ 只给 main）。
                            -->
                            <template #actions>
                                <button
                                    type="button"
                                    data-testid="workspace-container-plus-main"
                                    class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    :aria-label="t('sidebar.newChat')"
                                    :title="t('sidebar.newChat')"
                                    @click="openNewMainTab"
                                >
                                    <Plus class="size-3.5" aria-hidden="true" />
                                </button>
                            </template>
                        </WorkspaceContainerTabs>
                        <slot name="center" />
                    </div>
                </div>
            </div>
            <!--
                D-1777/D-1778 第 5 行：折叠 ≠ 关闭。折叠 = `treeCollapsed` ⇒ **`files` 面板体**收成
                TREE_COLLAPSED_WIDTH 的 rail（`workspace-file-rail` 仍在、`workspace-tree-expand` 一键展开，
                见下方 `#files` slot）；关闭 = files 页签从右栏行关掉（或 dockCollapsed 整列收起），
                重开走工具栏 workspace-toolbar-files。

                task-144 ③：**rail 不再与整个右栏二选一** —— 那一版把「折叠树」变成「右栏消失」，
                monitor/code/changes 一并不可达（实测读数见 `rightRowRendered` 上方注释）。

                task-144 ②（P1）：**右栏归属 dockview 壳时不许再画手写右栏**。
                本块是手写路径的右栏（`WorkspaceDock`），而 `dockviewEnabled` 时右栏由
                `WorkspaceShellDockview` 里那个跨栏实例承载 ⇒ 两块同时渲染就是两套右栏：
                实测（1920×1080，`__xhUseDockview=true`）展开态 `dock-active-panel` 仍在、
                折叠态 `workspace-file-rail` 解析到 **2 个**（DOM 序：壳内 rail + 旧的本块 rail）。
            -->
            <WorkspaceDock
                v-if="!dockviewEnabled && dockOpen && activeDockTab && rightVisible"
                :tabs="dockTabs"
                :active-tab="activeDockTab"
                :width="layout.dockWidth"
                :fill="containerMode === 'single'"
                :default-width="DOCK_WIDTH_DEFAULT"
                :focus="dockFocus"
                @update:active-tab="setActiveDockTab"
                @close-tab="closeDockTab"
                @close="collapseDock"
                @update:width="setDockWidth"
                @toggle-focus="toggleDockFocus"
                @row-key="onContainerRowKey"
                @reopen-tab="openDockTab"
            >
                <!--
                    D-1777/D-1778：files = 目录树的面板身份（右栏容器）。树宽 = 右栏 dock 宽；
                    折叠走 treeCollapsed（**面板体收成 rail**，见下面本 slot 的 v-if，task-144 ③），
                    关闭 = 关掉 files 页签。
                -->
                <!--
                    task-144 ②：`files` 面板内容**不再在这里另写一份**，改走
                    `WorkspaceDockPanelContent`（dockview 路径同一个组件、同一个分支）。
                    这就是该组件头注释「两条渲染路径共用同一份、避免各写一遍而漂移」的本意 ——
                    此前 dockview 路径恰恰漏了 `files`，正是因为内容只在这个 slot 里。
                -->
                <template #files>
                    <!--
                        task-144 ③（Lead 2026-11-17 批）：**折叠 = 这个面板收起来**，所以 rail 收在
                        `files` 的**面板体**里，右栏行与其余页签（monitor/code/changes/…）照常渲染。
                        折叠不回收列宽（右栏仍 = dockWidth），这是裁定接受的取舍。
                    -->
                    <div
                        v-if="effectiveTreeCollapsed"
                        data-testid="workspace-file-rail"
                        class="flex h-full flex-col items-center gap-1 border-r border-border bg-surface-canvas py-2"
                        :style="{ width: TREE_COLLAPSED_WIDTH + 'px' }"
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
                    <WorkspaceDockPanelContent
                        v-else
                        id="files"
                        :session-id="sessionId"
                        :workspace-id="workspaceId"
                        @collapse-tree="toggleTree"
                        @close="collapseDock"
                        @mention="emit('mention', $event)"
                    />
                </template>
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
