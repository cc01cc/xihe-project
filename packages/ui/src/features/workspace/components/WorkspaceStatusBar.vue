<script setup lang="ts">
/**
 * task-312：工作区底部状态栏。
 *
 * <p>用户原话（2026-11-13）：「会话页（工作区的主体交互区）底部是不是应该有一个状态栏」。
 * 判据只有一条 —— **不点也能读到、且随时在变**。据此只放三条（全部指向**既有**数据源，
 * 不发明任何新产品概念）：</p>
 *
 * <ol>
 *   <li>SSE 连接态（三态：连接中 / 已连接 / 未连接）</li>
 *   <li>待审批总数（有才显示）</li>
 *   <li>本次 run 用量（有 run 才显示）</li>
 * </ol>
 *
 * <p><b>被否决的候选（防复发，别再加回来）</b>：</p>
 * <ul>
 *   <li>当前 git 分支 —— 全仓 `currentBranch` / `branchName` / `gitBranch`
 *       <b>零命中</b>，无数据源；要做得先建数据源，那是新产品面。</li>
 *   <li>模型名 —— PLAN-0555 已裁定移除 composer 模型展示，加回是<b>反向</b>。</li>
 *   <li>运行中 job 数 —— 数据源 `activeJobCount` 只在
 *       `WorkspaceEnvironmentView` 内（且只用于禁用「释放」按钮），
 *       进全局状态栏需先提升到 workspace 级 store = 新产品面。</li>
 *   <li>当前 agent principal —— 「不变的信息属于 header 或 settings」，且工具栏已有徽标。</li>
 *   <li>会话标题 —— 与二级导航面包屑重复。</li>
 * </ul>
 *
 * <p><b>挂载位置为什么是页面级（本组件由 `WorkspaceView` 挂载）</b>：
 * 三条数据源里 SSE 连接态是<b>页面级</b>的（`useWorkspaceSSE` 在
 * `WorkspaceView:203` 实例化，不是 store）；另外两条是全局 store。
 * 挂到 shell / layout 层就必须先把 SSE 连接态提升成 store —— 那属于「新增 store 字段」，
 * 本卡边界明确禁止。所以挂在页面级：三条全都拿得到，且<b>零 store 改动</b>。</p>
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
    /** SSE 是否已连上（页面级 `workspaceEvents.isConnected`）。 */
    connected: boolean;
    /** SSE 是否正在连接中（页面级 `workspaceEvents.isConnecting`）。 */
    connecting: boolean;
    /** 待审批总数（全局 `agentStore.pendingApprovalTotal`）。 */
    pendingApprovalTotal: number;
    /** 本次 run 的输入 tokens（无 run 时为 null）。 */
    usageInput?: number | null;
    /** 本次 run 的输出 tokens。 */
    usageOutput?: number | null;
}>();

const { t } = useI18n();

/**
 * 三态派生。**顺序有语义**：`connecting` 优先于 `connected` ——
 * 重连过程中 `isConnected` 可能仍是上一轮的 true，先判 connecting 才不会把
 * 「正在重连」读成「已连接」。
 */
const connectionState = computed<"connecting" | "connected" | "disconnected">(() => {
    if (props.connecting) return "connecting";
    if (props.connected) return "connected";
    return "disconnected";
});

const connectionLabel = computed(() => {
    switch (connectionState.value) {
        case "connecting":
            return t("workspace.eventsConnecting");
        case "connected":
            return t("workspace.eventsConnected");
        default:
            return t("workspace.eventsDisconnected");
    }
});

/**
 * 状态点颜色。**不用品牌色**（注意力预算：状态点不是 CTA）：
 * 已连接 = 绿（成功语义）、连接中 = 琥珀（进行中）、未连接 = 灰（中性，不是错误红 ——
 * 断线会自动重连，不是用户需要立刻处置的错误）。
 */
const dotClass = computed(() => {
    switch (connectionState.value) {
        case "connecting":
            return "bg-amber-500";
        case "connected":
            return "bg-emerald-600";
        default:
            return "bg-muted-foreground/40";
    }
});

/** 有 run 才显示用量；`0` 也是有效读数（不能因为 0 就隐藏）。 */
const showUsage = computed(() => typeof props.usageInput === "number");
</script>

<template>
    <div
        data-testid="workspace-status-bar"
        class="flex h-6 shrink-0 items-center gap-3 border-t bg-muted/20 px-3 text-xs text-muted-foreground max-md:hidden"
    >
        <!-- ① SSE 连接态：三态各有独立 data 属性值，判据可断言「实际是哪一态」而不是「元素存在」。 -->
        <span
            data-testid="workspace-status-connection"
            :data-connection-state="connectionState"
            class="inline-flex items-center gap-1.5"
        >
            <span
                class="inline-block size-1.5 shrink-0 rounded-full"
                :class="dotClass"
                aria-hidden="true"
            />
            <span>{{ connectionLabel }}</span>
        </span>

        <!-- ② 待审批总数：0 时不渲染（0 条待审批是常态，占位等于噪音）。 -->
        <span
            v-if="pendingApprovalTotal > 0"
            data-testid="workspace-status-pending"
            class="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"
        >
            <span class="font-medium tabular-nums">{{ pendingApprovalTotal }}</span>
            <span>{{ t("sidebar.pendingApprovalBadge") }}</span>
        </span>

        <!-- ③ 本次 run 用量：无 run 不渲染。 -->
        <span
            v-if="showUsage"
            data-testid="workspace-status-usage"
            class="ml-auto inline-flex items-center gap-2 tabular-nums"
        >
            <span>{{
                t("workspace.statusBarUsage", { input: usageInput, output: usageOutput ?? 0 })
            }}</span>
        </span>
    </div>
</template>
