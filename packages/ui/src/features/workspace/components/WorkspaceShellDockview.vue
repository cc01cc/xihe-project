<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, ref, watch } from "vue";
import { DockviewVue, type DockviewReadyEvent, type VueComponent } from "dockview-vue";
import { themeLight } from "dockview-core";
import { DOCKVIEW_OPTIONS } from "../../../lib/dockview";
// BL-564：产品侧此前从未引入 dockview 基础样式（翻旗后布局会散架）。基础 CSS 必须排在
// dockview-theme.css **之前**（theme 是对 `--dv-*` 变量的覆写层）。选择器全是 `.dv-*` /
// `.dockview-host`，默认路径（手写 dock）的 DOM 里不存在 ⇒ 不影响产品默认面。
import "dockview-vue/dist/styles/dockview.css";
import "../../../styles/dockview-theme.css";
import DockviewPanelHost from "./DockviewPanelHost.vue";
import {
    DOCK_TAB_IDS,
    DOCK_WIDTH_DEFAULT,
    TREE_COLLAPSED_WIDTH,
    TREE_WIDTH_DEFAULT,
    TREE_WIDTH_MAX,
    TREE_WIDTH_MIN,
} from "../../../composables/useWorkspaceLayout";
import {
    attachDockSashA11y,
    clampRatio,
    stepRatioForWidth,
    type SashRatioState,
} from "./dockSashA11y";

/**
 * task-369 S1（D-1222）：**一个 dockview 实例横跨中栏与右栏**。
 *
 * 模型四性质（D-1222 ⑤）各自对应一段代码：
 *   ① 树能被**关闭**（`removePanel`，面板与 40px rail 一起消失）—— 不是折叠；
 *   ② 关闭后能从**容器内**重开：组头 `rightHeaderActionsComponent` 的「+」菜单；
 *   ③ 能指定投到**中栏或右栏**：**从哪个容器的组头点「+」，就投进哪个容器**
 *      （菜单按几何判本组在主列左侧还是右侧 ⇒ 中栏/右栏，写进 placements）——
 *      不需要新词、不需要新状态，入口本身就在容器里；
 *   ④ 中栏与右栏**共用一个实例**：本组件只有一个 `DockviewVue`，右栏是它的第二个 group。
 *
 * S1 明确不做（Lead 裁定③）：宽度持久化 / proportionalLayout 交互、sash 拖拽与键盘契约、
 * dockMode 投影、dockFocus、序列化桥的双 group 接线。因此：
 *   - 树宽**锁死**（`minimumWidth === maximumWidth`）⇒ S1 没有可拖的分隔条，
 *     也就没有「键盘可达性回归窗口」（裁定②：S2 上拖拽时必须同批做 a11y 适配层）；
 *   - 折叠仍是离散动作：折叠 ⇒ 面板宽 40（rail），展开 ⇒ 240，两者都**不是**拖拽；
 *   - 不落任何新盘：持久化键仍只有 `xihe-layout-ws:<id>` 那一份（D-1222 ⑥）。
 *
 * 文案全部由调用方以 `t()` 传入（`labels` / `treeLabel`）—— 本组件不新增 i18n 键。
 * jsdom 不能测 dockview（硬需 ResizeObserver）⇒ 本组件不进单测，集成验证归 Playwright。
 */
const props = defineProps<{
    /** 打开的 dock 面板 id（单一 writer 仍是 WorkspaceWorkbench 的 layout）。 */
    dockTabs: string[];
    activeDockTab: string | null;
    /** 树面板是否在容器里（false = 已关闭，rail 也消失）。 */
    treeOpen: boolean;
    /** 树是否折叠成 40px rail（面板仍在）。 */
    treeCollapsed: boolean;
    /**
     * 文件树展开宽（px）。task-486（S2）：S1 时树宽锁死，宽度取常量；现在它是**受控值** ——
     * 初始宽由调用方给（持久值），拖拽/键盘改完后经 `resize-tree` 回写，**单一 writer 仍在
     * Workbench**（本组件不落盘、不自己记账）。
     */
    treeWidth?: number;
    /** dock 组初始宽（px，来自既有持久值；S1 只读不写）。 */
    dockWidth?: number;
    /** 面板 id → 已本地化标题（调用方用 DOCK_TAB_LABEL_KEYS + t() 生成）。 */
    labels: Record<string, string>;
    /** 树面板标题（调用方传 t('workspace.expandFiles')）。 */
    treeLabel: string;
    /** task-486（S2）：分隔条的无障碍可读名（i18n 由调用方给，本组件不持文案）。 */
    sashLabel: string;
}>();

