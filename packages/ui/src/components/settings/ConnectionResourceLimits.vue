<script setup lang="ts">
/**
 * PLAN-0622 Resource Governor（连接级限额）——只负责**展示 + 编辑 + 正数校验**，
 * 不改动连接的其它字段。父组件（ProviderHub）把 `v-model` 的值合并进 PATCH。
 *
 * 语义（冻结契约）：字段留空 = 不限额；填写则必须是 **正整数**。
 * 超限时 CP 返回 `429 RESOURCE_EXHAUSTED` + `Retry-After`，与 429 提示同源。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ConnectionModelLimit, ProviderConnection } from "../../types/providerConnection";

const props = defineProps<{
    /** 正在编辑的连接；`null` 表示新建（限额区不渲染）。 */
    connection: ProviderConnection | null;
    /** 无编辑权限时只读展示（fail-closed：调用方按 CP 能力投影判定后传入）。 */
    readonly?: boolean;
}>();

const emit = defineEmits<{
    "update:limits": [
        value: {
            maxInflight: number | null;
            maxQueue: number | null;
            windowTokenBudget: number | null;
            windowSeconds: number | null;
            modelLimits: ConnectionModelLimit[];
        },
    ];
}>();

const { t } = useI18n();

interface LimitsForm {
    maxInflight: string;
    maxQueue: string;
    windowTokenBudget: string;
    windowSeconds: string;
}

function toInput(value: number | null | undefined): string {
    return typeof value === "number" ? String(value) : "";
}

const form = ref<LimitsForm>({
    maxInflight: "",
    maxQueue: "",
    windowTokenBudget: "",
    windowSeconds: "",
});
const modelLimits = ref<ConnectionModelLimit[]>([]);

// 组件自持表单状态，每次 `connection` 变化（打开另一条连接）时从连接重置；
// 变更通过 `update:limits` 上抛给父组件的 PATCH（父组件不持有第二份真相）。
watch(
    () => props.connection,
    (connection) => {
        form.value = {
            maxInflight: toInput(connection?.maxInflight),
            maxQueue: toInput(connection?.maxQueue),
            windowTokenBudget: toInput(connection?.windowTokenBudget),
            windowSeconds: toInput(connection?.windowSeconds),
        };
        modelLimits.value = (connection?.modelLimits ?? []).map((entry) => ({ ...entry }));
        emitLimits();
    },
    { immediate: true },
);

/** 每一项要么空，要么是正整数；`0` 与负数、小数都非法（限额为 0 等于禁用，应留空不设限）。 */
const fieldErrors = computed(() => {
    const errors: Record<keyof LimitsForm, string> = {
        maxInflight: "",
        maxQueue: "",
        windowTokenBudget: "",
        windowSeconds: "",
    };
    for (const key of Object.keys(errors) as Array<keyof LimitsForm>) {
        const raw = form.value[key].trim();
        if (raw === "") continue;
        if (!/^[1-9]\d*$/.test(raw)) errors[key] = t("settings.providerHub.limitsPositiveInteger");
    }
    return errors;
});

const hasError = computed(
    () =>
        Object.values(fieldErrors.value).some(Boolean) ||
        modelLimits.value.some(
            (entry) =>
                !entry.provider.trim() ||
                !entry.model.trim() ||
                [entry.maxInflight, entry.windowTokenBudget, entry.windowSeconds].some(
                    (value) =>
                        value !== null &&
                        value !== undefined &&
                        (!Number.isInteger(value) || value <= 0),
                ),
        ),
);

function parse(raw: string): number | null {
    const text = raw.trim();
    return text === "" ? null : Number(text);
}

function emitLimits() {
    emit("update:limits", {
        maxInflight: parse(form.value.maxInflight),
        maxQueue: parse(form.value.maxQueue),
        windowTokenBudget: parse(form.value.windowTokenBudget),
        windowSeconds: parse(form.value.windowSeconds),
        modelLimits: modelLimits.value.map((entry) => ({ ...entry })),
    });
}

watch([form, modelLimits], emitLimits, { deep: true });

function addModelLimit() {
    modelLimits.value = [
        ...modelLimits.value,
        {
            provider: "",
            model: "",
            maxInflight: null,
            windowTokenBudget: null,
            windowSeconds: null,
        },
    ];
}

function removeModelLimit(index: number) {
    modelLimits.value = modelLimits.value.filter((_, current) => current !== index);
}

function setModelLimit(index: number, patch: Partial<ConnectionModelLimit>) {
    modelLimits.value = modelLimits.value.map((entry, current) =>
        current === index ? { ...entry, ...patch } : entry,
    );
}

