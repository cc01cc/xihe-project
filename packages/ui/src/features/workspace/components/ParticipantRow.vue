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
import { computed, ref, watch } from "vue";
import { Shield } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { participantDisplayName, participantInitials } from "./participantInitials";
import type {
    ParticipantRespondPolicy,
    ParticipantWakePolicy,
    SessionParticipantRole,
    SessionParticipantView,
} from "../../../types/participant";

const props = withDefaults(
    defineProps<{
        participant: SessionParticipantView;
        /** U2：`capabilities.manage` —— false 时移除/改策略在**点击前**就禁用（F-01 形状）。 */
        canManage: boolean;
        /** U2：`capabilities.mention` —— false 时 @ 入口禁用。 */
        canMention: boolean;
        /**
         * BL-317：工作区写能力（`auth.canWriteWorkspace` 投影）。false（VIEWER）时
         * 「标记已读」在**点击前**禁用并给出只读原因 —— 否则点击必然 403 `WORKSPACE_READ_ONLY`。
         * 缺省 true：既有调用方/单测不传时行为不变。
         */
        canWrite?: boolean;
        /** 正在移除该行（请求在途），避免重复点击。 */
        removing?: boolean;
        /** 策略保存中（避免重复提交）。 */
        saving?: boolean;
        /** PLAN-0660 T5.6：本人已读游标推进中（避免重复提交）。 */
        advancing?: boolean;
        /**
         * BL-317b（IM 调研 §4「行密度」）：移动端默认只露 头像/名字、HUMAN/AGENT 徽标、
         * PRIMARY/MEMBER/GUARD、`@我 N`；策略/模型/移除收进**展开区**（`summary`）。
         * 缺省 `full` = 桌面既有行为，一行都不改。
         */
        density?: "full" | "summary";
    }>(),
    { canWrite: true, density: "full" },
);

/**
 * 展开态：`full` 恒展开；`summary` 由行内「更多」控制。
 * 切密度时重置（例如从桌面切到移动，别把上一轮展开态带过去）。
 */
const expanded = ref(props.density !== "summary");
watch(
    () => props.density,
    (density) => {
        expanded.value = density !== "summary";
    },
);
const showDetails = computed(() => props.density !== "summary" || expanded.value);

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
    /** PLAN-0660 T5.6：把**本人**的已读游标推进到服务端允许的最新位置（PATCH 由父级发出）。 */
    advanceCursor: [participant: SessionParticipantView];
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
    GUARD: "workspace.participantRoleGuardBuiltin",
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

/** R7：服务端游标是唯一真相；缺失即为"未知"，不渲染徽标、不当成 0。 */
const mentionCount = computed(() => {
    const count = props.participant.readCursor?.mentionCount;
    return typeof count === "number" && count > 0 ? count : null;
});

const disabled = computed(() => Boolean(props.participant.disabledAt));

/**
 * PLAN-0660 T5.6：「标记已读」只出现在**本人的那一行**。
 *
 * 身份判断沿用契约既有来源：CP 归约的 `selfOwned` + `principalKind`（`PATCH …/cursor` 只接受
 * HUMAN 且 `principal_id` 是调用者的行，其余 403 `CURSOR_SELF_ONLY`）。**不按角色名特判**——
 * PRIMARY/MEMBER/GUARD 说的是会话内职责，与"这个游标是不是我的"无关；也没有新增能力位：
 * 游标的所有权就是行自己的 `selfOwned`，再加一个 capability 只是把同一事实抄两份。
 * 停用行不显示：CP 侧游标虽还在，但替停用行做"已读"动作没有意义。
 */
const canAdvanceOwnCursor = computed(
    () =>
        props.participant.selfOwned === true &&
        props.participant.principalKind === "HUMAN" &&
        !disabled.value,
);

/**
 * BL-317：只读工作区（VIEWER）里「标记已读」在点击前禁用。
 * 判定源是既有写能力投影（`auth.canWriteWorkspace`），不是角色名特判 —— 与
 * `SessionPolicyControls` 对模式写入的做法同源；CP 的 403 `WORKSPACE_READ_ONLY` 不变。
 */
const readOnly = computed(() => props.canWrite === false);

/** 父级负责发 PATCH（与移除/改策略同一条路径），本组件只报告意图。 */
function requestAdvance(): void {
    if (!canAdvanceOwnCursor.value || readOnly.value || props.advancing) return;
    emit("advanceCursor", props.participant);
}
</script>

<template>
    <li
        class="flex items-start gap-2 rounded-md border px-2 py-1 text-xs"
        :class="disabled ? 'opacity-60' : ''"
        :data-testid="`participant-row-${participant.participantId}`"
    >
        <span
            class="flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium"
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
                    v-if="disabled"
                    class="rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] text-destructive"
                    :data-testid="`participant-disabled-badge-${participant.participantId}`"
                    >{{ t("workspace.participantDisabledBadge") }}</span
                >
            </p>
            <!-- 策略：只读文字 + （有 manage 时）可编辑下拉。**先渲染，保存成功后才改值**。 -->
            <template v-if="showDetails">
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
                    <span
                        :data-testid="`participant-respond-indicator-${participant.participantId}`"
                    >
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
                                ($event.target as HTMLSelectElement)
                                    .value as ParticipantRespondPolicy,
                            )
                        "
                    >
                        <option value="ALWAYS">
                            {{ t("workspace.participantRespondAlways") }}
                        </option>
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
            </template>
        </div>
        <!--
            BL-317b：摘要行只留「更多」；展开后才出现策略/模型/移除。
            `aria-expanded` + 44px 触控区，键盘可达。
        -->
        <button
            v-if="density === 'summary' && !expanded"
            type="button"
            class="shrink-0 rounded border px-2 py-1 text-[10px] text-muted-foreground max-md:min-h-[44px] max-md:min-w-[44px]"
            :data-testid="`participant-expand-${participant.participantId}`"
            :aria-expanded="expanded"
            :aria-label="t('workspace.participantMoreAction')"
            @click="expanded = true"
        >
            {{ t("workspace.participantMoreAction") }}
        </button>
        <div v-if="showDetails" class="flex shrink-0 flex-col items-end gap-1">
            <!--
                PLAN-0660 T5.6：本人行的已读推进。上限由 CP 夹取（advance-only + session max），
                这里不显示/不计算任何数字，成功后徽标直接由服务端返回的 mentionCount 派生。
            -->
            <button
                v-if="canAdvanceOwnCursor"
                type="button"
                class="rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50 max-md:min-h-[44px] max-md:min-w-[44px]"
                data-testid="participant-cursor-advance"
                :disabled="advancing === true || readOnly"
                :title="
                    readOnly
                        ? t('workspace.viewerReadOnly')
                        : t('workspace.participantCursorAdvanceHint')
                "
                @click="requestAdvance"
            >
                {{ t("workspace.participantCursorAdvance") }}
            </button>
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
