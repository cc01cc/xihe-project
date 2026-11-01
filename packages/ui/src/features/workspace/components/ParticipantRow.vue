<script setup lang="ts">
/**
 * PLAN-0623：会话参与者行（dock `members` tab 的行渲染）。
 *
 * 只消费 M0 契约字段（`src/types/participant.ts` ↔ `openapi.yaml:3637`）：
 * - 首字母头像由 `displayName` 派生（全仓此前**没有** initials 助手，所以这里新建）；
 * - 有三枚徽标：主体类型、会话角色、（AGENT）来源；
 * - 两个策略指示：唤醒、回应；
 * - 未读/@我**只**来自服务端游标：`readCursor.mentionCount > 0` 才出现，缺失/为 0 不渲染
 *   —— 不用 0 冒充"无未读"。
 *
 * 模型意图（`defaultModelProvider/Name`）契约里还没有，行内暂不显示；等 M1a 联表补字段。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
    ParticipantRespondPolicy,
    ParticipantWakePolicy,
    SessionParticipantRole,
    SessionParticipantView,
} from "../../../types/participant";

const props = defineProps<{
    participant: SessionParticipantView;
    /** U2：`capabilities.manage` —— false 时移除/改策略在**点击前**就禁用（F-01 形状）。 */
    canManage: boolean;
    /** U2：`capabilities.mention` —— false 时 @ 入口禁用。 */
    canMention: boolean;
    /** 正在移除该行（请求在途），避免重复点击。 */
    removing?: boolean;
}>();

const emit = defineEmits<{ remove: [participant: SessionParticipantView] }>();

/** 破坏性操作走两次点击确认（与 0622 的禁用 Agent 同一形状），不做 alertdialog。 */
const confirmingRemove = ref(false);

function requestRemove(): void {
    if (!props.canManage || props.removing) return;
    if (!confirmingRemove.value) {
        confirmingRemove.value = true;
        return;
    }
    confirmingRemove.value = false;
    emit("remove", props.participant);
}

/** M1a：仅 AGENT 有模型意图；HUMAN 为 null（契约字段，不猜）。 */
const modelIntent = computed(() => {
    const provider = props.participant.defaultModelProvider,
        name = props.participant.defaultModelName;
    if (!provider && !name) return "";
    return `${provider ?? "—"} / ${name ?? "—"}`;
});

const { t } = useI18n();

/** 首字母头像：取 displayName 的前两个词首字母；缺名时退回 principalId 前两位（不上屏假名）。 */
const initials = computed(() => {
    const name = props.participant.displayName?.trim();
    if (name) {
        const words = name.split(/\s+/).filter(Boolean);
        const letters = words.slice(0, 2).map((word) => word[0] ?? "");
        return letters.join("").toUpperCase();
    }
    return props.participant.principalId.slice(0, 2).toUpperCase();
});

const displayName = computed(
    () => props.participant.displayName?.trim() || props.participant.principalId,
);

const kindLabel = computed(() =>
    t(
        props.participant.principalKind === "AGENT"
            ? "workspace.participantKindAgent"
            : "workspace.participantKindHuman",
    ),
);

const ROLE_KEYS: Record<SessionParticipantRole, string> = {
    PRIMARY: "workspace.participantRolePrimary",
    MEMBER: "workspace.participantRoleMember",
    GUARD: "workspace.participantRoleGuard",
};

const WAKE_KEYS: Record<ParticipantWakePolicy, string> = {
    ALL_MESSAGES: "workspace.participantWakeAllMessages",
    MENTION: "workspace.participantWakeMention",
};

const RESPOND_KEYS: Record<ParticipantRespondPolicy, string> = {
    ALWAYS: "workspace.participantRespondAlways",
    WHEN_MENTIONED: "workspace.participantRespondWhenMentioned",
    JUDGE: "workspace.participantRespondJudge",
    MUTED: "workspace.participantRespondMuted",
};

const roleLabel = computed(() => t(ROLE_KEYS[props.participant.role]));
const wakeLabel = computed(() => t(WAKE_KEYS[props.participant.wakePolicy]));
const respondLabel = computed(() => t(RESPOND_KEYS[props.participant.respondPolicy]));

