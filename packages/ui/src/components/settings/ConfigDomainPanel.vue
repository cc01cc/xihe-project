<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ConfigKeyMeta } from "../../stores/config";

const { t } = useI18n();

export interface DomainField {
    key: string;
    label: string;
    type: "text" | "password" | "select" | "number" | "json" | "textarea";
    options?: { label: string; value: string }[];
    /** Upper bound for `number` fields (e.g. systemToolTimeoutS ≤ 30, PLAN-0308 T3.1). */
    max?: number;
    /** Written by the instance layer only (e.g. agent-runtime.instructions, decision #17). */
    instanceOnly?: boolean;
    /**
     * PLAN-0503: candidates computed at render time from a sibling field's
     * editing value (e.g. defaultModel options filtered by defaultProvider).
     */
    optionsFor?: (dependencyValue: string) => { label: string; value: string }[];
    /** PLAN-0503: sibling field whose editing value feeds `optionsFor`. */
    optionsDependsOn?: string;
    /**
     * PLAN-0503: select keeps out-of-candidate values (drift) and offers a
     * free-text escape, so a directory outage never blocks manual input.
     */
    allowCustom?: boolean;
}

const props = defineProps<{
    domain: string;
    title: string;
    entries: Record<string, string>;
    readonly?: boolean;
    admin?: boolean;
    summary?: string;
    schema: DomainField[];
    /** domain key -> env-effective value when an env overlay wins (decision #22). */
    envLocked?: Record<string, string>;
    /** PLAN-0503: optional directory-freshness line (revision / verifiedAt). */
    note?: string;
    /** PLAN-0554: per-key provenance for this layer/domain. */
    meta?: Record<string, ConfigKeyMeta>;
    /** PLAN-0554: current layer, used for inheritance wording. */
    layer?: "instance" | "user" | "workspace";
}>();

const emit = defineEmits<{
    save: [body: Record<string, string>];
    reset: [key: string];
}>();

const expanded = ref(false),
    editing = ref<Record<string, string>>({});

function toggle() {
    expanded.value = !expanded.value;
    if (expanded.value) {
        const init: Record<string, string> = {};
        for (const field of props.schema) {
            init[field.key] = props.entries[field.key] ?? "";
        }
        editing.value = init;
    }
}

function isLocked(key: string): boolean {
    return (!!props.envLocked && key in props.envLocked) || !!props.meta?.[key]?.locked;
}

/** PLAN-0554: server-judged writability; absent meta keeps the legacy behaviour. */
function isWritable(key: string): boolean {
    const item = props.meta?.[key];
    return !item || item.writable;
}

function sourceText(key: string): string {
    switch (props.meta?.[key]?.source) {
        case "env":
            return t("settings.configSourceEnv");
        case "workspace":
            return t("settings.configSourceWorkspace");
        case "user":
            return t("settings.configSourceUser");
        case "instance":
            return t("settings.configSourceInstance");
        case "code":
            return t("settings.configSourceCode");
        case "none":
            return t("settings.configSourceNone");
        default:
            return "";
    }
}

function sourceHint(key: string): string {
    const item = props.meta?.[key];
    if (!item) return "";
    if (item.locked) return t("settings.configSourceEnv");
    if (props.layer === "instance") {
        return item.overridable
            ? t("settings.configSourceOverridable")
            : t("settings.configSourceInstanceOnly");
    }
    if (item.source === "none") return t("settings.configSourceNone");
    if (props.layer && item.source !== props.layer) {
        return t("settings.configSourceInherited", { source: sourceText(key) });
    }
    if (!item.writable) return t("settings.configSourceReadonly");
    return "";
}

function lockedValue(key: string): string {
    const value = props.envLocked?.[key] ?? "";
    if (value && isPasswordKey(key)) {
        return value.length > 8 ? `${value.substring(0, 3)}****${value.slice(-4)}` : "****";
    }
    return value;
}

function isPasswordKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return (
        normalized.includes("apikey") ||
        normalized.includes("secret") ||
        normalized.includes("password")
    );
}

/** Sentinel option value that flips a select into free-text mode (PLAN-0503). */
const CUSTOM_OPTION = "__custom__";

const customMode = ref<Record<string, boolean>>({});

