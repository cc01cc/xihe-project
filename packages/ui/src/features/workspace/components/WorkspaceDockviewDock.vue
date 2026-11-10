<script setup lang="ts">
import { ref, watch } from "vue";
import { DockviewVue, type DockviewReadyEvent } from "dockview-vue";
import { themeLight } from "dockview-core";
import { DOCKVIEW_OPTIONS } from "../../../lib/dockview";
import DockviewPanelHost from "./DockviewPanelHost.vue";
import type { DockTab } from "./workspaceDockTabs";

/**
 * PLAN-0756 T1: dock 区 dockview 宿主（独立组件，薄）。
 *
 * dockview 是 DOM 布局库，jsdom 无布局引擎（硬需 ResizeObserver）⇒ 本组件**不在 jsdom
 * 单测**；集成验证归 Playwright e2e（决策 #18）。`proportionalLayout:false` 见 `lib/dockview.ts`；
 * `markRaw(api)` 由 dockview-vue 内部完成（dockview.vue:481-494 官方注释要求）。
 *
 * 面板内容经 **静态** `#panel-<id>` slot 注入（`DOCK_TAB_IDS` 是冻结的 7 项集合）；
 * dockview-vue 的 `hasSlot()` 读 `$slots[name]`，动态 slot 名在该检查点上不可靠。
 */
const props = defineProps<{
    tabs: DockTab[];
    activeTab: string;
    mode?: "pinned" | "floating";
}>();

const emit = defineEmits<{
    "update:activeTab": [id: string];
    "close-tab": [id: string];
}>();

const dockApi = ref<DockviewReadyEvent["api"] | null>(null);

function onDockReady(event: DockviewReadyEvent) {
    dockApi.value = event.api;
    syncDockPanels();
    syncDockMode();
}

/**
 * 同步 XH 布局语义（`dockTabs` / `activeDockTab`）→ dockview 面板组。单一 writer 仍在
 * `WorkspaceWorkbench`，这里只是渲染投影。
 */
function syncDockPanels() {
    const api = dockApi.value;
    if (!api) return;
    const openIds = props.tabs.map((tab) => tab.id);
    for (const id of openIds) {
        if (!api.getPanel(id)) {
            api.addPanel({
                id,
                component: id,
                title: props.tabs.find((t) => t.id === id)?.label ?? id,
                position: id === openIds[0] ? undefined : { referencePanel: openIds[0] },
                inactive: id !== props.activeTab,
            });
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const panel of api.panels as any[]) {
        if (!openIds.includes(panel.id)) api.removePanel(panel);
    }
    const active = api.getPanel(props.activeTab);
    if (active) active.api.setActive();
}

watch([() => props.tabs, () => props.activeTab], syncDockPanels);

/** PLAN-0756 T3: floating 模式驱动 dockview 浮动组（断点派生仍在 WorkspaceWorkbench）。 */
function syncDockMode() {
    const api = dockApi.value;
    if (!api) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const group: any = api.groups?.[0];
    if (!group) return;
    if (props.mode === "floating" && group.api?.location?.type !== "floating") {
        api.addFloatingGroup(group, { width: 360, height: api.height || 400 });
    }
}

watch(() => props.mode, syncDockMode);
</script>

<template>
    <DockviewVue
        class="h-full w-full"
        v-bind="DOCKVIEW_OPTIONS"
        :theme="themeLight"
        @ready="onDockReady"
    >
        <template #panel-code>
            <DockviewPanelHost tab-id="code">
                <slot name="code" />
            </DockviewPanelHost>
        </template>
        <template #panel-changes>
            <DockviewPanelHost tab-id="changes">
                <slot name="changes" />
            </DockviewPanelHost>
        </template>
        <template #panel-monitor>
            <DockviewPanelHost tab-id="monitor">
                <slot name="monitor" />
            </DockviewPanelHost>
        </template>
        <template #panel-members>
            <DockviewPanelHost tab-id="members">
                <slot name="members" />
            </DockviewPanelHost>
        </template>
        <template #panel-context>
            <DockviewPanelHost tab-id="context">
                <slot name="context" />
            </DockviewPanelHost>
        </template>
        <template #panel-agents>
            <DockviewPanelHost tab-id="agents">
                <slot name="agents" />
            </DockviewPanelHost>
        </template>
        <template #panel-delegation>
            <DockviewPanelHost tab-id="delegation">
                <slot name="delegation" />
            </DockviewPanelHost>
        </template>
    </DockviewVue>
</template>
