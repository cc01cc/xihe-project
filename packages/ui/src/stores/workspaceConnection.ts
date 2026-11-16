import { defineStore } from "pinia";
import { ref } from "vue";

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
        publishConnection,
        publishUsage,
        reset,
    };
});
