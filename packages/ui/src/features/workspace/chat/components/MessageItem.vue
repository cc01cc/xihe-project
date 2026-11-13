<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AttachmentFile, Message } from "../../../../types";
import type { SessionParticipantRole, SessionParticipantView } from "../../../../types/participant";
import { participantDisplayName, participantInitials } from "../../components/participantInitials";
import { mappedErrorCopy } from "../../../../lib/errorMessages";
import { terminalMarkerOf } from "../runStateView";
import RunTerminalChip from "./RunTerminalChip.vue";
import TextPart from "./parts/TextPart.vue";
import ReasoningPart from "./parts/ReasoningPart.vue";
import ArtifactPart from "./parts/ArtifactPart.vue";
import CitationPart from "./parts/CitationPart.vue";
import ToolCallHost from "./ToolCallHost.vue";
import RunCheckpointMarker from "./RunCheckpointMarker.vue";
import VoiceOutput from "../../../../components/multimodal/VoiceOutput.vue";
import {
    Attachment,
    AttachmentActions,
    AttachmentAction,
    AttachmentContent,
    AttachmentDescription,
    AttachmentGroup,
    AttachmentMedia,
    AttachmentTitle,
    AttachmentTrigger,
} from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
    Download,
    Brain,
    LoaderCircle,
    Clock,
    Trash2,
    GitBranch,
    Shield,
    ChevronDown,
} from "@lucide/vue";
import { Message as MessageRoot, MessageContent, MessageHeader } from "@/components/ui/message";
import ProcessRow from "./ProcessRow.vue";
import AttachmentPreviewDialog from "./AttachmentPreviewDialog.vue";
import { actorOf } from "../actorView";
import type { ResolvedDelivery } from "../deliveryView";

const props = defineProps<{
    message: Message;
    isStreaming?: boolean;
    branchBusy?: boolean;
    /**
     * PLAN-0631 D31-09: the session participant CP attributed this message to, resolved by
     * the list from the roster. `undefined` = no attribution (history has none, BL-197)
     * and then **no** identity row is rendered — PRIMARY is never assumed.
     */
    responder?: SessionParticipantView;
    /**
     * PLAN-0659 T1.2：给**过程行**挂 actor 徽标。只在混主体线程为 true（单主体线程重复
     * 标注同一个人是噪音）；消息身份行不受此开关影响（它一直按服务端归因渲染）。
     */
    showActor?: boolean;
    /**
     * PLAN-0659 T1.3：消息头投递语义（发送/抄送/被 @），由列表按本地发送态 + 花名册
     * 解析成**显示名**后传入；`undefined` = 不渲染投递行。
     *
     * 限制（BL-239）：TO/CC 无持久载体，会话重载后丢失；@ 从正文 + 花名册重建仍在。
     */
    delivery?: ResolvedDelivery;
}>();
const { t } = useI18n();

/**
 * PLAN-0659 T1.2：该消息的产出主体。只从服务端归因派生（`responder`），没有归因就没有
 * actor —— 与身份行同一口径，不猜 PRIMARY。颜色中立，靠首字母 + 名字。
 */
const actorOfMessage = computed(() =>
    actorOf(props.responder, t("workspace.participantUnknownName")),
);
const actorForRows = computed(() => (props.showActor ? actorOfMessage.value : undefined));

/**
 * PLAN-0659 T1.3：抄送名单按 locale 连接（视图里不硬编码 "、" / ", "）。@ 已单独高亮，
 * 所以这里只承载「其余旁听者」，同一个人不会出现两次。
 */
const deliveryCcNames = computed(() =>
    (props.delivery?.cc ?? []).join(t("chat.delivery.listSeparator")),
);
/** PLAN-0665 M2：TO 变集合（一条消息可定向多个 agent），消息头显示 `发送→A · B`。 */
const deliveryToNames = computed(() =>
    (props.delivery?.to ?? []).join(t("chat.delivery.listSeparator")),
);

