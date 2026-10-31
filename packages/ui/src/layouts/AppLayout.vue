<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { PanelLeftOpen } from "@lucide/vue";
import Sidebar from "../components/sidebar/Sidebar.vue";
import { useAgentStore } from "../stores/agent";
import { useAuthStore } from "../stores/auth";
import { useSessionStore } from "../stores/session";
import { workspaceChatPath } from "../lib/routes";
import { clearLayoutStorage, useWorkspaceLayout } from "../composables/useWorkspaceLayout";

const mobileMediaQuery =
    typeof window === "undefined" || typeof window.matchMedia !== "function"
        ? null
        : window.matchMedia("(max-width: 767px)");
const isMobile = ref(mobileMediaQuery?.matches ?? false);
const { navOpen, navWidth, mainOffset } = useWorkspaceLayout({ isMobile });
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const agentStore = useAgentStore();
const auth = useAuthStore();
const sessionStore = useSessionStore();
const pendingPollIntervalMs = 10_000;
let pendingPollTimer: ReturnType<typeof setInterval> | null = null;

const mainMargin = computed(() => `${mainOffset.value}px`);

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

onMounted(() => {
    if (mobileMediaQuery) {
        if (typeof mobileMediaQuery.addEventListener === "function") {
            mobileMediaQuery.addEventListener("change", updateViewport);
        } else {
            mobileMediaQuery.addListener(updateViewport);
        }
    }
    void auth.hydrateWorkspace();
    refreshPendingApprovals();
    pendingPollTimer = setInterval(refreshPendingApprovals, pendingPollIntervalMs);
});

onUnmounted(() => {
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
        <Sidebar v-model:open="navOpen" v-model:width="navWidth" :is-mobile="isMobile" />
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
            class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-surface-content transition-[margin] duration-300"
            :style="{ marginLeft: mainMargin }"
        >
            <div
                v-if="firstPendingOtherSession"
                data-testid="global-pending-approval-banner"
                class="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm backdrop-blur-sm"
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
            <router-view />
        </main>
    </div>
</template>