const emit = defineEmits<{
    "update:activeDockTab": [id: string];
    "close-tab": [id: string];
    "close-tree": [];
    /** 「+」菜单重开：target 由**被点击的组头**决定（判据③）。 */
    "reopen-panel": [payload: { id: string; target: "center" | "dock" }];
    /** task-486（S2）：树宽变化（拖拽结束或键盘）⇒ 调用方写 `xihe-layout-ws:<id>.treeWidth`。 */
    "resize-tree": [width: number];
}>();

const MAIN_PANEL_ID = "main";
const TREE_PANEL_ID = "tree";
const DOCK_PANEL_IDS: readonly string[] = DOCK_TAB_IDS;

const hostRef = ref<HTMLElement | null>(null);
const dockApi = ref<DockviewReadyEvent["api"] | null>(null);
/** sync 期间抑制 dockview 回调 ⇒ 自己删面板不会被当成用户关闭。 */
let syncing = false;
/** task-486：最近一次已经回写出去的树宽（拖拽/键盘都一样）⇒ 只在真变化时 emit。 */
let emittedTreeWidth = 0;
/** 适配层的卸载函数（组件卸载时摘 MutationObserver 与键盘监听）。 */
let detachSashA11y: (() => void) | null = null;
/**
 * 指针状态（判「这次几何变化是不是用户拖的」）：
 * `pointerActive` = 现在按着；`pointerUpAt` = 最近一次抬指时刻。
 *
 * 为什么需要「抬指后宽限窗口」：dockview 是在指针**抬起之后**才 fire 一次 layout change，
 * 只看 `pointerActive` 会漏掉整次拖拽的最终值（实测：树宽确实拖到了 320，但持久键没写）。
 */
let pointerActive = false;
/** 这次按下之后指针**真的移动过** ⇒ 是拖拽，不是点击。 */
let pointerMoved = false;
let pointerOrigin = { x: 0, y: 0 };
let lastDragUpAt = Number.NEGATIVE_INFINITY;
/**
 * 待执行的自愈重试（见 scheduleProductWidths）。**用户一旦开始操作就要取消它** ——
 * 否则重试会把用户刚按出来的宽度再写回目标值（实测 3 轮里有 1 轮拖拽/键盘结果被抹回，
 * 属「修好了但仍会偶发覆盖」的真 flake，不能留着）。
 */
let widthApplyTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 宽度自愈循环的「代次」。每次请求 +1 ⇒ 旧循环在下一拍自己退出。
 *
 * 为什么需要它（实测 flake）：早先用「单个 timer 句柄 + 成功后 clearTimeout」时，
 * 挂载那一轮的循环「成功」（读到目标值）会把**展开那一轮刚排上的重试**一起清掉 ⇒
 * 折叠→展开偶发停在 200（3 轮里 1 轮）。句柄是共享资源，代次是每轮私有的。
 */
let widthApplyGen = 0;
const DRAG_GRACE_MS = 500;
/** 判定「移动过」的最小位移（px）：点击（如折叠按钮）不该被当成拖拽。 */
const DRAG_MIN_MOVE_PX = 4;
let detachPointer: (() => void) | null = null;

// 卸载时摘干净：MutationObserver 挂着 DOM 引用，不摘会让已销毁的组件随页面存活。
onBeforeUnmount(() => {
    detachSashA11y?.();
    detachSashA11y = null;
    detachPointer?.();
    detachPointer = null;
});

