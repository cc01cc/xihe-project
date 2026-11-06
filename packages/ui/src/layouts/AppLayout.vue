<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { PanelLeftOpen } from "@lucide/vue";
import Sidebar from "../components/sidebar/Sidebar.vue";
import WorkspaceTabBar from "../features/workspace/components/WorkspaceTabBar.vue";
import SseSubscriberLimitNotice from "../features/workspace/components/SseSubscriberLimitNotice.vue";
import { createUserChannelSse } from "../features/workspace/chat/useUserChannelSSE";
import {
    clearSseSubscriberLimit,
    reportSseSubscriberLimit,
} from "../features/workspace/composables/sseSubscriberLimit";
import { useSessionParticipantsStore } from "../features/workspace/stores/sessionParticipants";
import { useUserQuestionsStore } from "../features/workspace/stores/userQuestions";
import { useAgentStore } from "../stores/agent";
import { useAuthStore } from "../stores/auth";
import { useSessionStore } from "../stores/session";
import { workspaceChatPath } from "../lib/routes";
import {
    WORKSPACE_LAYOUT_KEY,
    clearLayoutStorage,
    useWorkspaceLayout,
} from "../composables/useWorkspaceLayout";

const mobileMediaQuery =
    typeof window === "undefined" || typeof window.matchMedia !== "function"
        ? null
        : window.matchMedia("(max-width: 767px)");
const isMobile = ref(mobileMediaQuery?.matches ?? false);
const workspaceLayout = useWorkspaceLayout({ isMobile });
const { navOpen, navWidth, mainOffset, navYielded } = workspaceLayout;
// S5-W2: the workbench publishes its squeeze demand here (single geometry owner).
provide(WORKSPACE_LAYOUT_KEY, workspaceLayout);
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const agentStore = useAgentStore();
const auth = useAuthStore();
const sessionStore = useSessionStore();
const participantsStore = useSessionParticipantsStore();
const userQuestionsStore = useUserQuestionsStore();
const pendingPollIntervalMs = 10_000;
let pendingPollTimer: ReturnType<typeof setInterval> | null = null;

const mainMargin = computed(() => `${mainOffset.value}px`);

/**
 * S3a: the route tab bar is part of the workspace shell. It renders for the four
 * sibling workspace routes only (`/workspace/:ws`, `/chat/:sid`, `/environment`,
 * `/scheduled-tasks`, `/settings`), never for the global `/settings/config` pages
 * or on mobile (the mobile flow keeps its sheets).
 */
const workspaceTabBarWorkspaceId = computed(() => {
    const fromRoute = route.params.workspaceId;
    if (typeof fromRoute === "string" && fromRoute) return fromRoute;
    return auth.currentWorkspaceId ?? "";
});
const workspaceTabBarSessionId = computed(() => {
    const fromRoute = route.params.sessionId;
    if (typeof fromRoute === "string" && fromRoute) return fromRoute;
    return sessionStore.currentSessionId;
});
const workspaceTabBarVisible = computed(
    () =>
        !isMobile.value &&
        route.path.startsWith("/workspace") &&
        Boolean(workspaceTabBarWorkspaceId.value),
);

const currentRouteSessionId = computed(() => {
    const sessionId = route.params.sessionId;
    if (typeof sessionId === "string" && sessionId !== "default") return sessionId;
    if (route.path === "/workspace" || route.path.startsWith("/workspace/")) {
        return sessionStore.currentSessionId;
    }
    return null;
});

const pendingForOtherSessions = computed(() =>
    agentStore.pendingApprovalSummaries.filter(
        (summary) => summary.count > 0 && summary.sessionId !== currentRouteSessionId.value,
    ),
);

const pendingForOtherSessionCount = computed(() =>
    pendingForOtherSessions.value.reduce((total, summary) => total + summary.count, 0),
);

const totalPendingApprovalCount = computed(() =>
    agentStore.pendingApprovalSummaries.reduce((total, summary) => total + summary.count, 0),
);

const firstPendingOtherSession = computed(() => pendingForOtherSessions.value[0] ?? null);

function refreshPendingApprovals() {
    if (!auth.isAuthenticated || !auth.currentWorkspaceId) {
        agentStore.clearPendingApprovals();
        return;
    }
    void agentStore.refreshPendingApprovals(false, auth.currentWorkspaceId ?? undefined);
}

function goToFirstPendingSession() {
    const pending = firstPendingOtherSession.value;
    const currentWorkspaceId =
        (route.params.workspaceId as string | undefined) ?? auth.currentWorkspaceId;
    if (pending && currentWorkspaceId) {
        void router.push(workspaceChatPath(currentWorkspaceId, pending.sessionId));
    }
}

