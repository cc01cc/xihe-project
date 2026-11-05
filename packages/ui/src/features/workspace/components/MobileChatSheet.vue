<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Sheet from "../../../components/ui/sheet/Sheet.vue";
import SheetContent from "../../../components/ui/sheet/SheetContent.vue";
import SheetHeader from "../../../components/ui/sheet/SheetHeader.vue";
import SheetTitle from "../../../components/ui/sheet/SheetTitle.vue";
import SheetDescription from "../../../components/ui/sheet/SheetDescription.vue";
import ChatPanel from "../chat/components/ChatPanel.vue";
import MobileMembersSheet from "./MobileMembersSheet.vue";
import { MessageCircle } from "@lucide/vue";
import { useAgentStore } from "../../../stores/agent";
import { useSessionStore } from "../../../stores/session";
import { useSessionParticipantsStore } from "../stores/sessionParticipants";

const props = defineProps<{
    sessionId: string;
}>();

const agentStore = useAgentStore(),
    sessionStore = useSessionStore(),
    membersStore = useSessionParticipantsStore();
const { t } = useI18n();
const open = ref(false);
/** BL-317b：独立的成员 sheet 开关（关闭后焦点由 `MobileMembersSheet` 还给触发按钮）。 */
const membersOpen = ref(false);
const memberRows = computed(() => membersStore.participants ?? []);
const memberCount = computed(() => memberRows.value.length);
const memberMentionTotal = computed(() =>
    memberRows.value.reduce((sum, row) => sum + (row.readCursor?.mentionCount ?? 0), 0),
);
const memberAvatarInitials = computed(() =>
    memberRows.value
        .slice(0, 3)
        .map((row) => (row.displayName ?? "").trim().slice(0, 1).toUpperCase() || "?"),
);
const membersEntryLabel = computed(() =>
    memberMentionTotal.value > 0
        ? t("workspace.membersEntryLabelWithMentions", {
              count: memberCount.value,
              mentions: memberMentionTotal.value,
          })
        : t("workspace.membersEntryLabel", { count: memberCount.value }),
);
watch(
    () => props.sessionId,
    (id) => {
        if (id) void membersStore.ensureLoaded(id);
    },
    { immediate: true },
);
const agentPrincipalId = computed(
    () =>
        sessionStore.sessions.find((session) => session.id === props.sessionId)?.agentPrincipalId ??
        null,
);

/**
 * PLAN-0342 审查修复: mirror ChatPanel's session-scoped filter. A pending
 * approval from another session must not disable this sheet's outside-click
 * dismissal — the approval modal only renders for this sheet's session.
 */
const approvalPending = computed(() =>
    agentStore.agentState.pendingApprovals.some(
        (approval) =>
            approval.sessionId === props.sessionId &&
            (approval.state === undefined ||
                approval.state === "pending" ||
                approval.state === "dispatch_unknown"),
    ),
);

function toggle() {
    open.value = !open.value;
}

/**
 * PLAN-0342 decision #14: while an approval is pending the sheet must not be
 * dismissed by the approval modal's pointer-down. reka treats the teleported
 * modal as "outside" and would otherwise close the sheet, unmounting the
 * ChatPanel (and the modal) between mousedown and mouseup so the click never
 * fires — the approval could never be submitted on mobile.
 */
function onPointerDownOutside(event: Event) {
    if (approvalPending.value) event.preventDefault();
}

defineExpose({ toggle });
</script>

<template>
    <div class="md:hidden">
        <button
            class="fixed bottom-4 right-4 z-30 size-12 rounded-full bg-action text-action-foreground shadow-lg flex items-center justify-center"
            title="Chat"
            aria-label="Open chat"
            @click="toggle"
        >
            <MessageCircle class="size-5" aria-hidden="true" />
        </button>
        <Sheet :open="open" @update:open="(v) => (open = v)">
            <SheetContent
                side="bottom"
                class="h-[75vh] p-0 gap-0"
                data-testid="mobile-chat-sheet"
                @pointer-down-outside="onPointerDownOutside"
            >
                <SheetHeader class="px-4 pt-3 pb-2 text-left border-b">
                    <div class="flex min-w-0 items-center gap-2">
                        <SheetTitle>对话</SheetTitle>
                        <!--
                            BL-317b（IM 调研 §1）：移动端会话标题区就是这份 sheet 的头 —— 成员入口
                            放在这里（头像堆叠 + 人数 + 聚合 @N），而不是隐藏的桌面会话列。
                            溢出菜单入口保留作兜底（BL-317）。
                        -->
                        <button
                            type="button"
                            class="flex min-h-[44px] min-w-[44px] items-center gap-1.5 rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
                            data-testid="members-entry-mobile"
                            :aria-label="membersEntryLabel"
                            :title="membersEntryLabel"
                            aria-haspopup="dialog"
                            :aria-expanded="membersOpen"
                            @click="membersOpen = true"
                        >
                            <span class="flex -space-x-1.5" aria-hidden="true">
                                <span
                                    v-for="(initial, index) in memberAvatarInitials"
                                    :key="`avatar-${index}`"
                                    data-testid="members-entry-avatar"
                                    class="flex size-5 items-center justify-center rounded-full border bg-muted text-[10px] font-medium text-foreground/70"
                                    >{{ initial }}</span
                                >
                            </span>
                            <span
                                v-if="memberCount > 0"
                                class="tabular-nums"
                                data-testid="members-entry-count"
                                >{{ memberCount }}</span
                            >
                            <span
                                v-if="memberMentionTotal > 0"
                                class="rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground"
                                data-testid="members-entry-mentions"
                                >@{{ memberMentionTotal }}</span
                            >
                        </button>
                        <span
                            data-testid="mobile-session-agent"
                            class="max-w-44 truncate rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            :title="agentPrincipalId ?? t('workspace.agentUnbound')"
                        >
                            {{
                                agentPrincipalId
                                    ? `${t("workspace.activeAgent")} · ${agentPrincipalId.slice(0, 8)}`
                                    : t("workspace.agentUnbound")
                            }}
                        </span>
                    </div>
                    <SheetDescription
                        >在当前 workspace 中与 Agent 对话。工具绑定当前
                        workspace。</SheetDescription
                    >
                </SheetHeader>
                <!-- BL-317b：独立成员 sheet（覆盖式），正文复用 SessionParticipantsPanel。 -->
                <MobileMembersSheet
                    :open="membersOpen"
                    :session-id="sessionId"
                    @close="membersOpen = false"
                />
                <div class="flex-1 min-h-0 flex flex-col">
                    <!-- PLAN-0626 M2: mobile has no dock, so the session settings keep
                         expanding in place inside this sheet. -->
                    <ChatPanel
                        v-if="open"
                        :session-id="sessionId"
                        tool-mode="workspace"
                        :is-mobile="true"
                    />
                </div>
            </SheetContent>
        </Sheet>
    </div>
</template>
