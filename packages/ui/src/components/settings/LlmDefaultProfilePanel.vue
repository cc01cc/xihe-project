<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { ApiError } from "../../composables/api";
import { mappedErrorCopy } from "../../lib/errorMessages";
import { logger } from "../../lib/logger";
import { parseLlmProfileValue } from "../../services/llmProviderProfile";
import { listApiInputTypes, listProviderCatalog } from "../../services/providerConnectionService";
import { useConfigStore, type ConfigLayer } from "../../stores/config";
import { getProviderInfo } from "../../types/provider";
import type { ProviderDefinition } from "../../types/providerConnection";

/**
 * PLAN-0764 T1.6（task-150）：实例层的 llm-provider「默认偏好」编辑器。
 *
 * 只写一个完整的 profile 单元（providerId + connectionKey + model，D-913③：不扩
 * ProviderScope）。task-152 定稿 resolver（llm/embedding 共用单 helper）：profile 整组
 * 按 workspace > workspace-default > user > instance 取第一组存在的配置，不做键级合并；连接归属提供该
 * profile 的那一层（workspace→WORKSPACE、user/instance→消费用户 USER，owner 规则而
 * 非优先序）；该层连接不可用时唯一末位兜底是共享 INSTANCE 连接，不跨层搜索；全无
 * 匹配 llm 返回 409 LLM_PROFILE_CONFLICT（不静默回落）。
 */
const props = withDefaults(
    defineProps<{
        layer: ConfigLayer;
        readonly?: boolean;
    }>(),
    { readonly: false },
);

const emit = defineEmits<{
    (e: "saved"): void;
}>();

const { t } = useI18n(),
    configStore = useConfigStore();

/**
 * task-14 / F-07：错误 toast 优先用 `problem.code` 的本地化文案（`LLM_PROFILE_CONFLICT`
 * 已有译文），绝不把 CP 的原始 problem 报文直出给用户。未映射的 code 回退本页通用失败句。
 */
function errorCopy(cause: unknown, fallbackKey: string): string {
    const code = cause instanceof ApiError ? cause.problem.code : undefined;
    return mappedErrorCopy(code) ?? t(fallbackKey);
}

/** 目录加载失败不阻塞编辑：提供方退化为「目录未加载」提示，模型/连接槽仍可手填。 */
const providers = ref<ProviderDefinition[]>([]);
const chatApiTypeIds = ref<string[]>([]);
const providerId = ref("");
const model = ref("");
const connectionKey = ref("default");
const loading = ref(true);
const localSaving = ref(false);

const CONNECTION_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const entries = computed(() => configStore.layerConfig[props.layer]?.["llm-provider"] ?? {});
const currentProfile = computed(() => parseLlmProfileValue(entries.value["profile"]));

function providerDisplayName(id: string): string {
    return (
        providers.value.find((provider) => provider.id === id)?.displayName ??
        getProviderInfo(id)?.name ??
        id
    );
}

/**
 * 支持 chat 的提供方：能力来自 `/api-input-types` 的 operation=chat（真仓
 * ProviderDefinition.supportedApiTypes 指向这些 apiTypeId）。mock 目录 fixture 省略
 * supportedApiTypes 时退回目录里的 supports.chat 线索（仅 mock lane 形状）。
 */
const chatProviders = computed(() => {
    const chatIds = new Set(chatApiTypeIds.value);
    return providers.value.filter((provider) => {
        const supported = provider.supportedApiTypes ?? [];
        if (supported.length > 0) return supported.some((type) => chatIds.has(type.apiTypeId));
        const mockSupports = (provider.supports as unknown as { chat?: boolean }).chat;
        return mockSupports !== false;
    });
});

/** 当前 profile 的 provider 可能已不在（目录变化）也会丢失选择 ⇒ 兜底补一行。 */
const providerOptions = computed(() => {
    const options = chatProviders.value.map((provider) => ({
        id: provider.id,
        label: provider.displayName || provider.id,
    }));
    if (providerId.value && !options.some((option) => option.id === providerId.value)) {
        options.push({ id: providerId.value, label: providerDisplayName(providerId.value) });
    }
    return options;
});

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].sort();
}

/** 连接槽建议：当前管理员自己可见连接的 connectionKey（输入提示，不展示连接列表）。 */
const connectionKeySuggestions = computed(() =>
    uniqueSorted(
        configStore.providerConnections
            .filter((connection) => connection.providerId === providerId.value)
            .map((connection) => connection.connectionKey),
    ),
);

