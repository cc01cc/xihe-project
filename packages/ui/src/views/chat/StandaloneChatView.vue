<script setup lang="ts">
/**
 * task-373 / `D-1228` + `D-1236`（Lead 批：前端-only、极简、单 commit 可整块回退）。
 *
 * <p>独立会话（无工作区）的聊天页。它只解决一件事：**一个无工作区的会话能被打开**。
 * 所以这里没有工作区 chrome（页签栏 / 文件树 / dock 都属于工作区），也没有收件人 / 参与者轨 /
 * 工具结果那套更宽的会话 UI —— 那些还没讨论，不在本页提前建。</p>
 *
 * <p><b>为什么复用 `ChatPanel`：</b>它的 props 只有 `sessionId`（+ 可选 toolMode / isMobile），
 * 本来就工作区无关。`toolMode` 保持默认 `none`：无工作区 ⇒ 无文件上下文，文件/工具操作归
 * 工作区绑定会话。</p>
 *
 * <p><b>为什么进页面就清工作区上下文：</b>CP 的会话读门按 workspace **相等**过滤
 * （`SessionReadAccess#resolve`），带着 tab 工作区头读 `workspace_id IS NULL` 的会话必然 404；
 * 只有不带（或空）头的请求才走行探针（`ChatController` D-47-05）。清之前先把 live 投影存进
 * 按组缓存，否则左栏那一组会显示成假空态。</p>
 *
 * <p><b>高度链：</b>本页不在 `/workspace/*` 下 ⇒ `AppLayout` 不渲染页签栏，`main` 自身滚动、
 * 路由视口是 `display:contents`。所以这里用 `h-full`（main 有确定高度）而不是 `flex-1`
 * （main 此时不是 flex 容器，`flex-1` 不生效）。</p>
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Loader2, MessageSquare } from "@lucide/vue";
import ChatPanel from "../../features/workspace/chat/components/ChatPanel.vue";
import { api, ApiError } from "../../composables/api";
import { useAuthStore } from "../../stores/auth";
import { useSessionStore } from "../../stores/session";
import { workspaceChatPath } from "../../lib/routes";
import { logger } from "../../lib/logger";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const auth = useAuthStore();
const sessionStore = useSessionStore();

const sessionId = computed(() => String(route.params.sessionId ?? ""));
const loading = ref(true);
const error = ref<string | null>(null);
const title = ref("");

async function load(id: string): Promise<void> {
    if (!id) return;
    loading.value = true;
    error.value = null;
    try {
        const record = await api.getSession(id);
        if (record.workspaceId) {
            // 这条会话其实属于某个工作区：送它回该去的地方，而不是在这里渲染一个半残页。
            void router.replace(workspaceChatPath(record.workspaceId, id));
            return;
        }
        sessionStore.applySessionRecord(record);
        sessionStore.selectSession(id);
        title.value = record.title;
    } catch (cause) {
        error.value = cause instanceof ApiError ? cause.message : t("standaloneChat.failed");
        logger.error("Load standalone session failed", { sessionId: id, cause });
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    const previousWorkspaceId = auth.currentWorkspaceId;
    if (previousWorkspaceId) sessionStore.cacheLiveSessionsFor(previousWorkspaceId);
    auth.enterWorkspaceless();
    void load(sessionId.value);
});

watch(sessionId, (id) => void load(id));
</script>

<template>
    <div data-testid="standalone-chat" class="flex h-full min-h-0 flex-col">
        <header
            data-testid="standalone-chat-header"
            class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4"
        >
            <MessageSquare class="size-4 shrink-0 opacity-70" aria-hidden="true" />
            <h1
                data-testid="standalone-chat-title"
                class="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
            >
                {{ title || t("standaloneChat.untitled") }}
            </h1>
            <span
                data-testid="standalone-chat-badge"
                class="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
            >
                {{ t("sidebar.standaloneGroup") }}
            </span>
        </header>

        <div
            v-if="loading"
            data-testid="standalone-chat-loading"
            class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
        >
            <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
            {{ t("standaloneChat.loading") }}
        </div>

        <div
            v-else-if="error"
            data-testid="standalone-chat-error"
            class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        >
            <p class="text-sm text-foreground">{{ t("standaloneChat.failed") }}</p>
            <p class="break-words text-xs text-muted-foreground">{{ error }}</p>
            <button
                type="button"
                data-testid="standalone-chat-retry"
                class="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="load(sessionId)"
            >
                {{ t("common.retry") }}
            </button>
        </div>

        <ChatPanel v-else :session-id="sessionId" class="min-h-0 flex-1" />
    </div>
</template>
