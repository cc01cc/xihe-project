<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Plus } from "@lucide/vue";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";

/**
 * 容器页签行「+」的**唯一**实现（task-140 / D-1907 rev7「两容器 + 对等」）。
 *
 * <p>rev7 的判据是「两个容器的 + 弹出**同一组**组件」，因此两个入口不能各写一份菜单：
 * 一份改了口径另一份不知道，就是今天「主栏 + 新建会话、右栏 + 重开面板」的成因。
 * 这里只做三件事 —— 触发按钮、菜单原语、项的选中态投影；**点哪个组件、落到哪个容器、
 * 布局怎么写，全部由调用方决定**（主栏与右栏各自 emit `select` 给自己的 writer）。</p>
 *
 * <p><b>为什么是 reka 原语而不是手搓</b>：`role=menu` / `menuitemcheckbox`、Esc 关闭、
 * 上下键 roving focus、点外部关闭都由栈内 vendor 的 `components/ui/dropdown-menu`
 * （shadcn-vue on reka-ui）提供，手搓版本正是本轮要替换掉的东西。</p>
 *
 * <p><b>已开项用 `aria-checked`</b>（Lead 2026-11-20 裁定，开关语义）⇒ 项类型必须是
 * `DropdownMenuCheckboxItem`（自动 `role=menuitemcheckbox` + `aria-checked`）；
 * 不能把 `aria-checked` 挂普通 `menuitem` 上，那是无效组合。
 * 状态真源在调用方（`entry.checked` 只读投影）：**不接 `update:model-value`**，
 * 否则菜单自己记第二份真源。</p>
 *
 * <p><b>testid 契约</b>：触发按钮恒为 `workspace-container-plus-<containerId>`
 * （`task155-main-overflow` 与既有 66+ 消费点按它定位）；菜单与项由调用方给，
 * 右栏沿用 `dock-reopen-menu` / `dock-reopen-item-<id>` 不改名（无收益漂移）。
 * 菜单内容经 `DropdownMenuPortal` 落到 body ⇒ 单测要查 `document`，不能 `wrapper.get`。</p>
 */
interface ContainerAddEntry {
    /** 组件 id（dock 面板 id 或将来三元组里的视图 id），原样回传给调用方。 */
    id: string;
    /** 已翻译好的标签（调用方持有 i18n table，组件不猜 key）。 */
    label: string;
    /** 该组件当前是否已在这个容器里打开（只读投影，用于 `aria-checked`）。 */
    checked: boolean;
    /** 该项的 `data-testid`（各车道既有契约不同，由调用方给）。 */
    testid: string;
}

const props = withDefaults(
    defineProps<{
        containerId: "main" | "right";
        entries: ContainerAddEntry[];
        disabled?: boolean;
    }>(),
    { disabled: false },
);

const emit = defineEmits<{
    /** 选中某个组件。开/关/聚焦/换容器的语义归调用方（单一 writer）。 */
    select: [id: string];
}>();

const { t } = useI18n();
</script>

<template>
    <DropdownMenu>
        <DropdownMenuTrigger as-child>
            <button
                type="button"
                :data-testid="`workspace-container-plus-${props.containerId}`"
                class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                :aria-label="t('workspace.containerPlusNew')"
                :title="t('workspace.containerPlusNew')"
                :disabled="props.disabled"
            >
                <Plus class="size-3.5" aria-hidden="true" />
            </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
            align="end"
            :data-testid="`workspace-container-add-menu-${props.containerId}`"
            class="w-44"
        >
            <DropdownMenuCheckboxItem
                v-for="entry in props.entries"
                :key="entry.id"
                :data-testid="entry.testid"
                :model-value="entry.checked"
                class="justify-start gap-2"
                @select="emit('select', entry.id)"
            >
                <span class="min-w-0 flex-1 truncate">{{ entry.label }}</span>
                <span v-if="entry.checked" class="shrink-0 text-xs text-muted-foreground">{{
                    t("workspace.dockTabOpen")
                }}</span>
            </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
    </DropdownMenu>
</template>
