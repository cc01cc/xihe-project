<script setup lang="ts">
/**
 * PLAN-0756 决策材料：dockview 能力演示页（dev-only，不进产品路由）。
 *
 * 演示 6 项能力，全部走 dockview 真实 API（不是模拟）：拆两组 / 跨组拖 tab / sash 缩放 /
 * 浮动组 / toJSON+fromJSON 序列化恢复 / 收窄能力对照（disableDnd + disableFloatingGroups）。
 *
 * 数据全 mock，零网络请求；视觉只用产品 token（`styles/main.css`）与
 * `styles/dockview-theme.css` 的 `--dv-*` 映射，不引第二套设计语言。
 */
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import { DockviewVue, type DockviewReadyEvent } from "dockview-vue";
import { themeLight } from "dockview-core";
import { DOCKVIEW_OPTIONS } from "../lib/dockview";

type DockviewApi = DockviewReadyEvent["api"];

const dockApi = shallowRef<DockviewApi | null>(null);
const disposables: { dispose: () => void }[] = [];

/** 页面代码框里的 JSON（「保存布局」写入）。 */
const savedJson = ref("");
const note = ref("初始：3 个面板同组（对话 / 文件预览 / 运行日志）");
const narrowed = ref(false);
const groupCount = ref(1);
const panelCount = ref(3);
const floatGroupCount = ref(0);

/** 初始布局快照，供「重置」还原。 */
let initialJson = "";

const statusLine = computed(
    () =>
        "组 " +
        groupCount.value +
        " · 面板 " +
        panelCount.value +
        " · 浮动组 " +
        floatGroupCount.value,
);

function syncCounts() {
    const api = dockApi.value;
    if (!api) return;
    groupCount.value = api.groups.length;
    panelCount.value = api.panels.length;
    floatGroupCount.value = api.groups.filter(
        (group) => group.api.location.type === "floating",
    ).length;
}

function onReady(event: DockviewReadyEvent) {
    const api = event.api;
    dockApi.value = api;
    disposables.push(
        api.onDidAddGroup(() => syncCounts()),
        api.onDidRemoveGroup(() => syncCounts()),
        api.onDidAddPanel(() => syncCounts()),
        api.onDidRemovePanel(() => syncCounts()),
    );
    // 初始：3 个面板注册为同一组的 3 个 tab（slot `#panel-<id>` 提供内容）。
    api.addPanel({ id: "chat", component: "chat", title: "对话" });
    api.addPanel({
        id: "file",
        component: "file",
        title: "文件预览",
        position: { referencePanel: "chat", direction: "within" },
    });
    api.addPanel({
        id: "logs",
        component: "logs",
        title: "运行日志",
        position: { referencePanel: "chat", direction: "within" },
    });
    // 回到「对话」为活动 tab（addPanel 会让最后添加的成为活动）。
    api.getPanel("chat")?.api.setActive();
    initialJson = JSON.stringify(api.toJSON());
    syncCounts();
}

/** ① 多面板同屏：把「运行日志」移到右侧新组（当前手写 dock 做不到）。 */
function splitIntoTwoGroups() {
    const api = dockApi.value;
    if (!api) return;
    const panel = api.getPanel("logs");
    if (!panel) return;
    const existing = api.groups.filter((group) => group.api.location.type !== "floating");
    if (existing.length >= 2) {
        note.value = "已经是两组了 —— 试着把 tab 拖到另一组（②），或拖分隔条（③）";
        return;
    }
    const group = api.addGroup({ referencePanel: "chat", direction: "right" });
    panel.api.moveTo({ group, position: "center" });
    note.value = "① 已拆成两组：左「对话 + 文件预览」，右「运行日志」";
    syncCounts();
}

/** ④ 浮动组：把当前活动面板浮到窗口上。 */
function floatActivePanel() {
    const api = dockApi.value;
    if (!api) return;
    if (narrowed.value) {
        note.value = "收窄模式已禁用浮动组（取消勾选 ⑥ 再试）";
        return;
    }
    const panel = api.activePanel ?? api.getPanel("logs") ?? api.panels[0];
    if (!panel) return;
    // 显式给 x/y：默认会浮在 dock 区上方，把两个组都挡住；放左上更能看清「浮在主列上」。
    api.addFloatingGroup(panel, { x: 140, y: 150, width: 520, height: 340 });
    note.value = "④ 已把「" + String(panel.title) + "」浮成浮动组（左上，可拖动标题栏移动）";
    syncCounts();
}

