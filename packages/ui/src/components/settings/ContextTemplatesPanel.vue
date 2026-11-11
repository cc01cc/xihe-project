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
import { formatApiType } from "../../lib/apiTypeLabels";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const props = defineProps<{
    entries: Record<string, string>;
    saving: boolean;
    layer: ConfigLayer;
    readonly?: boolean;
    /**
     * 保存写入口，由父组件注入：必须 await 到真实 PUT 200 才 resolve，失败要抛。
     * 未注入时退回 emit("save")（仅单元测试/旧调用方兼容，此时无法感知真实结果）。
     */
    submit?: (entries: Record<string, string>) => Promise<void>;
}>();
const emit = defineEmits<{ save: [entries: Record<string, string>] }>();
const { t } = useI18n();
/**
 * api-request-templates 只有 instance/user 两层显式读（契约 readTemplateConfig 的 type），
 * 而它的面板只在这两层出现；这里把共享的 ConfigLayer 收窄成面板真正会用的两个值。
 */
const templateLayer = computed<"instance" | "user">(() =>
    props.layer === "instance" ? "instance" : "user",
);
const templates = ref<ApiRequestTemplate[]>([]);
const types = ref<ApiInputType[]>([]);
const builtins = ref<ApiRequestTemplate[]>([]);
const selected = ref<ApiRequestTemplate | null>(null);
const selectedType = ref("");
const diagnostics = ref<TemplateDiagnostic[]>([]);
const validating = ref(false);
const submitting = ref(false);
const busy = computed(() => props.saving || submitting.value || validating.value);
const error = ref("");
let generation = 0;
onBeforeUnmount(() => {
    generation++;
});
const sourceInput = ref<HTMLTextAreaElement | null>(null);
const palette = [
    "user_input",
    "agent_instructions",
    // PLAN-0632 Gate G-0: model-visible context blocks. Empty until PLAN-0628 (skills listing)
    // and PLAN-0629 (memory) produce content; seeding them here keeps authoring truthful.
    "skill_catalog",
    "agent_memory",
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
    () => [props.layer, props.entries.templates] as const,
    ([layer, raw], previous) => {
        if (!previous || layer !== previous[0]) {
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
/**
 * P2-2 ③：模板状态是 CP 枚举（`draft`/`published`），中文界面里不许直出裸英文。
 * 未登记的值**原样返回**（新增状态不会显示成空白或错误中文）。
 */
const STATUS_LABEL_KEYS: Record<string, string> = {
    draft: "settings.apiRequest.statusDraft",
    published: "settings.apiRequest.statusPublished",
};
function statusLabel(status: string | null | undefined): string {
    if (!status) return "—";
    const key = STATUS_LABEL_KEYS[status];
    return key ? t(key) : status;
}

/**
 * 只做排版：`JSON.parse` → `JSON.stringify(…, null, 2)`（两空格缩进）。
 * 语义不变：`${xh.*}` 等字符串值原样保留，不增删字段，不自动补默认值。
 * 非法 JSON 就地报错且**不改写原文**（不静默、不「尽力修复」）。
 */
function formatSource() {
    const current = selected.value;
    if (!current || busy.value) return;
    try {
        const parsed: unknown = JSON.parse(current.bodySource);
        current.bodySource = JSON.stringify(parsed, null, 2);
        error.value = "";
        diagnostics.value = [];
    } catch (cause) {
        const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
        const message = `${t("common.error")}${detail}`;
        logger.warn("API request template format failed", cause);
        error.value = message;
        toast.error(message);
    }
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
/**
 * 保存成功后回读服务端列表：列表原本只来自 props，父层未及时回填时用户会看到
 * 「保存成功但模板不出现」，因此这里以服务端返回为准再对齐一次。
 */
async function refreshTemplatesFromServer() {
    try {
        const entries = await readTemplateConfig(templateLayer.value);
        templates.value = parseTemplates(entries.templates);
        if (props.layer === "instance") {
            builtins.value = templates.value.filter((item) => item.status === "published");
        }
    } catch (cause) {
        logger.warn("API request template refresh after save failed", cause);
    }
    const persisted = templates.value.find(
        (item) => item.id === selected.value?.id && item.version === selected.value?.version,
    );
    if (persisted) selected.value = { ...persisted };
}

async function save(publish: boolean) {
    // 按钮在 busy 时已禁用；这里只兜并发重复点击，不再「静默无反应」。
    if (busy.value) return;
    const currentGeneration = generation;
    const next = nextRevision(publish ? "published" : "draft");
    if (!next) {
        error.value = t("settings.apiRequest.fallbackEmpty");
        return;
    }
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
    const entries = { ...props.entries, templates: JSON.stringify(updated) };
    submitting.value = true;
    try {
        if (props.submit) {
            // 只有在真实 PUT 200 后才会走到这里。
            await props.submit(entries);
        } else {
            emit("save", entries);
        }
        selected.value = next;
        await refreshTemplatesFromServer();
        toast.success(t("common.saved"));
    } catch (cause) {
        const message =
            cause instanceof Error && cause.message ? cause.message : t("settings.saveFailed");
        logger.warn("API request template save failed", cause);
        error.value = message;
        toast.error(message);
    } finally {
        submitting.value = false;
    }
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
            <Select v-model="selectedType">
                <SelectTrigger
                    data-testid="api-request-type"
                    :aria-label="t('common.apiType')"
                    class="rounded-md border bg-background px-2 py-1 text-xs"
                >
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem v-for="type in types" :key="typeKey(type)" :value="typeKey(type)">
                        {{ formatApiType(type.apiTypeId, type.version, t) }}
                    </SelectItem>
                </SelectContent>
            </Select>
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
                        >v{{ item.version }} · {{ statusLabel(item.status) }}</span
                    >
                </button>
                <p v-if="latest.length === 0" class="p-3 text-xs text-muted-foreground">
                    {{ t("settings.apiRequest.empty") }}
                </p>
            </nav>
            <div v-if="selected" class="min-w-0 space-y-3 p-4">
                <div class="flex flex-wrap items-center gap-2 text-xs">
                    <span>{{ formatApiType(selected.apiTypeId, selected.apiTypeVersion, t) }}</span>
                    <Select
                        :model-value="String(selected?.version ?? '')"
                        @update:model-value="
                            (value) => {
                                const found = revisions.find(
                                    (item) => item.version === Number(value),
                                );
                                if (found) select(found);
                            }
                        "
                    >
                        <SelectTrigger
                            :aria-label="t('settings.apiRequest.revisions')"
                            class="rounded border bg-background px-2 py-1"
                        >
                            <SelectValue>
                                v{{ selected?.version }} ·
                                {{
                                    statusLabel(
                                        revisions.find((item) => item.version === selected?.version)
                                            ?.status ?? "draft",
                                    )
                                }}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem
                                v-for="item in revisions"
                                :key="item.version"
                                :value="String(item.version)"
                            >
                                v{{ item.version }} · {{ statusLabel(item.status) }}
                            </SelectItem>
                        </SelectContent>
                    </Select>
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
                <div v-if="!readonly" class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        data-testid="api-request-format"
                        class="rounded-md border px-3 py-2 text-xs disabled:opacity-60"
                        :disabled="busy"
                        :aria-label="t('settings.apiRequest.format')"
                        @click="formatSource"
                    >
                        {{ t("settings.apiRequest.format") }}
                    </button>
                    <button
                        type="button"
                        data-testid="api-request-save-draft"
                        class="rounded-md border px-3 py-2 text-xs disabled:opacity-60"
                        :disabled="busy"
                        @click="save(false)"
                    >
                        {{ t("settings.apiRequest.saveDraft") }}
                    </button>
                    <button
                        type="button"
                        data-testid="api-request-publish"
                        class="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-60"
                        :disabled="busy"
                        @click="save(true)"
                    >
                        {{ t("settings.apiRequest.publish") }}
                    </button>
                    <span
                        v-if="busy"
                        role="status"
                        data-testid="api-request-saving"
                        class="text-xs text-muted-foreground"
                    >
                        {{ t("common.saving") }}
                    </span>
                </div>
            </div>
            <!-- P2-2 ①②：空态不再只说「去选 API Type」（`selectedType` 早在 onMounted 就填了首个类型，
                 叫用户去选等于让他找一个已经填好的控件），而是说清「没选中模板」并就地给新建入口。 -->
            <div v-else class="space-y-2 p-4">
                <p class="text-sm text-muted-foreground">
                    {{ t("settings.apiRequest.fallbackEmpty") }}
                </p>
                <button
                    v-if="!readonly && types.length > 0"
                    type="button"
                    data-testid="api-request-new-empty"
                    class="rounded-md border px-3 py-1 text-xs"
                    :disabled="saving"
                    @click="create"
                >
                    {{ t("settings.apiRequest.new") }}
                </button>
            </div>
        </div>
        <p v-if="error" role="alert" class="p-3 text-xs text-destructive">{{ error }}</p>
    </section>
</template>
