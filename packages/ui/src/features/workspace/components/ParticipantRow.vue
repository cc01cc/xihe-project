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
import { Shield } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { participantDisplayName, participantInitials } from "./participantInitials";
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
    /** 策略保存中（避免重复提交）。 */
    saving?: boolean;
}>();

function emitWake(wakePolicy: ParticipantWakePolicy): void {
    emit("policy", props.participant, { wakePolicy });
}

function emitRespond(respondPolicy: ParticipantRespondPolicy): void {
    emit("policy", props.participant, { respondPolicy });
}

const emit = defineEmits<{
    remove: [participant: SessionParticipantView];
    mention: [name: string];
    policy: [
        participant: SessionParticipantView,
        change: { wakePolicy?: ParticipantWakePolicy; respondPolicy?: ParticipantRespondPolicy },
    ];
}>();

/** 破坏性操作走两次点击确认（与 0622 的禁用 Agent 同一形状），不做 alertdialog。 */
const confirmingRemove = ref(false);

/** 提及：只把 `@displayName` 交给父级插入草稿 —— 面板**不发送**任何消息。 */
function requestMention(): void {
    // 没有真名就没法 `@`：不要把一个占位词插进草稿（那会变成真的"@未知用户"）。
    if (!props.canMention || !realName.value) return;
    emit("mention", realName.value);
}

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

/**
 * 首字母头像：取 displayName 的前两个词首字母；缺名时用「未知用户」的首字。
 * **不要**用 `principalId` 兜底：UUID 不是身份，是噪声。
 * PLAN-0631 D31-10：实现抽到 `participantInitials.ts`，与消息身份行共用同一份。
 */
const realName = computed(() => props.participant.displayName?.trim() ?? "");

/** 没有名字时用本地化占位，而不是把 UUID 摆给用户看。 */
const displayName = computed(() =>
    participantDisplayName(realName.value, t("workspace.participantUnknownName")),
);

const initials = computed(() =>
    participantInitials(realName.value, t("workspace.participantUnknownName")),
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
                    class="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]"
                    :data-testid="`participant-role-badge-${participant.participantId}`"
                    :data-session-role="participant.role"
                >
                    <!--
                        PLAN-0625 M3：GUARD 的区分度用 **icon 不用新色**（色彩系统不为徽标破例，
                        D25 纪律）；与 PRIMARY/MEMBER 同一徽标底色。
                    -->
                    <Shield v-if="participant.role === 'GUARD'" class="size-3" aria-hidden="true" />
                    {{ roleLabel }}
                </span>
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
            <!-- 策略：只读文字 + （有 manage 时）可编辑下拉。**先渲染，保存成功后才改值**。 -->
            <p class="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <span :data-testid="`participant-wake-indicator-${participant.participantId}`">
                    {{ t("workspace.participantWakeLabel") }}:
                </span>
                <select
                    v-if="canManage && participant.role !== 'PRIMARY'"
                    class="rounded border bg-background px-1 py-0.5 text-[10px] disabled:opacity-50"
                    :data-testid="`participant-wake-select-${participant.participantId}`"
                    :value="participant.wakePolicy"
                    :disabled="saving"
                    @change="
                        emitWake(
                            ($event.target as HTMLSelectElement).value as ParticipantWakePolicy,
                        )
                    "
                >
                    <option value="ALL_MESSAGES">
                        {{ t("workspace.participantWakeAllMessages") }}
                    </option>
                    <option value="MENTION">{{ t("workspace.participantWakeMention") }}</option>
                </select>
                <span v-else>{{ wakeLabel }}</span>
                <span :data-testid="`participant-respond-indicator-${participant.participantId}`">
                    {{ t("workspace.participantRespondLabel") }}:
                </span>
                <select
                    v-if="canManage && participant.role !== 'PRIMARY'"
                    class="rounded border bg-background px-1 py-0.5 text-[10px] disabled:opacity-50"
                    :data-testid="`participant-respond-select-${participant.participantId}`"
                    :value="participant.respondPolicy"
                    :disabled="saving"
                    @change="
                        emitRespond(
                            ($event.target as HTMLSelectElement).value as ParticipantRespondPolicy,
                        )
                    "
                >
                    <option value="ALWAYS">{{ t("workspace.participantRespondAlways") }}</option>
                    <option value="WHEN_MENTIONED">
                        {{ t("workspace.participantRespondWhenMentioned") }}
                    </option>
                    <option value="JUDGE">{{ t("workspace.participantRespondJudge") }}</option>
                    <option value="MUTED">{{ t("workspace.participantRespondMuted") }}</option>
                </select>
                <span v-else>{{ respondLabel }}</span>
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
                :disabled="!canMention || disabled || !realName"
                :title="
                    !realName
                        ? t('workspace.participantMentionNoName')
                        : canMention
                          ? t('workspace.participantMentionAction')
                          : t('workspace.participantMentionDenied')
                "
                @click="requestMention"
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
