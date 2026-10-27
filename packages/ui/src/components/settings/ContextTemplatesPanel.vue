<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import type { ConfigLayer } from "../../stores/config";
import { listApiInputTypes } from "../../services/providerConnectionService";
import {
    parseTemplates,
    readTemplateConfig,
    validateTemplate,
    type ApiRequestTemplate,
    type TemplateDiagnostic,
} from "../../services/apiRequestTemplates";
import type { ApiInputType } from "../../types/providerConnection";
import { logger } from "../../lib/logger";

const props = defineProps<{
    entries: Record<string, string>;
    saving: boolean;
    layer: ConfigLayer;
    workspaceId?: string;
    readonly?: boolean;
}>();
const emit = defineEmits<{ save: [entries: Record<string, string>] }>();
const { t } = useI18n();
const templates = ref<ApiRequestTemplate[]>([]);
const types = ref<ApiInputType[]>([]);
const builtins = ref<ApiRequestTemplate[]>([]);
const selected = ref<ApiRequestTemplate | null>(null);
const selectedType = ref("");
const diagnostics = ref<TemplateDiagnostic[]>([]);
const validating = ref(false);
const error = ref("");
let generation = 0;
onBeforeUnmount(() => {
    generation++;
});
const sourceInput = ref<HTMLTextAreaElement | null>(null);
const palette = [
    "user_input",
    "agent_instructions",
    "model",
    "conversation_history",
    "tools",
    "rag_context",
];
const latest = computed(() => {
    const result = new Map<string, ApiRequestTemplate>();
    for (const item of templates.value)
        if (!result.has(item.id) || result.get(item.id)!.version < item.version)
            result.set(item.id, item);
    return [...result.values()];
});
const revisions = computed(() =>
    templates.value
        .filter((item) => item.id === selected.value?.id)
        .sort((a, b) => b.version - a.version),
);
watch(
    () => [props.layer, props.workspaceId, props.entries.templates] as const,
    ([layer, workspaceId, raw], previous) => {
        if (!previous || layer !== previous[0] || workspaceId !== previous[1]) {
            generation++;
            selected.value = null;
            diagnostics.value = [];
            error.value = "";
            validating.value = false;
        }
        templates.value = parseTemplates(raw);
        if (!selected.value) selected.value = templates.value[0] ? { ...templates.value[0] } : null;
    },
    { immediate: true },
);
onMounted(async () => {
    const currentGeneration = generation;
    try {
        const [catalog, entries] = await Promise.all([
            listApiInputTypes(),
            readTemplateConfig("instance"),
        ]);
        if (currentGeneration !== generation) return;
        types.value = catalog.types.filter((item) => item.operation === "chat");
        builtins.value = parseTemplates(entries.templates).filter(
            (item) => item.status === "published",
        );
        selectedType.value = types.value[0] ? typeKey(types.value[0]) : "";
    } catch (cause) {
        if (currentGeneration !== generation) return;
        logger.warn("API request editor metadata load failed", cause);
        error.value = t("settings.apiRequest.loadFailed");
    }
});
function typeKey(item: ApiInputType) {
    return item.apiTypeId + "@" + item.version;
}
function select(item: ApiRequestTemplate) {
    selected.value = { ...item };
    diagnostics.value = [];
    error.value = "";
}
function create() {
    const type = types.value.find((item) => typeKey(item) === selectedType.value);
    const builtin = builtins.value.find(
        (item) => item.apiTypeId === type?.apiTypeId && item.apiTypeVersion === type.version,
    );
    if (!type || !builtin) {
        error.value = t("settings.apiRequest.defaultUnavailable");
        return;
    }
    selected.value = {
        id: crypto.randomUUID(),
        version: 1,
        name: t("settings.apiRequest.untitled"),
        description: "",
        apiTypeId: type.apiTypeId,
        apiTypeVersion: type.version,
        bodySource: builtin.bodySource,
        status: "draft",
    };
    diagnostics.value = [];
}
function insertVariable(name: string) {
    if (!selected.value) return;
    const input = sourceInput.value;
    const start = input?.selectionStart ?? selected.value.bodySource.length;
    const end = input?.selectionEnd ?? start;
    const token = "${xh." + name + "}";
    selected.value.bodySource =
        selected.value.bodySource.slice(0, start) + token + selected.value.bodySource.slice(end);
    input?.focus();
}
function nextRevision(status: ApiRequestTemplate["status"]): ApiRequestTemplate | null {
    if (!selected.value) return null;
    const persisted = templates.value.find(
        (item) => item.id === selected.value!.id && item.version === selected.value!.version,
    );
    const max = Math.max(
        0,
        ...templates.value
            .filter((item) => item.id === selected.value!.id)
            .map((item) => item.version),
    );
    return {
        ...selected.value,
        status,
        version: persisted?.status === "published" ? max + 1 : selected.value.version,
    };
}
async function save(publish: boolean) {
    const currentGeneration = generation;
    const next = nextRevision(publish ? "published" : "draft");
    if (!next || props.saving || validating.value) return;
    error.value = "";
    if (!next.name.trim()) {
        error.value = t("settings.apiRequest.nameRequired");
        return;
    }
    if (publish) {
        validating.value = true;
        const identity = selected.value;
        try {
            const result = await validateTemplate(next);
            if (currentGeneration !== generation || selected.value !== identity) return;
            diagnostics.value = result.diagnostics;
            if (!result.valid) return;
        } catch (cause) {
            if (currentGeneration !== generation) return;
            logger.warn("API request validation failed", cause);
            error.value = t("settings.apiRequest.validationFailed");
            return;
        } finally {
            if (currentGeneration === generation) validating.value = false;
        }
    }
    if (currentGeneration !== generation) return;
    const updated = templates.value.filter(
        (item) => item.id !== next.id || item.version !== next.version,
    );
    updated.push(next);
    emit("save", { ...props.entries, templates: JSON.stringify(updated) });
    selected.value = next;
    toast.info(t("settings.apiRequest.saveRequested"));
}
</script>