/**
 * PLAN-0572 / BL-555 G3：持久化快照被 CP 截断（ToolCallSnapshotService.MAX_CALLS）。
 * 只有显式 true 才算截断；缺失 = 未截断（或旧 CP 未投影），不渲染提示。
 */
const toolCallsTruncated = computed(() => props.message.toolCallsTruncated === true);

const emit = defineEmits<{
    approve: [id: string];
    reject: [id: string];
    delete: [id: string];
    retry: [id: string];
    branch: [id: string];
    revert: [sliceRef: string];
}>();

/**
 * PLAN-0572 / BL-555 G3：截断提示的展开态。
 *
 * 持久化快照最多 200 条（`ToolCallSnapshotService.MAX_CALLS`），更早的调用**不在**快照里，
 * 因此没有卡片可展开。展开体的作用是说明这一点并指向唯一可读的完整清单 —— run trace
 * （`GET /chat/runs/{runId}/trace`）；不把未持久化的调用伪装成卡片。
 */
const toolCallsExpanded = ref(false);

const isUser = computed(() => props.message.role === "user");
const isSystem = computed(() => props.message.role === "system");
const isMarker = computed(() => props.message.marker !== undefined);

/**
 * PLAN-0631 D31-09: alignment follows **ownership**, not `role`.
 *
 * A `speakAs` message is `role=user` but was not written by the caller, so it must not sit
 * on the right pretending to be "me". Ownership comes from the roster: a HUMAN row with
 * `selfOwned` is the caller (`types/participant.ts:44-49`); every other responder — other
 * humans and all agents — renders on the left with an identity row.
 */
const isOwnMessage = computed(() => {
    const responder = props.responder;
    if (responder) return responder.principalKind === "HUMAN" && responder.selfOwned === true;
    return isUser.value;
});
const showResponder = computed(() => Boolean(props.responder) && !isOwnMessage.value);
const responderName = computed(() =>
    props.responder
        ? participantDisplayName(props.responder.displayName, t("workspace.participantUnknownName"))
        : "",
);
const responderInitials = computed(() =>
    props.responder
        ? participantInitials(props.responder.displayName, t("workspace.participantUnknownName"))
        : "",
);

const ROLE_KEYS: Record<SessionParticipantRole, string> = {
    PRIMARY: "workspace.participantRolePrimary",
    MEMBER: "workspace.participantRoleMember",
    GUARD: "workspace.participantRoleGuardBuiltin",
};
const responderRoleLabel = computed(() =>
    props.responder ? t(ROLE_KEYS[props.responder.role]) : "",
);

const timestamp = computed(() => {
    const d = new Date(props.message.timestamp);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
});

const bubbleVariant = computed(() => {
    if (isOwnMessage.value) {
        return "default";
    }
    if (isSystem.value) {
        return "outline";
    }
    return "muted";
});

function getTextContent(): string {
    if (!props.message.parts || props.message.parts.length === 0) {
        return props.message.content;
    }
    const textParts = props.message.parts.filter((p) => p.type === "text");
    return textParts.map((p) => p.content).join("");
}

const statusIcon = computed(() => {
    switch (props.message.status) {
        case "thinking":
            return Brain;
        case "executing":
            return LoaderCircle;
        default:
            return Clock;
    }
});

/**
 * PLAN-0631 D31-07: the live status line is user-visible copy, so it must come from
 * i18n. It was hardcoded English ("Thinking..."/"Executing task...") while
 * `chat.thinking` already existed in both locales; `executing` reuses the existing
 * `chat.toolStatus.running` wording instead of inventing a fourth synonym.
 */
const markerLabel = computed(() =>
    props.message.status === "executing" ? t("chat.toolStatus.running") : t("chat.thinking"),
);

/**
 * PLAN-0631 D31-12: `isStreaming` alone must not create a Bubble.
 *
 * A tool-first run receives `tool_call` before any token, so the live assistant
 * message had no content yet and rendered an **empty bubble** above the tool card.
 * The live status line already covers the "nothing yet" window.
 */
const hasBubbleContent = computed(
    () => Boolean(props.message.content) || Boolean(props.message.parts?.length),
);