/** ⑤ 序列化：把当前布局打印到页面代码框。 */
function saveLayout() {
    const api = dockApi.value;
    if (!api) return;
    savedJson.value = JSON.stringify(api.toJSON(), null, 2);
    note.value = "⑤ 已保存：api.toJSON() 打印到下方代码框（这就是要持久化的全部状态）";
}

/** ⑤ 恢复：用 fromJSON 还原到保存时的布局。 */
function restoreLayout() {
    const api = dockApi.value;
    if (!api) return;
    if (!savedJson.value) {
        note.value = "先点「保存布局」，再点恢复";
        return;
    }
    try {
        api.fromJSON(JSON.parse(savedJson.value));
        note.value = "⑤ 已用 api.fromJSON() 还原到保存时的布局";
        syncCounts();
    } catch (error) {
        note.value = "恢复失败：" + String(error);
    }
}

/** ⑥ 收窄能力：只保留 tabs + 分组，关掉拖拽与浮动。 */
function applyNarrow() {
    const api = dockApi.value;
    if (!api) return;
    api.updateOptions({
        disableDnd: narrowed.value,
        disableFloatingGroups: narrowed.value,
    });
    note.value = narrowed.value
        ? "⑥ 收窄：disableDnd + disableFloatingGroups —— tab 拖不动、面板浮不起来，只剩分组与缩放"
        : "⑥ 已恢复完整能力（可拖 tab、可浮动）";
}

/** 回到初始布局。 */
function resetLayout() {
    const api = dockApi.value;
    if (!api || !initialJson) return;
    api.fromJSON(JSON.parse(initialJson));
    savedJson.value = "";
    note.value = "已重置为初始布局";
    syncCounts();
}

