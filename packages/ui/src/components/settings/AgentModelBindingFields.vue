<script setup lang="ts">
/**
 * task-401 / `D-1248`：智能体**模型意图**三段（provider＞连接＞模型）+ 白名单开关。
 *
 * <p>为什么抽成组件：创建与编辑两个弹窗都要它（两个真消费方，不是预想复用）。控件全部用栈内
 * vendor（`Select` / `Checkbox`），中性色 —— 低频可逆动作不上强调色（注意力预算 L2）。</p>
 *
 * <p>数据复用既有状态：`configStore.providerConnections` + `modelCache.providers`（`GET /models`
 * 按 connectionId 聚合），不建第二份连接/目录状态。连接**只用于挑模型**，不上 wire —— 契约原文
 * 「the principal never holds a provider connection」；模型身份在 UI 侧是 connectionId+modelId，
 * 落到载荷是 provider+model。</p>
 *
 * <p>级联用**显式 change 处理**而不是 watch：编辑弹窗要按存量意图预填三段，watch 会把预填当成
 * 「用户换了提供方」而清空连接与模型（预填即自毁）。整个草稿是一个 `modelValue` 单元，
 * 与 `llm-provider` profile「整组读写、不做键级合并」同形。</p>
 */
import { computed, onMounted, ref } from "vue";
import type { AcceptableValue } from "reka-ui";
import { useI18n } from "vue-i18n";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { logger } from "../../lib/logger";
import { useConfigStore } from "../../stores/config";
import { chatModelNamesOf, listProviderCatalog } from "../../services/providerConnectionService";
import { getProviderInfo } from "../../types/provider";
import type { ProviderDefinition } from "../../types/providerConnection";

export interface AgentModelBindingDraft {
    provider: string;
    connectionId: string;
    model: string;
    restrict: boolean;
}

const props = withDefaults(
    defineProps<{
        modelValue: AgentModelBindingDraft;
        /**
         * 存量模型意图（编辑面预填）。provider+model 能映射到某条可见 chat 连接的目录时
         * 才预填三段；映射不到就留空（UI 另显示「当前：…」），不猜一条连接塞给用户。
         */
        intent?: { provider: string; model: string } | null;
        /** 测试 id 前缀：创建与编辑两个弹窗同屏装配，必须可区分。 */
        fieldPrefix?: string;
        hintPrefix?: string;
        disabled?: boolean;
    }>(),
    {
        fieldPrefix: "instance-agents-form",
        hintPrefix: "instance-agents-model",
        disabled: false,
    },
);

const emit = defineEmits<{ "update:modelValue": [value: AgentModelBindingDraft] }>();

const { t } = useI18n();
const configStore = useConfigStore();
const providerDefs = ref<ProviderDefinition[]>([]);
const loading = ref(false);

const chatConnections = computed(() =>
    configStore.providerConnections.filter((item) => item.operation === "chat" && item.enabled),
);
const providerOptions = computed(() =>
    [...new Set(chatConnections.value.map((item) => item.providerId))].map((id) => ({
        id,
        label:
            providerDefs.value.find((item) => item.id === id)?.displayName ??
            getProviderInfo(id)?.name ??
            id,
    })),
);
const connectionOptions = computed(() =>
    chatConnections.value.filter((item) => item.providerId === props.modelValue.provider),
);
const selectedConnection = computed(
    () => chatConnections.value.find((item) => item.id === props.modelValue.connectionId) ?? null,
);
const modelOptions = computed(() =>
    selectedConnection.value
        ? chatModelNamesOf(selectedConnection.value, configStore.modelCache.providers)
        : [],
);
const unavailable = computed(
    () => configStore.providerConnectionsError || Boolean(configStore.modelError),
);
/** 半组选择不是合法载荷：要么三个都空（沿用平台默认），要么三个都有。 */
const incomplete = computed(() => {
    const picked = [
        props.modelValue.provider,
        props.modelValue.connectionId,
        props.modelValue.model,
    ].filter(Boolean);
    return picked.length === 1 || picked.length === 2;
});

function patchDraft(part: Partial<AgentModelBindingDraft>): void {
    emit("update:modelValue", { ...props.modelValue, ...part });
}

function onProvider(value: AcceptableValue): void {
    const provider = typeof value === "string" ? value : "";
    patchDraft({ provider, connectionId: "", model: "", restrict: false });
}

function onConnection(value: AcceptableValue): void {
    const connectionId = typeof value === "string" ? value : "";
    const connection = chatConnections.value.find((item) => item.id === connectionId) ?? null;
    const models = connection ? chatModelNamesOf(connection, configStore.modelCache.providers) : [];
    patchDraft({ connectionId, model: models[0] ?? "" });
}

async function loadOptions(): Promise<void> {
    loading.value = true;
    try {
        // 目录失败不阻塞：提供方名退化为 id，连接与模型目录仍可用（两个 store loader 自吞错误）。
        const catalog = listProviderCatalog()
            .then((response) => response.providers ?? [])
            .catch((cause: unknown) => {
                logger.warn("Provider catalog load failed", cause);
                return [] as ProviderDefinition[];
            });
        const [defs] = await Promise.all([
            catalog,
            configStore.loadProviderConnections(),
            configStore.fetchModels(),
        ]);
        providerDefs.value = defs;
    } finally {
        loading.value = false;
    }
}