/**
 * PLAN-0631 D31-02 (M1-C) / BL-406: the two end states that left the transcript without any
 * visible conclusion. A `partial` or `cancelled` run keeps whatever it produced and then
 * just stops, so the message row used to read like a finished answer.
 *
 * Deliberately only these two:
 *  - `succeeded` stays silent (no news is good news, D31-02);
 *  - `failed` / `ambiguous` already have the error box + recovery banner (D31-02/05).
 *
 * The resolver (`terminalMarkerOf`) is shared with the collapsed run shell in `MessageList`,
 * so both surfaces mark exactly the same runs. Wording/colour live in `RunTerminalChip`
 * (`runStateLabelKey`, D31-01): no new status names and no new colour values.
 */
const terminalMarker = computed(() =>
    terminalMarkerOf(props.message.runStatus, props.message.terminalOutcome),
);

function isImage(type: string) {
    return type.startsWith("image/");
}

function downloadAttachment(url: string, name: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
}

function attachmentUrl(attachment: AttachmentFile): string {
    if (attachment.url) return attachment.url;
    if (attachment.fileId) return `/api/v1/files/${attachment.fileId}`;
    return "";
}

/**
 * PLAN-0683 (BL-381) T2.2: the attachment card opens the budgeted preview overlay.
 * Clicking the card is the only preview entry; it never loads the file eagerly.
 */
const previewAttachment = ref<AttachmentFile | null>(null);
const previewOpen = ref(false);

function openAttachmentPreview(attachment: AttachmentFile) {
    if (!attachmentUrl(attachment)) return;
    previewAttachment.value = attachment;
    previewOpen.value = true;
}

function handleImageError(event: Event) {
    const img = event.target as HTMLImageElement;
    img.style.display = "none";
}

function handleDelete() {
    emit("delete", props.message.id);
}

const canDelete = computed(() => !isMarker.value && props.message.role !== "system");
/**
 * PLAN-0631 D31-05: an `ambiguous` terminal must never offer a direct retry — the provider
 * may have applied the work, so re-running would duplicate side effects
 * (`spec/ui/interaction-model.md:57`). The guard is unconditional on purpose: a future wire
 * that sets `retryable:true` on an ambiguous outcome must not re-open the button.
 */
const canRetry = computed(() => {
    if (props.message.terminalOutcome === "ambiguous") return false;
    return Boolean(props.message.error && props.message.retryable);
});
const canCreateBranch = computed(
    () =>
        (props.message.role === "user" || props.message.role === "assistant") &&
        Boolean(props.message.runId) &&
        ["succeeded", "failed", "partial", "ambiguous", "cancelled"].includes(
            props.message.runStatus ?? "",
        ),
);

// PLAN-0492 T3.1: a budget-exhausted run carries RUN_BUDGET_EXHAUSTED with the
// exhausted dimension in errorDetail (`budgetDimension=<dim>`); surface a
// localized reason plus the takeover hint (resume by sending in the input).
const budgetExhaustedDimension = computed(() => {
    if (props.message.errorCode !== "RUN_BUDGET_EXHAUSTED") return null;
    return /(?:^|\s)budgetDimension=(\S+)/.exec(props.message.error ?? "")?.[1] ?? "";
});
const budgetExhaustedReason = computed(() => {
    if (budgetExhaustedDimension.value === null) return null;
    if (budgetExhaustedDimension.value === "turns") return t("chat.budgetExhaustedTurns");
    if (budgetExhaustedDimension.value === "elapsed") return t("chat.budgetExhaustedElapsed");
    if (budgetExhaustedDimension.value === "tokens") return t("chat.budgetExhaustedTokens");
    return t("chat.budgetExhaustedTurns");
});

// PLAN-0493 T3.1: a no-progress run carries RUN_NO_PROGRESS (tier-2 terminal,
// trigger fact = the code itself); surface a localized reason plus the same
// takeover hint (resume by sending in the input / Follow-up Queue).
const noProgressReason = computed(() =>
    props.message.errorCode === "RUN_NO_PROGRESS" ? t("chat.noProgressReason") : null,
);

