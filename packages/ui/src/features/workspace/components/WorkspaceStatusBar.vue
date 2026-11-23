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
import { ShieldAlert } from "@lucide/vue";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "../../../components/ui/breadcrumb";
import { useAgentStore } from "../../../stores/agent";
import { useAuthStore } from "../../../stores/auth";
import { useWorkspaceConnectionStore } from "../../../stores/workspaceConnection";
import { useWorkspaceEventStatus } from "../composables/useWorkspaceEventStatus";
import { useWorkspaceNav } from "../composables/useWorkspaceNav";

const { t } = useI18n();
const agentStore = useAgentStore();
const auth = useAuthStore();
const connection = useWorkspaceConnectionStore();

/**
 * 沙箱执行面读数（task-134 / DSD-1507 ②）—— 从会话头搬下来的**唯一**一项状态。
 *
 * <p><b>判据</b>：只有 `windows-host`（direct_attach，无文件系统授权限制、只限启动目录）
 * 需要常显警示 —— 换句话说是「你以为有沙箱限制，其实没有」这件事只在这一个后端成立。
 * `windows-mxc` / `docker` 的隔离是常态，占位反而是噪音，故整节点不渲染（DOM 里不存在，
 * 判据可断言 count 为 0）。</p>
 *
 * <p><b>为什么条件只看 executionMode，没有第二个「FS 限制」标志</b>：wire 面
 * （`ApiWorkspace` / `WORKSPACE_WIRE_FIELDS`，`composables/api.ts:153`）**没有**任何
 * 文件系统限制字段，14 个键里能表达这件事的只有 `executionMode`；`windows-host` 就是
 * 「不限读写范围」的那个后端。若将来 CP 加了限制位，条件应改成
 * `executionMode === "windows-host" && !workspace.fsRestricted`（届时同步改本注释与 spec）。</p>
 *
 * <p><b>文案沿用既有 key</b>：`workspace.sandboxEnforcement`（全文）/ `...Short`（行内），
 * 与搬走前的会话头徽标同一句，不新造措辞。</p>
 */
const showSandboxReading = computed(() => auth.workspace?.executionMode === "windows-host");
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
 * 四态派生**已收敛到 `composables/useWorkspaceEventStatus`**（task-10 item 3 / batch-2 #3）：
 * 原先这里与聊天页徽标 `WorkspaceView.vue` 各写一套（此处四态、那里二态），同一屏会出现
 * 「文件事件重连中」与「本页未订阅文件事件」互相矛盾的两句。派生顺序与文案的唯一实现
 * 见该 composable；本组件只负责视觉（文字 + 状态点颜色）。
 */
const { state: connectionState, label: connectionLabel } = useWorkspaceEventStatus();

/**
 * 状态点颜色。**不用品牌色**（注意力预算：状态点不是 CTA）：
 * 已连接 = 绿（成功语义）、连接中 = 琥珀（进行中）、未连接 = 灰（中性，不是错误红 ——
 * 断线会由页面横幅点名，状态点只负责「一眼看出在不在」）。
 *
 * <p>task-81：新增的「本页未订阅」走 `default` ⇒ **灰**，与「未连接」同色而非另立一种颜色。
 * 理由（裁定原文）：别让新态引入第三种颜色语义 —— 未订阅不是故障，不该占用琥珀/红。
 * 两态靠**文案**区分（「本页未订阅文件事件」vs「文件事件未连接」），不靠颜色。</p>
 *
 * <p>**task-83：不透明度从 `/40` 提到实心 —— 存量无障碍违例的修复。**
 * 实测（WCAG 2.2 SC 1.4.11 非文本 UI 3:1；颜色探针 `e2e/helpers/color.ts` 的
 * `contrastRatio`，走 computed → oklab/oklch → sRGB → WCAG，前景 alpha 合成到**已全链合成**
 * 的背景上，不是停在半透明层）：</p>
 *
 * ```text
 *   bg-muted-foreground/40   light 1.72 : 1   dark 2.16 : 1   ← 两个主题都不达标（违例）
 *   bg-muted-foreground      light 5.05 : 1   dark 6.74 : 1   ← task-83 修复后，双双 ≥3:1
 *   （实测口径：环境页状态栏 / chrome-beta；读数取 getComputedStyle 全链合成后再算 WCAG）
 * ```
 *
 * <p>**归属：存量缺陷，非 task-81/83 引入。** `bg-muted-foreground/40` 由 task-312
 * (`9c9042d76`) 引入，task-81 只是复用了 `default` 分支。task-81 之前它只有
 * disconnected 一个主人，task-81 之后 unsubscribed 也落进来 ⇒ 违例的**暴露面**变大了，
 * 但颜色本身没动。</p>
 *
 * <p>为什么不按「装饰性」豁免：点带 `aria-hidden="true"` ⇒ 它对屏幕阅读器隐形 ⇒
 * 它恰恰是视觉用户的线索 ⇒ 豁免的前提（「还有别的线索」）在颜色通道上不成立
 * （1.72:1 连「这点颜色有变化」都可能看不出）。裁定：(a) 按状态线索判 3:1，无豁免。</p>
 */