/**
 * 模型建议：`/models` 返回的是按 connectionId 聚合的目录（不是 provider 参数查询），
 * 这里按 providerId 聚合 chat 模型名；没有就留空让用户手填（实例默认不要求本层有连接）。
 */
const modelSuggestions = computed(() => {
    if (!providerId.value) return [];
    const catalogs = configStore.modelCache?.providers ?? {};
    return uniqueSorted(
        Object.entries(catalogs)
            .filter(([key, catalog]) => (catalog.providerId ?? key) === providerId.value)
            .flatMap(([, catalog]) =>
                (catalog.models ?? [])
                    .filter((item) => item.capabilities?.chat)
                    .map((item) => item.name),
            ),
    );
});

/**
 * task-288：建议列表最多渲染 6 个可点项，其余折叠成「另有 N 个」。
 * 模型目录可能几十条，全铺开会把这一栏挤成半屏；**这是展示上限、不是数据裁剪** ——
 * 自由输入仍可填任意值，隐藏项不会造成不可达。
 */
const SUGGESTION_CHIP_LIMIT = 6;
const visibleModelSuggestions = computed(() =>
    modelSuggestions.value.slice(0, SUGGESTION_CHIP_LIMIT),
);
const hiddenModelSuggestionCount = computed(() =>
    Math.max(0, modelSuggestions.value.length - SUGGESTION_CHIP_LIMIT),
);
const visibleConnectionKeySuggestions = computed(() =>
    connectionKeySuggestions.value.slice(0, SUGGESTION_CHIP_LIMIT),
);
const hiddenConnectionKeySuggestionCount = computed(() =>
    Math.max(0, connectionKeySuggestions.value.length - SUGGESTION_CHIP_LIMIT),
);

/** 提供方目录整个没加载出来（判据③）：三个槽位都还能手填，但要一次说清。 */
const catalogUnavailable = computed(() => !loading.value && providers.value.length === 0);

const connectionKeyInvalid = computed(() => {
    const value = connectionKey.value.trim();
    return !CONNECTION_KEY_PATTERN.test(value) || value.length > 64;
});
const canSave = computed(
    () =>
        !props.readonly &&
        !loading.value &&
        !localSaving.value &&
        Boolean(providerId.value) &&
        Boolean(model.value.trim()) &&
        !connectionKeyInvalid.value,
);

async function load() {
    loading.value = true;
    try {
        const [catalog, inputTypes] = await Promise.all([
            listProviderCatalog().catch((cause: unknown) => {
                logger.warn("LLM provider catalog load failed", cause);
                return { catalogRevision: "", providers: [] };
            }),
            listApiInputTypes().catch((cause: unknown) => {
                logger.warn("API input types load failed", cause);
                return { types: [] };
            }),
        ]);
        providers.value = catalog.providers ?? [];
        chatApiTypeIds.value = (inputTypes.types ?? [])
            .filter((type) => type.operation === "chat")
            .map((type) => type.apiTypeId);
        await Promise.all([configStore.loadProviderConnections(), configStore.fetchModels()]);
        syncFromCurrentProfile();
    } finally {
        loading.value = false;
    }
}

/** 只把「当前生效的实例层 profile」灌回表单；用户编辑期间父组件刷新不会覆盖输入。 */
function syncFromCurrentProfile() {
    const profile = currentProfile.value;
    providerId.value = profile?.providerId ?? "";
    model.value = profile?.model ?? "";
    connectionKey.value = profile?.connectionKey ?? "default";
}

async function handleSave() {
    if (!canSave.value) return;
    localSaving.value = true;
    try {
        await configStore.putLayerConfig(props.layer, "llm-provider", {
            profile: JSON.stringify({
                providerId: providerId.value,
                connectionKey: connectionKey.value.trim(),
                model: model.value.trim(),
            }),
        });
        await configStore.loadLayerDomains(props.layer);
        syncFromCurrentProfile();
        toast.success(t("settings.llmInstanceSaved"));
        emit("saved");
    } catch (cause) {
        logger.warn("LLM instance default save failed", cause);
        toast.error(errorCopy(cause, "settings.llmInstanceSaveFailed"));
    } finally {
        localSaving.value = false;
    }
}

