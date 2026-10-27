<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useConfigStore, LAYER_DOMAINS, type ConfigLayer } from "../../stores/config";
import ConfigDomainPanel, { type DomainField } from "./ConfigDomainPanel.vue";
import ConfigSourceSummary from "./ConfigSourceSummary.vue";
import AgentTemplatesPanel from "./AgentTemplatesPanel.vue";
import ContextTemplatesPanel from "./ContextTemplatesPanel.vue";
import EmbeddingSettingsPanel from "./EmbeddingSettingsPanel.vue";
import ProviderHub from "./ProviderHub.vue";
import { logger } from "../../lib/logger";
import { getProviderInfo } from "../../types/provider";
import type { ProviderDefinition } from "../../types/providerConnection";
import { listProviderCatalog } from "../../services/providerConnectionService";
import { parseLlmProfileValue } from "../../services/llmProviderProfile";

/**
 * PLAN-0560 T2.4: 域清单 + 摘要 + 保存/重置 + ProviderHub/embedding/templates 分派，
 * 从 ConfigSettings 抽出，供全局 Instance/User 与工作区设置页（workspace 层）共用。
 * 只搬代码，不改 data-testid。
 */
const props = withDefaults(
    defineProps<{
        layer: ConfigLayer;
        workspaceId?: string;
        readonly?: boolean;
    }>(),
    { workspaceId: undefined, readonly: false },
);

const emit = defineEmits<{
    // 只有 instance 层引导按钮会发出，目标只会是全局页的另一层（user）。
    "switch-layer": [layer: "instance" | "user"];
    "go-workspace": [];
}>();

const { t } = useI18n(),
    configStore = useConfigStore();

const domainLabels: Record<string, string> = {
    "llm-provider": t("settings.domainLlmProvider"),
    "context-policy": t("settings.domainContextPolicy"),
    embedding: t("settings.domainEmbedding"),
    rag: t("settings.domainRag"),
    "agent-runtime": t("settings.domainAgentRuntime"),
    "agent-profile": t("settings.domainAgentProfile"),
    "user-preference": t("settings.domainUserPreference"),
    logging: t("settings.domainLogging"),
    "approval-policy": t("settings.domainApprovalPolicy"),
    "agent-templates": t("settings.domainAgentTemplates"),
    "api-request-templates": t("settings.domainContextTemplates"),
    "job-policy": t("settings.domainJobPolicy"),
};

/**
 * PLAN-0503 T2.1: the provider list comes from the CP catalog; the builtin
 * list is only the offline fallback (its own comment declares the catalog as
 * the authoritative source).
 */
const catalogProviders = ref<ProviderDefinition[]>([]);

const levelOptions = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"].map((level) => ({
        label: level,
        value: level,
    })),
    boolOptions = [
        { label: "true", value: "true" },
        { label: "false", value: "false" },
    ];

function providerDisplayName(providerId: string): string {
    return (
        catalogProviders.value.find((provider) => provider.id === providerId)?.displayName ??
        getProviderInfo(providerId)?.name ??
        providerId
    );
}