const dotClass = computed(() => {
    switch (connectionState.value) {
        case "connecting":
            return "bg-amber-500";
        case "connected":
            return "bg-emerald-600";
        // unsubscribed 与 disconnected 都落 default（灰）：靠文案区分，不靠颜色（见上）。
        default:
            return "bg-muted-foreground";
    }
});

/** 有 run 才显示用量；`0` 也是有效读数（不能因为 0 就隐藏）。 */
const showUsage = computed(() => typeof connection.usageInput === "number");

/**
 * 计费来源与费用（task-941 从 `WorkspaceView` 会话头搬来，wire 值来自
 * `workspaceConnection` store 对 `chatStore.getSessionLastUsage` 的只读派生）。
 *
 * <p>**文案全部来自 i18n**（`workspace.usageSource*` / `workspace.usageCostUnmapped` /
 * `workspace.usageCostNote*`），本组件只做 `t(key)`：wire 原值 → key 的映射表在
 * `stores/workspaceConnection.ts`（`USAGE_SOURCE_I18N_KEYS` / `USAGE_COST_NOTE_I18N_KEYS`），
 * 所以「改文案」永远只改语言包、不在模板里写死。</p>
 *
 * <p>`cost` 语义沿用 CP `UsageCostMapper`：`null` = 没有定价或没有 token 计数。两者用不同
 * 文案区分 —— `fallback`（这一轮根本没有 token 计数）显示破折号（「没有这个读数」），
 * 其余显示「未定价」（「有数但没定价」）。凭空写 `$0` 会把「没有定价」说成「这次免费」。</p>
 */
const usageSourceLabel = computed(() => {
    const key = connection.usageSourceKey;
    return key ? t(key) : (connection.usageSource ?? "");
});
const usageCostText = computed(() => {
    if (connection.usageCost != null) return `$${connection.usageCost}`;
    return connection.usageSource === "fallback" ? "—" : t("workspace.usageCostUnmapped");
});
const usageCostTitle = computed(() =>
    connection.usageCost != null
        ? ""
        : t(connection.usageCostNoteKey ?? "workspace.usageCostNoteUnknown"),
);
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

        <!--
            ①b 沙箱执行面（task-134：从会话头搬来）：只有 windows-host 无 FS 限制时占位，
            其它后端整节点不渲染（理由与条件见 script 里 showSandboxReading 的注释）。
        -->
        <span
            v-if="showSandboxReading"
            data-testid="workspace-status-sandbox"
            :data-sandbox-enforcement="'unrestricted-fs'"
            role="note"
            class="inline-flex shrink-0 items-center gap-1 text-amber-700 dark:text-amber-300"
            :title="t('workspace.sandboxEnforcement')"
            :aria-label="t('workspace.sandboxEnforcement')"
        >
            <ShieldAlert class="size-3 shrink-0" aria-hidden="true" />
            <span>{{ t("workspace.sandboxEnforcementShort") }}</span>
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
            <!--
                task-941：费用（`$x` / 「未定价」/「—」）与计费来源（真实计费/估算/用量兜底）。
                `data-cost-source` / `data-cost-note` / `data-source` 保留 wire 原值供排障，
                可见文本一律走 i18n（判据见上方 script 注释）。
            -->
            <span
                data-testid="workspace-status-usage-cost"
                :data-cost-source="connection.usageCostSource ?? ''"
                :data-cost-note="connection.usageCostNote ?? ''"
                :title="usageCostTitle || undefined"
                class="shrink-0"
                >{{ usageCostText }}</span
            >
            <span
                v-if="connection.usageSource"
                data-testid="workspace-status-usage-source"
                :data-source="connection.usageSource"
                class="shrink-0"
                >{{ usageSourceLabel }}</span
            >
        </span>
    </div>
</template>
