<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useConfigStore, LAYER_DOMAINS, type ConfigLayer } from "../../stores/config";
import ConfigDomainPanel, {
    type DomainField,
} from "../../components/settings/ConfigDomainPanel.vue";
import ConfigSourceSummary from "../../components/settings/ConfigSourceSummary.vue";
import AgentTemplatesPanel from "../../components/settings/AgentTemplatesPanel.vue";
import ContextTemplatesPanel from "../../components/settings/ContextTemplatesPanel.vue";
import EmbeddingSettingsPanel from "../../components/settings/EmbeddingSettingsPanel.vue";
import McpStdioServerList from "../../components/settings/McpStdioServerList.vue";
import ProviderHub from "../../components/settings/ProviderHub.vue";
import SettingsNav from "../../components/settings/SettingsNav.vue";
import BackToChatButton from "../../components/settings/BackToChatButton.vue";
import { api } from "../../composables/api";
import { logger } from "../../lib/logger";
import { getProviderInfo } from "../../types/provider";
import type { ProviderDefinition } from "../../types/providerConnection";
import { listProviderCatalog } from "../../services/providerConnectionService";
import { parseLlmProfileValue } from "../../services/llmProviderProfile";
import { useAuthStore } from "../../stores/auth";

const { t } = useI18n(),
    configStore = useConfigStore(),
    authStore = useAuthStore();

type LayerTab = ConfigLayer;
const activeTab = ref<LayerTab>(authStore.isAdmin ? "instance" : "user");

const tabs = computed<{ key: LayerTab; label: string }[]>(() => {
    const list: { key: LayerTab; label: string }[] = [];
    if (authStore.isAdmin) list.push({ key: "instance", label: t("settings.tabInstance") });
    // PLAN-0523 批注④: 实例 → 个人 → 工作区（继承链由广到窄；
    // 生效优先级仍为 工作区 > 个人 > 实例，见 spec/ui-surfaces.md S1）。
    list.push({ key: "user", label: t("settings.tabUser") });
    list.push({ key: "workspace", label: t("settings.tabWorkspace") });
    return list;
});

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

const fetchError = ref(false),
    savingDomains = ref<Record<string, boolean>>({});
// Only the first load of a layer shows the full-page loading state. Reloads
// after a save must keep the panels mounted (otherwise the expanded domain
// panel and its save button unmount mid-interaction).
const hasLayerData = computed(
    () => Object.keys(configStore.layerConfig[activeTab.value] ?? {}).length > 0,
);
const showInitialLoading = computed(() => configStore.layerLoading && !hasLayerData.value);
const exporting = ref(false),
    importing = ref(false),
    importWarnings = ref<string[]>([]),
    includeSecrets = ref(true);

const mcpJson = ref(""),
    mcpError = ref(""),
    mcpSaving = ref(false);
type RemoteMcpServer = {
    id: string;
    name: string;
    url: string;
    oauth: {
        clientId: string;
        authorizationEndpoint: string;
        tokenEndpoint: string;
        scope: string;
        redirectUri?: string;
    };
};
type AuthorizationStatus = "required" | "authorizing" | "authorized" | "failed";
const oauthStatus = ref<Record<string, AuthorizationStatus>>({}),
    oauthError = ref("");

function currentWorkspaceId(): string {
    return authStore.currentWorkspaceId ?? "";
}

const visibleDomains = computed(() => [...LAYER_DOMAINS[activeTab.value]]);

const showWorkspaceHint = computed(() => activeTab.value === "workspace" && !currentWorkspaceId()),
    showMcp = computed(() => activeTab.value === "workspace" && !!currentWorkspaceId()),
    showImportExport = computed(() => activeTab.value === "instance");

function schemaFor(domain: string): DomainField[] {
    const fields = domainSchemas.value[domain] ?? [];
    if (activeTab.value === "instance") return fields;
    return fields.filter((field) => !field.instanceOnly);
}

function envLockedFor(domain: string): Record<string, string> {
    return configStore.envOverridden[domain] ?? {};
}