const domainSchemas = computed<Record<string, DomainField[]>>(() => ({
    // PLAN-0523 T3.6 (决策 #13): llm-provider 不再有通用表单字段——默认身份
    // profile / 每模型 modelParams 均由「模型提供方」分区（ProviderHub）就地编辑；
    // 旧 imageProvider/三采样键随 schema 与迁移退役（imageProvider 键保留给冻结的图像块）。
    "llm-provider": [],
    "context-policy": [
        { key: "defaults", label: t("settings.fieldCompactionDefaults"), type: "json" },
        { key: "models", label: t("settings.fieldCompactionModels"), type: "json" },
    ],
    "approval-policy": [
        {
            key: "mode",
            label: t("settings.fieldApprovalMode"),
            type: "select",
            options: [
                { label: t("settings.approvalModeManual"), value: "manual" },
                { label: t("settings.approvalModeAuto"), value: "auto" },
            ],
        },
        {
            key: "askActionClasses",
            label: t("settings.fieldApprovalAskActionClasses"),
            type: "json",
        },
    ],
    "job-policy": [
        { key: "defaultTimeoutSecs", label: t("settings.fieldDefaultTimeoutSecs"), type: "number" },
        { key: "maxTimeoutSecs", label: t("settings.fieldMaxTimeoutSecs"), type: "number" },
    ],
    embedding: [
        { key: "model", label: t("settings.fieldModel"), type: "text" },
        { key: "dimensions", label: t("settings.fieldDimensions"), type: "number" },
    ],
    rag: [
        { key: "chunkSize", label: t("settings.fieldChunkSize"), type: "number" },
        { key: "chunkOverlap", label: t("settings.fieldChunkOverlap"), type: "number" },
        { key: "topK", label: t("settings.fieldTopK"), type: "number" },
        { key: "minScore", label: t("settings.fieldMinScore"), type: "number" },
    ],
    "agent-runtime": [
        {
            key: "useRegistry",
            label: t("settings.fieldUseRegistry"),
            type: "select",
            options: boolOptions,
        },
        {
            key: "useSupervisor",
            label: t("settings.fieldUseSupervisor"),
            type: "select",
            options: boolOptions,
        },
        { key: "workersDir", label: t("settings.fieldWorkersDir"), type: "text" },
        {
            key: "instructions",
            label: t("settings.fieldInstructions"),
            type: "textarea",
            instanceOnly: true,
        },
        {
            key: "systemToolTimeoutS",
            label: t("settings.fieldSystemToolTimeout"),
            type: "number",
            max: 30,
        },
        { key: "toolOutputLimitBytes", label: t("settings.fieldToolOutputLimit"), type: "number" },
        // PLAN-0492: ChatRun 累计预算（值键 user/workspace 可写；*Ceiling 仅 instance
        // 层可写，0 = 不钳制；runMaxTokens 当前观测模式）。
        { key: "runMaxTurns", label: t("settings.fieldRunMaxTurns"), type: "number" },
        {
            key: "runMaxElapsedSeconds",
            label: t("settings.fieldRunMaxElapsedSeconds"),
            type: "number",
        },
        { key: "runMaxTokens", label: t("settings.fieldRunMaxTokens"), type: "number" },
        {
            key: "runMaxTurnsCeiling",
            label: t("settings.fieldRunMaxTurnsCeiling"),
            type: "number",
            instanceOnly: true,
        },
        {
            key: "runMaxElapsedSecondsCeiling",
            label: t("settings.fieldRunMaxElapsedSecondsCeiling"),
            type: "number",
            instanceOnly: true,
        },
        {
            key: "runMaxTokensCeiling",
            label: t("settings.fieldRunMaxTokensCeiling"),
            type: "number",
            instanceOnly: true,
        },
        // PLAN-0493: 语义重复/无进展检测阈值与窗口（值键 user/workspace 可写；
        // escalate/window 的 *Ceiling 仅 instance 层可写，0 = 不钳制）。
        { key: "loopRepeatWarn", label: t("settings.fieldLoopRepeatWarn"), type: "number" },
        { key: "loopRepeatRefuse", label: t("settings.fieldLoopRepeatRefuse"), type: "number" },
        {
            key: "loopRepeatEscalate",
            label: t("settings.fieldLoopRepeatEscalate"),
            type: "number",
        },
        { key: "loopErrorRunWarn", label: t("settings.fieldLoopErrorRunWarn"), type: "number" },
        {
            key: "loopErrorRunEscalate",
            label: t("settings.fieldLoopErrorRunEscalate"),
            type: "number",
        },
        {
            key: "loopStaleResultWarn",
            label: t("settings.fieldLoopStaleResultWarn"),
            type: "number",
        },
        {
            key: "loopStaleResultEscalate",
            label: t("settings.fieldLoopStaleResultEscalate"),
            type: "number",
        },
        { key: "loopWindowSize", label: t("settings.fieldLoopWindowSize"), type: "number" },
        {
            key: "loopRepeatEscalateCeiling",
            label: t("settings.fieldLoopRepeatEscalateCeiling"),
            type: "number",
            instanceOnly: true,
        },
        {
            key: "loopErrorRunEscalateCeiling",
            label: t("settings.fieldLoopErrorRunEscalateCeiling"),
            type: "number",
            instanceOnly: true,
        },
        {
            key: "loopStaleResultEscalateCeiling",
            label: t("settings.fieldLoopStaleResultEscalateCeiling"),
            type: "number",
            instanceOnly: true,
        },
        {
            key: "loopWindowSizeCeiling",
            label: t("settings.fieldLoopWindowSizeCeiling"),
            type: "number",
            instanceOnly: true,
        },
    ],
    "agent-profile": [{ key: "userName", label: t("settings.fieldUserName"), type: "text" }],
    "user-preference": [
        {
            key: "theme",
            label: t("settings.fieldTheme"),
            type: "select",
            options: [
                { label: t("settings.light"), value: "light" },
                { label: t("settings.dark"), value: "dark" },
                { label: t("settings.system"), value: "system" },
            ],
        },
        { key: "language", label: t("settings.language"), type: "text" },
    ],
    logging: [
        {
            key: "logLevel",
            label: t("settings.fieldLogLevel"),
            type: "select",
            options: levelOptions,
        },
        {
            key: "levelAgent",
            label: t("settings.fieldLevelAgent"),
            type: "select",
            options: levelOptions,
        },
        {
            key: "levelCp",
            label: t("settings.fieldLevelCp"),
            type: "select",
            options: levelOptions,
        },
        {
            key: "levelRuntime",
            label: t("settings.fieldLevelRuntime"),
            type: "select",
            options: levelOptions,
        },
        {
            key: "levelUi",
            label: t("settings.fieldLevelUi"),
            type: "select",
            options: levelOptions,
        },
        {
            key: "centralTelemetryEnabled",
            label: t("settings.fieldCentralTelemetryEnabled"),
            type: "select",
            options: boolOptions,
        },
    ],
}));

