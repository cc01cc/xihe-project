<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { computed, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { Sun } from "@lucide/vue";

const { t } = useI18n(),
    router = useRouter(),
    route = useRoute(),
    auth = useAuthStore();

const email = ref(""),
    name = ref(""),
    password = ref(""),
    errorMsg = ref<string | null>(null),
    loading = ref(false),
    emailTouched = ref(false),
    passwordTouched = ref(false);

/** Client-side mirror of the CP's email shape; the server stays the authority (400). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const emailError = computed(() => {
    if (!emailTouched.value) return null;
    const value = email.value.trim();
    if (!value) return t("onboarding.emailRequired");
    return EMAIL_PATTERN.test(value) ? null : t("onboarding.emailInvalid");
});

const passwordError = computed(() => {
    if (!passwordTouched.value || password.value) return null;
    return t("onboarding.passwordRequired");
});

const canSubmit = () =>
    Boolean(email.value.trim()) &&
    EMAIL_PATTERN.test(email.value.trim()) &&
    Boolean(password.value) &&
    !loading.value;

async function handleSubmit() {
    // The submit button stays clickable when the form is incomplete so the inline errors can
    // explain what is missing (BL-151: a disabled button plus zero feedback was the bug).
    emailTouched.value = true;
    passwordTouched.value = true;
    if (!canSubmit()) return;
    loading.value = true;
    errorMsg.value = null;
    const ok = await auth.register(email.value.trim(), password.value, name.value);
    loading.value = false;
    if (ok) {
        router.push((route.query.redirect as string) || "/workspace");
    } else {
        errorMsg.value = auth.error ?? t("onboarding.failed");
    }
}
</script>

<template>
    <div class="flex items-center justify-center min-h-screen bg-muted/30">
        <div class="w-full max-w-md p-8 bg-background rounded-xl shadow-sm border">
            <div class="text-center mb-6">
                <div class="mb-2 text-3xl"><Sun class="mx-auto size-8" aria-hidden="true" /></div>
                <h1 class="text-2xl font-bold">{{ t("onboarding.title") }}</h1>
                <p class="text-sm text-muted-foreground mt-1">{{ t("onboarding.hint") }}</p>
            </div>

            <form class="space-y-4" @submit.prevent="handleSubmit">
                <div>
                    <label class="block text-sm font-medium mb-1" for="email">{{
                        t("onboarding.email")
                    }}</label>
                    <input
                        id="email"
                        v-model="email"
                        type="email"
                        inputmode="email"
                        name="email"
                        autocomplete="email"
                        @blur="emailTouched = true"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    <p
                        v-if="emailError"
                        role="alert"
                        data-testid="onboarding-email-error"
                        class="mt-1 text-sm text-destructive"
                    >
                        {{ emailError }}
                    </p>
                </div>
                <div>
                    <label class="block text-sm font-medium mb-1" for="name">{{
                        t("onboarding.name")
                    }}</label>
                    <input
                        id="name"
                        v-model="name"
                        type="text"
                        name="name"
                        autocomplete="name"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                </div>
                <div>
                    <label class="block text-sm font-medium mb-1" for="password">{{
                        t("onboarding.password")
                    }}</label>
                    <input
                        id="password"
                        v-model="password"
                        type="password"
                        name="password"
                        autocomplete="new-password"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                        @blur="passwordTouched = true"
                    />
                    <p
                        v-if="passwordError"
                        role="alert"
                        data-testid="onboarding-password-error"
                        class="mt-1 text-sm text-destructive"
                    >
                        {{ passwordError }}
                    </p>
                </div>

                <button
                    type="submit"
                    class="w-full py-2 px-4 rounded-md font-medium text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    :class="
                        canSubmit()
                            ? 'bg-primary hover:bg-primary/90'
                            : 'bg-muted-foreground/30 text-muted-foreground'
                    "
                    :disabled="loading"
                >
                    {{ loading ? t("onboarding.creating") : t("onboarding.submit") }}
                </button>

                <p v-if="errorMsg" class="text-sm text-destructive text-center">{{ errorMsg }}</p>
            </form>
        </div>
    </div>
</template>
