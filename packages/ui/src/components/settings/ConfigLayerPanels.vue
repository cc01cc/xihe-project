<script setup lang="ts">
import { computed, onMounted, ref, watch, watchEffect } from "vue";
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
import { isEmbeddingWriteLayer } from "../../services/embeddingProfile";
import LlmDefaultProfilePanel from "./LlmDefaultProfilePanel.vue";
import ProviderHub from "./ProviderHub.vue";
import { logger } from "../../lib/logger";
import { getProviderInfo } from "../../types/provider";
import type { ProviderDefinition } from "../../types/providerConnection";
import { listProviderCatalog } from "../../services/providerConnectionService";
import { parseLlmProfileValue } from "../../services/llmProviderProfile";
import { DOMAIN_LABEL_KEY } from "../../lib/settingsIa";
import ContextModelOverrides from "./ContextModelOverrides.vue";
import {
    CONTEXT_POLICY_DOMAIN,
    DEFAULTS_KEY,
    DEFAULTS_PREFIX,
    MODELS_KEY,
    composeDefaults,
    defaultsLeaves,
    decomposeDefaults,
    parseObjectValue,
    valueToText,
} from "./contextPolicyForm";

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
        /**
         * task-227「合页不合域」：**只渲染列出的这几个域**（模型配置组页用，一页三段）。
         * 与 `domain` 的区别只是粒度：`domain` 是单段、`domains` 是多段，两者都不改变
         * 「每个域各自保存」的语义（保存仍按域 PUT，见 handleSave(domain)）。
         * **清单由调用方从 settingsIa 派生**，本组件不再写第二份域名单。
         */
        domains?: readonly ConfigDomain[];
    }>(),
    { readonly: false, domain: undefined, domains: undefined },
);