const savingDomains = ref<Record<string, boolean>>({});

const visibleDomains = computed(() => [...LAYER_DOMAINS[props.layer]]);

function schemaFor(domain: string): DomainField[] {
    const fields = domainSchemas.value[domain] ?? [];
    if (props.layer === "instance") return fields;
    return fields.filter((field) => !field.instanceOnly);
}

function envLockedFor(domain: string): Record<string, string> {
    return configStore.envOverridden[domain] ?? {};
}

async function loadProviderCatalog() {
    try {
        const response = await listProviderCatalog();
        catalogProviders.value = response.providers ?? [];
    } catch (e) {
        logger.warn("Provider catalog load failed, using builtin fallback", e);
        catalogProviders.value = [];
    }
}

onMounted(() => {
    void loadProviderCatalog();
    void configStore.fetchModels();
});

async function reloadLayer() {
    await configStore.loadLayerDomains(props.layer, props.workspaceId);
}

function generateSummary(domain: string): string {
    const entries = configStore.layerConfig[props.layer][domain] || {};
    if (Object.keys(entries).length === 0) return "";
    if (domain === "llm-provider") {
        // PLAN-0504: summarize the resolved profile unit (legacy fields retired).
        const profile = parseLlmProfileValue(entries["profile"]);
        if (!profile) return "";
        const provider = providerDisplayName(profile.providerId);
        return `${provider} / ${profile.model}`;
    }
    if (domain === "rag") {
        const cs = entries["chunkSize"],
            tk = entries["topK"];
        return [cs && `chunk: ${cs}`, tk && `topK: ${tk}`].filter(Boolean).join(", ");
    }
    if (domain === "embedding") {
        const model = entries["model"],
            dims = entries["dimensions"];
        return [model, dims && `(${dims}d)`].filter(Boolean).join(" ");
    }
    if (domain === "logging") {
        const level = entries["logLevel"] || entries["levelAgent"];
        return level ? `level: ${level}` : "";
    }
    if (domain === "agent-profile") {
        return entries["userName"] || "";
    }
    return "";
}

function validateJsonFields(domain: string, body: Record<string, string>): string | null {
    for (const field of domainSchemas.value[domain] ?? []) {
        if (field.type !== "json") continue;
        const value = body[field.key];
        if (!value) continue;
        try {
            JSON.parse(value);
        } catch {
            return `${field.label}: ${t("settings.invalidJson")}`;
        }
    }
    return null;
}

async function handleSave(domain: string, body: Record<string, string>) {
    const jsonError = validateJsonFields(domain, body);
    if (jsonError) {
        toast.error(jsonError);
        return;
    }
    savingDomains.value[domain] = true;
    try {
        await configStore.putLayerConfig(props.layer, domain, body, props.workspaceId);
        await reloadLayer();
        if (domain !== "agent-templates") {
            toast.success(`${domainLabels[domain] || domain} ${t("common.saved")}`);
        }
    } catch (e) {
        if (domain !== "agent-templates") {
            toast.error(e instanceof Error ? e.message : `${t("settings.saveFailed")} ${domain}`);
        }
    } finally {
        savingDomains.value[domain] = false;
    }
}

async function handleReset(domain: string, key: string) {
    try {
        if (props.layer === "instance") {
            await configStore.deleteInstanceKey(domain, key);
        } else {
            await configStore.putLayerConfig(props.layer, domain, { [key]: "" }, props.workspaceId);
        }
        await reloadLayer();
        toast.success(`${key} ${t("common.reset")}`);
    } catch (e) {
        toast.error(e instanceof Error ? e.message : t("settings.saveFailed"));
    }
}
</script>

