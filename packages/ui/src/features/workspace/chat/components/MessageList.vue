<script setup lang="ts">
import {
    ref,
    computed,
    nextTick,
    watch,
    onMounted,
    onBeforeUnmount,
    type ComponentPublicInstance,
} from "vue";
import { useI18n } from "vue-i18n";

import type { Message, SessionRunSummary } from "../../../../types";
import type { SessionParticipantView } from "../../../../types/participant";
import { useSessionParticipantsStore } from "../../stores/sessionParticipants";
import { useChatStore } from "../stores/chat.ts";
import MessageItem from "./MessageItem.vue";
import ContextTruncationNotice from "./ContextTruncationNotice.vue";
import MessageSearch from "./MessageSearch.vue";
import RunGroupHeader from "./RunGroupHeader.vue";
import RunTerminalChip from "./RunTerminalChip.vue";
import { terminalMarkerOf, type TerminalMarker } from "../runStateView";
import type { AgentContextTruncation } from "../composables/useSSE";
import { hasMultipleActors } from "../actorView";
import { resolveDelivery, type ResolvedDelivery } from "../deliveryView";
import { DEFAULT_VIRTUAL_MIN_ROWS } from "../composables/virtualWindow";
import { useVirtualMessageWindow } from "../composables/useVirtualMessageWindow";
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
    /**
     * PLAN-0670 M2d.1：CP 响应带 `nextCursor`/`truncated` 时才为 true（不硬编码假设）。
     * 旧 CP 返回数组 ⇒ false ⇒ 入口不渲染，行为与改造前一致。
     */
    hasOlder?: boolean;
    /** 向上取更旧一页进行中（按钮禁用 + 文案切换）。 */
    loadingOlder?: boolean;
    /** PLAN-0670 M2d.3：因 500 条上限被折叠（已从内存丢弃）的最旧消息条数；0 = 无折叠。 */
    foldedCount?: number;
    /**
     * PLAN-0760：已展开段触顶（M ≥ 1500）。入口保留但禁用，文案说明上限 ——
     * 不静默消失（用户需要知道为什么不能再加载）。
     */
    expandedReachedLimit?: boolean;
}>();

/**
 * PLAN-0631 D31-08/09: the message identity row is driven by the **server** attribution
 * (`Message.participantId`, stamped from the SSE envelope), resolved against the session's
 * participant roster that the composer already loads (`ensureLoaded`). A message without
 * attribution resolves to `undefined` and renders **no** identity row — the rosters is the
 * only lookup, PRIMARY is never assumed.
 */
const participantsStore = useSessionParticipantsStore();
const chatStore = useChatStore();

