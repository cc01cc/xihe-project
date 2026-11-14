<script setup lang="ts" generic="T extends Record<string, any>">
import { computed, useAttrs, type HTMLAttributes } from "vue";
import { TreeItem, type TreeItemEmits, type TreeItemProps } from "reka-ui";
import { cn } from "@/lib/utils";

defineOptions({
    inheritAttrs: false,
});

const props = defineProps<TreeItemProps<T> & { class?: HTMLAttributes["class"] }>();
const emits = defineEmits<TreeItemEmits<T>>();

const attrs = useAttrs();

/**
 * task-33：本组件声明了 `inheritAttrs: false`，却只把**声明过的 props** 往下传 —— 于是
 * 使用方附加的任何属性（`data-testid`、`aria-level`…）都被静默丢弃。那不是"用法问题"，
 * 是包装器自己的缺陷：包一层的目的就是「保留 vendor 行为 + 加我们的约定」，attrs 无出口
 * 等于把这个目的取消了。实证：org 组织树模板里写着 `:data-testid="'org-tree-node-' + key"`，
 * 一直**没进过 DOM**，因为没人断言过，几年都没被发现。
 *
 * <p>合并方向是加法：三处调用点（`OrgUnitTreePanel`、`TreeNodeList`、预览
 * `TreeCapabilitiesSection`）里只有 org 树会附加属性，其余只传 `value` / `level` / `class`。
 * `class` 是声明 prop（在 `props.class`，不在 `$attrs`），故不会被重复应用。</p>
 */
const delegatedProps = computed(() => {
    const { class: _cls, ...rest } = props as unknown as Record<string, unknown>;
    return { ...rest, ...attrs } as unknown as Omit<TreeItemProps<T>, "class">;
});
</script>

<template>
    <TreeItem
        v-slot="slotProps"
        data-slot="tree-item"
        v-bind="delegatedProps"
        @select="(event) => emits('select', event)"
        @toggle="(event) => emits('toggle', event)"
        :class="cn('outline-none', props.class)"
    >
        <slot v-bind="slotProps" />
    </TreeItem>
</template>
