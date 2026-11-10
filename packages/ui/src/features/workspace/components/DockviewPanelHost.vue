<script setup lang="ts">
import { onMounted, ref } from "vue";

/**
 * PLAN-0756 T1: dockview 面板的 Vue 内容宿主。
 *
 * dockview 的 Vue 集成经 `<Teleport>` 把 scoped slot（`panel-<id>`）渲染进每个
 * `.dv-content-container`。本组件是 slot 的根：拿到面板 `api` 后把 `.dv-content-container`
 * 设为 `display:contents`（让产品内容直接撑满 dockview 的内容区，去掉容器默认 padding），
 * 并把 slot 的具名内容透传进来。
 *
 * 渲染的具名 slot 由父级（`WorkspaceDock`）按 tab id 注入，这里只做 Teleport 挂载点。
 */
defineProps<{ tabId: string }>();

const hostRef = ref<HTMLElement | null>(null);

onMounted(() => {
    // dockview 的 .dv-content-container 带默认 padding，让产品内容直接撑满内容区。
    const container = hostRef.value?.closest(".dv-content-container") as HTMLElement | null;
    if (container) container.style.display = "contents";
});
</script>

<template>
    <!-- 内容经父级 slot 透传；Teleport 目标由 dockview-vue 的 DockviewPortals 管理 -->
    <div ref="hostRef" class="dockview-panel-host h-full min-h-0 w-full overflow-hidden">
        <slot />
    </div>
</template>