function updateViewport() {
    const nextIsMobile = mobileMediaQuery?.matches ?? false;
    if (nextIsMobile === isMobile.value) return;

    isMobile.value = nextIsMobile;
    navOpen.value = !nextIsMobile;
}

watch(
    () => route.fullPath,
    () => {
        if (isMobile.value) navOpen.value = false;
        refreshPendingApprovals();
    },
);

// PLAN-0582 V10: layout is user-scoped state. Dropping it here (instead of in
// the auth store) keeps the single writer in the layout layer while still
// covering logout and cross-tab logout broadcasts.
watch(
    () => auth.isAuthenticated,
    (isAuthenticated) => {
        if (!isAuthenticated) clearLayoutStorage();
    },
);

watch(
    () => [auth.user?.id, auth.currentWorkspaceId] as const,
    ([userId, workspaceId], previous) => {
        if (userId === previous?.[0] && workspaceId === previous?.[1]) return;
        agentStore.reset();
        if (userId && workspaceId) refreshPendingApprovals();
    },
);

/**
 * PLAN-0660 T5.6 —— user-channel（`GET /api/v1/user-events`）的**唯一生产挂载点**。
 *
 * 为什么选 AppLayout，而不是 App/tab/面板：
 * - 频道是**用户级**的（`spec/session/user-channel.md` §4：只按 Bearer 认证、无 workspace 上下文），
 *   所以只要登录着就该有一条连接，而不是每个会话或每个面板各开一条；挂在某个 tab 里会让"切走
 *   tab 就收不到通知"变成设计缺陷。
 * - AppLayout 是登录后的壳（`/login`、`/register`、`/onboarding` 都不用它），生命周期天然与
 *   "已登录会话"对齐：`onMounted` 开、`onUnmounted`（登出跳转 / 壳销毁）关，成对且不在未登录
 *   状态下空转。再往上是 App，那里没有卸载点，反而要自己造一次性 flag。
 * - 与下方 pending-approval 轮询同一形状（挂载开、卸载停），不用再造一套生命周期抽象。
 *
 * hint 只做一件事：交给 `sessionParticipants` store 的合并器，由它决定"是不是当前会话"并
 * 至多触发一次名单重读（顺序/去重/重连全在已有实现里，这里不重复判定）。因此重连时服务端重投
 * 同一帧是幂等的，多标签页也只是各自多读一次名单。
 */
const userChannel = createUserChannelSse({
    getToken: () => auth.token,
    onNotified: (sessionId, participantId) => {
        participantsStore.onUserChannelHint(sessionId, participantId);
    },
    // PLAN-0660 T5.18/T5.19：`user_question` 帧只带 `{questionId,sessionId,state}`，**没有正文**
    // （§4 的 hint 语义），所以这里不做任何本地改写，只把用户级投影标脏 —— store 内部 300ms 合并、
    // 到点整体重拉，重复帧因此不会追加出重复条目。
    onQuestion: (questionId, sessionId, state) => {
        userQuestionsStore.onUserChannelHint(questionId, sessionId, state);
    },
    // T5.18 的另一半：通道**不 replay**，断线期间的事件不补发，所以每次握手成功（含重连）都要重拉
    // 投影。首连也走这里，因此挂载时不必再单独拉一次（通道连不上时徽标本就不该谎报旧状态）。
    onConnected: () => {
        void userQuestionsStore.reload();
    },
    // BL-335：撞上 `429 USER_CHANNEL_FULL` 时通道自己停掉重连（上限是持续态），这里只负责
    // 把"该页数据已停止刷新"的指引交给壳级横幅。
    onSubscriberLimit: (code) => {
        reportSseSubscriberLimit(code);
    },
});

onMounted(() => {
    if (mobileMediaQuery) {
        if (typeof mobileMediaQuery.addEventListener === "function") {
            mobileMediaQuery.addEventListener("change", updateViewport);
        } else {
            mobileMediaQuery.addListener(updateViewport);
        }
    }
    void auth.hydrateWorkspace();
    // PLAN-0660 T5.6：已登录才开流（未登录的壳不该对着空 token 起一轮退避重连）。
    if (auth.isAuthenticated) userChannel.start();
    refreshPendingApprovals();
    pendingPollTimer = setInterval(refreshPendingApprovals, pendingPollIntervalMs);
});