/**
 * The visible headline of a failure that has no dedicated branch above.
 *
 * CP's `detail` is English operator text ("Provider temporarily unavailable"); it must not
 * be the user-facing sentence (DEV-011「不得直显 CP 英文 detail」). The stable code stays
 * visible so the user can quote it to support, the mapped/localized copy carries the
 * meaning, and the raw detail survives only as the hover title for diagnostics.
 */
const streamErrorCopy = computed(() => {
    const code = props.message.errorCode?.trim() ?? "";
    const copy = mappedErrorCopy(code) ?? t("chat.streamErrorGeneric");
    return code ? `${code}: ${copy}` : copy;
});

// PLAN-0750 / G8 (task-155): a submission refused because the Session has no active Agent
// principal binding carries the dedicated `AGENT_PRINCIPAL_MISSING` code. Branch to actionable
// guidance (bind one in Workspace settings → Agent management / ask a workspace admin) instead
// of the generic 403 line — the bare code keeps the message identifiable for support.
const principalMissingRefusal = computed(
    () => props.message.errorCode?.trim() === "AGENT_PRINCIPAL_MISSING",
);

/**
 * PLAN-0622 Resource Governor：`429 RESOURCE_EXHAUSTED` 不显示 CP 英文 detail，
 * 而是按 `resourceKind` + `retryAfterSeconds` 给本地化、可操作的说明。
 */
const resourceExhausted = computed(() => props.message.errorCode === "RESOURCE_EXHAUSTED");
const resourceKindLabel = computed(() => {
    const kind = props.message.resourceKind;
    if (!kind) return t("chat.resourceKindUnknown");
    // CP 的 resourceKind 是 SNAKE_CASE（FILE_WRITE），映射到 `chat.resourceKindFileWrite`。
    const pascal = kind
        .split("_")
        .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
        .join("");
    const key = `chat.resourceKind${pascal}`;
    const label = t(key);
    return label === key ? t("chat.resourceKindUnknown") : label;
});
const resourceExhaustedText = computed(() => {
    const seconds = props.message.retryAfterSeconds;
    if (typeof seconds === "number" && seconds > 0) {
        return t("chat.resourceExhausted", {
            kind: resourceKindLabel.value,
            seconds,
        });
    }
    return t("chat.resourceExhaustedNoWait", { kind: resourceKindLabel.value });
});

onUnmounted(() => {
    props.message.attachments?.forEach((attachment) => {
        if (attachment.url.startsWith("blob:")) {
            URL.revokeObjectURL(attachment.url);
        }
    });
});
</script>

