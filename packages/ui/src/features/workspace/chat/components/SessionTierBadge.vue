<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useSessionTierStore } from "../../../../stores/sessionTier";
import type { SessionTier } from "../../../../types";

/**
 * D-1908（DSD id=1448）一 · 继承来源徽标 —— 摘要行上唯一的状态读数。
 *
 * 三态 + 一个降级子态（互斥，不新增第四形态）：
 * - `source === "session"` ⇒ 「会话覆盖：X」
 * - `source === "workspace"` ⇒ 「继承中 · 工作区默认：X」
 * - `source === "none"` ⇒ 「继承中 · 工作区未设默认值」（实际回落最严 `view`，选择器那边给提示）
 * - 不可配置 ⇒ 「无权限修改：原因」（BL-311：徽标仍可见，不藏）
 *
 * 刻意只读 store、不发自己的请求：与选择器共享一次 `GET`（`load` 按 loaded 去重）。
 */
const props = defineProps<{ sessionId: string }>();

const { t } = useI18n();
const tierStore = useSessionTierStore();

const state = computed(() => tierStore.getState(props.sessionId));

watch(
    () => props.sessionId,
    (sessionId) => {
        if (sessionId) void tierStore.load(sessionId);
    },
    { immediate: true },
);

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

const tierLabel = computed(() => {
    const tier = state.value?.tier;
    return tier ? t(LABEL_KEYS[tier]) : null;
});

const text = computed<string | null>(() => {
    const current = state.value;
    if (!current?.loaded || !tierLabel.value) return null;
    if (!current.canConfigure) {
        const reasonKey = current.denyReason ? REASON_KEYS[current.denyReason] : undefined;
        return t("sessionSettings.tierNoPermission", {
            reason: reasonKey ? t(reasonKey) : t("workspace.viewerReadOnly"),
        });
    }
    if (current.source === "none") return t("sessionSettings.tierNoWorkspaceDefault");
    if (current.source === "session") {
        return t("sessionSettings.tierOverride", { tier: tierLabel.value });
    }
    return t("sessionSettings.tierInherited", { tier: tierLabel.value });
});
</script>

<template>
    <span
        v-if="text"
        data-testid="session-tier-badge"
        class="shrink-0"
        :title="tierLabel ?? undefined"
    >
        {{ text }}
    </span>
</template>
