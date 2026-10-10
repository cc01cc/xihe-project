<script setup lang="ts">
import { provide, onMounted } from "vue";
import { useTheme } from "./composables/useTheme";
import { ThemeInjectionKey } from "./types";
import { useConfigStore } from "./stores/config";
import { useAuthStore } from "./stores/auth";
import { useSessionStore } from "./stores/session";
import { Toaster } from "./components/ui/sonner";

const theme = useTheme();
provide(ThemeInjectionKey, theme);

const authStore = useAuthStore(),
    configStore = useConfigStore(),
    sessionStore = useSessionStore();
onMounted(async () => {
    if (!authStore.isAuthenticated) return;
    configStore.loadAllDomains().catch(() => {
        // 后端不可用时使用本地持久化配置；错误已在 store 中记录
    });
    if (authStore.currentWorkspaceId) {
        try {
            await sessionStore.loadSessions();
        } catch {
            // 拉取失败不阻塞启动；错误已在 SessionStore 中记录
        }
    }
});
</script>

<template>
    <router-view />
    <Toaster />
</template>
