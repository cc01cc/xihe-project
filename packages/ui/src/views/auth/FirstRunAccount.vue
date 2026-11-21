<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError, type FirstRunAccountDisclosure } from "../../composables/api";

const { t } = useI18n();
const disclosure = ref<FirstRunAccountDisclosure | null>(null);
const username = ref("");
const password = ref("");
const busy = ref(false);
const attempted = ref(false);
const rewritten = ref(false);
const error = ref("");
let active = true;

onUnmounted(() => {
    active = false;
    disclosure.value = null;
    password.value = "";
});

async function reveal() {
    if (busy.value || attempted.value) return;
    attempted.value = true;
    busy.value = true;
    error.value = "";
    try {
        const result = await api.discloseFirstRunAccount();
        if (!active) return;
        disclosure.value = result;
        username.value = result.account.username;
    } catch (cause) {
        if (!active) return;
        error.value =
            cause instanceof ApiError && cause.problem.status === 410
                ? "onboarding.firstRunConsumed"
                : cause instanceof ApiError && cause.problem.status === 403
                  ? "onboarding.firstRunUnavailable"
                  : "onboarding.firstRunRevealFailed";
    } finally {
        if (active) busy.value = false;
    }
}

async function rewrite() {
    if (busy.value || password.value.length < 8 || password.value.length > 128) return;
    busy.value = true;
    error.value = "";
    try {
        await api.rewriteFirstRunAccount(password.value, username.value.trim() || undefined);
        if (!active) return;
        disclosure.value = null;
        password.value = "";
        rewritten.value = true;
    } catch {
        if (active) error.value = "onboarding.firstRunFailed";
    } finally {
        if (active) busy.value = false;
    }
}
</script>

<template>
    <div class="space-y-4">
        <p class="text-sm text-muted-foreground">{{ t("onboarding.firstRunIntro") }}</p>
        <button
            v-if="!attempted"
            type="button"
            class="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
            :disabled="busy"
            @click="reveal"
        >
            {{ t("onboarding.firstRunReveal") }}
        </button>
        <template v-if="disclosure">
            <p v-if="disclosure.state === 'generated-secret'" class="text-sm">
                {{ t("onboarding.firstRunOnce") }}
            </p>
            <p v-else class="text-sm">{{ t("onboarding.firstRunOperator") }}</p>
            <p class="text-sm">
                {{ t("onboarding.firstRunEmail") }}: {{ disclosure.account.email }}
            </p>
            <p
                v-if="disclosure.state === 'generated-secret' && disclosure.secret?.value"
                class="break-all text-sm"
            >
                {{ t("onboarding.firstRunSecret") }}: <code>{{ disclosure.secret.value }}</code>
            </p>
            <form class="space-y-4" @submit.prevent="rewrite">
                <label class="block text-sm" for="first-run-username">
                    {{ t("onboarding.firstRunUsername") }}
                </label>
                <input
                    id="first-run-username"
                    v-model="username"
                    autocomplete="username"
                    maxlength="32"
                    class="w-full rounded-md border bg-background px-3 py-2"
                />
                <label class="block text-sm" for="first-run-password">
                    {{ t("onboarding.firstRunNewPassword") }}
                </label>
                <input
                    id="first-run-password"
                    v-model="password"
                    type="password"
                    autocomplete="new-password"
                    minlength="8"
                    maxlength="128"
                    required
                    class="w-full rounded-md border bg-background px-3 py-2"
                />
                <button
                    type="submit"
                    :disabled="busy"
                    class="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-60"
                >
                    {{ t("onboarding.firstRunRewrite") }}
                </button>
            </form>
        </template>
        <p v-if="rewritten" role="status" class="text-sm">
            {{ t("onboarding.firstRunRewritten") }}
        </p>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ t(error) }}</p>
        <router-link
            :to="{ name: 'login' }"
            class="block text-center text-sm text-primary hover:underline"
        >
            {{ t("onboarding.firstRunLogin") }}
        </router-link>
    </div>
</template>
