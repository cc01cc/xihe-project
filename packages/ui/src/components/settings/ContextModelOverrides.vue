<script setup lang="ts">
/**
 * task-285：「按模型覆盖」子表（`context-policy.models`）。
 *
 * <p>为什么不再是 JSON 文本框：用户原话「模型窗口表又是什么」——`models` 是**按模型的覆盖表**
 * （`LlmSummaryProvider.java:282` 的 `models.path(baseModel)`，每行 `pick(modelCfg, defaults, key)`
 * 覆盖同名默认值），不是「窗口尺寸表」。标签与形态一起改：标签说清是什么，形态说清能填哪些键。
 *
 * <p>每行只暴露该行真实可用的键 —— 键清单来自生成物 `mapValueFields`（CP schema 的
 * `models.additionalProperties.properties`），**不手抄第二份**；未登记的键原样保留并在行内点名，
 * 因为「UI 不认识就丢掉」是静默丢数据。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import {
    composeModels,
    decomposeModels,
    modelOverrideFields,
    unknownKeysOf,
    type ModelRowDraft,
} from "./contextPolicyForm";

const { t } = useI18n();

const props = defineProps<{
    /** 当前 `models` 键的原文（CP 存的就是 JSON 文本）。 */
    modelsRaw: string;
    readonly?: boolean;
    saving?: boolean;
}>();

const emit = defineEmits<{ save: [payload: Record<string, string>] }>();

const fields = modelOverrideFields();
const rows = ref<ModelRowDraft[]>([]);

function reload(): void {
    rows.value = decomposeModels(props.modelsRaw);
}
// 每次 `entries` 变化（保存后 reload / 切层）都重算草稿；与 ConfigDomainPanel 的展开重取同源。
watch(() => props.modelsRaw, reload, { immediate: true });

const locked = computed(() => props.readonly === true);

/** 名字重复或为空时不发请求 —— 否则后一行会静默盖掉前一行。 */
const nameProblem = computed<boolean>(() => {
    const names = rows.value.map((row) => row.name.trim());
    return names.some((name) => name === "") || new Set(names).size !== names.length;
});

function addRow(): void {
    rows.value.push({ name: "", values: {} });
}

function removeRow(index: number): void {
    rows.value.splice(index, 1);
}

function unknownFor(name: string): string[] {
    return name.trim() === "" ? [] : unknownKeysOf(props.modelsRaw, name.trim());
}

function submit(): void {
    if (nameProblem.value) return;
    const text = composeModels(props.modelsRaw, rows.value);
    // `null` = 与原文深度相等 ⇒ **一个字节都不动**（卡面判据 ② 的机器形式：不改就不写）。
    if (text === null) return;
    emit("save", { models: text });
}
</script>

<template>
    <div class="border rounded-lg mb-2 overflow-hidden" data-testid="ctx-models-overrides">
        <div class="px-4 py-3 bg-muted/30 space-y-1">
            <div class="text-xs font-medium tracking-wide text-muted-foreground">
                {{ t("settings.fieldCompactionModels") }}
            </div>
            <p class="text-xs text-muted-foreground">{{ t("settings.ctxModelsHint") }}</p>
        </div>

        <div class="px-4 py-3 space-y-3">
            <p v-if="rows.length === 0" class="text-sm text-muted-foreground">
                {{ t("settings.ctxModelsEmpty") }}
            </p>

            <div
                v-for="(row, index) in rows"
                :key="index"
                class="border rounded-md p-3 space-y-2"
                data-testid="ctx-model-row"
            >
                <div class="flex items-center gap-2">
                    <label
                        class="text-xs text-muted-foreground shrink-0"
                        :for="`ctx-model-name-${index}`"
                    >
                        {{ t("settings.ctxModelName") }}
                    </label>
                    <!-- task-310：形态回落 vendor `Input` 默认，只保留描边覆盖（见 ConfigDomainPanel 同款注释） -->
                    <Input
                        :id="`ctx-model-name-${index}`"
                        v-model="row.name"
                        :data-testid="`ctx-model-name-${index}`"
                        :disabled="locked"
                        :placeholder="t('settings.ctxModelNamePlaceholder')"
                        class="min-w-0 flex-1"
                    />
                    <button
                        v-if="!locked"
                        type="button"
                        :data-testid="`ctx-model-remove-${index}`"
                        class="px-2 py-1 text-xs border rounded hover:bg-muted"
                        @click="removeRow(index)"
                    >
                        {{ t("settings.ctxModelRemove") }}
                    </button>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div v-for="field in fields" :key="field.key" class="flex items-center gap-2">
                        <label
                            class="text-xs text-muted-foreground w-40 shrink-0"
                            :for="`ctx-model-${index}-${field.key}`"
                        >
                            {{ t(`settings.ctx.${field.key}`) }}
                        </label>
                        <Select
                            v-if="field.type === 'enum'"
                            :model-value="row.values[field.key] || ''"
                            :disabled="locked"
                            @update:model-value="
                                (value) =>
                                    (row.values[field.key] =
                                        value === '__unset__' ? '' : String(value ?? ''))
                            "
                        >
                            <SelectTrigger
                                :id="`ctx-model-${index}-${field.key}`"
                                :data-testid="`ctx-model-${index}-${field.key}`"
                                class="min-w-0 flex-1"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__unset__">{{
                                    t("settings.notSet")
                                }}</SelectItem>
                                <SelectItem
                                    v-for="option in field.enumValues ?? []"
                                    :key="option.value"
                                    :value="option.value"
                                >
                                    {{
                                        option.value === "llm"
                                            ? t("settings.ctxSummaryProviderLlm")
                                            : t("settings.ctxSummaryProviderRule")
                                    }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <Input
                            v-else
                            :id="`ctx-model-${index}-${field.key}`"
                            v-model="row.values[field.key]"
                            :data-testid="`ctx-model-${index}-${field.key}`"
                            :disabled="locked"
                            :type="
                                field.type === 'integer' || field.type === 'number'
                                    ? 'number'
                                    : 'text'
                            "
                            class="min-w-0 flex-1"
                        />
                    </div>
                </div>

                <p
                    v-if="unknownFor(row.name).length > 0"
                    class="text-xs text-muted-foreground"
                    :data-testid="`ctx-model-unknown-${index}`"
                >
                    {{
                        t("settings.ctxModelsUnknownKept", {
                            keys: unknownFor(row.name).join(", "),
                        })
                    }}
                </p>
            </div>

            <p
                v-if="nameProblem"
                class="text-xs text-destructive"
                data-testid="ctx-models-name-error"
            >
                {{ t("settings.ctxModelsDuplicateName") }}
            </p>

            <div class="flex flex-wrap gap-2">
                <button
                    v-if="!locked"
                    type="button"
                    data-testid="ctx-models-add"
                    class="px-3 py-1 text-xs border rounded hover:bg-muted"
                    @click="addRow"
                >
                    {{ t("settings.ctxModelAdd") }}
                </button>
                <button
                    v-if="!locked"
                    type="button"
                    data-testid="ctx-models-save"
                    :disabled="saving || nameProblem"
                    class="px-3 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50"
                    @click="submit"
                >
                    {{ t("settings.ctxModelsSave") }}
                </button>
            </div>
        </div>
    </div>
</template>
