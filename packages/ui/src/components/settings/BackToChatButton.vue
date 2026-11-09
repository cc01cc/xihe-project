<script setup lang="ts">
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useSessionStore } from "../../stores/session";
import { ArrowLeft } from "@lucide/vue";
import { useAuthStore } from "../../stores/auth";
import { workspaceChatPath, workspacePath } from "../../lib/routes";

const router = useRouter();
const { t } = useI18n();
const sessionStore = useSessionStore(),
    auth = useAuthStore();

/**
 * 「返回聊天」的目标页：当前会话 → 该会话；否则 → 当前工作区；再否则 → 工作区选择面。
 * 这是**历史回退不可用时的兜底**，不是常规路径（常规路径见 `goBack`）。
 */
function pushChat() {
    const id = sessionStore.currentSessionId;
    if (id) {
        const workspaceId = sessionStore.currentSession?.workspaceId ?? auth.currentWorkspaceId;
        if (workspaceId) router.push(workspaceChatPath(workspaceId, id));
        else router.push("/workspace");
    } else {
        const workspaceId = auth.currentWorkspaceId;
        router.push(workspaceId ? workspacePath(workspaceId) : "/workspace");
    }
}

/**
 * task-36 ②：返回聊天**优先走历史回退**。
 *
 * <p>原实现每次点都 `router.push(聊天)`，于是「聊天 → 设置 → 返回聊天 → 再进设置 → 再返回」每轮都新增一条
 * 历史，浏览器后退键要按很多下才回得去（<b>历史堆积</b>）。判据：</p>
 * <ol>
 *   <li>上一条历史就是聊天/工作区页 ⇒ `router.back()`：回到用户真正来的地方，且**不新增**历史；</li>
 *   <li>否则（新标签直链、上一条是另一个设置页、或根本没有历史）⇒ `pushChat()`：保证一次点击就能离开设置区，
 *       因为按钮文案承诺的是「返回聊天」，把用户退回上一个设置页不算兑现。</li>
 * </ol>
 * <p>`router.options.history.state.back` 只在 web history 下有值（memory history 下为 null），读取时按未知形状防御。</p>
 */
function goBack() {
    const historyState = router.options.history.state as { back?: string | null } | undefined;
    const previous = historyState?.back ?? null;
    const cameFromChat =
        typeof previous === "string" &&
        (previous === "/workspace" || previous.startsWith("/workspace/"));
    if (cameFromChat) {
        router.back();
        return;
    }
    pushChat();
}
</script>

<template>
    <button
        data-testid="settings-back-to-chat"
        class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        @click="goBack"
    >
        <ArrowLeft class="size-4" aria-hidden="true" />
        {{ t("chat.backToChat") }}
    </button>
</template>
