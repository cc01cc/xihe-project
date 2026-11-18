<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { computed, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { useConfigStore } from "../../stores/config";
import { safeRedirect } from "../../router/safeRedirect";
import { Sun } from "@lucide/vue";

const { t } = useI18n(),
    router = useRouter(),
    route = useRoute(),
    auth = useAuthStore(),
    config = useConfigStore();

// PLAN-0565 ruling #7: identifier is email or username.
const identifier = ref(""),
    password = ref(""),
    errorMsg = ref<string | null>(null),
    phase = ref<"idle" | "submitting" | "entering">("idle"),
    busy = computed(() => phase.value !== "idle");

function rateLimitMessage(): string | null {
    if (auth.lastError?.code !== "AUTH_RATE_LIMITED") return null;
    const seconds = auth.lastError.retryAfterSeconds;
    return seconds ? t("login.rateLimitedSeconds", { seconds }) : t("login.rateLimited");
}

/** Shared post-authentication transition so both entries behave identically. */
async function enterWorkspace() {
    phase.value = "entering";
    // task-74：与 `App.vue` 同一契约，判据同 CP 的 `READ_INSTANCE_CONTENT` 原子
    // （`ConfigController.java:89-90`），不查能力位。
    config.loadAllDomains({ canReadInstanceContent: auth.canReadInstanceContent }).catch(() => {
        // 后端不可用时使用本地持久化配置；错误已在 store 中记录
    });
    // task-224 档 4：`?redirect=` 是外来输入（可能被手工改、也可能是登出链遗留的嵌套串），
    // 一律过 `safeRedirect`：入口页/已嵌套/站外/超长都回落到 `/workbench`（模块入口，
    // `task-34` / `D-1122`；fallback 在 `router/safeRedirect.ts` 里）。原文写的是 `/workspace`，
    // 入口改名后这句成了过期注释（`task-146` 收口）。
    const redirect = safeRedirect(route.query.redirect);
    try {
        const failure = await router.push(redirect);
        if (failure) {
            phase.value = "idle";
            errorMsg.value = t("login.navigationFailed");
        }
    } catch {
        phase.value = "idle";
        errorMsg.value = t("login.navigationFailed");
    }
}

async function handleSubmit() {
    if (phase.value !== "idle" || !identifier.value || !password.value) return;
    phase.value = "submitting";
    errorMsg.value = null;
    const ok = await auth.login(identifier.value, password.value);
    if (!ok) {
        errorMsg.value = rateLimitMessage() ?? auth.error;
        phase.value = "idle";
        return;
    }
    // Keep the form locked through the route transition: the old code cleared
    // `loading` before the un-awaited push, which reopened the submit window.
    await enterWorkspace();
}
</script>

<template>
    <!-- task-81：页面根即主内容区 ⇒ 用 HTML main 元素给出顶层 landmark
         （W3C ARIA APG · Main Landmark：每页一个、应为顶层地标、用 main 元素定义）。
         auth 面无侧栏，故不套 SidebarInset（它带 sidebar 布局语义，产品代码里也零引用）。 -->
    <main class="flex items-center justify-center min-h-screen bg-muted/30">
        <div class="w-full max-w-md p-8 bg-background rounded-xl shadow-sm border">
            <div class="text-center mb-6">
                <div class="mb-2 text-3xl"><Sun class="mx-auto size-8" aria-hidden="true" /></div>
                <h1 class="text-2xl font-bold">{{ t("login.title") }}</h1>
                <p class="text-sm text-muted-foreground mt-1">{{ t("login.hint") }}</p>
            </div>

            <form class="space-y-4" :aria-busy="busy" @submit.prevent="handleSubmit">
                <div>
                    <label class="block text-sm font-medium mb-1" for="identifier">{{
                        t("login.username")
                    }}</label>
                    <input
                        id="identifier"
                        v-model="identifier"
                        type="text"
                        name="identifier"
                        autocomplete="username"
                        :disabled="busy"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
                    />
                </div>
                <div>
                    <label class="block text-sm font-medium mb-1" for="password">{{
                        t("login.password")
                    }}</label>
                    <input
                        id="password"
                        v-model="password"
                        type="password"
                        name="password"
                        autocomplete="current-password"
                        :disabled="busy"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
                    />
                </div>
                <!--
                    task-125：禁用观感不靠整行 opacity，且文字色**按分支给全**。
                    ① 原静态 text-primary-foreground 与禁用分支的 text-muted-foreground 同特异性
                    （0,1,0），源码序前者恒胜 ⇒ 分支文字色一直是死类，禁用键实际=白字 on washed 灰底
                    （light 实测 1.539 / dark 1.529）。② 原 disabled:opacity-40 再把整体压到
                    1.194 / 1.208（<3:1 禁用判据）。修法：静态只留布局/光标，两个分支各带完整
                    底色+字色（启用 = bg-primary + text-primary-foreground；未就绪/提交中 =
                    bg-muted-foreground/30 + text-muted-foreground，washed 灰底表达"不可点"），
                    实测 light ≈3.3 / dark ≈4.6，达标且观感不变。disabled:cursor-not-allowed 保留
                    （pointer-events 未关，光标真实生效）。
                -->
                <button
                    type="submit"
                    class="w-full py-2 px-4 rounded-md font-medium transition-colors disabled:cursor-not-allowed"
                    :class="
                        identifier && password && !busy
                            ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
                            : 'bg-muted-foreground/30 text-muted-foreground'
                    "
                    :disabled="!identifier || !password || busy"
                >
                    {{
                        phase === "submitting"
                            ? t("login.loggingIn")
                            : phase === "entering"
                              ? t("login.entering")
                              : t("login.login")
                    }}
                </button>

                <p v-if="errorMsg" class="text-sm text-destructive text-center">{{ errorMsg }}</p>

                <p class="text-sm text-center text-muted-foreground">
                    {{ t("login.noAccount") }}
                    <router-link to="/register" class="text-primary hover:underline font-medium">{{
                        t("login.register")
                    }}</router-link>
                </p>
            </form>
        </div>
    </main>
</template>