<template>
    <template v-for="domain in visibleDomains" :key="domain">
        <!-- PLAN-0523 T3.1: llm-provider 合并为单一「模型提供方」分区
             （spec/ui-surfaces.md S1/S3）；旧 ProfilePanel / 层全局参数表单
             退役（组件删除在 T3.6）。 -->
        <template v-if="domain === 'llm-provider'">
            <div class="border rounded-lg mb-2 overflow-hidden" data-testid="provider-partition">
                <div class="px-4 py-3 bg-muted/30 space-y-1">
                    <div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {{ t("settings.providerPartitionKicker") }}
                    </div>
                    <h3 class="text-sm font-semibold">
                        {{ t("settings.providerPartitionTitle") }}
                    </h3>
                    <p class="text-xs text-muted-foreground">
                        {{ t("settings.providerPartitionDesc") }}
                    </p>
                </div>
                <div class="px-4 py-3 space-y-3">
                    <template v-if="layer === 'instance'">
                        <p class="text-sm text-muted-foreground">
                            {{ t("settings.providerInstanceGuidance") }}
                        </p>
                        <div class="flex flex-wrap gap-2">
                            <button
                                data-testid="provider-instance-go-user"
                                class="px-3 py-1 text-xs border rounded hover:bg-muted"
                                @click="emit('switch-layer', 'user')"
                            >
                                {{ t("settings.providerInstanceGoUser") }}
                            </button>
                            <button
                                data-testid="provider-instance-go-workspace"
                                class="px-3 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50"
                                :disabled="!workspaceId"
                                :title="
                                    workspaceId
                                        ? undefined
                                        : t('settings.providerInstanceNoWorkspace')
                                "
                                @click="emit('go-workspace')"
                            >
                                {{ t("settings.providerInstanceGoWorkspace") }}
                            </button>
                        </div>
                        <div
                            class="flex gap-2 items-start border-l-2 border-border pl-3 text-xs text-muted-foreground"
                        >
                            <span aria-hidden="true">i</span>
                            <span>{{ t("settings.providerInstanceNote") }}</span>
                        </div>
                    </template>
                    <ProviderHub
                        v-else
                        :workspace-id="workspaceId"
                        :scope="layer === 'user' ? 'USER' : 'WORKSPACE'"
                        :readonly="readonly"
                    />
                    <ConfigSourceSummary
                        v-if="layer !== 'instance'"
                        domain="llm-provider"
                        :layer="layer"
                        :meta="configStore.layerMeta[layer]['llm-provider'] || {}"
                    />
                </div>
            </div>
        </template>
        <template v-else-if="domain === 'agent-templates'">
            <AgentTemplatesPanel
                :entries="configStore.layerConfig[layer][domain] || {}"
                :saving="savingDomains[domain] || false"
                @save="handleSave(domain, $event)"
            />
            <ConfigSourceSummary
                domain="agent-templates"
                :layer="layer"
                :meta="configStore.layerMeta[layer]['agent-templates'] || {}"
            />
        </template>
        <template v-else-if="domain === 'api-request-templates'">
            <ContextTemplatesPanel
                :key="`${layer}:${workspaceId ?? ''}`"
                :entries="configStore.layerConfig[layer][domain] || {}"
                :saving="savingDomains[domain] || false"
                :layer="layer"
                :workspace-id="workspaceId"
                @save="handleSave(domain, $event)"
            />
            <ConfigSourceSummary
                domain="api-request-templates"
                :layer="layer"
                :meta="configStore.layerMeta[layer]['api-request-templates'] || {}"
            />
        </template>
        <template v-else-if="domain === 'embedding' && layer !== 'instance'">
            <EmbeddingSettingsPanel
                :layer="layer === 'user' ? 'user' : 'workspace'"
                :workspace-id="workspaceId"
                :saving="savingDomains[domain] || false"
            />
            <ConfigSourceSummary
                domain="embedding"
                :layer="layer"
                :meta="configStore.layerMeta[layer]['embedding'] || {}"
            />
        </template>
        <ConfigDomainPanel
            v-else
            :domain="domain"
            :title="domainLabels[domain] || domain"
            :entries="configStore.layerConfig[layer][domain] || {}"
            :admin="layer !== 'user'"
            :summary="generateSummary(domain)"
            :schema="schemaFor(domain)"
            :env-locked="envLockedFor(domain)"
            :meta="configStore.layerMeta[layer][domain] || {}"
            :layer="layer"
            :readonly="readonly"
            @save="handleSave(domain, $event)"
            @reset="handleReset(domain, $event)"
        />
    </template>
</template>