const builtInTools = [
    "read_file",
    "write_file",
    "list_directory",
    "execute_command",
    "glob",
    "grep",
    "edit_file",
    "delete_file",
    "delete_directory",
    "read_file_range",
    "mkdir",
    "move_file",
    "copy_file",
    "get_file_info",
    "watch_directory",
    "extract_pdf_text",
    "apply_patch",
    "start_background_process",
    "list_background_processes",
    "get_background_process",
    "cancel_background_process",
    "read_command_output",
];

async function loadProviderCatalog() {
    try {
        const response = await listProviderCatalog();
        catalogProviders.value = response.providers ?? [];
    } catch (e) {
        logger.warn("Provider catalog load failed, using builtin fallback", e);
        catalogProviders.value = [];
    }
}

onMounted(async () => {
    await handleOAuthCallback();
    void loadProviderCatalog();
    void configStore.fetchModels();
    fetchError.value = false;
    try {
        if (activeTab.value !== "workspace" || currentWorkspaceId()) {
            await configStore.loadLayerDomains(activeTab.value, currentWorkspaceId());
        }
        if (showMcp.value) await loadMcpConfig();
    } catch (e) {
        logger.warn("Failed to load config domains", e);
        fetchError.value = true;
        toast.error("Failed to load configuration");
    }
});

async function switchTab(tab: LayerTab) {
    if (activeTab.value === tab) return;
    activeTab.value = tab;
    fetchError.value = false;
    try {
        if (tab !== "workspace" || currentWorkspaceId()) {
            await configStore.loadLayerDomains(tab, currentWorkspaceId());
        }
        if (tab === "workspace" && currentWorkspaceId() && !mcpJson.value) {
            await loadMcpConfig();
        }
    } catch (e) {
        logger.warn("Failed to load config domains for layer " + tab, e);
        fetchError.value = true;
        toast.error(t("settings.saveFailed"));
    }
}

async function reloadActiveLayer() {
    await configStore.loadLayerDomains(activeTab.value, currentWorkspaceId());
}

async function loadMcpConfig() {
    try {
        const resp = await api.getMcpConfig(currentWorkspaceId());
        if (resp.mcpServers) {
            const value =
                typeof resp.mcpServers === "string" ? JSON.parse(resp.mcpServers) : resp.mcpServers;
            mcpJson.value = JSON.stringify(
                value.mcpServers ? value : { mcpServers: value },
                null,
                2,
            );
        } else {
            mcpJson.value = JSON.stringify({ mcpServers: {} }, null, 2);
        }
    } catch (e) {
        logger.warn("Failed to load MCP config, using empty default", e);
        mcpJson.value = JSON.stringify({ mcpServers: {} }, null, 2);
    }
}

function getRemoteServers(): RemoteMcpServer[] {
    try {
        const parsed = JSON.parse(mcpJson.value) as Record<string, unknown>;
        const servers = (
            parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : parsed
        ) as Record<string, Record<string, unknown>>;
        return Object.entries(servers).flatMap(([id, server]) => {
            if (typeof server.url !== "string" || !server.url) return [];
            const oauth = (
                typeof server.oauth === "object" && server.oauth !== null ? server.oauth : {}
            ) as Record<string, unknown>;
            const value = (key: string) => oauth[key] ?? server[key],
                clientId = value("clientId") ?? value("client_id"),
                authorizationEndpoint =
                    value("authorizationEndpoint") ?? value("authorization_endpoint"),
                tokenEndpoint = value("tokenEndpoint") ?? value("token_endpoint"),
                scope = value("scope");
            if (
                [clientId, authorizationEndpoint, tokenEndpoint, scope].some(
                    (item) => typeof item !== "string" || !item,
                )
            )
                return [];
            const redirectUri = value("redirectUri") ?? value("redirect_uri");
            return [
                {
                    id,
                    name: typeof server.name === "string" ? server.name : id,
                    url: server.url,
                    oauth: {
                        clientId: clientId as string,
                        authorizationEndpoint: authorizationEndpoint as string,
                        tokenEndpoint: tokenEndpoint as string,
                        scope: scope as string,
                        redirectUri: typeof redirectUri === "string" ? redirectUri : undefined,
                    },
                },
            ];
        });
    } catch (e) {
        logger.warn("Failed to parse remote MCP OAuth configuration", e);
        return [];
    }
}

