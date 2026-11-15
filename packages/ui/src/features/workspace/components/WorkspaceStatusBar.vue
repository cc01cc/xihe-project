<script setup lang="ts">
/**
 * task-312：工作区底部状态栏；**task-160（S2a）起由壳层 `WorkspaceShell` 挂载**。
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
 *   <li><b>会话标题 —— 已作废的否决理由（task-160）</b>：原话是「与二级导航面包屑重复」，
 *       但面包屑<b>已经搬进本状态栏</b>（同一行左侧），所以「重复」不再成立 ——
 *       面包屑自己就带当前上下文。**不要用这条旧理由把面包屑或标题再驳回**；
 *       若将来要加会话标题，判据是「是否与左侧面包屑末段同词」：同词即重复，不同词才可加。</li>
 * </ul>
 *
 * <p><b>挂载位置与读数来源（task-160 / `D-1527` ①）</b>：本组件由 `WorkspaceShell` 挂载
 * ⇒ 六个工作区页都看得到。但连接态与用量是**页面级**读数（`useWorkspaceSSE` /
 * `lastUsage` 都在页面实例里），所以它们经 `useWorkspaceConnectionStore` 发布后在此读取；
 * 待审批总数本来就是全局 store（`agentStore.pendingApprovalTotal`）。</p>
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "../../../components/ui/breadcrumb";
import { useAgentStore } from "../../../stores/agent";
import { useWorkspaceConnectionStore } from "../../../stores/workspaceConnection";
import { useWorkspaceNav } from "../composables/useWorkspaceNav";

const { t } = useI18n();
const agentStore = useAgentStore();
const connection = useWorkspaceConnectionStore();
/**
 * 面包屑（task-160 从 `WorkspaceSecondaryNav` **整段搬来**，不是重写）：
 * 三段 `工作区（可点）→ 工作区名（不可点）→ 当前页（aria-current="page"）`。
 * 末段的 `aria-current` 由 vendor 的 `BreadcrumbPage` 自带（`BreadcrumbPage.vue:16`），
 * 所以导航行那边**必须**去掉 `aria-current`，否则一页里有两个「当前页」。
 */
const { trail } = useWorkspaceNav();
const containerLabel = computed(() => t("workspaceNav.workspaceContainer"));

/** 待审批总数：全局 store，**本组件直接读**（壳层也拿得到，不需要 props 透传）。 */
const pendingApprovalTotal = computed(() => agentStore.pendingApprovalTotal);

/**
 * 三态派生。**顺序有语义**：`connecting` 优先于 `connected` ——
 * 重连过程中 `isConnected` 可能仍是上一轮的 true，先判 connecting 才不会把
 * 「正在重连」读成「已连接」。
 */
const connectionState = computed<"connecting" | "connected" | "disconnected">(() => {
    if (connection.connecting) return "connecting";
    if (connection.connected) return "connected";
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
 * 断线会由页面横幅点名，状态点只负责「一眼看出在不在」）。
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
const showUsage = computed(() => typeof connection.usageInput === "number");
</script>

<template>
    <div
        data-testid="workspace-status-bar"
        class="flex h-6 shrink-0 items-center gap-3 border-t bg-muted/20 px-3 text-xs text-muted-foreground max-md:hidden"
    >
        <!-- 面包屑（task-160：从二级导航整段搬来；三段顺序与可点/不可点划分原样保留）。 -->
        <Breadcrumb
            data-testid="workspace-breadcrumb"
            :aria-label="t('workspaceNav.breadcrumbLabel')"
            class="min-w-0 text-muted-foreground"
        >
            <BreadcrumbList class="gap-1 text-xs">
                <BreadcrumbItem>
                    <BreadcrumbLink as-child class="hover:text-foreground">
                        <!--
                            根段在「会话」页时**恰好就是当前页**（`/workspace/:id`），vue-router 的
                            `RouterLink` 会自动加 `aria-current="page"` ⇒ 状态栏里出现两个「当前页」
                            （根链接 + 末段 `BreadcrumbPage`）。一页只能有一个：这里显式降级成
                            `aria-current="false"`（ARIA 规范里「明确不是当前项」），末段保留唯一的 page。
                        -->
                        <RouterLink :to="trail.rootPath" aria-current-value="false">{{
                            containerLabel
                        }}</RouterLink>
                    </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <!--
                    task-297：中间段 = **哪个工作区**（不可点：与第一段同址，两段相邻去同一处等于重复链接）。
                    不用 `BreadcrumbPage`：它硬写 `aria-current="page"`，一页只能有一个且属于末段。
                -->
                <BreadcrumbItem>
                    <span
                        data-testid="workspace-breadcrumb-container"
                        class="max-w-[16rem] truncate"
                    >
                        {{ trail.container.label }}
                    </span>
                </BreadcrumbItem>
                <BreadcrumbSeparator v-if="trail.page" />
                <BreadcrumbItem v-if="trail.page">
                    <BreadcrumbPage>{{ t(trail.page.labelKey) }}</BreadcrumbPage>
                </BreadcrumbItem>
            </BreadcrumbList>
        </Breadcrumb>

        <!-- 面包屑与读数之间的竖线：间距只分组、不分类，所以两种信息之间要有可见分隔。 -->
        <span aria-hidden="true" class="h-3 w-px shrink-0 bg-border" />

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
                t("workspace.statusBarUsage", {
                    input: connection.usageInput,
                    output: connection.usageOutput ?? 0,
                })
            }}</span>
        </span>
    </div>
</template>