/** PLAN-0670 M2c / BL-292：run 级截断提示（按 runId 取，不按会话全局）。 */
const truncationSessionId = computed(() => props.messages[0]?.sessionId ?? "");
const truncationRunIds = computed(() => [
    ...new Set(props.messages.map((message) => message.runId).filter((id): id is string => !!id)),
]);
const singleTruncationRunId = computed(() =>
    truncationRunIds.value.length === 1 ? truncationRunIds.value[0] : undefined,
);
function truncationFor(runId: string | undefined): AgentContextTruncation | undefined {
    if (!runId || !truncationSessionId.value) return undefined;
    if (chatStore.isRunContextTruncationDismissed(truncationSessionId.value, runId)) {
        return undefined;
    }
    return chatStore.getRunContextTruncation(truncationSessionId.value, runId);
}
function dismissTruncation(runId: string): void {
    if (truncationSessionId.value) {
        chatStore.dismissRunContextTruncation(truncationSessionId.value, runId);
    }
}
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
    loadOlder: [];
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
    /**
     * BL-406：折叠时 run 头之外必须还有终态芯片（否则「常显」不成立）。由共享 resolver 给出，
     * 与消息行尾的芯片同源，`succeeded`/`failed` 在这里同样没有标记。
     */
    terminalMarker: TerminalMarker | null;
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
            const status = runStatusOf(runId, groupMessages) ?? null;
            const terminalOutcome = runOutcomeOf(runId, groupMessages) ?? null;
            const header: RunHeaderModel = {
                runId,
                status,
                terminalOutcome,
                terminalMarker: terminalMarkerOf(status, terminalOutcome),
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

/**
 * PLAN-0670 M2d.2 —— 窗口化渲染（虚拟滚动）。
 *
 * 现状（PLAN-0670 实测）：全量渲染 5k 条 ⇒ 102,940 DOM / 16.8 FPS，20k 条直接渲染不出来。
 * 这里只减少 **DOM**：行仍是同一套 `RunGroupHeader` / `Marker` / `MessageScrollerItem` /
 * `MessageItem`，窗口外行用上下占位高度撑住 scrollHeight，所以：
 * - 滚动条长度与位置语义不变（占位 = 未渲染行的高度和）；
 * - 新消息贴底由 `MessageScrollerProvider auto-scroll` 负责（窗口在底部时 end=count）；
 * - 搜索态**关闭窗口化**（过滤结果通常很小，且搜索后滚到顶的既有行为保持不变）；
 * - 向上加载历史（未来分页）用 `captureAnchor/restoreAnchor` 钉住用户正在读的那行。
 */
const VIRTUAL_FALLBACK_ROW_HEIGHT = 120;
/**
 * BL-316 —— 滚动视口元素的来源（**不是** context，见下）。
 *
 * 原实现用 `inject(MessageScrollerContextKey, null).viewportRef` 取滚动容器，但提供该 context 的
 * `MessageScrollerProvider` 是**本组件的子节点**（模板里包着整块内容），而 Vue 的 provide/inject
 * 只沿祖先链向下查找 ⇒ `inject` 恒为 `null` ⇒ `attachViewport(null)` ⇒ `viewportHeight` 恒 0 ⇒
 * `active` 恒 false ⇒ 窗口化渲染在产品里从未生效（长会话仍全量渲染，这也是 BL-315 自触发循环
 * 长期没被窗口化掩盖/暴露的直接原因之一）。
 *
 * 现在改从**组件 ref** 取：`MessageScrollerViewport` 是单根组件，根节点就是那个 `overflow-y-auto`
 * 的滚动 div。再用 `data-slot` 复核一层——将来若组件加了包裹层，这里退回内部那一层而不是把
 * 外层元素当视口（认错元素的后果是静默失效，比报错更难查）。
 */
const viewportComponent = ref<ComponentPublicInstance | null>(null);

function resolveViewportElement(): HTMLElement | null {
    const root = viewportComponent.value?.$el;
    if (!(root instanceof HTMLElement)) return null;
    return root.dataset.slot === "message-scroller-viewport"
        ? root
        : root.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
}

const rowKeys = computed(() => rows.value.map((row) => row.key));
/**
 * prepend/丢最旧的一帧：临时关闭窗口化（全量渲染），让 provider 的
 * `preserve-scroll-on-prepend` 用真实 DOM 锚点恢复位置；下一帧再恢复窗口化并由
 * `restoreAnchor` 做精确校正。窗口化下直接按高度估算会因 fallback 误差跳位（实测 11k px）。
 */
const historyMutationPause = ref(false);
/**
 * BL-382 B —— 「篇幅无关上界」：只有**表小到挂一次也不贵**时才允许用「关窗口化 → 全量渲染一帧」
 * 当锚定手段；超过这个行数就保持窗口化，位置交给 `prependScrollSnapshot` 的同帧补偿（A）。
 *
 * 根因（`docs/evidence/bl382-attribution/proof.md` §3.1）：每补一页都会整表挂载 → 等一帧 → 拆回
 * 窗口，99 轮 = 99 次全表挂载/卸载（实测 192 个长任务、1.94/轮、第 99 轮 5698ms），代价随表长 × 轮次
 * 增长；而锚定本身只需要 O(视口) 的补偿。阈值按 proof §7.1 先取 200，AC-2 出数后再按实测调。
 */
const HISTORY_PAUSE_MAX_ROWS = 200;
const virtualEnabled = computed(
    () =>
        // BL-382 B：大表禁止用「关窗口化」当锚定手段（否则又把代价绑回表长）。
        (!historyMutationPause.value || rows.value.length > HISTORY_PAUSE_MAX_ROWS) &&
        !searchQuery.value &&
        rows.value.length > DEFAULT_VIRTUAL_MIN_ROWS,
);
const {
    window: virtualWindow,
    active: virtualizationActive,
    attach: attachViewport,
    measure: measureRow,
    captureAnchor,
    restoreAnchor,
    scrollTop: virtualScrollTop,
} = useVirtualMessageWindow({
    rowKeys,
    enabled: virtualEnabled,
    fallbackHeight: VIRTUAL_FALLBACK_ROW_HEIGHT,
});

onMounted(async () => {
    await nextTick();
    attachViewport(resolveViewportElement());
});
onBeforeUnmount(() => attachViewport(null));

/** 只渲染窗口内的行；未启用窗口化时保持全量（搜索/小列表语义逐字节不变）。 */
const visibleRows = computed(() => {
    if (!virtualizationActive.value) return rows.value;
    return rows.value.slice(virtualWindow.value.start, virtualWindow.value.end);
});
const topSpacerHeight = computed(() =>
    virtualizationActive.value ? `${virtualWindow.value.topPadding}px` : "0px",
);
const bottomSpacerHeight = computed(() =>
    virtualizationActive.value ? `${virtualWindow.value.bottomPadding}px` : "0px",
);

function rowElementRef(key: string, element: unknown): void {
    const el =
        element instanceof HTMLElement
            ? element
            : ((element as { $el?: HTMLElement } | null)?.$el ?? null);
    measureRow(key, el instanceof HTMLElement ? el : null);
}

/**
 * BL-382 C —— 回填期指标（longTasks/轮、pause 时长、单轮回填耗时）的**可观测输出**。
 *
 * 默认全关：关闭时每轮只多一次字符串比较，不改行为、不打印、不写 DOM。开启后只写内存环形数组：
 * - 开：控制台 `localStorage.setItem("xh:history-perf", "1")` 后刷新，或会话内 `window.__xhHistoryPerfOn = true`
 * - 读：`window.__xhHistoryPerfReport()`（最近 200 轮明细 + longTasks 累计与每轮增量）
 * - 清：`window.__xhHistoryPerfReset()`；关：`localStorage.removeItem("xh:history-perf")`
 * 需要它的判据是 proof §8.2 的 AC-4（longTasks/轮）与 AC-5（堆与轮次解耦），都要真栈测量窗，故本组件
 * 只负责**把数备好**，不自己下结论。
 */
const HISTORY_PERF_KEY = "xh:history-perf";
const HISTORY_PERF_MAX_ENTRIES = 200;
interface HistoryPerfEntry {
    at: number;
    rows: number;
    firstKey: string;
    /** 本轮是否走了「关窗口化」全表渲染（BL-382 B：只有 ≤ HISTORY_PAUSE_MAX_ROWS 才会）。 */
    paused: boolean;
    /** 关窗口化的持续时长（ms）；未关窗口化时为 0。 */
    pauseMs: number;
    /** 同帧 scrollTop 补偿量（px，BL-382 A）；未补偿时为 0。 */
    grownPx: number;
    /** 本轮期间新增的 longtask 条数（= longTasks/轮 的直接读数）。 */
    longTasks: number;
    /** 本轮从 watcher 进入到 6 帧校正结束的总耗时（ms）。 */
    totalMs: number;
}
const historyPerfLog: HistoryPerfEntry[] = [];
const historyPerfLongTasks: number[] = [];
function historyPerfEnabled(): boolean {
    if (typeof window === "undefined") return false;
    if ((window as unknown as { __xhHistoryPerfOn?: boolean }).__xhHistoryPerfOn === true)
        return true;
    try {
        return window.localStorage.getItem(HISTORY_PERF_KEY) === "1";
    } catch {
        // 隐私模式/禁用 storage：按"关"处理（观测功能失效不得影响回填路径）。
        return false;
    }
}
function historyPerfInstall(): void {
    const host = window as unknown as {
        __xhHistoryPerfReport?: () => unknown;
        __xhHistoryPerfReset?: () => void;
    };
    if (host.__xhHistoryPerfReport) return;
    if (typeof PerformanceObserver !== "undefined") {
        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) historyPerfLongTasks.push(entry.duration);
            }).observe({ type: "longtask", buffered: true });
        } catch {
            // 浏览器不支持 longtask（Safari/Firefox 现状）：其余指标照采，报告里 longTasks 恒 0。
        }
    }
    host.__xhHistoryPerfReport = () => ({
        prepends: historyPerfLog.map((entry) => ({ ...entry })),
        longTasks: {
            count: historyPerfLongTasks.length,
            totalMs: Math.round(historyPerfLongTasks.reduce((sum, duration) => sum + duration, 0)),
        },
    });
    host.__xhHistoryPerfReset = () => {
        historyPerfLog.length = 0;
        historyPerfLongTasks.length = 0;
    };
}