/**
 * 判据③的投放记录：面板 id → 目标容器。**组件局部、不持久化**（S1 不落新盘，D-1222 ⑥）。
 * 由组头「+」菜单在点击时写入（target 由被点组头所在容器决定），sync 时消费。
 * 缺省：树 → 中栏，dock 面板 → 右栏。
 */
const placements = ref<Record<string, "center" | "dock">>({});
const placementOf = (id: string): "center" | "dock" =>
    placements.value[id] ?? (id === TREE_PANEL_ID ? "center" : "dock");

const treeWidth = computed(() =>
    props.treeCollapsed ? TREE_COLLAPSED_WIDTH : (props.treeWidth ?? TREE_WIDTH_DEFAULT),
);
const dockWidth = computed(() => props.dockWidth ?? DOCK_WIDTH_DEFAULT);

function ensureMain(api: NonNullable<typeof dockApi.value>): void {
    if (api.getPanel(MAIN_PANEL_ID)) return;
    api.addPanel({ id: MAIN_PANEL_ID, component: MAIN_PANEL_ID, title: "" });
}

/**
 * dock 面板：缺省落主列**右侧**（右栏容器），其余同组；被「+」投到中栏的落主列左侧。
 *
 * 注意 dockview 语义（实测 run2 纠正）：`direction: "left" | "right"` 是**新建一个 group**，
 * 不是往同组加 tab ⇒ 并排的树/主列/dock 各自是一个 group，同属一个实例（判据④）。
 */
function syncDock(api: NonNullable<typeof dockApi.value>): void {
    const open = props.dockTabs;
    // 右栏锚点 = 第一个目标为右栏的打开面板；投到中栏的面板不能当右栏锚点。
    const anchor = open.find((id) => placementOf(id) === "dock") ?? open[0];
    for (const id of open) {
        if (api.getPanel(id)) continue;
        const toCenter = placementOf(id) === "center";
        api.addPanel({
            id,
            component: id,
            title: props.labels[id] ?? id,
            initialWidth: !toCenter && id === anchor ? dockWidth.value : undefined,
            position: toCenter
                ? { direction: "left", referencePanel: MAIN_PANEL_ID }
                : id === anchor
                  ? { direction: "right", referencePanel: MAIN_PANEL_ID }
                  : { referencePanel: anchor },
            inactive: id !== props.activeDockTab,
        });
    }
    for (const id of DOCK_PANEL_IDS) {
        if (open.includes(id)) continue;
        const stale = api.getPanel(id);
        if (stale) api.removePanel(stale);
    }
    const active = props.activeDockTab ? api.getPanel(props.activeDockTab) : null;
    if (active) active.api.setActive();
}

/**
 * 树面板：关闭 ⇒ removePanel（rail 一起消失，判据①）；宽度变化 ⇒ **移除后按新宽重建**。
 *
 * 为什么重建而不是 setSize：实测 run2 对已存在面板调 `setConstraints + setSize` 不生效
 * （折叠后 rail 仍 240，且无 pageerror）。重建与 legacy 路径同构 —— 手写栏折叠时本来就
 * `v-if` 卸载 FileTreePanel ⇒ 不丢额外状态。宽度用库的 `api.width` 读回，不自己记账。
 */
function syncTree(api: NonNullable<typeof dockApi.value>): void {
    const existing = api.getPanel(TREE_PANEL_ID);
    if (!props.treeOpen) {
        if (existing) api.removePanel(existing);
        return;
    }
    const width = treeWidth.value;
    if (existing) {
        if (Math.round(existing.api.width) === width) return;
        api.removePanel(existing);
    }
    // 目标容器由 placements 决定（判据③）。syncDock 先跑 ⇒ 右栏锚点此刻已存在；
    // 此前误在 syncDock 之前拿 dockTabs[0]（默认 'monitor'）当 referencePanel ⇒ dockview 抛
    // `referencePanel 'monitor' does not exist` 并中断整个 sync（实测 run1 全红根因）。
    const dockAnchor = props.dockTabs.find((id) => placementOf(id) === "dock") ?? props.dockTabs[0];
    const position =
        placementOf(TREE_PANEL_ID) === "dock"
            ? { direction: "right" as const, referencePanel: dockAnchor ?? MAIN_PANEL_ID }
            : { direction: "left" as const, referencePanel: MAIN_PANEL_ID };
    // task-486（S2）拆锁：折叠态仍是 40px 固定宽（rail 没有可拖的余地），展开态放进产品夹取
    // 区间 200–320（与手写分支 `clampTreeWidth` 同界）—— 库只负责几何，边界语义仍由产品给。
    const locked = props.treeCollapsed;
    api.addPanel({
        id: TREE_PANEL_ID,
        component: TREE_PANEL_ID,
        title: props.treeLabel,
        position,
        initialWidth: width,
        minimumWidth: locked ? width : TREE_WIDTH_MIN,
        maximumWidth: locked ? width : TREE_WIDTH_MAX,
    });
}