onMounted(async () => {
    await loadOptions();
    const intent = props.intent;
    if (!intent?.provider || !intent.model) return;
    // 已有草稿就不覆盖（用户可能已经动过手）。
    if (props.modelValue.provider || props.modelValue.model) return;
    const match = chatConnections.value.find(
        (item) =>
            item.providerId === intent.provider &&
            chatModelNamesOf(item, configStore.modelCache.providers).includes(intent.model),
    );
    if (!match) return;
    emit("update:modelValue", {
        provider: intent.provider,
        connectionId: match.id,
        model: intent.model,
        restrict: props.modelValue.restrict,
    });
});
</script>

<template>
    <div
        class="space-y-2 rounded-md border border-border p-3"
        :data-testid="`${fieldPrefix}-model`"
    >
        <div class="space-y-1">
            <Label>{{ t("settings.instanceResources.agents.fieldModel") }}</Label>
            <p class="text-xs text-muted-foreground">
                {{ t("settings.instanceResources.agents.modelHint") }}
            </p>
        </div>
        <div class="grid gap-2 sm:grid-cols-3">
            <div class="space-y-1">
                <Label class="text-xs" :for="`${fieldPrefix}-provider`">
                    {{ t("settings.instanceResources.agents.modelProviderLabel") }}
                </Label>
                <Select
                    :model-value="modelValue.provider"
                    :disabled="disabled || loading || providerOptions.length === 0"
                    @update:model-value="onProvider"
                >
                    <SelectTrigger
                        :id="`${fieldPrefix}-provider`"
                        class="w-full"
                        :data-testid="`${fieldPrefix}-provider`"
                    >
                        <SelectValue
                            :placeholder="t('settings.instanceResources.agents.modelProviderLabel')"
                        />
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
            </div>
            <div class="space-y-1">
                <Label class="text-xs" :for="`${fieldPrefix}-connection`">
                    {{ t("settings.instanceResources.agents.modelConnectionLabel") }}
                </Label>
                <Select
                    :model-value="modelValue.connectionId"
                    :disabled="disabled || loading || !modelValue.provider"
                    @update:model-value="onConnection"
                >
                    <SelectTrigger
                        :id="`${fieldPrefix}-connection`"
                        class="w-full"
                        :data-testid="`${fieldPrefix}-connection`"
                    >
                        <SelectValue
                            :placeholder="
                                t('settings.instanceResources.agents.modelConnectionLabel')
                            "
                        />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem
                            v-for="option in connectionOptions"
                            :key="option.id"
                            :value="option.id"
                        >
                            {{ option.label }}
                        </SelectItem>
                    </SelectContent>
                </Select>
            </div>
            <div class="space-y-1">
                <Label class="text-xs" :for="`${fieldPrefix}-model`">
                    {{ t("settings.instanceResources.agents.modelNameLabel") }}
                </Label>
                <Select
                    :model-value="modelValue.model"
                    :disabled="disabled || loading || !modelValue.connectionId"
                    @update:model-value="
                        (value: AcceptableValue) =>
                            patchDraft({ model: typeof value === 'string' ? value : '' })
                    "
                >
                    <SelectTrigger
                        :id="`${fieldPrefix}-model`"
                        class="w-full"
                        :data-testid="`${fieldPrefix}-model-name`"
                    >
                        <SelectValue
                            :placeholder="t('settings.instanceResources.agents.modelNameLabel')"
                        />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem v-for="name in modelOptions" :key="name" :value="name">
                            {{ name }}
                        </SelectItem>
                    </SelectContent>
                </Select>
            </div>
        </div>
        <p
            v-if="!loading && chatConnections.length === 0"
            class="text-xs text-muted-foreground"
            :data-testid="`${hintPrefix}-no-connections`"
        >
            {{ t("settings.instanceResources.agents.modelNoConnections") }}
        </p>
        <p
            v-if="unavailable"
            class="text-xs text-muted-foreground"
            :data-testid="`${hintPrefix}-load-failed`"
        >
            {{ t("settings.instanceResources.agents.modelLoadFailed") }}
        </p>
        <p
            v-if="incomplete"
            class="text-xs text-destructive"
            :data-testid="`${hintPrefix}-incomplete`"
        >
            {{ t("settings.instanceResources.agents.modelIncomplete") }}
        </p>
        <label v-if="modelValue.model" class="flex items-center gap-2 text-xs">
            <Checkbox
                :model-value="modelValue.restrict"
                :disabled="disabled"
                :data-testid="`${fieldPrefix}-restrict`"
                @update:model-value="
                    (value: boolean | 'indeterminate') => patchDraft({ restrict: value === true })
                "
            />
            {{ t("settings.instanceResources.agents.modelRestrict") }}
        </label>
    </div>
</template>
