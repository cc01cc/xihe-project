<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { computed, onMounted, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { useConfigStore } from "../../stores/config";
import { api } from "../../composables/api";
import { logger } from "../../lib/logger";
import { Button } from "../../components/ui/button";
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

/**
 * BL-150 A: the passwordless entry only exists on a local (loopback single-user) instance. The
 * bootstrap signal is the CP's own answer, so the button can never appear on a normal deployment.
 */
const localMode = ref(false);
const localLoginBusy = ref(false);

onMounted(async () => {
    try {
        const status = await api.bootstrapStatus();
        localMode.value = status.localMode === true;
    } catch (e) {
        // Fail closed: no signal means no passwordless button.
        logger.warn("Failed to read bootstrap status: " + (e instanceof Error ? e.message : e));
        localMode.value = false;
    }
});

function rateLimitMessage(): string | null {
    if (auth.lastError?.code !== "AUTH_RATE_LIMITED") return null;
    const seconds = auth.lastError.retryAfterSeconds;
    return seconds ? t("login.rateLimitedSeconds", { seconds }) : t("login.rateLimited");
}

/** Shared post-authentication transition so both entries behave identically. */
async function enterWorkspace() {
    phase.value = "entering";
    config.loadAllDomains({ isAdmin: auth.isAdmin }).catch(() => {
        // 后端不可用时使用本地持久化配置；错误已在 store 中记录
    });
    const redirect = (route.query.redirect as string) || "/workspace";
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

/** BL-150 A: passwordless re-entry; CP answers 409 when the instance is not single-user. */
async function handleLocalLogin() {
    if (phase.value !== "idle" || localLoginBusy.value) return;
    localLoginBusy.value = true;
    errorMsg.value = null;
    const ok = await auth.localLogin();
    localLoginBusy.value = false;
    if (!ok) {
        errorMsg.value =
            auth.lastError?.code === "LOCAL_SINGLE_USER_REQUIRED"
                ? t("login.localSingleUserRequired")
                : auth.error;
        return;
    }
    await enterWorkspace();
}
</script>

<template>
    <div class="flex items-center justify-center min-h-screen bg-muted/30">
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
                <button
                    type="submit"
                    class="w-full py-2 px-4 rounded-md font-medium text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    :class="
                        identifier && password && !busy
                            ? 'bg-primary hover:bg-primary/90'
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

                <!-- BL-150 A: local single-user instance → passwordless entry (never on a normal deployment). -->
                <div v-if="localMode" class="space-y-2 border-t pt-4">
                    <Button
                        type="button"
                        variant="outline"
                        class="w-full"
                        data-testid="login-local-mode"
                        :disabled="busy || localLoginBusy"
                        @click="handleLocalLogin"
                    >
                        {{ localLoginBusy ? t("login.localLoggingIn") : t("login.localLogin") }}
                    </Button>
                    <p class="text-xs text-center text-muted-foreground">
                        {{ t("login.localModeHint") }}
                    </p>
                </div>

                <p class="text-sm text-center text-muted-foreground">
                    {{ t("login.noAccount") }}
                    <router-link to="/register" class="text-primary hover:underline font-medium">{{
                        t("login.register")
                    }}</router-link>
                </p>
            </form>
        </div>
    </div>
</template>