/**
 * task-486（S2）：同步后**显式**把产品宽度写到位。
 *
 * 为什么不能只靠 addPanel({ initialWidth })（实测，mock lane 1920×1080，宿主宽 1158）：
 * 三个 group 建完读到的几何是 tree=200 / main=100 / dock=858 —— 树被压到自己的**最小宽**、
 * dock 组把余量全吃掉，initialWidth 没有落到最终布局上。S1 时看不出这个问题，因为那时
 * 树宽 min=max=240（约束把值钉住）；**拆锁后这个缺口立刻显形**：不补这一步，持久化的 320
 * 在 reload 后会是 200（判据⑤的实测红态）。
 *
 * 用库公开的 panel.api.setSize({ width })（键盘路径已实测有效）。全程包在 syncing 里，
 * 免得这一写被当成用户拖拽而反手 emit 一次。
 */
function applyProductWidths(): void {
    const api = dockApi.value;
    if (!api) return;
    const tree = api.getPanel(TREE_PANEL_ID);
    syncing = true;
    try {
        if (tree && !props.treeCollapsed) tree.api.setSize({ width: treeWidth.value });
        // dock 组也要显式给宽：不写的话它按余量吃掉空间，树宽再准也会被挤回最小宽。
    } finally {
        syncing = false;
    }
    emittedTreeWidth = Math.round(api.getPanel(TREE_PANEL_ID)?.api.width ?? 0);
}

/**
 * 应用宽度的**时机**（实测教训）：同步阶段（onReady / syncPanels 内）调 setSize 会被 dockview
 * 自己的首轮布局覆盖 —— 读回来仍是 tree=200 / dock=858。所以推到下一帧：库的初始布局已在
 * 帧内 flush 完，此时 setSize 才生效（键盘路径本来就发生在布局稳定之后，所以它一直是对的）。
 *
 * 首帧还**不一定够**（第 2–3 帧才稳定）⇒ 有界重试（≤12 次 ×100ms，读到目标值即停）。
 * 每轮带自己的代次：新请求作废旧循环，旧循环不会误清别人的定时器。
 */
function startProductWidthSync(): void {
    const gen = ++widthApplyGen;
    const step = (attempt: number): void => {
        if (gen !== widthApplyGen) return;
        applyProductWidths();
        const want = props.treeCollapsed ? TREE_COLLAPSED_WIDTH : treeWidth.value;
        const now = Math.round(dockApi.value?.getPanel(TREE_PANEL_ID)?.api.width ?? -1);
        if (Math.abs(now - want) > 1 && attempt < 12) {
            widthApplyTimer = setTimeout(() => {
                widthApplyTimer = null;
                step(attempt + 1);
            }, 100);
        }
    };
    if (typeof requestAnimationFrame !== "function") {
        step(0);
        return;
    }
    requestAnimationFrame(() => step(0));
}

function syncPanels(): void {
    const api = dockApi.value;
    if (!api) return;
    syncing = true;
    try {
        ensureMain(api);
        // 顺序固定：dock 先于树 —— 树投右栏时要拿 dock 面板当 referencePanel。
        syncDock(api);
        syncTree(api);
    } finally {
        syncing = false;
    }
    startProductWidthSync();
}

