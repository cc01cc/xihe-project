<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { usePolicyStore } from "../../../../stores/policy";
import { useAuthStore } from "../../../../stores/auth";
import { logger } from "../../../../lib/logger";
import type { SessionPolicyMode } from "../../../../types";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

const props = defineProps<{
    sessionId: string;
}>();

const { t } = useI18n();
const policyStore = usePolicyStore();
/**
 * BL-311：只读工作区（VIEWER）不该看见**可点的**写入口再吃 403 `WORKSPACE_READ_ONLY`。
 *
 * 判定源沿用既有投影，不新增能力位：`useAuthStore().canWriteWorkspace`
 * （`stores/auth.ts:96-98` = CP `WorkspaceView.canWrite`，旧响应回退 `workspaceRole !== "VIEWER"`）。
 * 同一来源已被 composer 发送（`ChatPanel.vue:1028`）、文件树写操作（`FileTreePanel.vue:218`）与
 * 审批操作（`ApprovalModal.vue:49`）使用 —— CP 仍是权威（守卫与 403/404 契约不变，BL-309），
 * 这里只决定"控件是否可操作"这个 affordance。
 */
const authStore = useAuthStore();
const readOnly = computed(() => !authStore.canWriteWorkspace);

const modeLabelKeys: Record<SessionPolicyMode, string> = {
    manual: "chat.approvalModeManual",
    auto: "chat.approvalModeAuto",
};
const policyModes = Object.keys(modeLabelKeys) as SessionPolicyMode[];

function isPolicyMode(value: string): value is SessionPolicyMode {
    return policyModes.includes(value as SessionPolicyMode);
}

const state = computed(() => policyStore.getState(props.sessionId)),
    mode = computed(() => state.value?.mode ?? null);
const modeLabel = computed(() =>
    mode.value ? t(modeLabelKeys[mode.value]) : t("chat.approvalModeUnavailable"),
);
const busy = computed(() => Boolean(state.value?.loading || state.value?.changing));
const lastRequestedMode = ref<SessionPolicyMode | null>(null);

// PLAN-0582 S4 / P0-4: never surface the raw `CODE: english detail` string from
// the API layer; the store keeps the diagnostic for logs and the UI shows an
// actionable, localized inline hint instead.
const errorMessage = computed(() => {
    if (!state.value?.error) return null;
    return state.value.loaded
        ? t("chat.approvalModeChangeFailed")
        : t("chat.approvalModeLoadFailed");
});

watch(
    () => props.sessionId,
    (sessionId) => {
        lastRequestedMode.value = null;
        if (sessionId) void policyStore.load(sessionId);
    },
    { immediate: true },
);

async function changeMode(nextMode: SessionPolicyMode) {
    const sessionId = props.sessionId;
    // BL-311：只读工作区不发写请求。模板已 `disabled`（真实浏览器不会派发激活事件），
    // 这层是防守：将来有人只改模板、忘了语义时，写仍然不会被发出去。
    if (!sessionId || busy.value || readOnly.value) return;
    lastRequestedMode.value = nextMode;
    try {
        const result = await policyStore.change(sessionId, nextMode);
        if (props.sessionId === sessionId) {
            toast.success(`${t("chat.approvalModeChanged")}: ${t(modeLabelKeys[result.mode])}`);
        }
    } catch (cause) {
        logger.warn("Session policy mode change failed", cause);
    }
}

function handleModeChange(value: string) {
    if (isPolicyMode(value)) void changeMode(value);
}

function retry() {
    const sessionId = props.sessionId;
    if (!sessionId) return;
    if (!state.value?.loaded) {
        void policyStore.load(sessionId);
        return;
    }
    if (lastRequestedMode.value) void changeMode(lastRequestedMode.value);
}
</script>

<template>
    <div class="min-w-0">
        <!--
            BL-311：只读工作区里**保留模式展示**（下拉仍显示当前值 = 状态可读），只是不可操作。
            用 disabled（而不是不渲染）是项目既有纪律 —— 无权限时**点击前**就给出不可用状态与原因，
            而不是让用户点了才收 403（同 `ParticipantRow` 的 U2/F-01 形状）。
        -->
        <Select
            :model-value="mode ?? ''"
            :disabled="!mode || busy || readOnly"
            @update:model-value="(value) => handleModeChange(String(value ?? ''))"
        >
            <SelectTrigger
                :id="`session-policy-mode-${sessionId}`"
                data-testid="session-policy-mode"
                class="w-full min-w-40 max-w-44 truncate rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                :aria-label="t('chat.approvalModeLabel')"
                :title="readOnly ? t('workspace.viewerReadOnly') : modeLabel"
            >
                <SelectValue :placeholder="t('chat.approvalModeUnavailable')" />
            </SelectTrigger>
            <SelectContent>
                <SelectItem v-for="policyMode in policyModes" :key="policyMode" :value="policyMode">
                    {{ t(modeLabelKeys[policyMode]) }}
                </SelectItem>
            </SelectContent>
        </Select>
        <!-- 只读原因的可见说明：只靠 `title` 会让禁用看起来像"坏了"。复用既有中英文案。 -->
        <p
            v-if="readOnly"
            data-testid="session-policy-mode-readonly"
            class="mt-1 line-clamp-2 text-xs text-muted-foreground"
        >
            {{ t("workspace.viewerReadOnly") }}
        </p>
        <p
            v-if="errorMessage"
            data-testid="session-policy-mode-error"
            class="mt-1 flex items-center gap-2 text-xs text-destructive"
            role="alert"
        >
            <span class="line-clamp-2 min-w-0 flex-1">{{ errorMessage }}</span>
            <button
                type="button"
                data-testid="session-policy-mode-retry"
                class="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-xs font-medium transition hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="retry"
            >
                {{ t("common.retry") }}
            </button>
        </p>
    </div>
</template>
