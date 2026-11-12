<script setup lang="ts">
import { computed, provide, onMounted } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { useTheme } from "./composables/useTheme";
import { useMobileSafeArea } from "./composables/useMobileSafeArea";
import { ThemeInjectionKey } from "./types";
import { useConfigStore } from "./stores/config";
import { useAuthStore } from "./stores/auth";
import { useSessionStore } from "./stores/session";
import { Toaster } from "./components/ui/sonner";
import GlobalRail from "./components/sidebar/GlobalRail.vue";
import ModuleStage from "./layouts/ModuleStage.vue";
import router from "./router";

const theme = useTheme();
provide(ThemeInjectionKey, theme);
useMobileSafeArea();

const authStore = useAuthStore(),
    configStore = useConfigStore(),
    sessionStore = useSessionStore();

/**
 * PLAN-0762 T2.1/T2.2 —— 全局层（GlobalRail + ModuleStage）在根组件常驻一次：
 * 模块切换（工作台 / 设置）由全局条完成，模块舞台一次只装一个路由模块。
 * 全局条只在桌面（lg 及以上）渲染 —— 与既有 NavRail / 设置页 rail 的断点口径一致；
 * 移动端沿用各自的抽屉入口，不新增移动面（本卡非目标）。
 */
const isMobile = useMediaQuery("(max-width: 1023px)");
const currentRoute = computed(() => router.currentRoute.value);
const railVisible = computed(
    () =>
        authStore.isAuthenticated &&
        currentRoute.value.meta.requiresAuth === true &&
        !isMobile.value,
);

onMounted(async () => {
    // PLAN-0611: the initial navigation may still be resolving here. Reading `isAuthenticated`
    // before it settles sees the store's pre-navigation state and skips every post-login load
    // (config domains, sessions).
    await router.isReady();
    if (!authStore.isAuthenticated) return;
    // PLAN-0610 W5a: the cached user may predate the capability projection (no `capabilities`
    // field) or its capabilities may have been changed by another administrator. Refresh once
    // before the first permission-sensitive load so instance settings entries and instance config
    // layers neither flash nor disappear. Failure is soft: the cached user stays.
    await authStore.refreshCapabilities();
    // task-74：判据是 CP 的 `READ_INSTANCE_CONTENT` 原子（`ConfigController.java:89-90/:207-220`），
    // 不是 `cap:instance:admin` —— 能力位与动作原子互不蕴含，混用会造出新的不同轴。
    configStore
        .loadAllDomains({ canReadInstanceContent: authStore.canReadInstanceContent })
        .catch(() => {
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
    <div class="flex h-screen overflow-hidden bg-background text-foreground">
        <!-- 唯一 router-view：全局层不得为鉴权页另开第二个 outlet（BL-344 的实例重挂教训）。 -->
        <GlobalRail v-if="railVisible" />
        <ModuleStage>
            <router-view />
        </ModuleStage>
    </div>
    <Toaster />
</template>
