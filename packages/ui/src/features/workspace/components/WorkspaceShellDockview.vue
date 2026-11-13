<script setup lang="ts">
import { computed, defineComponent, h, ref, watch } from "vue";
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
} from "../../../composables/useWorkspaceLayout";

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
    /** dock 组初始宽（px，来自既有持久值；S1 只读不写）。 */
    dockWidth?: number;
    /** 面板 id → 已本地化标题（调用方用 DOCK_TAB_LABEL_KEYS + t() 生成）。 */
    labels: Record<string, string>;
    /** 树面板标题（调用方传 t('workspace.expandFiles')）。 */
    treeLabel: string;
}>();

const emit = defineEmits<{
    "update:activeDockTab": [id: string];
    "close-tab": [id: string];
    "close-tree": [];
    /** 「+」菜单重开：target 由**被点击的组头**决定（判据③）。 */
    "reopen-panel": [payload: { id: string; target: "center" | "dock" }];
}>();

const MAIN_PANEL_ID = "main";
const TREE_PANEL_ID = "tree";
const DOCK_PANEL_IDS: readonly string[] = DOCK_TAB_IDS;

const dockApi = ref<DockviewReadyEvent["api"] | null>(null);
/** sync 期间抑制 dockview 回调 ⇒ 自己删面板不会被当成用户关闭。 */
let syncing = false;

/**
 * 判据③的投放记录：面板 id → 目标容器。**组件局部、不持久化**（S1 不落新盘，D-1222 ⑥）。
 * 由组头「+」菜单在点击时写入（target 由被点组头所在容器决定），sync 时消费。
 * 缺省：树 → 中栏，dock 面板 → 右栏。
 */
const placements = ref<Record<string, "center" | "dock">>({});
const placementOf = (id: string): "center" | "dock" =>
    placements.value[id] ?? (id === TREE_PANEL_ID ? "center" : "dock");

const treeWidth = computed(() => (props.treeCollapsed ? TREE_COLLAPSED_WIDTH : TREE_WIDTH_DEFAULT));
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
    api.addPanel({
        id: TREE_PANEL_ID,
        component: TREE_PANEL_ID,
        title: props.treeLabel,
        position,
        initialWidth: width,
        minimumWidth: width,
        maximumWidth: width,
    });
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
}

function onReady(event: DockviewReadyEvent): void {
    dockApi.value = event.api;
    syncPanels();
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
</template>
