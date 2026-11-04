<script setup lang="ts">
import { ref, computed, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { Message, SessionRunSummary } from "../../../../types";
import type { SessionParticipantView } from "../../../../types/participant";
import { useSessionParticipantsStore } from "../../stores/sessionParticipants";
import MessageItem from "./MessageItem.vue";
import MessageSearch from "./MessageSearch.vue";
import RunGroupHeader from "./RunGroupHeader.vue";
import { hasMultipleActors } from "../actorView";
import { resolveDelivery, type ResolvedDelivery } from "../deliveryView";
import { Search } from "@lucide/vue";
import { Marker } from "@/components/ui/marker";
import {
    MessageScroller,
    MessageScrollerProvider,
    MessageScrollerViewport,
    MessageScrollerContent,
    MessageScrollerItem,
    MessageScrollerButton,
} from "@/components/ui/message-scroller";

const props = defineProps<{
    messages: Message[];
    branchBusy?: boolean;
    /**
     * PLAN-0659 T1.1：该 session 的 run 摘要（`GET /chat/sessions/{id}/runs`），用于 run 头的
     * 状态/耗时。缺省时只用 message 自带的 `runStatus/terminalOutcome`，仍然能分组。
     */
    runs?: SessionRunSummary[];
}>();

/**
 * PLAN-0631 D31-08/09: the message identity row is driven by the **server** attribution
 * (`Message.participantId`, stamped from the SSE envelope), resolved against the session's
 * participant roster that the composer already loads (`ensureLoaded`). A message without
 * attribution resolves to `undefined` and renders **no** identity row — the rosters is the
 * only lookup, PRIMARY is never assumed.
 */
const participantsStore = useSessionParticipantsStore();
const { t } = useI18n();
const responderById = computed(() => {
    const byId = new Map<string, SessionParticipantView>();
    for (const row of participantsStore.participants ?? []) byId.set(row.participantId, row);
    return byId;
});
function responderFor(message: Message): SessionParticipantView | undefined {
    return message.participantId ? responderById.value.get(message.participantId) : undefined;
}

/**
 * PLAN-0659 T1.3：消息头投递语义投影（显示名）。TO/CC 来自 composer 本地发送态
 * （`Message.delivery`，BL-239：无持久载体）；@ 从正文 + 花名册重建。没有任何一态 ⇒ 不渲染。
 */
const roster = computed(() => participantsStore.participants ?? []);
function deliveryOf(message: Message): ResolvedDelivery | undefined {
    return resolveDelivery({
        delivery: message.delivery,
        content: message.content,
        role: message.role,
        roster: roster.value,
        unknownNameLabel: t("workspace.participantUnknownName"),
    });
}

const emit = defineEmits<{
    approve: [id: string];
    reject: [id: string];
    delete: [id: string];
    retry: [id: string];
    branch: [id: string];
    revert: [sliceRef: string];
}>();

const showSearch = ref(false),
    searchQuery = ref("");

const filteredMessages = computed(() => {
    if (!searchQuery.value) {
        return props.messages;
    }

    const q = searchQuery.value.toLowerCase();
    return props.messages.filter((msg) => msg.content.toLowerCase().includes(q));
});

watch(searchQuery, async () => {
    await nextTick();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const viewport = document.querySelector<HTMLElement>(
        '[data-testid="message-scroller-viewport"]',
    );
    if (viewport) viewport.scrollTop = 0;
});

type Entry = { type: "message"; msg: Message } | { type: "date"; date: string; id: string };

const entries = computed<Entry[]>(() => {
    const result: Entry[] = [];
    let lastDate = "";

    for (const msg of filteredMessages.value) {
        const parsedDate = new Date(msg.timestamp);
        const date = Number.isNaN(parsedDate.getTime()) ? "" : parsedDate.toLocaleDateString();
        if (date && date !== lastDate) {
            result.push({ type: "date", date, id: `date-${date}` });
            lastDate = date;
        }
        result.push({ type: "message", msg });
    }

    return result;
});

/**
 * PLAN-0659 T1.1：按 `runId` 把消息切成相邻段（消息本身即时间序；同一 run 的思考/命令/工具行
 * 都挂在它的 assistant 消息里，所以分组只需切消息）。**run 数 ≤1 时不分组**（design 反证：
 * 单 run 不增噪音，现有观感不变）。
 */
const runsById = computed(() => {
    const map = new Map<string, SessionRunSummary>();
    for (const run of props.runs ?? []) map.set(run.runId, run);
    return map;
});

function runStatusOf(runId: string, groupMessages: Message[]): string | undefined {
    const summary = runsById.value.get(runId);
    if (summary) return summary.status;
    return groupMessages.find((message) => message.runStatus)?.runStatus ?? undefined;
}

function runOutcomeOf(runId: string, groupMessages: Message[]): string | undefined {
    const summary = runsById.value.get(runId);
    if (summary?.terminalOutcome) return summary.terminalOutcome;
    return groupMessages.find((message) => message.terminalOutcome)?.terminalOutcome ?? undefined;
}

/** 失败/取消默认折叠成只剩 run 头（用户只需要知道失败，不需要重看过程）。 */
function defaultCollapsed(runId: string, groupMessages: Message[]): boolean {
    const status = runStatusOf(runId, groupMessages);
    if (status === "failed" || status === "cancelled") return true;
    const outcome = runOutcomeOf(runId, groupMessages);
    return outcome === "error" || outcome === "cancelled";
}

/** 用户手动切换的折叠覆盖（组件内 Map，不落 localStorage；跨会话切换自然失效）。 */
const collapsedOverrides = ref(new Map<string, boolean>());

function isCollapsed(runId: string, groupMessages: Message[]): boolean {
    return collapsedOverrides.value.get(runId) ?? defaultCollapsed(runId, groupMessages);
}

function toggleRun(runId: string, groupMessages: Message[]): void {
    const next = new Map(collapsedOverrides.value);
    next.set(runId, !isCollapsed(runId, groupMessages));
    collapsedOverrides.value = next;
}

function principalNameOf(groupMessages: Message[]): string | undefined {
    const attributed = groupMessages.find((message) => message.participantId);
    if (!attributed) return undefined;
    const responder = responderFor(attributed);
    return responder?.displayName ?? undefined;
}

/**
 * PLAN-0659 T1.2：线程是否混主体（≥2 个不同产出者）。只有混主体线程才给过程行挂 actor
 * 徽标 —— 单主体线程里每行重复同一身份是噪音（与「单 run 不分组」同一反证口径）。
 */
const multiActor = computed(() => hasMultipleActors(props.messages));

interface RunHeaderModel {
    runId: string;
    status?: string | null;
    terminalOutcome?: string | null;
    createdAt?: string | null;
    terminalAt?: string | null;
    principalName?: string;
    collapsed: boolean;
}

type Row =
    | { type: "date"; date: string; id: string; key: string }
    | { type: "header"; header: RunHeaderModel; groupMessages: Message[]; key: string }
    | { type: "message"; msg: Message; indented: boolean; key: string };

const rows = computed<Row[]>(() => {
    // 分段（相邻同 runId 归一组；日期分隔符跟随当前组）。
    const groups: Array<{ runId?: string; entries: Entry[] }> = [];
    for (const entry of entries.value) {
        if (entry.type === "date") {
            const last = groups[groups.length - 1];
            if (last) last.entries.push(entry);
            else groups.push({ runId: undefined, entries: [entry] });
            continue;
        }
        const runId = entry.msg.runId;
        const last = groups[groups.length - 1];
        if (last && last.runId === runId) last.entries.push(entry);
        else groups.push({ runId, entries: [entry] });
    }

    const distinctRuns = new Set(groups.map((group) => group.runId).filter(Boolean));
    const groupingEnabled = distinctRuns.size >= 2;

    const result: Row[] = [];
    for (const group of groups) {
        const groupMessages = group.entries
            .filter((entry): entry is { type: "message"; msg: Message } => entry.type === "message")
            .map((entry) => entry.msg);
        if (groupingEnabled && group.runId) {
            const runId = group.runId;
            const summary = runsById.value.get(runId);
            const header: RunHeaderModel = {
                runId,
                status: runStatusOf(runId, groupMessages) ?? null,
                terminalOutcome: runOutcomeOf(runId, groupMessages) ?? null,
                createdAt: summary?.createdAt ?? null,
                terminalAt: summary?.terminalAt ?? null,
                principalName: principalNameOf(groupMessages),
                collapsed: isCollapsed(runId, groupMessages),
            };
            result.push({ type: "header", header, groupMessages, key: `header-${runId}` });
            if (header.collapsed) continue;
        }
        for (const entry of group.entries) {
            if (entry.type === "date") {
                result.push({ type: "date", date: entry.date, id: entry.id, key: entry.id });
            } else {
                result.push({
                    type: "message",
                    msg: entry.msg,
                    indented: groupingEnabled && Boolean(group.runId),
                    key: entry.msg.id,
                });
            }
        }
    }
    return result;
});
</script>

<template>
    <MessageScrollerProvider auto-scroll default-scroll-position="last-anchor">
        <div data-testid="message-list" class="relative flex flex-1 flex-col min-h-0">
            <div v-if="showSearch" class="absolute right-12 top-2 z-10">
                <MessageSearch v-model="searchQuery" @close="showSearch = false" />
            </div>
            <button
                v-else
                type="button"
                data-testid="message-search-toggle"
                aria-label="搜索消息"
                class="absolute right-2 top-2 z-10 rounded-md border bg-background/90 p-1.5 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
                @click="showSearch = true"
            >
                <Search class="size-3.5" aria-hidden="true" />
            </button>

            <MessageScroller class="flex-1">
                <MessageScrollerViewport preserve-scroll-on-prepend>
                    <MessageScrollerContent :class="showSearch ? 'pt-12' : undefined">
                        <template v-for="row in rows" :key="row.key">
                            <RunGroupHeader
                                v-if="row.type === 'header'"
                                :run-id="row.header.runId"
                                :status="row.header.status"
                                :terminal-outcome="row.header.terminalOutcome"
                                :created-at="row.header.createdAt"
                                :terminal-at="row.header.terminalAt"
                                :principal-name="row.header.principalName"
                                :collapsed="row.header.collapsed"
                                @toggle="toggleRun(row.header.runId, row.groupMessages)"
                            />

                            <Marker
                                v-else-if="row.type === 'date'"
                                variant="separator"
                                class="my-2"
                            >
                                {{ row.date }}
                            </Marker>

                            <MessageScrollerItem
                                v-else
                                :message-id="row.msg.id"
                                :scroll-anchor="row.msg.role === 'user'"
                            >
                                <div
                                    data-testid="run-group-body"
                                    :class="
                                        row.indented
                                            ? 'ml-1 border-l border-border/60 pl-3'
                                            : undefined
                                    "
                                >
                                    <MessageItem
                                        :message="row.msg"
                                        :responder="responderFor(row.msg)"
                                        :delivery="deliveryOf(row.msg)"
                                        :show-actor="multiActor"
                                        :is-streaming="row.msg.isStreaming"
                                        :branch-busy="branchBusy"
                                        @approve="emit('approve', $event)"
                                        @reject="emit('reject', $event)"
                                        @delete="emit('delete', $event)"
                                        @retry="emit('retry', $event)"
                                        @branch="emit('branch', $event)"
                                        @revert="emit('revert', $event)"
                                    />
                                </div>
                            </MessageScrollerItem>
                        </template>
                    </MessageScrollerContent>
                </MessageScrollerViewport>
            </MessageScroller>

            <MessageScrollerButton v-if="filteredMessages.length > 0" direction="end" />
        </div>
    </MessageScrollerProvider>
</template>