const sourceLabel = computed(() => {
    const source = props.participant.source;
    if (!source) return "";
    return t(`workspace.agentSource${source[0].toUpperCase()}${source.slice(1)}`);
});

/** R7：服务端游标是唯一真相；缺失即为"未知"，不渲染徽标、不当成 0。 */
const mentionCount = computed(() => {
    const count = props.participant.readCursor?.mentionCount;
    return typeof count === "number" && count > 0 ? count : null;
});

const disabled = computed(() => Boolean(props.participant.disabledAt));
</script>

<template>
    <li
        class="flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs"
        :class="disabled ? 'opacity-60' : ''"
        :data-testid="`participant-row-${participant.participantId}`"
    >
        <span
            class="flex size-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium"
            :data-testid="`participant-initials-${participant.participantId}`"
            aria-hidden="true"
            >{{ initials }}</span
        >
        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
                <span class="truncate font-medium">{{ displayName }}</span>
                <span
                    v-if="mentionCount"
                    class="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground"
                    :data-testid="`participant-mention-badge-${participant.participantId}`"
                    :title="t('workspace.participantMentionBadge', { count: mentionCount })"
                    >@{{ mentionCount }}</span
                >
            </div>
            <p class="mt-1 flex flex-wrap items-center gap-1">
                <span
                    class="rounded border px-1.5 py-0.5 text-[10px]"
                    :data-testid="`participant-kind-badge-${participant.participantId}`"
                    :data-participant-kind="participant.principalKind"
                    >{{ kindLabel }}</span
                >
                <span
                    class="rounded border px-1.5 py-0.5 text-[10px]"
                    :data-testid="`participant-role-badge-${participant.participantId}`"
                    :data-session-role="participant.role"
                    >{{ roleLabel }}</span
                >
                <span
                    v-if="sourceLabel"
                    class="rounded border px-1.5 py-0.5 text-[10px]"
                    :data-testid="`participant-source-badge-${participant.participantId}`"
                    >{{ sourceLabel }}</span
                >
                <span
                    v-if="disabled"
                    class="rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] text-destructive"
                    :data-testid="`participant-disabled-badge-${participant.participantId}`"
                    >{{ t("workspace.participantDisabledBadge") }}</span
                >
            </p>
            <p class="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <span :data-testid="`participant-wake-indicator-${participant.participantId}`">
                    {{ t("workspace.participantWakeLabel") }}: {{ wakeLabel }}
                </span>
                <span :data-testid="`participant-respond-indicator-${participant.participantId}`">
                    {{ t("workspace.participantRespondLabel") }}: {{ respondLabel }}
                </span>
            </p>
            <!-- M1a：仅 AGENT 有模型意图（契约字段，缺失不猜）。 -->
            <p
                v-if="modelIntent"
                class="mt-1 text-[10px] text-muted-foreground"
                :data-testid="`participant-model-${participant.participantId}`"
            >
                {{ modelIntent }}
            </p>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-1">
            <!-- U2/F-01：无权限时**点击前**禁用，并给出原因，而不是点了才 403。 -->
            <button
                type="button"
                class="rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50"
                :data-testid="`participant-mention-${participant.participantId}`"
                :disabled="!canMention || disabled"
                :title="
                    canMention
                        ? t('workspace.participantMentionAction')
                        : t('workspace.participantMentionDenied')
                "
            >
                {{ t("workspace.participantMentionAction") }}
            </button>
            <button
                type="button"
                class="rounded border px-1.5 py-0.5 text-[10px] text-destructive disabled:opacity-50"
                :data-testid="`participant-remove-${participant.participantId}`"
                :disabled="
                    !canManage || disabled || removing === true || participant.role === 'PRIMARY'
                "
                :title="
                    canManage
                        ? t('workspace.participantRemoveAction')
                        : t('workspace.participantManageDenied')
                "
                @click="requestRemove"
            >
                {{
                    confirmingRemove
                        ? t("workspace.participantRemoveConfirm")
                        : t("workspace.participantRemoveAction")
                }}
            </button>
        </div>
    </li>
</template>