onUnmounted(() => {
    // PLAN-0660 T5.6：成对卸载 —— dispose 会 abort 在途 fetch 并清掉退避定时器，不留重连循环。
    userChannel.dispose();
    // PLAN-0660 T5.19：成对作废投影 —— 清合并窗 + 让在途响应失效 + 复位成「未加载」。
    // 只清 timer 不够：store 是进程级单例，快速换账号时旧请求回来会写进新账号的列表。
    userQuestionsStore.dispose();
    // BL-335：壳卸载（登出/切账号）时清掉订阅上限状态，避免下一个人看到上一个会话的横幅。
    clearSseSubscriberLimit();
    if (pendingPollTimer) {
        clearInterval(pendingPollTimer);
        pendingPollTimer = null;
    }
    agentStore.abortPendingRefresh();
    if (mobileMediaQuery) {
        if (typeof mobileMediaQuery.removeEventListener === "function") {
            mobileMediaQuery.removeEventListener("change", updateViewport);
        } else {
            mobileMediaQuery.removeListener(updateViewport);
        }
    }
});
</script>

<template>
    <div class="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar
            v-model:open="navOpen"
            v-model:width="navWidth"
            :is-mobile="isMobile"
            :force-collapsed="navYielded"
        />
        <button
            v-if="!navOpen && isMobile"
            type="button"
            data-testid="mobile-sidebar-toggle"
            aria-label="Open navigation"
            title="Open navigation"
            class="fixed right-3 top-3 z-30 inline-flex size-9 items-center justify-center rounded-md border bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent"
            @click="navOpen = true"
        >
            <PanelLeftOpen class="size-4" />
        </button>
        <main
            class="min-h-0 min-w-0 flex-1 bg-surface-content transition-[margin] duration-300"
            :class="
                workspaceTabBarVisible
                    ? 'flex flex-col overflow-hidden'
                    : 'overflow-x-hidden overflow-y-auto'
            "
            :style="{ marginLeft: mainMargin }"
        >
            <!-- BL-335：SSE 订阅上限（429）是持续态，用壳级横幅常驻；重新连上后自动消失。 -->
            <SseSubscriberLimitNotice />

            <div
                v-if="firstPendingOtherSession"
                data-testid="global-pending-approval-banner"
                class="sticky top-0 z-20 flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm backdrop-blur-sm"
                role="status"
            >
                <div class="min-w-0">
                    <p class="font-medium">{{ t("sidebar.pendingApprovalBanner") }}</p>
                    <p class="text-xs text-muted-foreground">
                        <span class="tabular-nums">{{ pendingForOtherSessionCount }}</span>
                        {{ t("sidebar.pendingApprovalCount") }}
                    </p>
                </div>
                <button
                    type="button"
                    data-testid="global-pending-approval-go-to"
                    class="shrink-0 rounded-md border border-amber-500/40 px-3 py-1.5 text-sm font-medium transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="goToFirstPendingSession"
                >
                    {{ t("sidebar.pendingApprovalGoTo") }}
                </button>
            </div>
            <div data-testid="pending-approval-live" aria-live="polite" class="sr-only">
                {{ t("sidebar.pendingApprovalLive") }}: {{ totalPendingApprovalCount }}
            </div>
            <!-- S3a: the middle route tab bar belongs to the workspace shell, so it
               survives navigation between the four sibling workspace routes. -->
            <WorkspaceTabBar
                v-if="workspaceTabBarVisible"
                :workspace-id="workspaceTabBarWorkspaceId"
                :session-id="workspaceTabBarSessionId"
            />
            <!--
                BL-344 残留（根治）：这里**只能有一个 `<router-view>`**。
                历史上是 `v-if` 分支里一个 + `v-else` 一个 —— 两个不同的 outlet 实例，
                当视口跨断点切换（`workspaceTabBarVisible` 随 `isMobile` 翻转）时，被路由的页面
                会**整体卸载重挂**（`e2e` 观测：被观察容器内 `mutations=0`、输入被清空，
                因为旧节点是连根移除的）。用户可见后果：正在填的表单草稿丢失。
                现在统一为一个 outlet，只切换外层容器是否参与布局：
                - 有页签栏（桌面 /workspace）：flex 列，页面拿到页签栏以下的剩余高度；
                - 无页签栏（移动）：`contents`（display:contents）让子节点等价于 `main` 的直接子节点，
                  布局与旧的 `v-else` 分支逐像素一致，但**不换实例**。
            -->
            <!-- 单一 router-view：断点切换不得换实例（否则路由页面整体重挂、草稿丢失；见 BL-344）。 -->
            <div
                class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
                :class="workspaceTabBarVisible ? '' : 'contents'"
                data-testid="workspace-route-viewport"
            >
                <router-view />
            </div>
        </main>
    </div>
</template>
