<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { logger } from "../../../../lib/logger";
import { useSessionTierStore } from "../../../../stores/sessionTier";
import { useAuthStore } from "../../../../stores/auth";
import type { SessionTier } from "../../../../types";

/**
 * D-1908（DSD id=1448）二 · 三档选择器 —— 取代原「审批模式」独立下拉。
 *
 * 三条不可退让的 UI 语义（都由先发测试 `chat/__tests__/sessionTierControls.spec.ts` 钉住）：
 *
 * 1. **越层禁选**（D-1908 三）：`available` 由后端按工作区执行方式给出，不在其中的档位
 *    `disabled`，并给**常显**说明（不只 tooltip）。强行触发 `update:modelValue` 也不发请求。
 * 2. **无权限可见 + 禁用 + 原因**（BL-311）：缺 `session:permission:configure` 或非 owner
 *    时选择器不隐藏，只禁用；原因用可见文本，不靠 `title`。
 * 3. **失败回滚**（D-1908 七）：不做乐观更新 ⇒ 失败时模型值仍是服务端旧值，错误文案走
 *    `presentCauseError` 的可读 copy（不含错误码与英文 detail）。
 *
 * 落点在 dock 的 `SessionContextPanel`（桌面端摘要行不承载选择器，见
 * `SessionSettingsPanel.vue` 的移动端说明）。
 */
const props = defineProps<{ sessionId: string }>();

const { t } = useI18n();
const tierStore = useSessionTierStore();
const authStore = useAuthStore();

const state = computed(() => tierStore.getState(props.sessionId));

watch(
    () => props.sessionId,
    (sessionId) => {
        if (sessionId) void tierStore.load(sessionId);
    },
    { immediate: true },
);

const TIERS: readonly SessionTier[] = ["view", "workspace", "full"];
const LABEL_KEYS: Record<SessionTier, string> = {
    view: "sessionSettings.tierView",
    workspace: "sessionSettings.tierWorkspace",
    full: "sessionSettings.tierFull",
};
const REASON_KEYS: Record<string, string> = {
    viewer: "sessionSettings.tierReasonViewer",
    "not-owner": "sessionSettings.tierReasonNotOwner",
    "no-atom": "sessionSettings.tierReasonNoAtom",
};

const tier = computed<SessionTier | null>(() => state.value?.tier ?? null);
const available = computed<readonly SessionTier[]>(() => state.value?.available ?? TIERS);
const unsupported = computed<SessionTier[]>(() =>
    TIERS.filter((option) => !available.value.includes(option)),
);
/**
 * 只读判定：CP 的 `canConfigure` 是权威，`canWriteWorkspace` 是本仓既有的 affordance 投影
 * （与 composer 发送守卫、文件树写操作同源，BL-311）—— 两者取严，宁可不给点也不吃 403。
 */
const readOnly = computed(() => !state.value?.canConfigure || !authStore.canWriteWorkspace);
const selectDisabled = computed(
    () => !state.value?.loaded || readOnly.value || Boolean(state.value?.changing),
);
const readonlyText = computed(() => {
    const current = state.value;
    if (!current || !readOnly.value) return null;
    const reasonKey = current.denyReason ? REASON_KEYS[current.denyReason] : undefined;
    return t("sessionSettings.tierNoPermission", {
        reason: reasonKey ? t(reasonKey) : t("workspace.viewerReadOnly"),
    });
});
const triggerLabel = computed(() => (tier.value ? t(LABEL_KEYS[tier.value]) : null));
const errorMessage = computed(() => state.value?.error ?? null);

async function handleChange(value: unknown): Promise<void> {
    const next = value as SessionTier | undefined;
    const current = state.value;
    // 防守（真实浏览器点不到禁选项，这里挡的是程序化 emit 与将来的模板改动）：
    // 无权限 / 越层 / 正在改 / 点的是当前档 ⇒ 不发请求，也不动值。
    if (!next || !current || !current.canConfigure || current.changing) return;
    if (!available.value.includes(next) || next === current.tier) return;
    try {
        await tierStore.change(props.sessionId, next);
    } catch (cause) {
        // store 已把可读文案写进 state.error，并在 logger 留痕；这里只吞掉拒绝，避免未处理异常。
        logger.warn("Session tier change rejected", cause);
    }
}
</script>

<template>
    <div class="min-w-0">
        <Select
            :model-value="tier ?? undefined"
            :disabled="selectDisabled"
            @update:model-value="handleChange"
        >
            <SelectTrigger
                :id="`session-tier-select-${sessionId}`"
                data-testid="session-tier-select"
                class="w-full min-w-40 max-w-44 truncate rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                :aria-label="t('sessionSettings.tierLabel')"
                :title="readonlyText ?? triggerLabel ?? t('sessionSettings.tierLabel')"
            >
                <SelectValue :placeholder="t('sessionSettings.tierLabel')" />
            </SelectTrigger>
            <SelectContent>
                <SelectItem
                    v-for="option in TIERS"
                    :key="option"
                    :value="option"
                    :disabled="!available.includes(option)"
                    :title="
                        available.includes(option)
                            ? undefined
                            : t('sessionSettings.tierUnsupported', { tier: t(LABEL_KEYS[option]) })
                    "
                >
                    {{ t(LABEL_KEYS[option]) }}
                </SelectItem>
            </SelectContent>
        </Select>
        <p
            v-if="readonlyText"
            data-testid="session-tier-readonly"
            class="mt-1 line-clamp-2 text-xs text-muted-foreground"
        >
            {{ readonlyText }}
        </p>
        <!-- 常显说明：禁选项为什么点不了，不该靠悬停才知道（D-1908 三）。 -->
        <p
            v-if="unsupported.length"
            data-testid="session-tier-unsupported"
            class="mt-1 line-clamp-2 text-xs text-muted-foreground"
        >
            {{ t("sessionSettings.tierUnsupportedHint") }}
        </p>
        <!-- 无工作区默认值 ⇒ 回落最严档，且必须说出来（不静默降级，D-1908 一）。 -->
        <p
            v-if="state?.source === 'none' && state?.loaded"
            data-testid="session-tier-fallback"
            class="mt-1 line-clamp-2 text-xs text-amber-800 dark:text-amber-300"
        >
            {{ t("sessionSettings.tierNoWorkspaceDefault") }}
        </p>
        <p
            v-if="errorMessage"
            data-testid="session-tier-error"
            class="mt-1 line-clamp-2 text-xs text-destructive"
            role="alert"
        >
            {{ errorMessage }}
        </p>
    </div>
</template>
