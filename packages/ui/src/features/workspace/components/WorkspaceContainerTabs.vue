<script setup lang="ts">
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "@lucide/vue";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import type { ContainerId } from "../lib/containers";

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
}>();

// 两个事件签名完全同形 ⇒ 用联合类型一次声明（unified-signatures）。
const emit = defineEmits<{
    (event: "select" | "close", tabId: string): void;
}>();

const { t } = useI18n();
const domId = useId();

const containerLabel = computed(() =>
    props.containerId === "tree" ? t("workspace.containerTree") : t("workspace.containerMain"),
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
    >
        <span class="text-xs font-medium text-muted-foreground">
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
                        :data-testid="'workspace-container-tab-' + containerId + '-' + tab.id"
                        :data-tab-id="tab.id"
                        :title="tab.label"
                        class="h-auto max-w-52 flex-none rounded-md px-2 py-1 text-xs after:hidden data-active:bg-transparent data-active:text-inherit dark:data-active:border-transparent dark:data-active:bg-transparent"
                        :class="tab.id === activeId ? 'font-medium' : ''"
                        @click="emit('select', tab.id)"
                    >
                        <span class="truncate">{{ tab.label }}</span>
                    </TabsTrigger>
                    <button
                        v-if="tab.closable"
                        type="button"
                        :data-testid="'workspace-container-tab-close-' + containerId + '-' + tab.id"
                        :aria-label="'关闭 ' + tab.label"
                        class="mr-1 rounded p-0.5 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click.stop="emit('close', tab.id)"
                    >
                        <X class="size-3" aria-hidden="true" />
                    </button>
                </div>
            </TabsList>
        </Tabs>
        <span v-if="allowEmpty && tabs.length === 0" class="text-xs text-muted-foreground">
            {{ t("workspace.containerEmpty") }}
        </span>
    </nav>
</template>
