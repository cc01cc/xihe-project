<script setup lang="ts">
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import { AppWindow, X } from "@lucide/vue";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import type { ContainerId } from "../lib/containers";
import type { ContainerRowKeyPayload, MoveDirection } from "../lib/containerTabNav";

/**
 * task-174（S2b）容器内页签行 —— **同一组件两实例**（左树容器 / 中内容容器）。
 *
 * 为什么是受控子件而不是自己去读布局：布局事实的唯一 writer 是 dockview 序列化那一路
 * （`useWorkspaceLayout`），容器归属由 `lib/containers.ts#containerOf` 纯派生。
 * 这个组件**不读 localStorage、不推路由、不改布局** —— 只把「这个容器承载哪些页签、
 * 当前哪个是活的」画出来，选择/关闭都 emit 给调用方。否则就会出现第二个 writer。
 *
 * 语义沿用 `WorkspaceTabBar`：reka `Tabs` 拥有 role/aria-selected/roving focus，
 * 有些不变量只在页签行内成立（判据②：**每个容器页签行内 aria-current ≤1**，不是全页 1）。
 */
const props = defineProps<{
    /** 本行属于哪个容器（同时作为 DOM 读数锚点 data-container）。 */
    containerId: ContainerId;
    tabs: readonly { id: string; label: string; closable: boolean }[];
    activeId: string | null;
    /**
     * 是否允许在**没有页签**时也渲染一条空行。
     *
     * 默认 `false`：**空容器不渲染页签行**。理由（Lead 2026-11-15 提醒）：一条「看起来有页签行、
     * 里面一个 tab 都没有」的空带是最难查的假绿 —— 判据「容器数 == 页签行数」会被它骗过。
     * 所以无页签 ⇒ 不渲染（而不是渲染空壳）；只有显式 `allowEmpty` 的调用方才画空行。
     */
    allowEmpty?: boolean;
    /**
     * D-1777/D-1778 §8 第 1 步：右栏行页签 testid 沿用既有 dock-tab-* 契约（src+e2e 66+
     * 消费点，不得改名），故可传前缀覆盖默认的 workspace-container-tab-<container>-<id>。
     */
    testidPrefix?: string;
    /** close 按钮 testid 前缀，默认 workspace-container-tab-close-<container>-。 */
    closeTestidPrefix?: string;
    /** true = 只有 active 页签渲染 close 按钮（dock 行语义， today 只给 active 页签）。 */
    closeActiveOnly?: boolean;
}>();

// 两个事件签名完全同形 ⇒ 用联合类型一次声明（unified-signatures）。
const emit = defineEmits<{
    (event: "select" | "close", tabId: string): void;
    /** 判定不在这里做：只有调用方知道「一共有哪些行」，本组件只上报按键事实。 */
    (event: "row-key", payload: ContainerRowKeyPayload): void;
    (event: "tab-auxclick", tabId: string, event_: MouseEvent): void;
}>();

const MOVE_KEY_DIRECTIONS: Readonly<Record<string, MoveDirection>> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowDown: "split",
};

/**
 * task-184：只在**页签行内**接管键盘（`D-1600` ①）。
 *
 * <p>为什么限定作用域而不是全局监听：`Ctrl+Alt+ArrowUp/Down` 是 CodeMirror `defaultKeymap`
 * 的 `addCursorAbove/Below`（`@codemirror/commands`），编辑器拿焦点时这些键必须归编辑器；
 * 页签行里没有编辑器 ⇒ 在行内接管既拿到了键、又不会与编辑器抢（`D-1600` ①的裁定理由）。
 * `F6` 不要求修饰键，但同样只在行内上报 —— 行外按 F6 是浏览器/OS 的事。</p>
 */
function onRowKeydown(event: KeyboardEvent): void {
    if (event.key === "F6") {
        emit("row-key", {
            container: props.containerId,
            key: event.key,
            shift: event.shiftKey,
            direction: null,
            event,
        });
        return;
    }
    if (!event.ctrlKey || !event.altKey) return;
    const direction = MOVE_KEY_DIRECTIONS[event.key];
    if (direction === undefined) return;
    emit("row-key", {
        container: props.containerId,
        key: event.key,
        shift: event.shiftKey,
        direction,
        event,
    });
}

const { t } = useI18n();
const domId = useId();

// D-1777/D-1778：容器集合 = {main, right}。`tree` 不再是容器（树是右栏的面板），
// 这里只认 main/right 两种值域。
const containerLabel = computed(() =>
    props.containerId === "right" ? t("workspace.containerRight") : t("workspace.containerMain"),
);

