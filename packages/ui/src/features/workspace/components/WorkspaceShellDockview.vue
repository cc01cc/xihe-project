<script setup lang="ts">
import { computed, defineComponent, h, ref, watch } from "vue";
import { DockviewVue, type DockviewReadyEvent, type VueComponent } from "dockview-vue";
import { themeLight } from "dockview-core";
import { DOCKVIEW_OPTIONS } from "../../../lib/dockview";
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
 *      （菜单读 `IDockviewHeaderActionsProps.group` 判断自己是中栏组还是 dock 组）——
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

const treeWidth = computed(() => (props.treeCollapsed ? TREE_COLLAPSED_WIDTH : TREE_WIDTH_DEFAULT));
const dockWidth = computed(() => props.dockWidth ?? DOCK_WIDTH_DEFAULT);

function ensureMain(api: NonNullable<typeof dockApi.value>): void {
    if (api.getPanel(MAIN_PANEL_ID)) return;
    api.addPanel({ id: MAIN_PANEL_ID, component: MAIN_PANEL_ID, title: "" });
}

/** 树面板：在则只改宽（不重挂，保住 FileTreePanel 内部状态），不在则按目标建。 */
function syncTree(api: NonNullable<typeof dockApi.value>): void {
    const existing = api.getPanel(TREE_PANEL_ID);
    if (!props.treeOpen) {
        if (existing) api.removePanel(existing);
        return;
    }
    const width = treeWidth.value;
    if (existing) {
        existing.api.setConstraints({ minimumWidth: width, maximumWidth: width });
        existing.api.setSize({ width });
        return;
    }
    const reference = props.dockTabs[0] ?? MAIN_PANEL_ID;
    api.addPanel({
        id: TREE_PANEL_ID,
        component: TREE_PANEL_ID,
        title: props.treeLabel,
        position: { direction: "left", referencePanel: reference },
        initialWidth: width,
        minimumWidth: width,
        maximumWidth: width,
    });
}

/** dock 组：首个面板落在主列右侧（= 第二个 group），其余同组。 */
function syncDock(api: NonNullable<typeof dockApi.value>): void {
    const open = props.dockTabs;
    const first = open[0];
    for (const id of open) {
        if (api.getPanel(id)) continue;
        api.addPanel({
            id,
            component: id,
            title: props.labels[id] ?? id,
            initialWidth: id === first ? dockWidth.value : undefined,
            position:
                id === first
                    ? { direction: "right", referencePanel: MAIN_PANEL_ID }
                    : { referencePanel: first },
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

function syncPanels(): void {
    const api = dockApi.value;
    if (!api) return;
    syncing = true;
    try {
        ensureMain(api);
        syncTree(api);
        syncDock(api);
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
 * props 由库注入（`IDockviewHeaderActionsProps`：group / panels / containerApi …）。
 * 这里用 `defineComponent + h` 就地定义，闭包直接拿本组件的 props/emit —— 不另建文件、不另建状态。
 * 菜单形态沿用产品既有 overflow 菜单（button + 绝对定位列表），不引入第二套设计语言。
 */
const PanelAddMenu = defineComponent({
    name: "DockviewPanelAddMenu",
    props: {
        panels: { type: Array, required: false, default: () => [] },
    },
    setup(menuProps) {
        const open = ref(false);
        /** 本组是中栏组（含 main）还是 dock 组 ⇒ 决定重开投放目标（判据③）。 */
        const target = computed<"center" | "dock">(() =>
            (menuProps.panels as Array<{ id: string }>).some((p) => p.id === MAIN_PANEL_ID)
                ? "center"
                : "dock",
        );
        const closedDock = computed(() =>
            DOCK_PANEL_IDS.filter((id) => !props.dockTabs.includes(id)),
        );
        const closedTree = computed(() => !props.treeOpen);
        const hasAny = computed(() => closedTree.value || closedDock.value.length > 0);
        const itemClass =
            "w-full rounded px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
        const reopen = (id: string) => {
            open.value = false;
            emit("reopen-panel", { id, target: target.value });
        };
        return () =>
            h("div", { class: "relative flex items-center" }, [
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
        class="h-full w-full"
        v-bind="DOCKVIEW_OPTIONS"
        :theme="themeLight"
        :right-header-actions-component="headerActionsComponent"
        @ready="onReady"
    >
        <template #panel-main>
            <DockviewPanelHost tab-id="main"><slot name="center" /></DockviewPanelHost>
        </template>
        <template #panel-tree>
            <DockviewPanelHost tab-id="tree"><slot name="tree" /></DockviewPanelHost>
        </template>
        <template v-for="id in DOCK_PANEL_IDS" :key="id" #[`panel-${id}`]>
            <DockviewPanelHost :tab-id="id"><slot :name="id" /></DockviewPanelHost>
        </template>
    </DockviewVue>
</template>