function fieldCandidates(field: DomainField): { label: string; value: string }[] {
    if (field.optionsFor) {
        const dependency = field.optionsDependsOn
            ? (editing.value[field.optionsDependsOn] ?? "")
            : "";
        return field.optionsFor(dependency);
    }
    return field.options ?? [];
}

/**
 * PLAN-0503 I3 / design「目录更新处置矩阵」: any select whose stored value is
 * outside the current candidate set must be annotated (catalog removal must not
 * leave a blank, unlabelled field). The free-text escape stays allowCustom-only.
 */
function isDrifted(field: DomainField): boolean {
    if (field.type !== "select") return false;
    const value = editing.value[field.key] ?? "";
    if (!value || customMode.value[field.key]) return false;
    return !fieldCandidates(field).some((option) => option.value === value);
}

function onSelectChange(field: DomainField, value: string) {
    if (field.allowCustom && value === CUSTOM_OPTION) {
        customMode.value = { ...customMode.value, [field.key]: true };
        return;
    }
    editing.value[field.key] = value;
}

function exitCustomMode(field: DomainField) {
    customMode.value = { ...customMode.value, [field.key]: false };
}

const validationError = ref("");

function handleSave() {
    // T3.1 评审修复：`max` 必须参与保存校验（native max 不影响程序化提交）。
    const invalid = props.schema.filter((field) => {
        if (field.type !== "number" || field.max === undefined) return false;
        const raw = editing.value[field.key];
        if (raw === undefined || raw === "" || isLocked(field.key) || !isWritable(field.key))
            return false;
        const num = Number(raw);
        return !Number.isInteger(num) || num < 1 || num > field.max;
    });
    if (invalid.length > 0) {
        validationError.value = invalid.map((field) => `${field.label} ≤ ${field.max}`).join("，");
        return;
    }
    validationError.value = "";
    const body = Object.fromEntries(
        Object.entries(editing.value).filter(
            ([key, value]) => value !== "" && !isLocked(key) && isWritable(key),
        ),
    );
    emit("save", body);
}

function handleReset(key: string) {
    emit("reset", key);
}
</script>