/**
 * 向上加载历史（分页就绪后由 ChatPanel prepend）时，prepend 前抓锚点、DOM 更新后恢复：
 * 用户正在读的那一行保持原视觉位置（与 `preserve-scroll-on-prepend` 同源，虚拟列表必须显式做）。
 */
watch(
    () => props.messages[0]?.id,
    async (nextFirst, prevFirst) => {
        if (!virtualizationActive.value || !nextFirst || !prevFirst || nextFirst === prevFirst)
            return;
        // BL-382 C：指标只在显式开启时采集（关闭时 perf 恒 null，后续分支全是 no-op）。
        const perfEnabled = historyPerfEnabled();
        if (perfEnabled) historyPerfInstall();
        const perf = perfEnabled
            ? {
                  beganAt: performance.now(),
                  longTasksBefore: historyPerfLongTasks.length,
                  pauseMs: 0,
                  grownPx: 0,
              }
            : null;
        // 先在旧 DOM 上抓锚点，再做锚定校正。
        const anchor = captureAnchor();
        // BL-382 A（根因修复）：prepend 前记录视口几何；DOM 更新后**同一帧**（微任务内、浏览器绘制前）
        // 把 scrollTop 加上 scrollHeight 增量 ⇒ 视口里那几行视觉位置不变。窗口化下这个增量正好等于
        // 顶部占位（未测量的 prepend 行按 fallback 撑高），所以不需要真实 DOM 也能算准。
        const viewport = resolveViewportElement();
        const snapshot =
            viewport === null
                ? null
                : { scrollHeight: viewport.scrollHeight, scrollTop: viewport.scrollTop };
        // BL-382 B：只有小表才允许「关窗口化 → 全量渲染一帧」（provider 用真实 DOM 锚点恢复）；
        // 大表保持窗口化，位置交给 A。这样代价不再随表长增长。
        const pauseWindowing = rows.value.length <= HISTORY_PAUSE_MAX_ROWS;
        const pauseStartedAt = perfEnabled ? performance.now() : 0;
        if (pauseWindowing) historyMutationPause.value = true;
        try {
            await nextTick();
            if (!pauseWindowing && snapshot !== null && viewport !== null) {
                const grown = viewport.scrollHeight - snapshot.scrollHeight;
                if (perf) perf.grownPx = Math.round(grown);
                if (grown !== 0) {
                    const next = Math.max(0, snapshot.scrollTop + grown);
                    viewport.scrollTop = next;
                    // 同步窗口计算的读数：只写 DOM 的话，本帧窗口仍按旧 scrollTop 切片，
                    // 要等 scroll 事件回来才补 —— 用户会看到一帧空白/错行。
                    virtualScrollTop.value = next;
                }
            }
            if (pauseWindowing)
                await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        } finally {
            if (perf)
                perf.pauseMs = pauseWindowing ? Math.round(performance.now() - pauseStartedAt) : 0;
            if (pauseWindowing) historyMutationPause.value = false;
        }
        await nextTick();
        await restoreAnchor(anchor);
        if (anchor) {
            // provider 的 MutationObserver 在"全量渲染 → 恢复窗口化"两次 DOM 变更后仍可能用
            // 旧锚点再纠正一次（实测中间位置 prepend 会被它拉到贴底）；连续几帧把锚点按回原视觉位置，
            // 谁最后写 scrollTop 谁生效，直到稳定为止。
            for (let frame = 0; frame < 6; frame += 1) {
                await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
                await restoreAnchor(anchor);
            }
        }
        if (perf) {
            historyPerfLog.push({
                at: Date.now(),
                rows: rows.value.length,
                firstKey: nextFirst,
                paused: pauseWindowing,
                pauseMs: perf.pauseMs,
                grownPx: perf.grownPx,
                longTasks: historyPerfLongTasks.length - perf.longTasksBefore,
                totalMs: Math.round(performance.now() - perf.beganAt),
            });
            if (historyPerfLog.length > HISTORY_PERF_MAX_ENTRIES) historyPerfLog.shift();
        }
    },
    { flush: "pre" },
);
</script>