/** 数值型模型限额：空串 → null。 */
function setModelLimitNumber(
    index: number,
    key: "maxInflight" | "windowTokenBudget" | "windowSeconds",
    raw: string,
) {
    const text = raw.trim();
    setModelLimit(index, {
        [key]: text === "" ? null : Number(text),
    } as Partial<ConnectionModelLimit>);
}

const fields: Array<{ key: keyof LimitsForm; label: string; testId: string }> = [
    { key: "maxInflight", label: "settings.providerHub.limitsMaxInflight", testId: "max-inflight" },
    { key: "maxQueue", label: "settings.providerHub.limitsMaxQueue", testId: "max-queue" },
    {
        key: "windowTokenBudget",
        label: "settings.providerHub.limitsWindowTokens",
        testId: "window-token-budget",
    },
    {
        key: "windowSeconds",
        label: "settings.providerHub.limitsWindowSeconds",
        testId: "window-seconds",
    },
];

defineExpose({ hasError, fieldErrors });
</script>

<template>
    <section
        v-if="connection"
        class="space-y-2 rounded-md border p-3"
        data-testid="connection-resource-limits"
    >
        <div>
            <h4 class="text-sm font-medium">{{ t("settings.providerHub.limitsTitle") }}</h4>
            <p class="mt-1 text-xs text-muted-foreground">
                {{ t("settings.providerHub.limitsHint") }}
            </p>
        </div>
        <div class="grid grid-cols-2 gap-2">
            <label v-for="field in fields" :key="field.key" class="block space-y-1 text-xs">
                <span>{{ t(field.label) }}</span>
                <input
                    v-model="form[field.key]"
                    type="text"
                    inputmode="numeric"
                    :readonly="readonly"
                    :data-testid="`connection-limit-${field.testId}`"
                    :aria-invalid="Boolean(fieldErrors[field.key])"
                    class="w-full rounded-md border bg-background px-2 py-1 text-xs disabled:opacity-60"
                />
                <span
                    v-if="fieldErrors[field.key]"
                    :data-testid="`connection-limit-${field.testId}-error`"
                    class="block text-destructive"
                >
                    {{ fieldErrors[field.key] }}
                </span>
            </label>
        </div>
        <div class="space-y-2">
            <div class="flex items-center justify-between">
                <span class="text-xs">{{ t("settings.providerHub.limitsModelLimits") }}</span>
                <button
                    type="button"
                    data-testid="connection-limit-model-add"
                    class="text-xs underline disabled:opacity-50"
                    :disabled="readonly"
                    @click="addModelLimit"
                >
                    {{ t("settings.providerHub.limitsAddModel") }}
                </button>
            </div>
            <div
                v-for="(entry, index) in modelLimits"
                :key="`model-limit-${index}`"
                class="grid grid-cols-[1fr_1fr_1fr_1fr_auto] items-center gap-1"
            >
                <input
                    :value="entry.provider"
                    :readonly="readonly"
                    :data-testid="`connection-limit-model-provider-${index}`"
                    :placeholder="t('settings.providerHub.limitsProvider')"
                    class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                    @input="
                        setModelLimit(index, {
                            provider: ($event.target as HTMLInputElement).value,
                        })
                    "
                />
                <input
                    :value="entry.model"
                    :readonly="readonly"
                    :data-testid="`connection-limit-model-name-${index}`"
                    :placeholder="t('settings.providerHub.limitsModel')"
                    class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                    @input="
                        setModelLimit(index, { model: ($event.target as HTMLInputElement).value })
                    "
                />
                <input
                    :value="entry.maxInflight ?? ''"
                    :readonly="readonly"
                    inputmode="numeric"
                    :data-testid="`connection-limit-model-inflight-${index}`"
                    :placeholder="t('settings.providerHub.limitsInflightShort')"
                    class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                    @input="
                        setModelLimitNumber(
                            index,
                            'maxInflight',
                            ($event.target as HTMLInputElement).value,
                        )
                    "
                />
                <input
                    :value="entry.windowTokenBudget ?? ''"
                    :readonly="readonly"
                    inputmode="numeric"
                    :data-testid="`connection-limit-model-tokens-${index}`"
                    :placeholder="t('settings.providerHub.limitsTokensShort')"
                    class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                    @input="
                        setModelLimitNumber(
                            index,
                            'windowTokenBudget',
                            ($event.target as HTMLInputElement).value,
                        )
                    "
                />
                <button
                    type="button"
                    :data-testid="`connection-limit-model-remove-${index}`"
                    :disabled="readonly"
                    :aria-label="t('settings.providerHub.limitsRemoveModel')"
                    class="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                    @click="removeModelLimit(index)"
                >
                    ×
                </button>
            </div>
            <p
                v-if="!readonly && !connection.maxInflight && !connection.maxQueue"
                class="text-xs text-muted-foreground"
            >
                {{ t("settings.providerHub.limitsUnset") }}
            </p>
        </div>
    </section>
</template>