function oauthStatusFor(serverId: string): AuthorizationStatus {
    return (
        oauthStatus.value[serverId] ??
        (sessionStorage.getItem(`xihe-oauth-authorized:${serverId}`) === "true"
            ? "authorized"
            : "required")
    );
}

async function handleOAuthCallback() {
    const params = new URLSearchParams(window.location.search),
        state = params.get("state"),
        code = params.get("code"),
        error = params.get("error");
    if (!state || (!code && !error)) return;
    const pendingKey = `xihe-oauth-pending:${state}`,
        serverId = sessionStorage.getItem(pendingKey);
    if (!serverId) return;
    oauthStatus.value[serverId] = "authorizing";
    try {
        if (error) throw new Error(error);
        const result = await api.completeOAuthSession(state, code as string);
        if (result.status !== "authorized") throw new Error("OAuth callback was not authorized");
        sessionStorage.setItem(`xihe-oauth-authorized:${serverId}`, "true");
        oauthStatus.value[serverId] = "authorized";
    } catch (e) {
        logger.warn("Remote MCP OAuth callback failed", e);
        oauthStatus.value[serverId] = "failed";
        oauthError.value = t("settings.authorizationFailed");
    } finally {
        sessionStorage.removeItem(pendingKey);
        window.history.replaceState(
            {},
            document.title,
            `${window.location.pathname}${window.location.hash}`,
        );
    }
}

async function authorizeRemoteServer(server: RemoteMcpServer) {
    oauthError.value = "";
    oauthStatus.value[server.id] = "authorizing";
    try {
        const redirectUri =
            server.oauth.redirectUri || `${window.location.origin}${window.location.pathname}`;
        const result = await api.startOAuthSession({
            workspaceId: currentWorkspaceId(),
            serverId: server.id,
            remoteEndpoint: server.url,
            clientId: server.oauth.clientId,
            authorizationEndpoint: server.oauth.authorizationEndpoint,
            tokenEndpoint: server.oauth.tokenEndpoint,
            redirectUri,
            scope: server.oauth.scope,
        });
        sessionStorage.setItem(`xihe-oauth-pending:${result.state}`, server.id);
        window.location.assign(result.authorizationUrl);
    } catch (e) {
        logger.warn(`Failed to start OAuth for remote MCP server ${server.id}`, e);
        oauthStatus.value[server.id] = "failed";
        oauthError.value = t("settings.authorizationFailed");
    }
}

async function saveMcpConfig() {
    mcpSaving.value = true;
    mcpError.value = "";
    try {
        const parsed = JSON.parse(mcpJson.value);
        await api.saveMcpConfig(currentWorkspaceId(), parsed.mcpServers);
        toast.success(t("common.saved"));
    } catch (e) {
        if (e instanceof SyntaxError) {
            mcpError.value = t("settings.invalidJson");
        } else {
            toast.error(t("settings.saveFailed"));
        }
    } finally {
        mcpSaving.value = false;
    }
}

function generateSummary(domain: string): string {
    const entries = configStore.layerConfig[activeTab.value][domain] || {};
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
        await configStore.putLayerConfig(activeTab.value, domain, body, currentWorkspaceId());
        await reloadActiveLayer();
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
        if (activeTab.value === "instance") {
            await configStore.deleteInstanceKey(domain, key);
        } else {
            await configStore.putLayerConfig(
                activeTab.value,
                domain,
                { [key]: "" },
                currentWorkspaceId(),
            );
        }
        await reloadActiveLayer();
        toast.success(`${key} ${t("common.reset")}`);
    } catch (e) {
        toast.error(e instanceof Error ? e.message : t("settings.saveFailed"));
    }
}