async function handleClear() {
    if (props.readonly) return;
    localSaving.value = true;
    try {
        // CP putLayer 的整单元清除语义：profile 空串 = 删除该层行，恢复继承
        // （ConfigService:731-735）。
        await configStore.putLayerConfig(props.layer, "llm-provider", { profile: "" });
        await configStore.loadLayerDomains(props.layer);
        syncFromCurrentProfile();
        toast.success(t("settings.llmInstanceCleared"));
        emit("saved");
    } catch (cause) {
        logger.warn("LLM instance default clear failed", cause);
        toast.error(errorCopy(cause, "settings.llmInstanceSaveFailed"));
    } finally {
        localSaving.value = false;
    }
}

onMounted(load);
</script>

<template>
    <div class="space-y-3" data-testid="llm-instance-default">
        <div class="space-y-1">
            <h4 class="text-sm font-semibold" data-testid="instance-default-title">
                {{ t("settings.llmInstanceDefaultTitle") }}
            </h4>
            <p class="text-xs text-muted-foreground">
                {{ t("settings.llmInstanceDefaultDesc") }}
            </p>
        </div>

        <div
            class="flex gap-2 items-start border-l-2 border-border pl-3 text-xs text-muted-foreground"
            data-testid="llm-instance-note"
        >
            <span aria-hidden="true">i</span>
            <span>{{ t("settings.providerInstanceNote") }}</span>
        </div>

        <div v-if="loading" class="text-sm text-muted-foreground">
            {{ t("common.loading") }}
        </div>
        <template v-else>
            <!--
                task-288 判据③：提供方目录整个没加载出来时（catalogProviders=[]），
                三个槽位其实都还能手填，但原来的提示只挂在提供方字段下面 ⇒ 用户以为整块坏了。
                这里在**三个字段之上**统一说一句，说明「都还能填、保存不受影响」。
            -->
            <p
                v-if="catalogUnavailable"
                class="text-xs text-muted-foreground"
                data-testid="llm-instance-catalog-unavailable"
            >
                {{ t("settings.llmInstanceCatalogUnavailable") }}
            </p>
            <div class="space-y-1">
                <label class="text-xs text-muted-foreground">
                    {{ t("settings.llmInstanceProviderLabel") }}
                </label>
                <Select
                    :model-value="providerId"
                    :disabled="readonly || localSaving"
                    @update:model-value="(value) => (providerId = String(value ?? ''))"
                >
                    <!--
                        task-288：原来这里是**手搓 trigger 类**（w-full border rounded px-2 py-1.5
                        text-sm bg-background disabled:opacity-60），逐项偏离 vendor 默认：
                        rounded(4px) vs rounded-lg、px-2 vs pl-2.5/pr-2、bg-background vs
                        bg-transparent、并自带 border 覆盖 border-input。⇒ 高度以外的计算样式
                        与全站 147 处 SelectTrigger 都不同，这一处不该有例外。
                        vendor 的 class 是**合并式覆盖**（cn() = tailwind-merge），所以只传布局
                        真正需要的 w-full（vendor 默认 w-fit，在表单列里要撑满）；圆角/内边距/
                        描边/底色一律回落 vendor 默认。
                    -->
                    <SelectTrigger data-testid="llm-instance-provider" class="w-full">
                        <SelectValue :placeholder="t('settings.llmInstanceProviderPlaceholder')" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem
                            v-for="option in providerOptions"
                            :key="option.id"
                            :value="option.id"
                        >
                            {{ option.label }}
                        </SelectItem>
                    </SelectContent>
                </Select>
                <p
                    v-if="providerOptions.length === 0"
                    class="text-xs text-muted-foreground"
                    data-testid="llm-instance-no-providers"
                >
                    {{ t("settings.llmInstanceNoProviders") }}
                </p>
            </div>

            <div class="space-y-1">
                <label class="text-xs text-muted-foreground">
                    {{ t("settings.llmInstanceModelLabel") }}
                </label>
                <input
                    v-model="model"
                    data-testid="llm-instance-model"
                    :disabled="readonly || localSaving"
                    :placeholder="t('settings.llmInstanceModelPlaceholder')"
                    class="w-full border rounded px-2 py-1.5 text-sm bg-background disabled:opacity-60"
                    autocomplete="off"
                />
                <!--
                    task-288：原方案是 `<datalist>` —— 它只在用户**开始输入时**由浏览器弹出，
                    没输入就完全看不见 ⇒ 用户看到的是一个裸文本框，以为「实例默认模型」根本没有
                    可选项（用户质问原话：「实例默认模型又是什么情况」）。
                    现在把建议**渲染出来**（可见、可点填），同时保留自由输入：目录外的模型名
                    照样能手填 —— 实例默认不要求本层有连接（见 modelSuggestions 的注释）。
                    用 vendor `Button` 而不是手搓 span：栈内已有组件优先，点击语义/禁用态/焦点环
                    直接继承 vendor 行为。
                -->
                <div
                    v-if="modelSuggestions.length > 0"
                    class="flex flex-wrap items-center gap-1"
                    data-testid="llm-instance-model-suggestions"
                >
                    <span class="text-xs text-muted-foreground">
                        {{ t("settings.llmInstanceSuggestionPick") }}
                    </span>
                    <Button
                        v-for="name in visibleModelSuggestions"
                        :key="name"
                        type="button"
                        size="xs"
                        variant="outline"
                        :disabled="readonly || localSaving"
                        :data-testid="`llm-instance-model-suggestion-${name}`"
                        @click="model = name"
                    >
                        {{ name }}
                    </Button>
                    <span
                        v-if="hiddenModelSuggestionCount > 0"
                        class="text-xs text-muted-foreground"
                        data-testid="llm-instance-model-suggestion-more"
                    >
                        {{
                            t("settings.llmInstanceSuggestionMore", {
                                count: hiddenModelSuggestionCount,
                            })
                        }}
                    </span>
                </div>
                <p
                    v-else
                    class="text-xs text-muted-foreground"
                    data-testid="llm-instance-model-no-catalog"
                >
                    {{ t("settings.llmInstanceModelNoCatalog") }}
                </p>
            </div>

            <div class="space-y-1">
                <label class="text-xs text-muted-foreground">
                    {{ t("settings.llmInstanceConnectionKeyLabel") }}
                </label>
                <input
                    v-model="connectionKey"
                    data-testid="llm-instance-connection-key"
                    :disabled="readonly || localSaving"
                    class="w-full border rounded px-2 py-1.5 text-sm bg-background disabled:opacity-60"
                    autocomplete="off"
                />
                <!-- task-288：同模型字段 —— datalist 不可见，改为可见可点填的建议行。 -->
                <div
                    v-if="connectionKeySuggestions.length > 0"
                    class="flex flex-wrap items-center gap-1"
                    data-testid="llm-instance-connection-key-suggestions"
                >
                    <span class="text-xs text-muted-foreground">
                        {{ t("settings.llmInstanceSuggestionPick") }}
                    </span>
                    <Button
                        v-for="key in visibleConnectionKeySuggestions"
                        :key="key"
                        type="button"
                        size="xs"
                        variant="outline"
                        :disabled="readonly || localSaving"
                        :data-testid="`llm-instance-connection-key-suggestion-${key}`"
                        @click="connectionKey = key"
                    >
                        {{ key }}
                    </Button>
                    <span
                        v-if="hiddenConnectionKeySuggestionCount > 0"
                        class="text-xs text-muted-foreground"
                        data-testid="llm-instance-connection-key-suggestion-more"
                    >
                        {{
                            t("settings.llmInstanceSuggestionMore", {
                                count: hiddenConnectionKeySuggestionCount,
                            })
                        }}
                    </span>
                </div>
                <p class="text-xs text-muted-foreground">
                    {{ t("settings.llmInstanceConnectionKeyHelp") }}
                </p>
                <p
                    v-if="connectionKeyInvalid"
                    class="text-xs text-red-600"
                    data-testid="llm-instance-connection-key-invalid"
                >
                    {{ t("settings.llmInstanceConnectionKeyInvalid") }}
                </p>
            </div>

            <p class="text-xs text-muted-foreground" data-testid="llm-instance-current">
                <template v-if="currentProfile">
                    {{
                        t("settings.llmInstanceCurrent", {
                            provider: providerDisplayName(currentProfile.providerId),
                            model: currentProfile.model,
                            key: currentProfile.connectionKey,
                        })
                    }}
                </template>
                <template v-else>{{ t("settings.llmInstanceUnset") }}</template>
            </p>

            <div class="flex flex-wrap gap-2">
                <button
                    v-if="!readonly"
                    data-testid="llm-instance-save"
                    class="px-3 py-1.5 text-sm border rounded hover:bg-muted disabled:opacity-50"
                    :disabled="!canSave"
                    @click="handleSave"
                >
                    {{ t("common.save") }}
                </button>
                <button
                    v-if="!readonly"
                    data-testid="llm-instance-clear"
                    class="px-3 py-1.5 text-sm border rounded hover:bg-muted disabled:opacity-50"
                    :disabled="localSaving || !currentProfile"
                    @click="handleClear"
                >
                    {{ t("settings.llmInstanceClear") }}
                </button>
            </div>
        </template>
    </div>
</template>
