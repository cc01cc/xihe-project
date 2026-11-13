<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronRight } from "@lucide/vue";
import { RAIL_HOVER_OPEN_DELAY_MS, type GlobalModuleDef } from "../../lib/globalModules";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

/**
 * GlobalRail 的一个模块行 + 它的二级菜单（`task-189`）。
 *
 * <p>拆成独立组件是为了**一处实现、两处使用**（`SidebarContent` 里的「工作台/资源」与
 * `SidebarFooter` 里的「设置」）—— 复制一份标记语言就等于两份可各自演化的交互（悬停延时、
 * aria 属性、菜单宽度迟早分叉），这与 `D-896`「内容必须由 SSOT 派生」同源：能派生就不复制。</p>
 *
 * <p>三条打开通道（卡面 `task-189`）：<b>悬浮</b>（仅折叠态 —— 展开态有文字，悬停开菜单会抢
 * 焦点）、<b>可点击</b>（行内 chevron 触发 `DropdownMenu`）、<b>可键盘</b>（chevron 是原生
 * `<button>`，Tab 可达、Enter/Space 打开；折叠态用 `sr-only` 藏**但不排除出可达性树**，
 * 所以键盘用户在折叠态也能开菜单）。行本身仍是导航：点行直接去模块落地页。</p>
 */
const props = defineProps<{
    module: GlobalModuleDef;
    /** 菜单是否打开（由父组件统一持有，保证同一时刻只开一个）。 */
    open: boolean;
    /** 全局条是否处于折叠态（决定悬浮是否作为打开通道）。 */
    collapsed: boolean;
    /** 当前路由路径（用于二级菜单项的选中态）。 */
    activePath: string;
    /** 本模块是否处于激活态（父组件按 `basePath` 前缀判定后传入）。 */
    active: boolean;
}>();

const emit = defineEmits<{
    navigate: [path: string];
    "update:open": [value: boolean];
}>();

const { t } = useI18n();
let hoverTimer: ReturnType<typeof setTimeout> | undefined;

function cancelHover() {
    if (hoverTimer !== undefined) {
        clearTimeout(hoverTimer);
        hoverTimer = undefined;
    }
}

function scheduleOpen(value: boolean) {
    cancelHover();
    hoverTimer = setTimeout(() => {
        emit("update:open", value);
        hoverTimer = undefined;
    }, RAIL_HOVER_OPEN_DELAY_MS);
}

function onPointerEnter() {
    if (props.open) return;
    if (!props.collapsed) return;
    scheduleOpen(true);
}

function onPointerLeave() {
    if (!props.open) {
        cancelHover();
        return;
    }
    scheduleOpen(false);
}

function isItemActive(path: string) {
    return props.activePath === path;
}

onBeforeUnmount(cancelHover);
</script>

<template>
    <SidebarMenuItem>
        <div class="relative" @pointerenter="onPointerEnter" @pointerleave="onPointerLeave">
            <SidebarMenuButton
                :data-testid="`global-rail-module-${module.id}`"
                :is-active="active"
                :aria-current="active ? 'page' : undefined"
                class="data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium"
                @click="emit('navigate', module.path)"
            >
                <component :is="module.icon" class="size-4 shrink-0" aria-hidden="true" />
                <span class="truncate group-data-[collapsible=icon]:hidden">{{
                    t(module.labelKey)
                }}</span>
            </SidebarMenuButton>
            <!--
                二级菜单触发器：折叠态用 `sr-only` 藏起，**不排除出可达性树** ——
                Tab 仍可聚焦、Enter/Space 仍能打开，只是视觉上让位给 56px 图标栏。
            -->
            <DropdownMenu
                :open="open"
                @update:open="(value: boolean) => emit('update:open', value)"
            >
                <DropdownMenuTrigger as-child>
                    <button
                        type="button"
                        :data-testid="`global-rail-menu-${module.id}`"
                        :aria-label="t('sidebar.moduleMenu')"
                        class="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:sr-only"
                    >
                        <ChevronRight class="size-3.5" aria-hidden="true" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    side="right"
                    align="start"
                    class="min-w-56"
                    :data-testid="`global-rail-menu-content-${module.id}`"
                    @pointerenter="cancelHover"
                    @pointerleave="onPointerLeave"
                >
                    <DropdownMenuLabel>{{ t(module.labelKey) }}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        v-for="item in module.items"
                        :key="item.id"
                        :data-testid="`global-rail-menu-item-${module.id}-${item.id}`"
                        class="gap-2"
                        @select="emit('navigate', item.path)"
                    >
                        <span class="truncate">{{ t(item.labelKey) }}</span>
                        <Check
                            v-if="isItemActive(item.path)"
                            class="ml-auto size-3.5"
                            aria-hidden="true"
                        />
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    </SidebarMenuItem>
</template>