<template>
    <!-- 2026-11-04：思考/执行状态与工具调用同一条单行过程行语言（无展开体）。 -->
    <ProcessRow
        v-if="isMarker"
        kind="thinking"
        :icon="statusIcon"
        :label="markerLabel"
        :class="message.status === 'executing' ? 'shimmer' : ''"
        testid="process-thinking"
        :actor="actorForRows"
        :expandable="false"
    />

    <MessageRoot
        v-else
        :align="isOwnMessage ? 'end' : 'start'"
        class="px-3 py-1"
        data-testid="message-item"
        :data-message-role="message.role"
    >
        <MessageContent class="max-w-[85%] min-w-0 md:max-w-[75%]">
            <!--
                PLAN-0659 T1.3：消息头投递语义 —— `发送→(A) · @被@者 · 抄送→(B,C)`。
                三态来源不同：TO/CC 是 composer 发送态本地视图（BL-239：无持久载体，刷新后
                丢失）；@ 从正文 + 花名册重建（仍在）。@ 是**高亮 chip**，不再重复出现在
                抄送名单里；只染色到 muted/foreground 层级（注意力预算：投递信息不是危险/主 CTA）。
            -->
            <div
                v-if="delivery"
                class="mb-0.5 flex flex-wrap items-center gap-1 px-0.5 text-xs text-muted-foreground"
                :class="isOwnMessage ? 'justify-end' : 'justify-start'"
                data-testid="message-delivery"
            >
                <span v-if="deliveryToNames" data-testid="message-delivery-to">{{
                    t("chat.delivery.to", { name: deliveryToNames })
                }}</span>
                <template v-if="delivery.mentions.length">
                    <span v-if="deliveryToNames" class="text-muted-foreground/60" aria-hidden="true"
                        >·</span
                    >
                    <span
                        v-for="name in delivery.mentions"
                        :key="`mention-${name}`"
                        class="rounded border border-border bg-muted/60 px-1 text-foreground"
                        data-testid="message-delivery-mention"
                        :title="t('chat.delivery.mentioned', { name })"
                        >@{{ name }}</span
                    >
                </template>
                <template v-if="delivery.cc.length">
                    <span
                        v-if="deliveryToNames || delivery.mentions.length"
                        class="text-muted-foreground/60"
                        aria-hidden="true"
                        >·</span
                    >
                    <span data-testid="message-delivery-cc">{{
                        t("chat.delivery.cc", { names: deliveryCcNames })
                    }}</span>
                </template>
            </div>
            <!--
                PLAN-0631 D31-09: identity row, reusing the shipped-but-unused MessageHeader.
                Only rendered for a **server-attributed** responder that is not the caller;
                no attribution ⇒ nothing (never PRIMARY).
            -->
            <MessageHeader
                v-if="showResponder"
                class="mb-0.5 gap-1 px-0.5"
                data-testid="message-responder"
                :data-participant-id="responder?.participantId"
            >
                <!--
                    2026-11-04 用户裁定（DSH 密度）：不再有独立头像列 —— 消息身份 = 16px 首字母
                    圆点 + 名称（多主体下靠圆点+名区分），中心线程保持无头像观感。
                -->
                <span
                    class="flex size-4 shrink-0 items-center justify-center rounded-full border bg-muted text-xs leading-none font-medium text-foreground"
                    data-testid="message-responder-initials"
                    :data-actor-principal-id="responder?.participantId"
                    :data-actor-kind="responder?.principalKind"
                    aria-hidden="true"
                    >{{ responderInitials }}</span
                >
                <span class="truncate text-foreground">{{ responderName }}</span>
                <span
                    class="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
                    data-testid="message-responder-role"
                    :data-session-role="responder?.role"
                >
                    <!-- Same discipline as ParticipantRow (D25): GUARD differs by icon, not color. -->
                    <Shield v-if="responder?.role === 'GUARD'" class="size-3" aria-hidden="true" />
                    {{ responderRoleLabel }}
                </span>
            </MessageHeader>
            <AttachmentGroup v-if="message.attachments?.length">
                <Attachment
                    v-for="attachment in message.attachments"
                    :key="attachment.fileId ?? attachment.id"
                    data-testid="message-attachment"
                    :class="isImage(attachment.type) ? 'w-32' : 'w-48'"
                >
                    <AttachmentMedia v-if="isImage(attachment.type)">
                        <img
                            :src="attachmentUrl(attachment)"
                            :alt="attachment.name"
                            loading="lazy"
                            decoding="async"
                            class="size-full object-cover"
                            @error="handleImageError"
                        />
                    </AttachmentMedia>
                    <AttachmentContent>
                        <AttachmentTitle>{{ attachment.name }}</AttachmentTitle>
                        <AttachmentDescription
                            >{{ (attachment.size / 1024).toFixed(1) }} KB</AttachmentDescription
                        >
                    </AttachmentContent>
                    <AttachmentActions>
                        <AttachmentAction
                            @click="downloadAttachment(attachmentUrl(attachment), attachment.name)"
                        >
                            <Download class="size-4" />
                        </AttachmentAction>
                    </AttachmentActions>
                    <!-- PLAN-0683 T2.2: whole card opens the budgeted preview; the download
                         action above stays on top (`z-20`) and never opens the overlay. -->
                    <AttachmentTrigger
                        v-if="attachmentUrl(attachment)"
                        :aria-label="t('files.previewOpen', { name: attachment.name })"
                        data-testid="message-attachment-preview-trigger"
                        @click="openAttachmentPreview(attachment)"
                    />
                </Attachment>
            </AttachmentGroup>

            <Bubble v-if="hasBubbleContent" :variant="bubbleVariant">
                <BubbleContent>
                    <template v-if="message.parts && message.parts.length > 0">
                        <template v-for="(part, idx) in message.parts" :key="idx">
                            <TextPart
                                v-if="part.type === 'text'"
                                :content="part.content"
                                :is-streaming="isStreaming && idx === message.parts.length - 1"
                            />
                            <ReasoningPart
                                v-if="part.type === 'reasoning'"
                                :content="part.content"
                                :actor="actorForRows"
                            />
                            <ArtifactPart v-if="part.type === 'artifact'" :part="part" />
                            <CitationPart v-if="part.type === 'citation'" :index="part.index" />
                        </template>
                    </template>
                    <p v-else-if="isUser" class="whitespace-pre-wrap text-sm">
                        {{ props.message.content }}
                    </p>
                    <p v-else class="text-sm">{{ props.message.content }}</p>
                </BubbleContent>
            </Bubble>

            <div
                v-if="message.error && message.role === 'assistant'"
                class="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
                data-testid="message-error"
            >
                <template v-if="budgetExhaustedReason">
                    <span
                        >{{ message.errorCode
                        }}<span v-if="budgetExhaustedDimension">
                            (budgetDimension={{ budgetExhaustedDimension }})</span
                        >: {{ budgetExhaustedReason }}</span
                    >
                    <span data-testid="message-budget-exhausted-hint" class="text-muted-foreground">
                        {{ t("chat.budgetExhaustedHint") }}
                    </span>
                </template>
                <template v-else-if="resourceExhausted">
                    <span data-testid="message-resource-exhausted">{{
                        resourceExhaustedText
                    }}</span>
                    <span
                        data-testid="message-resource-exhausted-hint"
                        class="text-muted-foreground"
                    >
                        {{ t("chat.resourceExhaustedHint") }}
                    </span>
                </template>
                <template v-else-if="noProgressReason">
                    <span>{{ message.errorCode }}: {{ noProgressReason }}</span>
                    <span data-testid="message-no-progress-hint" class="text-muted-foreground">
                        {{ t("chat.budgetExhaustedHint") }}
                    </span>
                </template>
                <template v-else-if="principalMissingRefusal">
                    <span data-testid="message-principal-missing"
                        >{{ message.errorCode }}: {{ t("chat.principalMissing") }}</span
                    >
                    <span
                        data-testid="message-principal-missing-hint"
                        class="text-muted-foreground"
                    >
                        {{ t("chat.principalMissingHint") }}
                    </span>
                </template>
                <template v-else>
                    <span :title="message.error">{{ streamErrorCopy }}</span>
                </template>
                <button
                    v-if="canRetry"
                    type="button"
                    class="font-medium underline underline-offset-2 hover:no-underline"
                    data-testid="message-retry-button"
                    @click="emit('retry', message.id)"
                >
                    {{ t("common.retry") }}
                </button>
            </div>

            <!--
                PLAN-0572 / BL-555 G3：持久化快照被 CP 截断时（ToolCallSnapshotService.MAX_CALLS）
                明示「可见 N / 共 M」，避免用户把截断列表当成全部调用。
                `toolCallsTotal` 缺失时回落到当前数组长度（不显示 0/0 这类假数字）。
            -->
            <div
                v-if="toolCallsTruncated"
                class="mt-1.5 rounded-md border border-border/60 bg-muted/20"
                data-testid="tool-calls-truncation-notice"
            >
                <button
                    type="button"
                    class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40"
                    :aria-expanded="toolCallsExpanded"
                    data-testid="tool-calls-truncation-toggle"
                    @click="toolCallsExpanded = !toolCallsExpanded"
                >
                    <span class="shrink-0 font-medium text-foreground">
                        {{ t("chat.toolCallsTruncationTitle") }}
                    </span>
                    <span class="min-w-0 flex-1 truncate">
                        {{
                            t("chat.toolCallsTruncationNotice", {
                                visible: message.toolCalls?.length ?? 0,
                                total: message.toolCallsTotal ?? message.toolCalls?.length ?? 0,
                            })
                        }}
                    </span>
                    <ChevronDown
                        class="size-3.5 shrink-0 transition-transform"
                        :class="toolCallsExpanded ? 'rotate-180' : ''"
                        aria-hidden="true"
                    />
                </button>
                <!--
                    展开体：说明「更早的调用未持久化、界面无法还原」，并指向 run trace
                    （唯一可读的完整清单）。不伪造卡片 —— 未持久化的调用没有可读数据。
                -->
                <div
                    v-if="toolCallsExpanded"
                    class="border-t border-border/60 px-2 py-1.5 text-xs text-muted-foreground"
                    data-testid="tool-calls-truncation-body"
                >
                    <p>{{ t("chat.toolCallsTruncationDetail") }}</p>
                    <p v-if="message.runId" class="mt-1">
                        {{ t("chat.toolCallsTruncationTraceHint") }}
                        <span class="font-mono text-foreground">{{ message.runId }}</span>
                    </p>
                </div>
            </div>

            <div v-if="message.toolCalls?.length" class="mt-1.5 w-full space-y-1">
                <ToolCallHost
                    v-for="tc in message.toolCalls"
                    :key="tc.id"
                    :tool-call="tc"
                    :actor="actorForRows"
                    @approve="emit('approve', $event)"
                    @reject="emit('reject', $event)"
                />
            </div>

            <!-- Workspace slice status and restore entry stay beside the message. -->
            <RunCheckpointMarker
                v-if="!isUser && !isSystem && message.runId"
                :run-id="message.runId"
                :session-id="message.sessionId"
                @revert="emit('revert', $event)"
            />

            <!--
                PLAN-0631 M1-C / BL-406: visible row-end conclusion for a run that stopped
                without being an error and without being a success. The chip is a shared
                component so the collapsed run shell in `MessageList` renders the same DOM
                (same testid/outcome/wording); hover-only meta stays hover-only.
            -->
            <RunTerminalChip
                v-if="terminalMarker"
                :outcome="terminalMarker"
                :class="isOwnMessage ? 'self-end' : 'self-start'"
            />

            <div
                class="invisible mt-0.5 flex items-center gap-2 opacity-0 transition-opacity group-hover/message:visible group-hover/message:opacity-100 group-focus-within/message:visible group-focus-within/message:opacity-100"
                :class="isUser ? 'justify-end' : 'justify-start'"
            >
                <span class="px-1 text-xs text-muted-foreground">{{ timestamp }}</span>
                <button
                    v-if="canDelete"
                    data-testid="message-delete-button"
                    class="p-1 rounded text-xs text-muted-foreground hover:text-destructive transition-colors"
                    :aria-label="'Delete message'"
                    @click="handleDelete"
                >
                    <Trash2 class="size-3" />
                </button>
                <button
                    v-if="canCreateBranch"
                    type="button"
                    data-testid="message-branch-button"
                    class="p-1 rounded text-xs text-muted-foreground hover:text-primary transition-colors"
                    :aria-label="t('chat.branchFromMessage')"
                    :disabled="branchBusy || isStreaming"
                    :aria-busy="branchBusy"
                    @click="emit('branch', message.id)"
                >
                    <GitBranch class="size-3" />
                </button>
                <VoiceOutput
                    v-if="!isUser && !isSystem"
                    :text="message.parts ? getTextContent() : message.content"
                />
            </div>
        </MessageContent>
        <AttachmentPreviewDialog
            v-if="previewAttachment"
            :open="previewOpen"
            :attachment="previewAttachment"
            :url="attachmentUrl(previewAttachment)"
            @update:open="previewOpen = $event"
        />
    </MessageRoot>
</template>
