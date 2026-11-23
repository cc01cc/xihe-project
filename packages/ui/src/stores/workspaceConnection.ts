import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useChatStore } from "../features/workspace/chat/stores/chat";
import { useSessionStore } from "./session";

/**
 * 计费来源/费用的 wire 值 → i18n key（task-941）。
 *
 * <p><b>为什么映射表放在本 store 而不是组件里</b>：卡片要求「状态由本 store 提供、组件内不得
 * 硬编码文案」。表里只有**键**（文案本身仍全部来自 `src/i18n`），所以组件只做 `t(key)`，
 * 判据与 key 的唯一落点是这里；将来 CP 加新的 `source`/`costNote` 值只改这两张表。</p>
 *
 * <p>`source` 三值与 `ChatRunUsage.source`（`types/index.ts`）逐字对齐；`costNote` 是 CP
 * `UsageCostMapper` 的英文原值，不进用户可见文案，只用于选键。</p>
 */
export const USAGE_SOURCE_I18N_KEYS: Record<string, string> = {
    real: "workspace.usageSourceReal",
    estimated: "workspace.usageSourceEstimated",
    fallback: "workspace.usageSourceFallback",
};
export const USAGE_COST_NOTE_I18N_KEYS: Record<string, string> = {
    "no token counts": "workspace.usageCostNoteNoTokenCounts",
    "model not in pricing config": "workspace.usageCostNoteNoPricing",
    "no pricing entry": "workspace.usageCostNoteNoPricing",
};

/**
 * 工作区**连接读数**（task-160 / S2a；`D-1527` ①）。
 *
 * <p><b>它是什么</b>：底部状态栏从页面级挂载搬到了壳层（`WorkspaceShell`），而连接态原本是
 * **页面级实例**（`useWorkspaceSSE`，见 `WorkspaceStatusBar.vue` 旧注释）—— 壳层拿不到页面实例，
 * 所以页面把「读数」发布到本 store，壳层只读。**连接生命周期仍由页面持有**
 * （`useWorkspaceSSE` 的 leader/重连/stop 都没有搬进来），本 store 不是连接本身的 owner。</p>
 *
 * <p><b>为什么不是把 `useWorkspaceSSE` 搬进 store</b>：那一搬等于把「谁连、何时连、怎么重连」
 * 变成全局单例，会和 `useSharedEventLeader` 的标签页协作、页面挂载期语义（切页即断）打架。
 * 裁定的边界是「只发布只读字段」，这里照办。</p>
 *
 * <p><b>只读通道，写方是页面 watch（Lead 2026-11-15 追加约束）</b>：本 store 的角色是
 * 「页面读数 → 壳层展示」的**通道**，不是状态的 owner。唯一 writer 是页面侧的 watch：
 * `useWorkspaceSSE` 发布连接读数、`WorkspaceView` 发布 `usageInput/usageOutput`。
 * 其它任何地方都不许调用 `publishConnection` / `publishUsage` —— 两个 writer 会让状态栏在两次
 * 发布之间闪，且「谁的读数算当前」会失去判据。**新代码若想写这两个函数，先回来改这条注释。**</p>
 *
 * <p><b>用量为什么也在这里</b>：`usageInput/usageOutput` 同样是页面级读数（`WorkspaceView` 的
 * `lastUsage` 派生），状态栏上移后没有 props 来源；若不发布，聊天页那条「本次 run 用量」会消失
 * （可见回归）。所以与连接态同一通道发布，语义仍是一条：**页面读数 → 壳层展示**。</p>
 *
 * <p><b>task-941 追加：费用/计费来源走「同一快照的只读派生」，不新增 writer。</b>
 * `usageCost/usageSource` 从 `chatStore.getSessionLastUsage(当前会话)` 就地派生（见
 * `usageDetail` 的注释）—— 那份快照的唯一 writer 是 SSE `usage` 事件落库，所以本条不破
 * 「每个读数只有一个 writer」的判据；`publishUsage` 仍然只由 `WorkspaceView` 调用。</p>
 */

