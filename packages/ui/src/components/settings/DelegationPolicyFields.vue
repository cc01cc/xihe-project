<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "../ui/input";
import { delegationPolicyValid, type DelegationPolicyValue } from "./delegationPolicyValue";

/**
 * task-191：委派预算字段组（maxCount / maxDepth），供主体详情抽屉使用。
 *
 * <p>空输入 = 未设置（用平台默认）；两半同填同清（半填由校验挡住，不发请求）。
 * 校验状态经 `defineExpose` 暴露给宿主做保存门控，宿主不复制校验规则。</p>
 */

const props = withDefaults(
    defineProps<{
        modelValue: DelegationPolicyValue;
        disabled?: boolean;
    }>(),
    { disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [value: DelegationPolicyValue] }>();
const { t } = useI18n();
const K = "agentPrincipalDetail.delegation.";

/**
 * task-45：setter 收到的**不一定是 string**。
 *
 * <p>宿主 `Input.vue` 用 `useVModel(passive)` 且模板是 `<input type="number" v-model>`，
 * Vue 的 vModelText 对 number 输入会 `looseToNumber` 后回灌，于是这里收到的是 number；
 * 清空时是 null。不归一就直接 `raw.trim()` 会抛 `TypeError: raw.trim is not a function`
 * （真栈表现：输入框有值但 data-dirty 恒 false、保存键恒禁用）。
 * 只在本地归一，**不动 Input.vue 的全局 passive 语义**（全仓 input 共用）。</p>
 */
function textOf(raw: unknown): string {
    if (raw === null || raw === undefined) return "";
    return typeof raw === "string" ? raw : String(raw);
}

// number input 的 v-model 中介：空串 ⇔ null，非法串原样保留让用户继续编辑。
const countText = computed({
    get: () => (props.modelValue.maxCount === null ? "" : String(props.modelValue.maxCount)),
    set: (raw: string) => {
        const trimmed = textOf(raw).trim();
        emit("update:modelValue", {
            ...props.modelValue,
            maxCount: trimmed === "" ? null : Number(trimmed),
        });
    },
});
const depthText = computed({
    get: () => (props.modelValue.maxDepth === null ? "" : String(props.modelValue.maxDepth)),
    set: (raw: string) => {
        const trimmed = textOf(raw).trim();
        emit("update:modelValue", {
            ...props.modelValue,
            maxDepth: trimmed === "" ? null : Number(trimmed),
        });
    },
});

const valid = computed(() => delegationPolicyValid(props.modelValue));

defineExpose({ valid });
</script>

<template>
    <div class="space-y-3" data-testid="delegation-policy-fields">
        <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
                <label class="text-sm font-medium" for="delegation-policy-max-count">
                    {{ t(K + "maxCount") }}
                </label>
                <Input
                    id="delegation-policy-max-count"
                    v-model="countText"
                    type="number"
                    min="0"
                    step="1"
                    :disabled="disabled"
                    data-testid="delegation-policy-max-count"
                />
            </div>
            <div class="space-y-1.5">
                <label class="text-sm font-medium" for="delegation-policy-max-depth">
                    {{ t(K + "maxDepth") }}
                </label>
                <Input
                    id="delegation-policy-max-depth"
                    v-model="depthText"
                    type="number"
                    min="1"
                    step="1"
                    :disabled="disabled"
                    data-testid="delegation-policy-max-depth"
                />
            </div>
        </div>
        <p class="text-xs leading-5 text-muted-foreground">{{ t(K + "hint") }}</p>
        <p
            v-if="!valid"
            class="text-xs text-destructive"
            role="alert"
            data-testid="delegation-policy-invalid"
        >
            {{ t(K + "invalid") }}
        </p>
    </div>
</template>