<template>
    <!--
        BL-316 第二步：`source-item-count` 声明"这块 DOM 是全部行的投影"（rows.length = 数据层行数）。
        **只在窗口化真正生效时声明**：窗口化关闭时 DOM 就是数据本身，任何子节点变化都是数据变化，
        必须走改造前的原有语义（否则会把"消息内容变长"这类 DOM 变化误判成纯投影而漏掉锚定）。
        scroller 据此把"窗口换页"与"新消息到达"区分开 —— 否则窗口换页会被当成新消息、把上滚拽回底部。
    -->
    <MessageScrollerProvider
        auto-scroll
        default-scroll-position="last-anchor"
        :source-item-count="virtualizationActive ? rows.length : undefined"
    >
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
                <MessageScrollerViewport ref="viewportComponent" preserve-scroll-on-prepend>
                    <MessageScrollerContent :class="showSearch ? 'pt-12' : undefined">
                        <!--
                            PLAN-0670 M2d.1：只有 CP 明确给出 `nextCursor/truncated` 才显示
                            「加载更早」入口；旧 CP（数组响应）不渲染，行为不变。
                        -->
                        <div
                            v-if="hasOlder || (foldedCount ?? 0) > 0 || expandedReachedLimit"
                            class="flex justify-center py-2"
                        >
                            <button
                                type="button"
                                data-testid="load-older-messages"
                                :disabled="loadingOlder || expandedReachedLimit"
                                class="rounded-md border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                                :title="
                                    expandedReachedLimit
                                        ? t('chat.expandedLimitReached')
                                        : undefined
                                "
                                @click="emit('loadOlder')"
                            >
                                {{
                                    loadingOlder
                                        ? t("chat.loadingOlder")
                                        : expandedReachedLimit
                                          ? t("chat.expandedLimitReached")
                                          : (foldedCount ?? 0) > 0
                                            ? t("chat.foldedOlder", { count: foldedCount })
                                            : t("chat.loadOlder")
                                }}
                            </button>
                        </div>
                        <!-- 单 run（无分组头）时提示仍要可见，且只挂在这一个 run 上。 -->
                        <ContextTruncationNotice
                            :truncation="truncationFor(singleTruncationRunId)"
                            @dismiss="
                                singleTruncationRunId && dismissTruncation(singleTruncationRunId)
                            "
                        />
                        <!-- 窗口化：窗口上方/下方的未渲染行用占位高度撑住 scrollHeight（PLAN-0670 M2d.2） -->
                        <div
                            v-if="virtualizationActive"
                            aria-hidden="true"
                            data-testid="virtual-top-spacer"
                            :style="{ height: topSpacerHeight }"
                        />
                        <template v-for="row in visibleRows" :key="row.key">
                            <div v-if="row.type === 'header'" :data-run-block="row.header.runId">
                                <RunGroupHeader
                                    :run-id="row.header.runId"
                                    :status="row.header.status"
                                    :terminal-outcome="row.header.terminalOutcome"
                                    :created-at="row.header.createdAt"
                                    :terminal-at="row.header.terminalAt"
                                    :principal-name="row.header.principalName"
                                    :collapsed="row.header.collapsed"
                                    @toggle="toggleRun(row.header.runId, row.groupMessages)"
                                />
                                <!--
                                    BL-406：折叠壳之外（run 头摘要行下方）也要有终态芯片 ——
                                    判据要求「常显」，而折叠时消息行整体不渲染，芯片会一起消失。
                                    与消息行尾用同一组件（同 testid/文案/色阶/`data-run-outcome`）。
                                -->
                                <RunTerminalChip
                                    v-if="row.header.collapsed && row.header.terminalMarker"
                                    :outcome="row.header.terminalMarker"
                                    class="ml-1"
                                />
                                <ContextTruncationNotice
                                    :truncation="truncationFor(row.header.runId)"
                                    @dismiss="dismissTruncation(row.header.runId)"
                                />
                            </div>

                            <Marker
                                v-else-if="row.type === 'date'"
                                variant="separator"
                                class="my-2"
                            >
                                {{ row.date }}
                            </Marker>

                            <MessageScrollerItem
                                v-else
                                :ref="(el) => rowElementRef(row.key, el)"
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
                        <div
                            v-if="virtualizationActive"
                            aria-hidden="true"
                            data-testid="virtual-bottom-spacer"
                            :style="{ height: bottomSpacerHeight }"
                        />
                    </MessageScrollerContent>
                </MessageScrollerViewport>
            </MessageScroller>

            <MessageScrollerButton v-if="filteredMessages.length > 0" direction="end" />
        </div>
    </MessageScrollerProvider>
</template>