/** 面板所在的 dockview group 元素（几何判据都用它）。 */
function groupElOf(panelId: string): HTMLElement | null {
    return (
        hostRef.value
            ?.querySelector<HTMLElement>(`[data-dockview-panel="${panelId}"]`)
            ?.closest<HTMLElement>(".dv-groupview") ?? null
    );
}

/**
 * task-486（S2）：把已存在的 `dockSashA11y` 接到 dockview 的分隔条上（BL-561 / task-326 裁 b）。
 *
 * **量纲 = 相邻两组占比**（适配层的规定）：这里取「树组宽 /（树组 + 主列组）」。
 * `apply` 走库自己的 `panel.api.setSize({ width })` —— 它是库**公开**的尺寸通道，
 * 不碰 vendor DOM、也不用改 dockview。
 *
 * **只认树↔主列那一道缝**：dockview 里每条组间分隔都是一个 `.dv-sash`，适配层会全部枚举；
 * 主列↔右栏那道缝若也被挂上键盘契约，一次方向键会同时说出「树宽占比」和「右栏占比」两个
 * 不相干的值（播报即撒谎）。判法是**几何**：这条缝的中线必须落在树组与主列组的交界上
 * （容差 4px，含树被投到主列右侧的情形）。
 */
const SASH_MATCH_TOLERANCE_PX = 4;

function sashBoundaryX(sash: HTMLElement): number | null {
    const tree = groupElOf(TREE_PANEL_ID);
    const main = groupElOf(MAIN_PANEL_ID);
    if (!tree || !main) return null;
    const treeRect = tree.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const boundary = treeRect.left < mainRect.left ? treeRect.right : mainRect.right;
    const rect = sash.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    return Math.abs(center - boundary) <= SASH_MATCH_TOLERANCE_PX ? boundary : null;
}

function measureSash(sash: HTMLElement): SashRatioState | null {
    if (sashBoundaryX(sash) === null) return null;
    const tree = groupElOf(TREE_PANEL_ID);
    const main = groupElOf(MAIN_PANEL_ID);
    if (!tree || !main) return null;
    const left = tree.getBoundingClientRect().width;
    const right = main.getBoundingClientRect().width;
    const total = left + right;
    if (!(total > 0)) return null;
    return {
        ratio: left / total,
        resetRatio: TREE_WIDTH_DEFAULT / total,
        minRatio: TREE_WIDTH_MIN / total,
        maxRatio: TREE_WIDTH_MAX / total,
        stepRatio: stepRatioForWidth(total),
    };
}

function cancelProductWidths(): void {
    widthApplyGen += 1;
    if (widthApplyTimer !== null) {
        clearTimeout(widthApplyTimer);
        widthApplyTimer = null;
    }
}

function applySash(ratio: number): void {
    cancelProductWidths();
    const panel = dockApi.value?.getPanel(TREE_PANEL_ID);
    const tree = groupElOf(TREE_PANEL_ID);
    const main = groupElOf(MAIN_PANEL_ID);
    if (!panel || !tree || !main) return;
    const total = tree.getBoundingClientRect().width + main.getBoundingClientRect().width;
    if (!(total > 0)) return;
    const clamped = clampRatio(ratio, TREE_WIDTH_MIN / total, TREE_WIDTH_MAX / total);
    const width = Math.round(clamped * total);
    panel.api.setSize({ width });
    emittedTreeWidth = width;
    emit("resize-tree", width);
}

/**
 * 拖拽后的宽度回写：只在**几何**原因上写（`reasons` 是自上次以来的并集，结构/激活/标题变化
 * 也会 fire）。值没变就不发，避免和调用方的 props 往返打架。
 */
