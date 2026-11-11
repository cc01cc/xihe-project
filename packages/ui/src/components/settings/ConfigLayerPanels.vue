<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
    useConfigStore,
    LAYER_DOMAINS,
    type ConfigDomain,
    type ConfigLayer,
} from "../../stores/config";
import ConfigDomainPanel, { type DomainField } from "./ConfigDomainPanel.vue";
import { useSettingsStore } from "../../stores/settings";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../i18n/locale";
import type { Language } from "../../types";
import ConfigSourceSummary from "./ConfigSourceSummary.vue";
import AgentTemplatesPanel from "./AgentTemplatesPanel.vue";
import ContextTemplatesPanel from "./ContextTemplatesPanel.vue";
import EmbeddingSettingsPanel from "./EmbeddingSettingsPanel.vue";
import LlmDefaultProfilePanel from "./LlmDefaultProfilePanel.vue";
import ProviderHub from "./ProviderHub.vue";
import { logger } from "../../lib/logger";
import { getProviderInfo } from "../../types/provider";
import type { ProviderDefinition } from "../../types/providerConnection";
import { listProviderCatalog } from "../../services/providerConnectionService";
import { parseLlmProfileValue } from "../../services/llmProviderProfile";
import { DOMAIN_LABEL_KEY } from "../../lib/settingsIa";

/**
 * PLAN-0560 T2.4: 域清单 + 摘要 + 保存/重置 + ProviderHub/embedding/templates 分派，
 * 从 ConfigSettings 抽出，供全局设置域页共用；工作区设置页的配置 tab 已随 task-253 移除，
 * 这里不再有 workspace 层分支（工作区层是每工作区的覆盖层，由工作区面承接）。
 * 只搬代码，不改 data-testid。
 */
const props = withDefaults(
    defineProps<{
        layer: ConfigLayer;
        readonly?: boolean;
        /** PLAN-0752 T1.2：只渲染这一个域（域页用）；不传 = 整层（沿用旧行为）。 */
        domain?: ConfigDomain;
    }>(),
    { readonly: false, domain: undefined },
);

const emit = defineEmits<{
    // 只有 instance 层引导按钮会发出，目标只会是全局页的另一层（user）。
    // task-253：原来的 "go-workspace" 引导（跳 /workspace/:id/settings?tab=config）随工作区
    // 配置 tab 一起移除 —— 那个 tab 已经不存在了，留着按钮就是死链。
    "switch-layer": [layer: "instance" | "user"];
    /** task-157：当前域页的可编辑字段数（SettingsDomainView 的页头次量纲 M）。 */
    "editable-count": [count: number];
}>();

const settings = useSettingsStore();
const { t } = useI18n(),
    configStore = useConfigStore();

/**
 * task-47：域名文案**调用时**求值。
 *
 * 原实现是 `const domainLabels: Record<string, string> = { …: t(…) }` —— setup 期只求值一次，
 * 页面内切语言不会重算，于是 `en-US` 界面保存后 toast 出现混合文案「用户偏好 Saved」
 * （中文域名 + 英文动词）。key 表统一取 `lib/settingsIa.ts#DOMAIN_LABEL_KEY`
 * （域标签的唯一 key 来源，左栏/面包屑/域页 h2 共用），这里不再复制第二份。
 */
function domainLabel(domain: string): string {
    const key = DOMAIN_LABEL_KEY[domain as ConfigDomain];
    return key ? t(key) : domain;
}

/**
 * PLAN-0503 T2.1: the provider list comes from the CP catalog; the builtin
 * list is only the offline fallback (its own comment declares the catalog as
 * the authoritative source).
 */
const catalogProviders = ref<ProviderDefinition[]>([]);

/** task-125：语言显示名只有 id → i18n key 映射；清单本体永远是 SUPPORTED_LOCALES。 */
const LANGUAGE_LABEL_KEY: Record<Language, string> = {
    "zh-CN": "settings.languageZh",
    "en-US": "settings.languageEn",
};