/** 页签/close 的 testid：右栏行走 dock-tab-* 前缀（见 props 注释），其余走容器形默认名。 */
function tabTestid(id: string): string {
    return props.testidPrefix
        ? props.testidPrefix + id
        : "workspace-container-tab-" + props.containerId + "-" + id;
}
function closeTestid(id: string): string {
    return props.closeTestidPrefix
        ? props.closeTestidPrefix + id
        : "workspace-container-tab-close-" + props.containerId + "-" + id;
}

/**
 * task-17 W-1（自审批01）：单 tab 且与容器标签同名 ⇒ 视觉上去掉容器标签，只留 tab。
 * 典型形态是树容器（恒单 tab「文件树」）——原先 nav 标签 + tab 画出「文件树 文件树」双标。
 * 可访问名不丢：nav 的 aria-label 仍是容器名；tab 文本照常可读。
 * 主容器单 tab（如仅一个会话）标签不同名 ⇒ 不受影响，容器标识保留。
 */
const singleTabRedundant = computed(
    () => props.tabs.length === 1 && props.tabs[0].label === containerLabel.value,
);

/** reka 的 v-model 是「当前活页签」；没有活页签时给空串，避免它自行选第一个。 */
const activeTab = computed<string>({
    get: () => props.activeId ?? "",
    set: (next) => {
        if (next) emit("select", next);
    },
});
</script>

<template>
    <nav
        v-if="tabs.length > 0 || allowEmpty"
        class="flex h-9 shrink-0 items-center gap-1 border-b bg-card px-2"
        data-testid="workspace-container-tabs"
        :data-container="containerId"
        :aria-label="containerLabel"
        @keydown="onRowKeydown"
    >
        <span
            v-if="!singleTabRedundant"
            data-testid="workspace-container-label"
            class="text-xs font-medium text-muted-foreground"
        >
            {{ containerLabel }}
        </span>
        <Tabs :id="domId" :model-value="activeTab" class="min-w-0 flex-1">
            <TabsList variant="line" class="p-0">
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
                        :data-testid="tabTestid(tab.id)"
                        @auxclick="emit('tab-auxclick', tab.id, $event)"
                        :data-tab-id="tab.id"
                        :title="tab.label"
                        class="h-auto max-w-52 flex-none rounded-md px-2 py-1 text-xs after:hidden data-active:bg-transparent data-active:text-inherit dark:data-active:border-transparent dark:data-active:bg-transparent"
                        :class="tab.id === activeId ? 'font-medium' : ''"
                        @click="emit('select', tab.id)"
                    >
                        <!--
                            task-52 / batch-02 ②（P1-3，`D-1703`）：**同名不同物**要能在视觉上分开。
                            侧栏会话行与本页签行渲染的是**同一个 title**，原先两者外观要素几乎一致
                            ⇒ 用户分不清「这一行是会话（点进去换会话）」还是「这是页签（换容器内视图）」。
                            这里加一个「窗口」图标（`AppWindow`）作为**页签身份**：
                            与侧栏会话行的对话气泡（`MessageSquareText`）语义相对 —— 页签=窗口、
                            会话=对话。图标走 `aria-hidden`，读屏靠 `role="tab"` 区分，不依赖图标。
                        -->
                        <AppWindow
                            data-testid="workspace-tab-identity"
                            class="mr-1 size-3 shrink-0 opacity-60"
                            aria-hidden="true"
                        />
                        <span class="truncate">{{ tab.label }}</span>
                    </TabsTrigger>
                    <!--
                        task-89（触控目标，WCAG 2.2 SC 2.5.8 ≥24×24）：`p-0.5` + `size-3`
                        ⇒ 14×14，与左邻 `workspace-container-tab-` 本体矩形距 7 ⇒ 是真缺陷。
                        `min-h-7 min-w-7` = 7 × 3.5px = 24.5px 命中盒；`X` 图标仍 size-3 不放大。
                    -->
                    <button
                        v-if="tab.closable && (!closeActiveOnly || tab.id === activeId)"
                        type="button"
                        :data-testid="closeTestid(tab.id)"
                        :aria-label="'关闭 ' + tab.label"
                        class="mr-1 inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click.stop="emit('close', tab.id)"
                    >
                        <X class="size-3" aria-hidden="true" />
                    </button>
                </div>
            </TabsList>
        </Tabs>
        <!--
            task-65 A 段（§8 第 1 步）：右栏行复用既有 WorkspaceContainerTabs，行尾 actions 插槽放
            mode/focus/close 三键（替代原 WorkspaceDock 自造 tablist 条内那三个按钮）。插槽必须挂在
            nav 内、Tabs 之后，否则三键会被看成容器页签（行内 role=tab 计数与 aria-current 都要干净）。
        -->
        <div class="ml-auto flex shrink-0 items-center gap-1">
            <slot name="actions" />
        </div>
        <span v-if="allowEmpty && tabs.length === 0" class="text-xs text-muted-foreground">
            {{ t("workspace.containerEmpty") }}
        </span>
    </nav>
</template>
