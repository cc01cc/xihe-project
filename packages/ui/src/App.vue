<script setup lang="ts">
import { provide, onMounted } from "vue";
import { useTheme } from "./composables/useTheme";
import { useMobileSafeArea } from "./composables/useMobileSafeArea";
import { ThemeInjectionKey } from "./types";
import { useConfigStore } from "./stores/config";
import { useAuthStore } from "./stores/auth";
import { useSessionStore } from "./stores/session";
import { Toaster } from "./components/ui/sonner";
import router from "./router";

const theme = useTheme();
provide(ThemeInjectionKey, theme);
useMobileSafeArea();

const authStore = useAuthStore(),
    configStore = useConfigStore(),
    sessionStore = useSessionStore();
onMounted(async () => {
    // PLAN-0611: the initial navigation may still be resolving here — it can also perform the
    // localMode passwordless sign-in. Reading `isAuthenticated` before it settles sees the store's
    // pre-navigation state and skips every post-login load (config domains, sessions).
    await router.isReady();
    if (!authStore.isAuthenticated) return;
    // PLAN-0610 W5a: the cached user may predate the capability projection (no `capabilities`
    // field) or its capabilities may have been changed by another administrator. Refresh once
    // before the first `isAdmin`-sensitive load so instance settings entries and instance config
    // layers neither flash nor disappear. Failure is soft: the cached user stays.
    await authStore.refreshCapabilities();
    configStore.loadAllDomains({ isAdmin: authStore.isAdmin }).catch(() => {
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