/** task-170 / F-11：日志级别是 CP 值（INFO/...），正文给中文名，值仍用原文。 */
const LOG_LEVEL_LABEL_KEY: Record<string, string> = {
    TRACE: "settings.logLevelTrace",
    DEBUG: "settings.logLevelDebug",
    INFO: "settings.logLevelInfo",
    WARN: "settings.logLevelWarn",
    ERROR: "settings.logLevelError",
};
function levelLabel(level: string): string {
    // CP 的 enum 同时允许大写与小写（logging.json: INFO/info），词表按大写键归一。
    const key = LOG_LEVEL_LABEL_KEY[level.toUpperCase()];
    return key ? t(key) : level;
}
function levelOptions(): Array<{ label: string; value: string }> {
    return ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"].map((level) => ({
        label: levelLabel(level),
        value: level,
    }));
}
const boolOptions = [
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
        // PLAN-0679 B-1: provider-layer request fingerprint switch (workspace-writable,
        // default true); independent from the context-fingerprint key.
        {
            key: "providerRequestFingerprintEnabled",
            label: t("settings.fieldProviderRequestFingerprint"),
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
        {
            key: "language",
            label: t("settings.language"),
            type: "select",
            // task-125 / D-899：选项由 SSOT 派生，不写死两条；与 theme 同为 select（既有惯例）。
            options: SUPPORTED_LOCALES.map((locale) => ({
                label: t(LANGUAGE_LABEL_KEY[locale]),
                value: locale,
            })),
        },
    ],
    logging: [
        {
            key: "logLevel",
            label: t("settings.fieldLogLevel"),
            type: "select",
            options: levelOptions(),
        },
        {
            key: "levelAgent",
            label: t("settings.fieldLevelAgent"),
            type: "select",
            options: levelOptions(),
        },
        {
            key: "levelCp",
            label: t("settings.fieldLevelCp"),
            type: "select",
            options: levelOptions(),
        },
        {
            key: "levelRuntime",
            label: t("settings.fieldLevelRuntime"),
            type: "select",
            options: levelOptions(),
        },
        {
            key: "levelUi",
            label: t("settings.fieldLevelUi"),
            type: "select",
            options: levelOptions(),
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

const visibleDomains = computed(() =>
    props.domain ? [props.domain] : [...LAYER_DOMAINS[props.layer]],
);

/**
 * PLAN-0752 T3.2：实例专属键在下层**不再静默消失**，而是渲染成只读行 + 「仅实例层」徽标
 * （design §5.1「不隐藏该行，隐藏会让用户以为没有这项」）。可写性仍由 ConfigDomainPanel 按
 * CP meta 判定；本函数只负责「这一层该看到哪些键」。
 */
function schemaFor(domain: string): DomainField[] {
    return domainSchemas.value[domain] ?? [];
}

function envLockedFor(domain: string): Record<string, string> {
    return configStore.envOverridden[domain] ?? {};
}

/**
 * task-157：页头「当前页可编辑 M 项」的唯一口径。
 *
 * <p>数的是「这个域页允许编辑的字段数」，不是当前渲染出的输入框数 —— 通用表单卡默认折叠
 * （ConfigDomainPanel 的 expanded=false），照 DOM 数会恒为 0；「可编辑」是能力，不是可见性。
 * 锁定（env / 管理员 / 只读 meta）与「实例专属键落到下层」都要扣掉，与 ConfigDomainPanel
 * 的 fieldReadonly / isLocked / isWritable 三个判据同源。</p>
 *
 * <p>专用面板没有统一 schema，按各自面板的字段级控件数固定折算（见注释）；连接管理页
 * （user llm-provider 的 ProviderHub）没有行内字段，记 0 —— 连接是「条目」不是「字段」，
 * 两种量纲不混。</p>
 */
const editableFieldCount = computed<number>(() => {
    const domain = props.domain;
    if (!domain || props.readonly) return 0;
    if (domain === "llm-provider") {
        // 实例层：provider 选择 / 默认模型 / 连接槽位 三个字段（LlmDefaultProfilePanel）。
        // 用户层：ProviderHub = 连接管理列表，没有行内字段。
        return props.layer === "instance" ? 3 : 0;
    }
    if (domain === "embedding") return 1; // 连接选择（EmbeddingSettingsPanel）
    if (domain === "agent-templates") return 7; // 名称/描述/prompt/工具模式/角色/provider/model
    if (domain === "api-request-templates") return 3; // 类型选择/名称/正文
    const meta = configStore.layerMeta[props.layer]?.[domain] ?? {};
    const envLocked = envLockedFor(domain);
    return (domainSchemas.value[domain] ?? []).filter((field) => {
        const item = meta[field.key];
        if (item?.locked || item?.adminLocked) return false;
        if (item && item.writable === false) return false;
        if (field.key in envLocked) return false;
        if (
            props.layer !== "instance" &&
            (field.instanceOnly === true || item?.overridable === false)
        ) {
            return false;
        }
        return true;
    }).length;
});
watchEffect(() => emit("editable-count", editableFieldCount.value));

/**
 * task-125（D-899，方案 B）：user-preference.language 是 settings store 的**薄皮肤** ——
 * 显示值取 settings.language（localStorage SSOT，PLAN-0602 唯一状态机），不进 CP payload。
 * CP config 里的同名键此后无写方（BL-573 的「假可操作性」由本改动关闭）。
 */
function entriesFor(domain: string): Record<string, string> {
    const entries = configStore.layerConfig[props.layer][domain] || {};
    if (domain !== "user-preference") return entries;
    return { ...entries, language: settings.language };
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
    await configStore.loadLayerDomains(props.layer);
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
    if (domain === "logging") {
        // task-170 / F-11：折叠态摘要不许转储裸 key:value（原先唯一可见内容就是 "level: INFO"）。
        const level = entries["logLevel"] || entries["levelAgent"];
        return level ? t("settings.logSummary", { level: levelLabel(level) }) : "";
    }
    if (domain === "agent-profile") {
        return entries["userName"] || "";
    }
    if (domain === "user-preference") {
        // task-169 / F-10：折叠态摘要行（原先用户偏好折叠后只剩域名 + 远距箭头）。
        // theme 是 CP config 值；language 取自 settings store（D-899 唯一状态机，不在 CP 里）。
        const THEME_LABEL_KEY: Record<string, string> = {
            light: "settings.light",
            dark: "settings.dark",
            system: "settings.system",
        };
        const theme = entries["theme"],
            themeLabel = theme && THEME_LABEL_KEY[theme] ? t(THEME_LABEL_KEY[theme]) : "";
        return [themeLabel, t(LANGUAGE_LABEL_KEY[settings.language])].filter(Boolean).join(" · ");
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

/**
 * API 请求模板面板的写入口（注入为 `submit`）：await 到真实 PUT 200 才 resolve，
 * 失败必须抛出——反馈（toast/内联错误）由面板自己给，所以本函数对
 * `api-request-templates` 域不弹 toast，也不吞异常。
 */
async function submitTemplates(entries: Record<string, string>) {
    await handleSave("api-request-templates", entries);
}

async function handleSave(domain: string, body: Record<string, string>) {
    // 这两个域的反馈由各自面板负责（agent-templates 一直如此，模板面板自 2026-11 起同样）。
    const panelOwnsFeedback = domain === "agent-templates" || domain === "api-request-templates";
    const jsonError = validateJsonFields(domain, body);
    if (jsonError) {
        if (panelOwnsFeedback) throw new Error(jsonError);
        toast.error(jsonError);
        return;
    }
    // task-125（D-899，方案 B）：user-preference.language 走 setLanguage（PLAN-0602 唯一
    // 状态机），从 CP payload 剥离 —— 双写必然漂移（启动只读 localStorage，CP 值是死水）。
    let payload = body;
    if (domain === "user-preference" && "language" in body) {
        const { language, ...rest } = body;
        if (language) settings.setLanguage(language as Language);
        payload = rest;
    }
    savingDomains.value[domain] = true;
    try {
        // 只剩 language 被剥离时可能为空 —— 空 PUT 有清库语义风险，跳过（语言已成功应用）。
        if (Object.keys(payload).length > 0) {
            await configStore.putLayerConfig(props.layer, domain, payload);
        }
        await reloadLayer();
        if (!panelOwnsFeedback) {
            toast.success(`${domainLabel(domain)} ${t("common.saved")}`);
        }
    } catch (e) {
        if (!panelOwnsFeedback) {
            toast.error(e instanceof Error ? e.message : `${t("settings.saveFailed")} ${domain}`);
        }
        if (panelOwnsFeedback) throw e;
    } finally {
        savingDomains.value[domain] = false;
    }
}

async function handleReset(domain: string, key: string) {
    try {
        // task-125：language 的重置 = 回默认语言（走同一状态机），不写 CP。
        if (domain === "user-preference" && key === "language") {
            settings.setLanguage(DEFAULT_LOCALE);
            await reloadLayer();
            toast.success(`${key} ${t("common.reset")}`);
            return;
        }
        if (props.layer === "instance") {
            await configStore.deleteInstanceKey(domain, key);
        } else {
            await configStore.putLayerConfig(props.layer, domain, { [key]: "" });
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
                    <h3 class="text-base font-semibold" data-testid="provider-hub-section-title">
                        {{ t("settings.providerPartitionTitle") }}
                    </h3>
                    <p class="text-xs text-muted-foreground">
                        {{
                            layer === "instance"
                                ? t("settings.providerPartitionDescInstance")
                                : t("settings.providerPartitionDesc")
                        }}
                    </p>
                </div>
                <div class="px-4 py-3 space-y-3">
                    <template v-if="layer === 'instance'">
                        <!-- PLAN-0764 T1.6（task-150）：实例层从引导块改为「默认偏好」编辑器；
                             连接仍留在个人/工作区层，实例只存 provider+connectionKey+model 整单元。 -->
                        <LlmDefaultProfilePanel :layer="layer" :readonly="readonly" />
                        <div class="flex flex-wrap gap-2">
                            <button
                                data-testid="provider-instance-go-user"
                                class="px-3 py-1 text-xs border rounded hover:bg-muted"
                                @click="emit('switch-layer', 'user')"
                            >
                                {{ t("settings.providerInstanceGoUser") }}
                            </button>
                        </div>
                    </template>
                    <ProviderHub v-else scope="USER" :readonly="readonly" />
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
                :readonly="readonly"
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
                :key="layer"
                :entries="configStore.layerConfig[layer][domain] || {}"
                :saving="savingDomains[domain] || false"
                :layer="layer"
                :readonly="readonly"
                :submit="submitTemplates"
                @save="handleSave(domain, $event)"
            />
            <ConfigSourceSummary
                domain="api-request-templates"
                :layer="layer"
                :meta="configStore.layerMeta[layer]['api-request-templates'] || {}"
            />
        </template>
        <!-- PLAN-0764 T1.5：实例层同样走专用面板（profile 单元）；旧通用表单的 model/dimensions
             两键不在 CP schema 里（validateEmbeddingLayer 只收 profile），是必 400 的错配。 -->
        <template v-else-if="domain === 'embedding'">
            <EmbeddingSettingsPanel
                :layer="layer"
                :saving="savingDomains[domain] || false"
                :readonly="readonly"
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
            :title="domainLabel(domain)"
            :entries="entriesFor(domain)"
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