onBeforeUnmount(() => {
    for (const disposable of disposables) disposable.dispose();
    disposables.length = 0;
});
</script>
<template>
    <div
        class="dockview-demo-root flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground"
    >
        <!-- 顶栏：能力按钮 -->
        <header class="flex shrink-0 items-center gap-2 border-b bg-card px-4 py-2 text-xs">
            <span class="font-semibold">dockview 能力演示</span>
            <span class="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                dev-only · 真组件 · 零请求
            </span>
            <span class="mx-2 h-4 w-px bg-border" />
            <button
                type="button"
                data-demo="split"
                class="rounded border px-2 py-1 hover:bg-accent"
                @click="splitIntoTwoGroups"
            >
                ① 拆成两组
            </button>
            <button
                type="button"
                data-demo="float"
                class="rounded border px-2 py-1 hover:bg-accent"
                @click="floatActivePanel"
            >
                ④ 浮动组
            </button>
            <button
                type="button"
                data-demo="save"
                class="rounded border px-2 py-1 hover:bg-accent"
                @click="saveLayout"
            >
                ⑤ 保存布局
            </button>
            <button
                type="button"
                data-demo="restore"
                class="rounded border px-2 py-1 hover:bg-accent"
                @click="restoreLayout"
            >
                ⑤ 恢复布局
            </button>
            <label class="ml-1 inline-flex items-center gap-1.5 rounded border px-2 py-1">
                <input
                    v-model="narrowed"
                    type="checkbox"
                    data-demo="narrow"
                    class="size-3"
                    @change="applyNarrow"
                />
                ⑥ 收窄（禁拖拽 + 禁浮动）
            </label>
            <button
                type="button"
                data-demo="reset"
                class="rounded border px-2 py-1 text-muted-foreground hover:bg-accent"
                @click="resetLayout"
            >
                重置
            </button>
            <span class="ml-auto tabular-nums text-muted-foreground" data-demo="counts">
                {{ statusLine }}
            </span>
        </header>

        <!-- 正文：左假主列 + 右 dock 区（示意真实工作台布局关系） -->
        <div class="flex min-h-0 flex-1">
            <section class="flex min-h-0 w-[54%] shrink-0 flex-col border-r bg-background">
                <div
                    class="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[11px] text-muted-foreground"
                >
                    主列占位（真实工作台里这里是对话/编辑器，dock 在右侧）
                </div>
                <div class="min-h-0 flex-1 space-y-3 overflow-hidden p-4">
                    <div class="max-w-[70%] rounded-lg bg-muted px-3 py-2 text-xs">
                        这是假主列内容，只用来示意「dock 区在右侧、会跟主列抢宽度」。
                    </div>
                    <div class="ml-auto max-w-[70%] rounded-lg bg-primary/10 px-3 py-2 text-xs">
                        演示页的数据全是 mock，页面不发任何 /api/v1 请求。
                    </div>
                    <div class="max-w-[70%] rounded-lg bg-muted px-3 py-2 text-xs">
                        右侧 dock 区是货真价实的 dockview 实例：拖 tab、拖分隔条、浮动都可用。
                    </div>
                    <div class="ml-auto max-w-[70%] rounded-lg bg-primary/10 px-3 py-2 text-xs">
                        布局状态可以用 api.toJSON() 一把拿走，再用 fromJSON 还原。
                    </div>
                </div>
            </section>

            <section class="dockview-host min-h-0 min-w-0 flex-1" data-demo="dock-area">
                <DockviewVue
                    class="h-full w-full"
                    v-bind="DOCKVIEW_OPTIONS"
                    :theme="themeLight"
                    @ready="onReady"
                >
                    <template #panel-chat>
                        <div class="flex h-full flex-col gap-2 overflow-auto p-3 text-xs">
                            <div class="font-medium">对话</div>
                            <div class="rounded bg-muted px-2 py-1.5">
                                用户：这个 dock 区能拆两组吗？
                            </div>
                            <div class="rounded bg-primary/10 px-2 py-1.5">
                                助手：能，点上面「① 拆成两组」，两个面板会并排同屏。
                            </div>
                            <div class="rounded bg-muted px-2 py-1.5">用户：拖 tab 呢？</div>
                            <div class="rounded bg-primary/10 px-2 py-1.5">
                                助手：直接拖到另一个组，dockview 自己处理落点高亮。
                            </div>
                            <div class="rounded bg-muted px-2 py-1.5">用户：那分隔条能拖吗？</div>
                            <div class="rounded bg-primary/10 px-2 py-1.5">
                                助手：能，拖两组之间的 sash 就能改宽度（③）。
                            </div>
                            <div class="rounded bg-muted px-2 py-1.5">用户：布局能存下来吗？</div>
                            <div class="rounded bg-primary/10 px-2 py-1.5">
                                助手：api.toJSON() 一把拿全部状态，见下方代码框（⑤）。
                            </div>
                        </div>
                    </template>
                    <template #panel-file>
                        <div
                            class="flex h-full flex-col overflow-auto p-3 font-mono text-[11px] leading-5"
                        >
                            <div class="mb-1 font-sans text-xs font-medium">文件预览</div>
                            <div class="text-muted-foreground">1 export function demo() {</div>
                            <div class="text-muted-foreground">
                                2 &nbsp;&nbsp;const panels = ["chat", "file", "logs"];
                            </div>
                            <div class="text-muted-foreground">
                                3 &nbsp;&nbsp;return panels.map(toTab);
                            </div>
                            <div class="text-muted-foreground">4 }</div>
                            <div class="text-muted-foreground">&nbsp;</div>
                            <div class="text-muted-foreground">
                                5 // 这个面板和「对话」在同一个组里，
                            </div>
                            <div class="text-muted-foreground">6 // 也可以被拖到别的组（②）。</div>
                            <div class="text-muted-foreground">&nbsp;</div>
                            <div class="text-muted-foreground">
                                7 // 拖过去之后两边的 tab 数会变，
                            </div>
                            <div class="text-muted-foreground">8 // 但布局本身仍是同一棵树。</div>
                        </div>
                    </template>
                    <template #panel-logs>
                        <div
                            class="flex h-full flex-col gap-0.5 overflow-auto p-3 font-mono text-[11px] leading-5"
                        >
                            <div class="mb-1 font-sans text-xs font-medium">运行日志</div>
                            <div>[10:00:00] INFO &nbsp;stack ready</div>
                            <div>[10:00:01] INFO &nbsp;ui mounted on :12692</div>
                            <div>[10:00:02] WARN &nbsp;mock only, no backend</div>
                            <div>[10:00:03] INFO &nbsp;dockview shell created</div>
                            <div>[10:00:03] INFO &nbsp;panel chat added (group 1)</div>
                            <div>[10:00:03] INFO &nbsp;panel file added (group 1)</div>
                            <div>[10:00:03] INFO &nbsp;panel logs added (group 1)</div>
                            <div>[10:00:04] DEBUG layout toJSON 1210 bytes</div>
                            <div>[10:00:05] INFO &nbsp;no /api/v1 request issued</div>
                        </div>
                    </template>
                </DockviewVue>
            </section>
        </div>

        <!-- 底栏：提示行 + 序列化代码框 -->
        <footer class="flex h-[210px] shrink-0 border-t bg-card">
            <div class="flex w-[38%] shrink-0 flex-col gap-1 border-r p-3 text-xs">
                <div class="font-medium">当前动作</div>
                <div class="text-muted-foreground" data-demo="note">{{ note }}</div>
                <div class="mt-auto space-y-0.5 text-[11px] text-muted-foreground">
                    <div>② 跨组拖 tab：把任一 tab 拖到另一组（真实拖拽）</div>
                    <div>③ 组间缩放：拖两组之间的分隔条</div>
                </div>
            </div>
            <div class="flex min-w-0 flex-1 flex-col p-3">
                <div class="mb-1 text-xs font-medium">⑤ api.toJSON() —— 布局持久化的全部状态</div>
                <pre
                    data-demo="json"
                    class="min-h-0 flex-1 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[10px] leading-4 text-muted-foreground"
                    >{{ savedJson || "（点「⑤ 保存布局」把当前布局序列化到这里）" }}</pre>
            </div>
        </footer>
    </div>
