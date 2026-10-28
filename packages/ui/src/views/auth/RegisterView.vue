<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { Sun } from "@lucide/vue";

const { t } = useI18n(),
    router = useRouter(),
    auth = useAuthStore();

const email = ref(""),
    username = ref(""),
    password = ref(""),
    confirmPassword = ref(""),
    localError = ref<string | null>(null),
    phase = ref<"idle" | "submitting" | "entering">("idle"),
    busy = computed(() => phase.value !== "idle");

const passwordMismatch = computed(() => {
    return !!(confirmPassword.value && password.value !== confirmPassword.value);
});

function rateLimitMessage(): string | null {
    if (auth.lastError?.code !== "AUTH_RATE_LIMITED") return null;
    const seconds = auth.lastError.retryAfterSeconds;
    return seconds ? t("register.rateLimitedSeconds", { seconds }) : t("register.rateLimited");
}

async function handleSubmit() {
    if (phase.value !== "idle" || !email.value || !password.value) return;
    if (password.value !== confirmPassword.value) {
        localError.value = t("common.passwordMismatch");
        return;
    }
    phase.value = "submitting";
    localError.value = null;
    const name = email.value.includes("@") ? email.value.split("@")[0] : email.value,
        ok = await auth.register(email.value, password.value, name, username.value || undefined);
    if (!ok) {
        localError.value = rateLimitMessage() ?? auth.error;
        phase.value = "idle";
        return;
    }
    phase.value = "entering";
    try {
        const failure = await router.push("/workspace");
        if (failure) {
            phase.value = "idle";
            localError.value = t("register.navigationFailed");
        }
    } catch {
        phase.value = "idle";
        localError.value = t("register.navigationFailed");
    }
}
</script>

<template>
    <div class="flex items-center justify-center min-h-screen bg-muted/30">
        <div class="w-full max-w-md p-8 bg-background rounded-xl shadow-sm border">
            <div class="text-center mb-6">
                <div class="mb-2 text-3xl"><Sun class="mx-auto size-8" aria-hidden="true" /></div>
                <h1 class="text-2xl font-bold">{{ t("register.title") }}</h1>
            </div>
            <p class="text-sm text-muted-foreground mb-6">{{ t("login.hint") }}</p>

            <form class="space-y-4" :aria-busy="busy" @submit.prevent="handleSubmit">
                <div>
                    <label class="block text-sm font-medium mb-1" for="email">{{
                        t("register.email")
                    }}</label>
                    <input
                        id="email"
                        v-model="email"
                        type="text"
                        name="email"
                        autocomplete="email"
                        :disabled="busy"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
                    />
                </div>
                <div>
                    <label class="block text-sm font-medium mb-1" for="username">{{
                        t("register.username")
                    }}</label>
                    <input
                        id="username"
                        v-model="username"
                        type="text"
                        name="username"
                        autocomplete="username"
                        :disabled="busy"
                        :placeholder="t('register.usernameHint')"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
                    />
                </div>
                <div>
                    <label class="block text-sm font-medium mb-1" for="password">{{
                        t("register.password")
                    }}</label>
                    <input
                        id="password"
                        v-model="password"
                        type="password"
                        name="password"
                        autocomplete="new-password"
                        :disabled="busy"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
                    />
                </div>
                <div>
                    <label class="block text-sm font-medium mb-1" for="confirmPassword">{{
                        t("register.confirmPassword")
                    }}</label>
                    <input
                        id="confirmPassword"
                        v-model="confirmPassword"
                        type="password"
                        name="confirmPassword"
                        autocomplete="new-password"
                        :disabled="busy"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
                        :class="passwordMismatch ? 'ring-1 ring-destructive' : ''"
                    />
                    <p v-if="passwordMismatch" class="text-xs text-destructive mt-1">
                        {{ t("common.passwordMismatch") }}
                    </p>
                </div>

                <p v-if="localError" class="text-sm text-destructive">{{ localError }}</p>

                <button
                    type="submit"
                    :disabled="busy || !email || !password || passwordMismatch"
                    class="w-full px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                    {{
                        phase === "submitting"
                            ? t("register.submitting")
                            : phase === "entering"
                              ? t("register.entering")
                              : t("register.submit")
                    }}
                </button>

                <p class="text-sm text-center text-muted-foreground">
                    {{ t("login.hasAccount") }}
                    <router-link to="/login" class="text-primary hover:underline">{{
                        t("login.login")
                    }}</router-link>
                </p>
            </form>
        </div>
    </div>
</template>