<template>
    <div :data-testid="`config-domain-${domain}`" class="border rounded-lg mb-2 overflow-hidden">
        <button
            class="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
            @click="toggle"
        >
            <span class="truncate">{{ title }}</span>
            <span class="flex min-w-0 items-center gap-2 shrink-0">
                <span
                    v-if="!expanded && summary"
                    class="text-xs text-muted-foreground truncate max-w-[200px]"
                    >{{ summary }}</span
                >
                <span class="text-muted-foreground">{{ expanded ? "▾" : "▸" }}</span>
            </span>
        </button>
        <div v-if="expanded" class="px-4 pb-3 space-y-2">
            <p
                v-if="note"
                :data-testid="`config-domain-note-${domain}`"
                class="text-[11px] text-muted-foreground"
            >
                {{ note }}
            </p>
            <div
                v-for="field in schema"
                :key="field.key"
                :data-testid="`config-field-${domain}-${field.key}`"
                class="flex min-w-0 items-center gap-2"
            >
                <div class="min-w-0 w-1/3">
                    <span class="block text-xs text-muted-foreground truncate">{{
                        field.label
                    }}</span>
                    <span
                        v-if="meta?.[field.key]"
                        :data-testid="`config-source-${domain}-${field.key}`"
                        class="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground"
                    >
                        <span class="shrink-0 rounded border border-border px-1 py-0.5">
                            {{ sourceText(field.key) }}
                        </span>
                        <span v-if="sourceHint(field.key)" class="min-w-0 truncate">
                            {{ sourceHint(field.key) }}
                        </span>
                    </span>
                </div>

                <template v-if="isLocked(field.key)">
                    <span
                        :data-testid="`config-env-lock-${domain}-${field.key}`"
                        class="min-w-0 flex-1 truncate px-2 py-1 text-sm border rounded bg-muted text-muted-foreground"
                        :title="t('settings.envLockedHint')"
                    >
                        {{ lockedValue(field.key) || t("settings.empty") }}
                    </span>
                    <span
                        class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-500/60 text-amber-600"
                        :title="t('settings.envLockedHint')"
                        >env</span
                    >
                </template>

                <template v-else-if="!readonly && field.type === 'select'">
                    <input
                        v-if="field.allowCustom && customMode[field.key]"
                        v-model="editing[field.key]"
                        :data-testid="`config-custom-${domain}-${field.key}`"
                        :disabled="!isWritable(field.key)"
                        class="min-w-0 flex-1 px-2 py-1 text-sm border rounded bg-background"
                        :placeholder="t('settings.customPlaceholder')"
                    />
                    <select
                        v-else
                        :value="editing[field.key]"
                        :data-testid="`config-select-${domain}-${field.key}`"
                        :disabled="!isWritable(field.key)"
                        class="min-w-0 flex-1 px-2 py-1 text-sm border rounded bg-background"
                        @change="onSelectChange(field, ($event.target as HTMLSelectElement).value)"
                    >
                        <option v-if="field.allowCustom" value="">
                            {{ t("settings.notSet") }}
                        </option>
                        <option v-if="isDrifted(field)" :value="editing[field.key]">
                            {{ t("settings.driftedOption", { value: editing[field.key] }) }}
                        </option>
                        <option
                            v-for="opt in fieldCandidates(field)"
                            :key="opt.value"
                            :value="opt.value"
                        >
                            {{ opt.label }}
                        </option>
                        <option v-if="field.allowCustom" :value="CUSTOM_OPTION">
                            {{ t("settings.customOption") }}
                        </option>
                    </select>
                </template>

                <textarea
                    v-else-if="!readonly && (field.type === 'json' || field.type === 'textarea')"
                    v-model="editing[field.key]"
                    rows="3"
                    :disabled="!isWritable(field.key)"
                    class="min-w-0 flex-1 px-2 py-1 text-sm border rounded bg-background"
                    :class="field.type === 'json' ? 'font-mono' : ''"
                    :placeholder="field.type === 'json' ? 'JSON' : ''"
                />

                <input
                    v-else-if="!readonly"
                    v-model="editing[field.key]"
                    :disabled="!isWritable(field.key)"
                    class="min-w-0 flex-1 px-2 py-1 text-sm border rounded bg-background"
                    :type="
                        field.type === 'password'
                            ? 'password'
                            : field.type === 'number'
                              ? 'number'
                              : 'text'
                    "
                    :max="field.type === 'number' ? field.max : undefined"
                    :title="field.type === 'number' && field.max ? `≤ ${field.max}` : undefined"
                />

                <span v-else class="min-w-0 flex-1 text-sm truncate">
                    {{
                        field.type === "password"
                            ? editing[field.key]
                                ? editing[field.key].substring(0, 3) +
                                  "****" +
                                  editing[field.key].slice(-4)
                                : t("settings.notSet")
                            : editing[field.key] || t("settings.empty")
                    }}
                </span>

                <span
                    v-if="isDrifted(field)"
                    :data-testid="`config-drift-${domain}-${field.key}`"
                    class="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-500/60 text-amber-600"
                    :title="t('settings.driftedHint')"
                    >{{ t("settings.driftedBadge") }}</span
                >
                <button
                    v-if="isDrifted(field) && !readonly && !isLocked(field.key)"
                    class="shrink-0 text-xs text-muted-foreground hover:text-foreground px-1"
                    :data-testid="`config-drift-clear-${domain}-${field.key}`"
                    :title="t('settings.driftedClear')"
                    @click="handleReset(field.key)"
                >
                    {{ t("settings.driftedClear") }}
                </button>
                <button
                    v-if="field.allowCustom && customMode[field.key] && !readonly"
                    class="shrink-0 text-xs text-muted-foreground hover:text-foreground px-1"
                    :data-testid="`config-custom-exit-${domain}-${field.key}`"
                    @click="exitCustomMode(field)"
                >
                    {{ t("settings.customBack") }}
                </button>

                <button
                    v-if="admin && !readonly && !isLocked(field.key) && isWritable(field.key)"
                    class="text-xs text-muted-foreground hover:text-foreground px-1"
                    :title="t('settings.resetToDefault')"
                    @click="handleReset(field.key)"
                >
                    ↺
                </button>
            </div>
            <p v-if="validationError" class="text-xs text-destructive px-1 pb-1" role="alert">
                {{ validationError }}
            </p>
            <div v-if="!readonly" class="flex justify-end pt-1">
                <button
                    class="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50"
                    :disabled="
                        !schema.some((field) => isWritable(field.key) && !isLocked(field.key))
                    "
                    @click="handleSave"
                >
                    {{ t("common.save") }}
                </button>
            </div>
        </div>
    </div>
</template>