export const useWorkspaceConnectionStore = defineStore("workspaceConnection", () => {
    /**
     * **本页有没有订阅文件事件**（task-81 P1-1）。
     *
     * <p><b>为什么需要它</b>：`connected=false` 有**两种完全不同的原因** —— ①订阅了但断了
     * （真故障）②本页根本没订阅（环境/资源/成员/设置等页）。状态栏把它们压成同一句
     * 「文件事件未连接」，用户会去查网络，而事实是这页不订阅。**把不同原因读成同一个像是
     * 故障的读数**，正是本轮要修的语义错误。</p>
     *
     * <p><b>谁来填</b>：发布方自己声明 —— `useWorkspaceSSE` 一挂载即置 true、卸载置 false。
     * 显示侧**不猜路由**（按路由写「哪些页面订阅」的白名单必然随新页面漂）。</p>
     *
     * <p><b>初始值必须是 false</b>：首帧若先读成 true 会闪一下「连接中」再回落；
     * 而从「未订阅页」进入时若默认 true，首帧会显示错误的态。改动见单测。</p>
     */
    const subscribed = ref(false);
    /** SSE 是否已连上（页面 `workspaceEvents.isConnected` 的只读副本）。 */
    const connected = ref(false);
    /** SSE 是否正在连接/重连（页面 `isConnecting` 的只读副本）。 */
    const connecting = ref(false);
    /** 最近一次连接错误文本；`null` = 无错误。 */
    const error = ref<string | null>(null);
    /** 本次 run 的输入 tokens（无 run 时 `null`）。 */
    const usageInput = ref<number | null>(null);
    /** 本次 run 的输出 tokens（无 run 时 `null`）。 */
    const usageOutput = ref<number | null>(null);

    /**
     * 计费读数的唯一事实源（task-941）：`chatStore.getSessionLastUsage(当前会话)`。
     *
     * <p><b>为什么这里不发布、而是就地派生</b>：`sessionLastUsage` 已经是 chat store 里的
     * per-session 全局快照（唯一 writer = SSE `usage` 事件落库，`SSEStream.vue#onUsage`）。
     * 卡片给本卡的写域不含页面（`WorkspaceView.vue` 仍只发布 in/out），若再引入第二个
     * `publishUsage*` writer 就会与既有发布互闪、并让「谁的读数算当前」失去判据 —— 所以
     * 费用/来源走**同一快照的只读派生**，与 `publishUsage` 的 in/out 同源（同一条
     * `ChatRunUsage`），不会在两处之间分叉。</p>
     *
     * <p>渲染侧仍以 `usageInput`（页面发布）为「本次 run 有读数」的开关：本守卫保证
     * 非聊天页（页面已 `reset()`）不会出现「只有费用/来源、没有 token」的半截读数。</p>
     */
    const sessionStore = useSessionStore();
    const chatStore = useChatStore();
    const usageDetail = computed(() => {
        const sessionId = sessionStore.currentSessionId;
        if (!sessionId) return null;
        return chatStore.getSessionLastUsage(sessionId);
    });
    /** `ChatRunUsage.source` 原值（real/estimated/fallback；无读数为 `null`）。 */
    const usageSource = computed(() => usageDetail.value?.source ?? null);
    /** 该来源对应的 i18n key；未登记的 wire 值返回 `null`（组件回落显示原值）。 */
    const usageSourceKey = computed(() =>
        usageSource.value ? (USAGE_SOURCE_I18N_KEYS[usageSource.value] ?? null) : null,
    );
    /** 费用（`null` = CP 没有定价或没有 token 计数；`0` 是有效读数）。 */
    const usageCost = computed(() => usageDetail.value?.cost ?? null);
    const usageCostSource = computed(() => usageDetail.value?.costSource ?? null);
    const usageCostNote = computed(() => usageDetail.value?.costNote ?? null);
    /** 费用不可用时的说明 key（按 CP `costNote` 原值选；未登记回落通用句）。 */
    const usageCostNoteKey = computed(() => {
        if (usageCost.value != null) return null;
        const note = usageCostNote.value;
        return (
            (note ? USAGE_COST_NOTE_I18N_KEYS[note] : undefined) ?? "workspace.usageCostNoteUnknown"
        );
    });

    /** 页面侧发布连接读数（唯一 writer = `useWorkspaceSSE` 的 watch）。 */
    function publishConnection(next: {
        connected: boolean;
        connecting: boolean;
        error: string | null;
    }): void {
        // 能发布连接读数这件事本身就证明本页有发布方 ⇒ 订阅态置 true。
        // 不额外收一个 `subscribed` 入参：那样调用方可能传 false 却同时传读数，自相矛盾。
        subscribed.value = true;
        connected.value = next.connected;
        connecting.value = next.connecting;
        error.value = next.error;
    }

    /** 页面侧发布 run 用量（无 run 传 `null`；`0` 是有效读数，不能当无值）。 */
    function publishUsage(input: number | null, output: number | null): void {
        usageInput.value = input;
        usageOutput.value = output;
    }

    /**
     * 页面卸载时清空：切到「环境 / 设置」这类不订阅 SSE 的页时，不能留着上一页的旧读数
     * （旧值会让人以为当前页也在收事件）。**这个意图不变。**
     *
     * <p>task-81 P1-1 的关键修正：原来这里把 `connected` 置 false 后，状态栏读成「未连接」
     * —— 与「订阅了但断了」不可区分。现在同时把 `subscribed` 置 false，让显示侧能读出
     * 「**本页未订阅**」这个中性事实，而不是一个看起来像故障的读数。</p>
     */
    function reset(): void {
        subscribed.value = false;
        connected.value = false;
        connecting.value = false;
        error.value = null;
        usageInput.value = null;
        usageOutput.value = null;
    }

    return {
        subscribed,
        connected,
        connecting,
        error,
        usageInput,
        usageOutput,
        usageSource,
        usageSourceKey,
        usageCost,
        usageCostSource,
        usageCostNote,
        usageCostNoteKey,
        publishConnection,
        publishUsage,
        reset,
    };
});