</template>

<style>
/*
 * 演示级覆盖（只作用于本页 `.dockview-demo-root`，不影响产品）。
 *
 * 为什么需要：产品侧的 `--dv-*` 映射（`styles/dockview-theme.css`）把「活动 tab 背景」与
 * 「非活动 tab 背景」都映到 `--surface-canvas`，两者视觉上**无法区分**；浮动组也没有阴影。
 * 演示页要让用户看清「哪个是活动 tab / 哪个是浮动窗」，所以这里补 10 个变量 + 浮动阴影。
 *
 * ⇒ 这几行本身就是「样式接管」的代价证据：要让 dockview 长成 XH 的样子，
 * 产品侧还需再调 3–5 个变量（见 evidence/dockview-capability-demo.md）。
 */
.dockview-demo-root .dockview-host {
    --dv-group-view-background-color: var(--card, #ffffff);
    --dv-tabs-and-actions-container-background-color: var(--muted, #f4f4f5);
    --dv-activegroup-visiblepanel-tab-background-color: var(--card, #ffffff);
    --dv-activegroup-visiblepanel-tab-color: var(--foreground, #18181b);
    --dv-activegroup-hiddenpanel-tab-background-color: var(--muted, #f4f4f5);
    --dv-activegroup-hiddenpanel-tab-color: var(--muted-foreground, #71717a);
    --dv-inactivegroup-visiblepanel-tab-background-color: var(--muted, #f4f4f5);
    --dv-inactivegroup-visiblepanel-tab-color: var(--muted-foreground, #71717a);
    --dv-inactivegroup-hiddenpanel-tab-background-color: var(--muted, #f4f4f5);
    --dv-inactivegroup-hiddenpanel-tab-color: var(--muted-foreground, #71717a);
    --dv-tab-divider-color: transparent;
}

/* 活动 tab 加一条顶部指示条（产品注意力预算 L3：选中指示 ≤2/屏）。 */
.dockview-demo-root .dockview-host .dv-tab.dv-active-tab {
    box-shadow: inset 0 2px 0 0 var(--primary, #18181b);
}

/* 浮动组：只有 floating 允许阴影（产品规则）。 */
.dockview-demo-root .dockview-host .dv-resize-container {
    box-shadow: 0 12px 32px -8px rgb(0 0 0 / 32%);
    border-radius: 6px;
}

/* sash 悬停可辨识（dockview 默认只在拖拽时变色）。 */
.dockview-demo-root .dockview-host .dv-sash:hover {
    background-color: var(--primary, #18181b);
    opacity: 0.35;
}
</style>