async function handleExport() {
    exporting.value = true;
    try {
        const content = await configStore.exportConfig(includeSecrets.value),
            blob = new Blob([content], { type: "application/json" }),
            url = URL.createObjectURL(blob),
            anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "config.import.local.jsonc";
        anchor.click();
        URL.revokeObjectURL(url);
        toast.success(t("settings.exportDone"));
    } catch (e) {
        logger.warn("Config export failed", e);
        toast.error(t("settings.exportFailed"));
    } finally {
        exporting.value = false;
    }
}

async function handleImportFile(event: Event) {
    const input = event.target as HTMLInputElement,
        file = input.files?.[0];
    if (!file) return;
    importing.value = true;
    importWarnings.value = [];
    try {
        const content = await file.text(),
            report = await configStore.importConfig(content);
        importWarnings.value = report.warnings ?? [];
        toast.success(`${t("settings.importDone")}: +${report.imported} / skip ${report.skipped}`);
        if (importWarnings.value.length) toast.warning(importWarnings.value[0]);
        await reloadActiveLayer();
    } catch (e) {
        logger.warn("Config import failed", e);
        toast.error(t("settings.importFailed"));
    } finally {
        importing.value = false;
        input.value = "";
    }
}
</script>

<template>
    <div>
        <BackToChatButton />
        <SettingsNav />
        <div class="mx-auto w-full max-w-6xl space-y-2 px-6 py-6">
            <h2 data-testid="settings-config-heading" class="text-lg font-semibold mb-4">
                {{ t("settings.configTab") }}
            </h2>

            <div v-if="fetchError" class="mb-3 px-3 py-2 text-sm bg-red-100 text-red-800 rounded">
                {{ t("common.error") }}: {{ t("settings.saveFailed") }}
            </div>

            <div v-if="showInitialLoading" class="text-sm text-muted-foreground">
                {{ t("common.loading") }}
            </div>

            <template v-else>
                <div class="flex gap-1 border-b mb-4">
                    <button
                        v-for="tab in tabs"
                        :key="tab.key"
                        :data-testid="`config-tab-${tab.key}`"
                        class="px-4 py-2 text-sm border-b-2 transition-colors"
                        :class="
                            activeTab === tab.key
                                ? 'border-primary text-foreground font-medium'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                        "
                        @click="switchTab(tab.key)"
                    >
                        {{ tab.label }}
                    </button>
                </div>

                <div v-if="showWorkspaceHint" class="text-sm text-muted-foreground px-1 py-4">
                    {{ t("settings.workspaceRequired") }}
                </div>

                <div v-else class="space-y-1">
                    <div
                        v-if="showImportExport"
                        class="border rounded-lg mb-2 overflow-hidden"
                        data-testid="config-import-export"
                    >
                        <div class="px-4 py-3 text-sm font-medium bg-muted/30">
                            {{ t("settings.importExport") }}
                        </div>
                        <div class="px-4 pb-3 space-y-2">
                            <div class="flex flex-wrap items-center gap-3">
                                <button
                                    data-testid="config-export-button"
                                    class="px-3 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50"
                                    :disabled="exporting"
                                    @click="handleExport"
                                >
                                    {{
                                        exporting ? t("common.loading") : t("settings.exportConfig")
                                    }}
                                </button>
                                <label
                                    class="flex items-center gap-1 text-xs text-muted-foreground"
                                >
                                    <input
                                        v-model="includeSecrets"
                                        data-testid="config-export-secrets"
                                        type="checkbox"
                                    />
                                    {{ t("settings.exportIncludeSecrets") }}
                                </label>
                                <label
                                    class="px-3 py-1 text-xs border rounded cursor-pointer hover:bg-muted"
                                    :class="{ 'opacity-50': importing }"
                                >
                                    {{
                                        importing ? t("common.loading") : t("settings.importConfig")
                                    }}
                                    <input
                                        data-testid="config-import-input"
                                        type="file"
                                        accept=".jsonc,.json,application/json"
                                        class="hidden"
                                        :disabled="importing"
                                        @change="handleImportFile"
                                    />
                                </label>
                            </div>
                            <ul
                                v-if="importWarnings.length"
                                class="text-xs text-amber-600 list-disc pl-4"
                                data-testid="config-import-warnings"
                            >
                                <li v-for="(warning, index) in importWarnings" :key="index">
                                    {{ warning }}
                                </li>
                            </ul>
                        </div>
                    </div>

                    <div
                        v-if="activeTab === 'workspace'"
                        data-testid="config-workspace-transition"
                        class="mb-2 rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                    >
                        {{ t("settings.workspaceTransitionNote") }}
                    </div>
                    <template v-for="domain in visibleDomains" :key="domain">
                        <!-- PLAN-0523 T3.1: llm-provider 合并为单一「模型提供方」分区
                             （spec/ui-surfaces.md S1/S3）；旧 ProfilePanel / 层全局参数表单
                             退役（组件删除在 T3.6）。 -->
                        <template v-if="domain === 'llm-provider'">
                            <div
                                class="border rounded-lg mb-2 overflow-hidden"
                                data-testid="provider-partition"
                            >
                                <div class="px-4 py-3 bg-muted/30 space-y-1">
                                    <div
                                        class="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                                    >
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
                                    <template v-if="activeTab === 'instance'">
                                        <p class="text-sm text-muted-foreground">
                                            {{ t("settings.providerInstanceGuidance") }}
                                        </p>
                                        <div class="flex flex-wrap gap-2">
                                            <button
                                                data-testid="provider-instance-go-user"
                                                class="px-3 py-1 text-xs border rounded hover:bg-muted"
                                                @click="switchTab('user')"
                                            >
                                                {{ t("settings.providerInstanceGoUser") }}
                                            </button>
                                            <button
                                                data-testid="provider-instance-go-workspace"
                                                class="px-3 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50"
                                                :disabled="!currentWorkspaceId()"
                                                :title="
                                                    currentWorkspaceId()
                                                        ? undefined
                                                        : t('settings.providerInstanceNoWorkspace')
                                                "
                                                @click="switchTab('workspace')"
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
                                        :workspace-id="currentWorkspaceId() || undefined"
                                        :scope="activeTab === 'user' ? 'USER' : 'WORKSPACE'"
                                    />
                                    <ConfigSourceSummary
                                        v-if="activeTab !== 'instance'"
                                        domain="llm-provider"
                                        :layer="activeTab"
                                        :meta="
                                            configStore.layerMeta[activeTab]['llm-provider'] || {}
                                        "
                                    />
                                </div>
                            </div>
                        </template>
                        <template v-else-if="domain === 'agent-templates'">
                            <AgentTemplatesPanel
                                :entries="configStore.layerConfig[activeTab][domain] || {}"
                                :saving="savingDomains[domain] || false"
                                @save="handleSave(domain, $event)"
                            />
                            <ConfigSourceSummary
                                domain="agent-templates"
                                :layer="activeTab"
                                :meta="configStore.layerMeta[activeTab]['agent-templates'] || {}"
                            />
                        </template>
                        <template v-else-if="domain === 'api-request-templates'">
                            <ContextTemplatesPanel
                                :key="`${activeTab}:${currentWorkspaceId()}`"
                                :entries="configStore.layerConfig[activeTab][domain] || {}"
                                :saving="savingDomains[domain] || false"
                                :layer="activeTab"
                                :workspace-id="currentWorkspaceId() || undefined"
                                @save="handleSave(domain, $event)"
                            />
                            <ConfigSourceSummary
                                domain="api-request-templates"
                                :layer="activeTab"
                                :meta="
                                    configStore.layerMeta[activeTab]['api-request-templates'] || {}
                                "
                            />
                        </template>
                        <template v-else-if="domain === 'embedding' && activeTab !== 'instance'">
                            <EmbeddingSettingsPanel
                                :layer="activeTab === 'user' ? 'user' : 'workspace'"
                                :workspace-id="currentWorkspaceId() || undefined"
                                :saving="savingDomains[domain] || false"
                            />
                            <ConfigSourceSummary
                                domain="embedding"
                                :layer="activeTab"
                                :meta="configStore.layerMeta[activeTab]['embedding'] || {}"
                            />
                        </template>
                        <ConfigDomainPanel
                            v-else
                            :domain="domain"
                            :title="domainLabels[domain] || domain"
                            :entries="configStore.layerConfig[activeTab][domain] || {}"
                            :admin="activeTab !== 'user'"
                            :summary="generateSummary(domain)"
                            :schema="schemaFor(domain)"
                            :env-locked="envLockedFor(domain)"
                            :meta="configStore.layerMeta[activeTab][domain] || {}"
                            :layer="activeTab"
                            @save="handleSave(domain, $event)"
                            @reset="handleReset(domain, $event)"
                        />
                    </template>

                    <div v-if="showMcp" class="border rounded-lg mb-2 overflow-hidden">
                        <div class="px-4 py-3 text-sm font-medium bg-muted/30">
                            {{ t("settings.domainMcp") }}
                        </div>
                        <div class="px-4 pb-3 space-y-3">
                            <McpStdioServerList :workspace-id="currentWorkspaceId()" />
                            <div class="space-y-2">
                                <div class="flex flex-wrap gap-2 mb-3">
                                    <span
                                        v-for="tool in builtInTools"
                                        :key="tool"
                                        class="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary"
                                    >
                                        {{ tool }}
                                    </span>
                                </div>
                                <textarea
                                    v-model="mcpJson"
                                    data-testid="mcp-config-textarea"
                                    class="w-full h-48 px-4 py-3 rounded-lg border bg-background font-mono text-sm resize-y"
                                />
                                <p v-if="mcpError" class="text-xs text-destructive">
                                    {{ mcpError }}
                                </p>
                                <div class="flex gap-2">
                                    <button
                                        class="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50"
                                        :disabled="mcpSaving"
                                        @click="saveMcpConfig"
                                    >
                                        {{ mcpSaving ? t("common.saving") : t("common.save") }}
                                    </button>
                                </div>
                                <div
                                    v-if="getRemoteServers().length"
                                    class="border-t pt-3 space-y-2"
                                >
                                    <div class="text-sm font-medium">
                                        {{ t("settings.remoteMcp") }}
                                    </div>
                                    <div
                                        v-for="server in getRemoteServers()"
                                        :key="server.id"
                                        class="flex items-center justify-between gap-3 text-sm"
                                        :data-testid="`remote-mcp-${server.id}`"
                                    >
                                        <span>{{ server.name }}</span>
                                        <span class="flex items-center gap-2">
                                            <span class="text-xs text-muted-foreground">
                                                {{
                                                    oauthStatusFor(server.id) === "authorized"
                                                        ? t("settings.authorized")
                                                        : oauthStatusFor(server.id) ===
                                                            "authorizing"
                                                          ? t("settings.authorizing")
                                                          : oauthStatusFor(server.id) === "failed"
                                                            ? t("settings.authorizationFailed")
                                                            : t("settings.authorizationRequired")
                                                }}
                                            </span>
                                            <button
                                                class="px-3 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50"
                                                :disabled="
                                                    oauthStatusFor(server.id) === 'authorizing'
                                                "
                                                @click="authorizeRemoteServer(server)"
                                            >
                                                {{
                                                    oauthStatusFor(server.id) === "authorized"
                                                        ? t("settings.authorized")
                                                        : t("settings.authorize")
                                                }}
                                            </button>
                                        </span>
                                    </div>
                                    <p v-if="oauthError" class="text-xs text-destructive">
                                        {{ oauthError }}
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </template>
        </div>
    </div>
</template>
