<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { onMounted, ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { api } from "../../composables/api";
import { Sun } from "@lucide/vue";

const { t } = useI18n(),
    router = useRouter(),
    route = useRoute(),
    auth = useAuthStore();

const email = ref(""),
    name = ref(""),
    password = ref(""),
    localMode = ref(false),
    errorMsg = ref<string | null>(null),
    loading = ref(false);

onMounted(async () => {
    try {
        localMode.value = (await api.bootstrapStatus()).localMode;
    } catch {
        // Non-fatal: fall back to requiring a password.
        localMode.value = false;
    }
});

const canSubmit = () =>
    Boolean(email.value) && (localMode.value || Boolean(password.value)) && !loading.value;

async function handleSubmit() {
    if (!canSubmit()) return;
    loading.value = true;
    errorMsg.value = null;
    const ok = await auth.register(email.value, password.value, name.value);
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
                        t("onboarding.username")
                    }}</label>
                    <input
                        id="email"
                        v-model="email"
                        type="text"
                        name="email"
                        autocomplete="email"
                        class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    />
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
                <div v-if="!localMode">
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
                    />
                </div>
                <p v-else class="text-sm text-muted-foreground">{{ t("onboarding.localHint") }}</p>

                <button
                    type="submit"
                    class="w-full py-2 px-4 rounded-md font-medium text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    :class="
                        canSubmit()
                            ? 'bg-primary hover:bg-primary/90'
                            : 'bg-muted-foreground/30 text-muted-foreground'
                    "
                    :disabled="!canSubmit()"
                >
                    {{ loading ? t("onboarding.creating") : t("onboarding.submit") }}
                </button>

                <p v-if="errorMsg" class="text-sm text-destructive text-center">{{ errorMsg }}</p>
            </form>
        </div>
    </div>
</template>