const emit = defineEmits<{
    // 只有 instance 层引导按钮会发出，目标只会是全局页的另一层（user）。
    // task-253：原来的 "go-workspace" 引导（跳 /workspace/:id/settings?tab=config）随工作区
    // 配置 tab 一起移除 —— 那个 tab 已经不存在了，留着按钮就是死链。
    "switch-layer": [layer: "instance" | "user"];
    /** task-157：当前域页的可编辑字段数（SettingsDomainView 的页头次量纲 M）。 */
    "editable-count": [count: number];
    /**
     * task-285：计数的**口径附注**。`editableFieldCount` 只数静态可枚举字段，而
     * `context-policy.models` 是行数随数据变化的子表 —— 光给 13 会让读者以为 13 就是全部。
     * 用第二个事件而不是把 count 改成对象：既有断言都断言在数字上，改形状会把别的域的读数
     * 一起打碎（additive 才不伤）。
     */
    "editable-count-note": [note: string];
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
 * task-31：实例层「被个人层覆盖」徽标的数据面。
 *
 * <p>面板（ConfigDomainPanel）只负责渲染，**拉取只在这里做一次**：当前查看者的 user 层
 * 与实例层同域同键都有行 ⇒ 实例默认值对这个用户不生效。为什么要自己拉：ConfigKeyMeta
 * 没有覆盖人字段（docs/api/openapi.yaml:3093-3094 的做法是「读 merged 生效值 + 用
 * layer=user 检测覆盖」），所以覆盖关系只能由 UI 比两份层数据得出。</p>
 *
 * <p>为什么失败时不画徽标：userEntries 为 undefined 表示「不知道」；把「不知道」画成
 * 「没有覆盖」正是本卡要修的缺陷类（用户改了用户层，实例页却看不出被覆盖）。</p>
 */
const userLayerLoaded = ref(false);
let userLayerInFlight: Promise<void> | null = null;

async function ensureUserLayerLoaded(): Promise<void> {
    if (userLayerLoaded.value) return;
    userLayerInFlight ??= configStore
        .loadLayerDomains("user")
        .then(
            () => {
                userLayerLoaded.value = true;
            },
            (e: unknown) => {
                logger.warn("user layer prefetch failed, override badges stay hidden", e);
            },
        )
        .finally(() => {
            userLayerInFlight = null;
        });
    await userLayerInFlight;
}

/** 只在实例层用得上：用户层自己看自己没有「被覆盖」可言。 */
function userEntriesFor(domain: ConfigDomain): Record<string, string> | undefined {
    if (props.layer !== "instance" || !userLayerLoaded.value) return undefined;
    return configStore.layerConfig.user[domain] ?? {};
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

/**
 * task-285：`context-policy` 的控件按 catalog 的 typed 叶子生成，**不再手写两个 JSON 框**。
 *
 * <p>用户原话：「压缩为什么用的是 JSON 呀？它不是就一个值就可以了吗？」——`defaults` 不是「一个值」，
 * 它是装了 13 个类型化键的包；**控件清单必须来自 `configSchemaCatalog`**（生成物，真源是 CP 的
 * `config-schemas/context-policy.json`），在这里手抄第二份就等于新造一个会漂的 SSOT。</p>
 *
 * <p>两处「为什么不是全都有范围校验」是**实测**不是取舍：`ConfigDomainPanel.numberRule` 的判据是
 * `Number.isInteger(num) && num >= 1 && num <= max`，所以 ①小数键（三个比例）套上去会恒红；
 * ②`keepRecentMessages` 的 CP 下界是 **0**，套上去会把合法的 0 判错。故只给「下界 ≥1 的整数键」
 * 加 `max`，其余交给 CP 校验（越界返回 400，UI 显示服务端错误）。</p>
 */
const CTX_POLICY_MAX: Record<string, number> = {
    agentsMdMaxBytes: 262144,
    envMaxBytes: 65536,
    maxInputTokens: 10000000,
    pruneWindowChars: 2000000,
    maxConsecutiveIneffective: 10,
    summaryTimeoutMs: 60000,
};

function ctxPolicySummaryProviderLabel(value: string): string {
    return value === "llm"
        ? t("settings.ctxSummaryProviderLlm")
        : t("settings.ctxSummaryProviderRule");
}

function ctxPolicyFields(): DomainField[] {
    return defaultsLeaves().map((leaf) => {
        const label = t(`settings.ctx.${leaf.key}`);
        const key = DEFAULTS_PREFIX + leaf.key;
        if (leaf.type === "boolean") return { key, label, type: "select", options: boolOptions };
        if (leaf.type === "enum") {
            return {
                key,
                label,
                type: "select",
                options: (leaf.enumValues ?? []).map((option) => ({
                    label: ctxPolicySummaryProviderLabel(option.value),
                    value: option.value,
                })),
            };
        }
        if (leaf.type === "integer" || leaf.type === "number") {
            const max = CTX_POLICY_MAX[leaf.key];
            // 布尔字段这里用 select + boolOptions：本文件既有布尔键（useRegistry / useSupervisor /
            // providerRequestFingerprintEnabled）都是这个形态，保持一致；不新引入 Switch 控件类型
            // 是为了不碰 ConfigDomainPanel 的渲染分支（task-286 正在改那一段，交界处已划死）。
            return max === undefined
                ? { key, label, type: "number" }
                : { key, label, type: "number", max };
        }
        return { key, label, type: "text" };
    });
}

const domainSchemas = computed<Record<string, DomainField[]>>(() => ({
    // PLAN-0523 T3.6 (决策 #13): llm-provider 不再有通用表单字段——默认身份
    // profile / 每模型 modelParams 均由「模型提供方」分区（ProviderHub）就地编辑；
    // 旧 imageProvider/三采样键随 schema 与迁移退役（imageProvider 键保留给冻结的图像块）。
    "llm-provider": [],
    // task-285：`defaults` 的 13 个类型化键逐个给控件；`models` 是按模型覆盖子表，
    // 由下方 <ContextModelOverrides> 渲染（**不在这里出现**，所以本域没有 json 字段了）。
    "context-policy": ctxPolicyFields(),
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

const visibleDomains = computed(() => {
    if (props.domains?.length) return [...props.domains];
    return props.domain ? [props.domain] : [...LAYER_DOMAINS[props.layer]];
});

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
    // 连接选择（EmbeddingSettingsPanel）。D-1122 / T2.4：embedding 已退出工作区层 ⇒
    // 那两层**没有**可编辑字段（面板根本不渲染，见下方分派守卫），不是"渲染了但禁用"。
    if (domain === "embedding") return isEmbeddingWriteLayer(props.layer) ? 1 : 0;
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
/**
 * 计数口径附注（见 emit 声明处）。只有「静态可枚举字段数 != 该域全部可编辑项」的域才给附注；
 * 行数从**当前层已加载的值**里数，所以保存后行数变化会跟着变 —— 不写死。
 */
const editableCountNote = computed<string>(() => {
    if (props.domain !== CONTEXT_POLICY_DOMAIN || props.readonly) return "";
    const entries = configStore.layerConfig[props.layer]?.[CONTEXT_POLICY_DOMAIN] || {};
    const rows = Object.keys(parseObjectValue(entries[MODELS_KEY])).length;
    return rows > 0
        ? t("settings.ia.domainEditableCountNote", { rows })
        : t("settings.ia.domainEditableCountNoteEmpty");
});
watchEffect(() => emit("editable-count", editableFieldCount.value));
watchEffect(() => emit("editable-count-note", editableCountNote.value));

/**
 * task-125（D-899，方案 B）：user-preference.language 是 settings store 的**薄皮肤** ——
 * 显示值取 settings.language（localStorage SSOT，PLAN-0602 唯一状态机），不进 CP payload。
 * CP config 里的同名键此后无写方（BL-573 的「假可操作性」由本改动关闭）。
 */
function entriesFor(domain: string): Record<string, string> {
    const entries = configStore.layerConfig[props.layer][domain] || {};
    // task-285：`defaults` 是一段 JSON 文本，面板按「一个 key 一个控件」渲染，
    // 所以这里把它摊成 `defaults.<leaf>` 的扁平行；写回时由 composeContextPolicyPayload 合回。
    if (domain === CONTEXT_POLICY_DOMAIN) {
        const out: Record<string, string> = {};
        for (const [leaf, text] of Object.entries(decomposeDefaults(entries[DEFAULTS_KEY]))) {
            out[DEFAULTS_PREFIX + leaf] = text;
        }
        return out;
    }
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
    if (props.layer === "instance") void ensureUserLayerLoaded();
});

// task-31：从别的层切到实例层时也要有覆盖数据（首次进入实例页由 onMounted 负责）。
watch(
    () => props.layer,
    (layer) => {
        if (layer === "instance") void ensureUserLayerLoaded();
    },
);

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

/**
 * task-285：把「逐字段草稿」合回 CP 认的两个键（`defaults` / `models` 的 JSON 文本）。
 *
 * <p>三条判据的落点：
 * ② **往返字节不变** —— 深度相等时 `composeDefaults` 返回 `null`，这里就不往 payload 里放该键
 *   （`handleSave` 对空 payload 直接跳过 PUT）。真正改动过才重排版。
 * ④ **未登记键不丢** —— 重组以**原始对象**为底，只覆盖/删除本表单认识的键。
 *</p>
 *
 * <p>为什么「不在 body 里的叶子 = 取消该键」是安全的：`ConfigDomainPanel.handleSave` 只过滤
 * 「空值 / 锁定 / 不可写 / 实例专属落到下层」四种；而 context-policy 的 CP meta 键是 `defaults`
 * 与 `models` 两个整键，**不存在** `defaults.<leaf>` 级别的锁定或不可写，所以叶子缺席只可能是
 * 「本来就没设 / 用户清空了」，两种都该等于删键。</p>
 */
function composeContextPolicyPayload(body: Record<string, string>): Record<string, string> {
    const entries = configStore.layerConfig[props.layer][CONTEXT_POLICY_DOMAIN] || {};
    const out: Record<string, string> = {};
    if (MODELS_KEY in body) out[MODELS_KEY] = body[MODELS_KEY];
    const drafts: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
        if (key.startsWith(DEFAULTS_PREFIX)) drafts[key.slice(DEFAULTS_PREFIX.length)] = value;
    }
    // 保存来自 models 子表时不要顺手重写 defaults（那会把「没动过」变成「动过」）。
    const defaultsTouched = !(MODELS_KEY in body) || Object.keys(drafts).length > 0;
    if (defaultsTouched) {
        for (const leaf of defaultsLeaves()) if (!(leaf.key in drafts)) drafts[leaf.key] = "";
        const text = composeDefaults(entries[DEFAULTS_KEY], drafts);
        if (text !== null) out[DEFAULTS_KEY] = text;
    }
    return out;
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
    if (domain === CONTEXT_POLICY_DOMAIN) payload = composeContextPolicyPayload(body);
    if (domain === "user-preference" && "language" in body) {
        const { language, ...rest } = body;
        if (language) settings.setLanguage(language as Language);
        payload = rest;
    }
    savingDomains.value[domain] = true;
    try {
        // task-285：`context-policy` 的逐字段表单在「什么都没改」时 payload 会是空对象
        // （`composeDefaults` 深度相等就返回 null ⇒ 不放 defaults；models 子表 unchanged 直接不 emit）。
        // 这种情况必须**静默返回**：既不发空 PUT（有清库语义风险），也不报「已保存」——
        // 报成功而实际一个请求都没发，就是把「跳过」伪装成「通过」。
        if (Object.keys(payload).length === 0 && domain !== "user-preference") return;
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
        // task-285：`defaults.<leaf>` 不是服务端的独立行，「重置」只能整键重写 —— 把该键从
        // `defaults` 对象里去掉后写回；去掉后对象为空且是实例层 ⇒ 直接删掉 `defaults` 整行，
        // 恢复「整域继承」，而不是把一个空对象钉在实例层。
        if (domain === CONTEXT_POLICY_DOMAIN && key.startsWith(DEFAULTS_PREFIX)) {
            const leaf = key.slice(DEFAULTS_PREFIX.length);
            const entries = configStore.layerConfig[props.layer][domain] || {};
            const obj = parseObjectValue(entries[DEFAULTS_KEY]);
            const drafts: Record<string, string> = {};
            for (const field of defaultsLeaves()) {
                drafts[field.key] = field.key === leaf ? "" : valueToText(obj[field.key]);
            }
            const text = composeDefaults(entries[DEFAULTS_KEY], drafts);
            if (text !== null) {
                const empty = Object.keys(parseObjectValue(text)).length === 0;
                if (props.layer === "instance" && empty) {
                    await configStore.deleteInstanceKey(domain, DEFAULTS_KEY);
                } else {
                    await configStore.putLayerConfig(props.layer, domain, { [DEFAULTS_KEY]: text });
                }
            }
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
    <!-- task-227：外层 `div` 只为**页内锚点**服务（`#settings-domain-<域>`），组页的分段导航
         直接跳到这一段；单域页也带同一个 id，所以同一套锚点两处都成立。`scroll-mt-14` 让跳转后
         段落不被粘性页头顶掉。 -->
    <div
        v-for="domain in visibleDomains"
        :key="domain"
        :id="'settings-domain-' + domain"
        class="scroll-mt-14"
    >
        <!-- PLAN-0523 T3.1: llm-provider 合并为单一「模型提供方」分区
             （spec/ui-surfaces.md S1/S3）；旧 ProfilePanel / 层全局参数表单
             退役（组件删除在 T3.6）。 -->
        <template v-if="domain === 'llm-provider'">
            <div class="border rounded-lg mb-2 overflow-hidden" data-testid="provider-partition">
                <div class="px-4 py-3 bg-muted/30 space-y-1">
                    <div class="text-xs font-medium tracking-wide text-muted-foreground">
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
             两键不在 CP schema 里（validateEmbeddingLayer 只收 profile），是必 400 的错配。
             D-1122 / T2.4：**工作区层不渲染这一块** —— 那里的 PUT 必得 400（域已退出工作区层），
             而卡级要求是「前端不画不该做的按钮」，不是「画了再禁用」。`isEmbeddingWriteLayer` 是
             同一条判据的机器形式（矩阵改回来时这里会自动恢复）。 -->
        <template v-else-if="domain === 'embedding' && isEmbeddingWriteLayer(layer)">
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
        <!-- D-1122 / T2.4 第二道保险：embedding 落到**非写层**（workspace / workspace-default）时
             整块不渲染 —— 既不挂 EmbeddingSettingsPanel，也**不许落回**下面的通用
             ConfigDomainPanel（那会画出 CP 必 400 的 model/dimensions 两键，正是 PLAN-0764 修掉的错配）。
             该域在这两层已退出矩阵 ⇒ 页面本就不可达；这一支是给「将来矩阵被改回 / 有人绕过路由直挂」
             留的机器判据，不是产品路径。 -->
        <template v-else-if="domain === 'embedding'" />
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
            :user-entries="userEntriesFor(domain)"
            @save="handleSave(domain, $event)"
            @reset="handleReset(domain, $event)"
        />
        <!-- task-285：`context-policy` 的第二个键（models）是「按模型覆盖」子表。
             它**不进** domainSchemas，所以该域页面上一个 json 字段都没有；未登记键由子表原样保留。 -->
        <ContextModelOverrides
            v-if="domain === 'context-policy'"
            :models-raw="(configStore.layerConfig[layer][domain] || {}).models || ''"
            :readonly="readonly"
            :saving="savingDomains[domain] || false"
            @save="handleSave(domain, $event)"
        />
    </div>
</template>
