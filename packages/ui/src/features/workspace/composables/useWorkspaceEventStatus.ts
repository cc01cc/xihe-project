import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceConnectionStore } from "../../../stores/workspaceConnection";

/**
 * 工作区「文件事件连接」四态 —— **单一实现**（task-10 item 3 / batch-2 第 3 条）。
 *
 * <p><b>为什么收敛成一处</b>：同一事实原先有两套语义 —— 底部状态栏
 * （`WorkspaceStatusBar`）是四态（未订阅 / 连接中 / 已连接 / 未连接），而聊天页徽标
 * （`WorkspaceView.vue` 的 `workspace-event-status`）是**二态**（连接中/重连中 vs 已连接）。
 * 于是同一屏幕、同一时刻会出现「文件事件重连中」（页面徽标）与「本页未订阅文件事件」
 * （状态栏）两句互相矛盾的话。这不是文案问题：两个组件对同一个 `connected=false`
 * 给出了**不同原因归属**，读的人自然会去查网络 —— 而事实是这页不订阅文件事件。
 * ⇒ 收敛为一条派生链，两个使用点只负责各自的视觉（文字/圆点），不再各写一套判断。</p>
 *
 * <p><b>派生顺序有语义，两层都必须保持</b>：</p>
 * <ol>
 *   <li>`subscribed` 判在最前（task-81 P1-1）：本页没有订阅方时 `connected/connecting`
 *       恒为默认 false —— 那是「没订阅」不是「断了」。若读成 disconnected，用户会去查网络。</li>
 *   <li>订阅页内部 `connecting` 优先于 `connected`：重连过程中 `isConnected` 可能仍是上一轮的
 *       true，先判 connecting 才不会把「正在重连」读成「已连接」。</li>
 * </ol>
 *
 * <p>读数来自 `useWorkspaceConnectionStore`（页面侧 `useWorkspaceSSE` 以 `immediate` watch 发布，
 * 首帧即有值，不会先闪一个错态）。</p>
 */
export type WorkspaceEventState = "unsubscribed" | "connecting" | "connected" | "disconnected";

export function useWorkspaceEventStatus() {
    const { t } = useI18n();
    const connection = useWorkspaceConnectionStore();

    const state = computed<WorkspaceEventState>(() => {
        if (!connection.subscribed) return "unsubscribed";
        if (connection.connecting) return "connecting";
        if (connection.connected) return "connected";
        return "disconnected";
    });

    const label = computed(() => {
        switch (state.value) {
            case "unsubscribed":
                return t("workspace.eventsUnsubscribed");
            case "connecting":
                return t("workspace.eventsConnecting");
            case "connected":
                return t("workspace.eventsConnected");
            default:
                return t("workspace.eventsDisconnected");
        }
    });

    return { state, label };
}