function onLayoutChange(event: { reasons: ReadonlySet<string> }): void {
    // **只有用户拖拽才回写**（实测教训，task-486）：库自己重建面板时也会 fire geometry，
    // 那时读到的是「还没落到目标宽」的中间值（200）。若照写，会把持久值写成 200 并把目标值
    // 反过来覆盖成 200 —— 展开回不来就是这个循环造成的（复现：折叠 40 → 展开应当 240，实读 200）。
    const dragging = pointerActive && pointerMoved;
    const dragJustEnded = performance.now() - lastDragUpAt < DRAG_GRACE_MS;
    if (!dragging && !dragJustEnded) return;
    if (!event.reasons.has("geometry") || syncing) return;
    const width = Math.round(dockApi.value?.getPanel(TREE_PANEL_ID)?.api.width ?? 0);
    if (width <= 0 || Math.abs(width - emittedTreeWidth) < 1) return;
    emittedTreeWidth = width;
    emit("resize-tree", width);
}

function onReady(event: DockviewReadyEvent): void {
    dockApi.value = event.api;
    syncPanels();
    emittedTreeWidth = Math.round(dockApi.value?.getPanel(TREE_PANEL_ID)?.api.width ?? 0);
    if (hostRef.value) {
        detachSashA11y = attachDockSashA11y(hostRef.value, {
            label: props.sashLabel,
            measure: measureSash,
            apply: (_sash, ratio) => applySash(ratio),
        });
    }
    event.api.onDidLayoutChange(onLayoutChange);
    // 拖拽判据：pointerdown 在宿主内、pointerup 可能在窗口任意处（拖出边界）⇒ 后者挂 window。
    const onPointerDown = (event: PointerEvent): void => {
        // 用户开始拖 ⇒ 立刻放弃「把宽度自愈到目标值」的重试。
        cancelProductWidths();
        pointerActive = true;
        pointerMoved = false;
        pointerOrigin = { x: event.clientX, y: event.clientY };
    };
    const onPointerMove = (event: PointerEvent): void => {
        if (!pointerActive || pointerMoved) return;
        const dx = event.clientX - pointerOrigin.x;
        const dy = event.clientY - pointerOrigin.y;
        if (Math.hypot(dx, dy) > DRAG_MIN_MOVE_PX) pointerMoved = true;
    };
    const onPointerUp = (): void => {
        if (pointerActive && pointerMoved) lastDragUpAt = performance.now();
        pointerActive = false;
        pointerMoved = false;
    };
    hostRef.value?.addEventListener("pointerdown", onPointerDown);
    hostRef.value?.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, true);
    detachPointer = () => {
        hostRef.value?.removeEventListener("pointerdown", onPointerDown);
        hostRef.value?.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp, true);
    };
    // 用户从 tab 的 × 关闭 ⇒ 回写 XH 状态（单一 writer 仍是 Workbench）。
    event.api.onDidRemovePanel((panel) => {
        if (syncing) return;
        if (panel.id === TREE_PANEL_ID) emit("close-tree");
        else if (panel.id !== MAIN_PANEL_ID) emit("close-tab", panel.id);
    });
    event.api.onDidActivePanelChange((event) => {
        const panel = event.panel;
        if (syncing || !panel) return;
        if (props.dockTabs.includes(panel.id)) emit("update:activeDockTab", panel.id);
    });
}

watch(
    [
        () => props.dockTabs,
        () => props.activeDockTab,
        () => props.treeOpen,
        () => props.treeCollapsed,
    ],
    syncPanels,
);

/**
 * 组头「+」菜单（判据②③）。dockview-vue 的 `rightHeaderActionsComponent` 收一个 Vue 组件，
 * props 由库注入（`IDockviewHeaderActionsProps`）。这里用 `defineComponent + h` 就地定义，
 * 闭包直接拿本组件的 props/emit/placements —— 不另建文件、不另建持久状态。
 *
 * **目标容器怎么判**（实测纠正）：树自己是独立 group ⇒ 「本组含 main」只能认出主列组，
 * 认不出「主列左侧的树组」也属中栏。dockview 没有公开的区域 API ⇒ 用几何：本组左边界
 * 在主列组左边 ⇒ 中栏，否则右栏。主列组经产品自己的 `data-dockview-panel="main"` 钩子定位
 * （不依赖测试 testid）。点击时现算，不用 computed 缓存 DOM 读数。
 */