<template>
    <section
        class="mb-2 overflow-hidden rounded-lg border"
        data-testid="api-request-templates-panel"
    >
        <header class="flex flex-wrap items-center gap-2 border-b p-3">
            <h3 class="mr-auto text-sm font-semibold">
                {{ t("settings.domainContextTemplates") }}
            </h3>
            <select
                v-model="selectedType"
                data-testid="api-request-type"
                aria-label="API Type"
                class="rounded-md border bg-background px-2 py-1 text-xs"
            >
                <option v-for="type in types" :key="typeKey(type)" :value="typeKey(type)">
                    {{ typeKey(type) }}
                </option>
            </select>
            <button
                v-if="!readonly"
                type="button"
                data-testid="api-request-new"
                class="rounded-md border px-3 py-1 text-xs"
                :disabled="saving || types.length === 0"
                @click="create"
            >
                {{ t("settings.apiRequest.new") }}
            </button>
        </header>
        <div class="grid min-h-80 md:grid-cols-[14rem_1fr]">
            <nav
                class="border-b p-2 md:border-b-0 md:border-r"
                :aria-label="t('settings.apiRequest.templates')"
            >
                <button
                    v-for="item in latest"
                    :key="item.id"
                    type="button"
                    class="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                    :class="{ 'bg-muted': selected?.id === item.id }"
                    @click="select(item)"
                >
                    {{ item.name }}
                    <span class="text-xs text-muted-foreground"
                        >v{{ item.version }} · {{ item.status }}</span
                    >
                </button>
                <p v-if="latest.length === 0" class="p-3 text-xs text-muted-foreground">
                    {{ t("settings.apiRequest.empty") }}
                </p>
            </nav>
            <div v-if="selected" class="min-w-0 space-y-3 p-4">
                <div class="flex flex-wrap items-center gap-2 text-xs">
                    <span>{{ selected.apiTypeId }}@{{ selected.apiTypeVersion }}</span>
                    <select
                        :value="selected.version"
                        :aria-label="t('settings.apiRequest.revisions')"
                        class="rounded border bg-background px-2 py-1"
                        @change="
                            select(
                                revisions.find(
                                    (item) =>
                                        item.version ===
                                        Number(($event.target as HTMLSelectElement).value),
                                ) ?? selected,
                            )
                        "
                    >
                        <option v-for="item in revisions" :key="item.version" :value="item.version">
                            v{{ item.version }} · {{ item.status }}
                        </option>
                        <option
                            v-if="!revisions.some((item) => item.version === selected?.version)"
                            :value="selected.version"
                        >
                            v{{ selected.version }} · draft
                        </option>
                    </select>
                </div>
                <label class="block text-xs"
                    >{{ t("settings.apiRequest.name")
                    }}<input
                        v-model="selected.name"
                        data-testid="api-request-name"
                        class="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
                        :disabled="readonly"
                /></label>
                <label class="block text-xs"
                    >{{ t("settings.apiRequest.description")
                    }}<input
                        v-model="selected.description"
                        class="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
                        :disabled="readonly"
                /></label>
                <div
                    v-if="!readonly"
                    class="flex flex-wrap gap-1"
                    :aria-label="t('settings.apiRequest.variables')"
                >
                    <button
                        v-for="name in palette"
                        :key="name"
                        type="button"
                        class="rounded border px-2 py-1 font-mono text-xs"
                        @click="insertVariable(name)"
                    >
                        {{ name }}
                    </button>
                </div>
                <label class="block text-xs"
                    >{{ t("settings.apiRequest.source")
                    }}<textarea
                        ref="sourceInput"
                        v-model="selected.bodySource"
                        data-testid="api-request-body-source"
                        spellcheck="false"
                        class="mt-1 min-h-80 w-full rounded-md border bg-background p-3 font-mono text-xs leading-6 disabled:opacity-60"
                        :disabled="readonly"
                    />
                </label>
                <ul
                    v-if="diagnostics.length"
                    role="alert"
                    class="space-y-1 text-xs text-destructive"
                >
                    <li v-for="(item, index) in diagnostics" :key="index">
                        {{ item.code }} · {{ item.path }} · {{ item.message }}
                    </li>
                </ul>
                <p class="text-xs text-muted-foreground">{{ t("settings.apiRequest.rawHelp") }}</p>
                <div v-if="!readonly" class="flex gap-2">
                    <button
                        type="button"
                        data-testid="api-request-save-draft"
                        class="rounded-md border px-3 py-2 text-xs"
                        :disabled="saving || validating"
                        @click="save(false)"
                    >
                        {{ t("settings.apiRequest.saveDraft") }}
                    </button>
                    <button
                        type="button"
                        data-testid="api-request-publish"
                        class="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground"
                        :disabled="saving || validating"
                        @click="save(true)"
                    >
                        {{ t("settings.apiRequest.publish") }}
                    </button>
                </div>
            </div>
            <p v-else class="p-4 text-sm text-muted-foreground">
                {{ t("settings.apiRequest.chooseType") }}
            </p>
        </div>
        <p v-if="error" role="alert" class="p-3 text-xs text-destructive">{{ error }}</p>
    </section>
</template>
