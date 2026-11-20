<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { CheckIcon, ChevronDownIcon } from "@lucide/vue";
import { computed } from "vue";
import { cn } from "@/lib/utils";
import type { SearchableComboboxOption } from "./types";
import {
    Combobox,
    ComboboxAnchor,
    ComboboxEmpty,
    ComboboxInput,
    ComboboxItem,
    ComboboxItemIndicator,
    ComboboxList,
    ComboboxTrigger,
    ComboboxViewport,
} from ".";

/**
 * task-152：>8 项选择器统一载体。
 *
 * 为什么不是 Select：Select 的弹层宽度跟着触发器走（这是 task-139 定的契约，保证「选项不会被裁在触发器外」），
 * 但 24 个审计状态 / 12 个配置域这种长列表塞进 62px 的触发器里就必须靠调用点 `min-w-*` 覆写兜底——
 * 那正是 task-152 要消掉的第二真相源。这里换成可搜索面板：宽度仍跟触发器，但面板自带搜索框，
 * 项数再多也是「输入收敛 → 点选」，不需要调用点改宽度。
 */
defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(
    defineProps<{
        modelValue?: string;
        options: readonly SearchableComboboxOption[];
        placeholder?: string;
        /** 过滤后无结果时的提示；不传则不渲染空态。 */
        emptyText?: string;
        /** 面板里搜索框的占位文案。 */
        searchPlaceholder?: string;
        disabled?: boolean;
        /** 落在触发器上的 data-testid，用来保住既有 e2e 选择器。 */
        testid?: string;
        triggerClass?: HTMLAttributes["class"];
        panelClass?: HTMLAttributes["class"];
    }>(),
    {
        modelValue: "",
        placeholder: "",
        emptyText: "",
        searchPlaceholder: "",
        disabled: false,
        testid: undefined,
        triggerClass: "",
        panelClass: "",
    },
);

const emit = defineEmits<{
    "update:modelValue": [value: string];
    "update:open": [open: boolean];
}>();

const current = computed<string>({
    get: () => props.modelValue ?? "",
    set: (value) => {
        if (value !== props.modelValue) emit("update:modelValue", value);
    },
});

const selectedLabel = computed(
    () => props.options.find((option) => option.value === current.value)?.label ?? "",
);
</script>

<template>
    <Combobox
        v-model="current"
        :disabled="disabled"
        :reset-search-term-on-select="true"
        :reset-search-term-on-blur="true"
        @update:open="(value: boolean) => emit('update:open', value)"
    >
        <ComboboxAnchor class="w-full">
            <ComboboxTrigger
                type="button"
                v-bind="$attrs"
                :data-testid="testid"
                :disabled="disabled"
                :aria-label="selectedLabel || placeholder"
                :class="
                    cn(
                        'flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground transition-colors outline-none hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-ring [&_svg]:size-4 [&_svg]:shrink-0',
                        triggerClass,
                    )
                "
            >
                <span class="min-w-0 flex-1 truncate text-left">
                    <slot name="value" :label="selectedLabel" :placeholder="placeholder">
                        <span v-if="selectedLabel" class="truncate">{{ selectedLabel }}</span>
                        <span v-else class="text-muted-foreground">{{ placeholder }}</span>
                    </slot>
                </span>
                <ChevronDownIcon class="size-4 shrink-0 opacity-50" />
            </ComboboxTrigger>
        </ComboboxAnchor>
        <ComboboxList
            :class="
                cn(
                    // task-152：面板下限 14rem —— 62px 的域筛选触发器若让面板等宽，搜索框连一个域名都放不下。
                    // 这是组件级宽度下限（单一真相源在组件里），不是调用点覆写。
                    'min-w-[14rem]',
                    panelClass,
                )
            "
        >
            <ComboboxInput
                :auto-focus="true"
                :disabled="disabled"
                :placeholder="searchPlaceholder || placeholder"
                class="px-2"
                data-testid="searchable-combobox-input"
            />
            <ComboboxViewport>
                <ComboboxEmpty v-if="emptyText">{{ emptyText }}</ComboboxEmpty>
                <ComboboxItem
                    v-for="option in options"
                    :key="option.value"
                    :value="option.value"
                    :text-value="option.label"
                >
                    <!-- task-152：面板宽度跟触发器（契约），长账号名/域名可能仍超出 → 与 SelectItem 一致补 title 兜底。 -->
                    <span class="min-w-0 flex-1 truncate" :title="option.label">{{
                        option.label
                    }}</span>
                    <span v-if="option.hint" class="shrink-0 text-xs text-muted-foreground">{{
                        option.hint
                    }}</span>
                    <ComboboxItemIndicator>
                        <CheckIcon class="size-4" />
                    </ComboboxItemIndicator>
                </ComboboxItem>
            </ComboboxViewport>
        </ComboboxList>
    </Combobox>
</template>