const PanelAddMenu = defineComponent({
    name: "DockviewPanelAddMenu",
    props: {
        panels: { type: Array, required: false, default: () => [] },
    },
    setup() {
        const open = ref(false);
        const rootRef = ref<HTMLElement | null>(null);
        const resolveTarget = (): "center" | "dock" => {
            const own = rootRef.value?.closest(".dv-groupview");
            const mainGroup = document
                .querySelector('[data-dockview-panel="main"]')
                ?.closest(".dv-groupview");
            if (!own || !mainGroup) return "center";
            if (own === mainGroup) return "center";
            return own.getBoundingClientRect().left < mainGroup.getBoundingClientRect().left
                ? "center"
                : "dock";
        };
        const closedDock = computed(() =>
            DOCK_PANEL_IDS.filter((id) => !props.dockTabs.includes(id)),
        );
        const closedTree = computed(() => !props.treeOpen);
        const hasAny = computed(() => closedTree.value || closedDock.value.length > 0);
        const itemClass =
            "w-full rounded px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
        const reopen = (id: string) => {
            open.value = false;
            const target = resolveTarget();
            placements.value = { ...placements.value, [id]: target };
            emit("reopen-panel", { id, target });
        };
        return () =>
            h("div", { ref: rootRef, class: "relative flex items-center" }, [
                h(
                    "button",
                    {
                        type: "button",
                        "data-testid": "dockview-add-trigger",
                        class: "rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        "aria-expanded": open.value,
                        "aria-label": props.treeLabel,
                        disabled: !hasAny.value,
                        onClick: () => {
                            open.value = !open.value;
                        },
                    },
                    "+",
                ),
                open.value && hasAny.value
                    ? h(
                          "div",
                          {
                              "data-testid": "dockview-add-menu",
                              class: "absolute right-0 top-full z-50 mt-1 w-52 rounded-md border bg-popover p-1 text-sm shadow-md",
                          },
                          [
                              closedTree.value
                                  ? h(
                                        "button",
                                        {
                                            type: "button",
                                            "data-testid": "dockview-add-item-tree",
                                            class: itemClass,
                                            onClick: () => reopen(TREE_PANEL_ID),
                                        },
                                        props.treeLabel,
                                    )
                                  : null,
                              ...closedDock.value.map((id) =>
                                  h(
                                      "button",
                                      {
                                          type: "button",
                                          "data-testid": `dockview-add-item-${id}`,
                                          class: itemClass,
                                          onClick: () => reopen(id),
                                      },
                                      props.labels[id] ?? id,
                                  ),
                              ),
                          ],
                      )
                    : null,
            ]);
    },
});

/** dockview-vue 的 `VueComponent` 比 `defineComponent` 的返回类型窄，这里做一次显式收窄。 */
const headerActionsComponent = PanelAddMenu as unknown as VueComponent;
</script>

<template>
    <!-- `hostRef` 必须落在**真实元素**上：`ref` 指向组件实例时拿到的是组件对象，
         `attachDockSashA11y` 需要 `container.querySelectorAll`（实测：挂组件实例会抛
         `container.querySelectorAll is not a function`，而且异常发生在 `@ready` 里 ⇒ 壳不渲染）。 -->
    <div ref="hostRef" class="h-full w-full">
        <DockviewVue
            class="dockview-host h-full w-full"
            v-bind="DOCKVIEW_OPTIONS"
            :theme="themeLight"
            :right-header-actions-component="headerActionsComponent"
            @ready="onReady"
        >
            <template #panel-main>
                <DockviewPanelHost tab-id="main" data-dockview-panel="main"
                    ><slot name="center"
                /></DockviewPanelHost>
            </template>
            <template #panel-tree>
                <DockviewPanelHost tab-id="tree" data-dockview-panel="tree"
                    ><slot name="tree"
                /></DockviewPanelHost>
            </template>
            <template v-for="id in DOCK_PANEL_IDS" :key="id" #[`panel-${id}`]>
                <DockviewPanelHost :tab-id="id" :data-dockview-panel="id"
                    ><slot :name="id"
                /></DockviewPanelHost>
            </template>
        </DockviewVue>
    </div>
</template>
