<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Copy, Eye, EyeOff, LoaderCircle } from "@lucide/vue";
import Dialog from "../../ui/dialog/Dialog.vue";
import DialogContent from "../../ui/dialog/DialogContent.vue";
import DialogHeader from "../../ui/dialog/DialogHeader.vue";
import DialogTitle from "../../ui/dialog/DialogTitle.vue";
import DialogDescription from "../../ui/dialog/DialogDescription.vue";
import DialogFooter from "../../ui/dialog/DialogFooter.vue";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { api, ApiError } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { credentialRevealErrorText } from "./errorText";

const props = withDefaults(
    defineProps<{
        open: boolean;
        credentialId: string;
        label?: string;
    }>(),
    { open: false, label: "" },
);

const emit = defineEmits<{
    close: [];
}>();

const { t } = useI18n();

const AUTO_HIDE_SECONDS = 30;

const password = ref(""),
    submitting = ref(false),
    error = ref(""),
    value = ref<string | null>(null),
    valueVisible = ref(true),
    countdown = ref(AUTO_HIDE_SECONDS);

let timer: ReturnType<typeof setInterval> | null = null;

function stopTimer() {
    if (timer !== null) {
        clearInterval(timer);
        timer = null;
    }
}

function clearValue() {
    value.value = null;
    stopTimer();
}

function startAutoHide() {
    countdown.value = AUTO_HIDE_SECONDS;
    stopTimer();
    timer = setInterval(() => {
        countdown.value -= 1;
        if (countdown.value <= 0) clearValue();
    }, 1000);
}

function reset() {
    password.value = "";
    submitting.value = false;
    error.value = "";
    value.value = null;
    valueVisible.value = true;
    stopTimer();
}

watch(
    () => props.open,
    (open) => {
        if (!open) {
            reset();
            return;
        }
        reset();
    },
);

async function submit() {
    if (submitting.value || value.value !== null) return;
    if (!password.value) {
        error.value = t("credentials.revealPasswordRequired");
        return;
    }
    submitting.value = true;
    error.value = "";
    try {
        const result = await api.revealCredential(props.credentialId, password.value);
        value.value = result.value;
        valueVisible.value = true;
        password.value = "";
        startAutoHide();
    } catch (e) {
        password.value = "";
        error.value = credentialRevealErrorText(e, t);
        if (!(e instanceof ApiError)) {
            logger.warn("Credential reveal failed", e);
        }
    } finally {
        submitting.value = false;
    }
}

async function copyValue() {
    if (value.value === null) return;
    try {
        await navigator.clipboard.writeText(value.value);
        toast.success(t("credentials.revealCopied"));
    } catch (e) {
        logger.warn("Clipboard write failed for a revealed credential", e);
        toast.error(t("credentials.revealCopyFailed"));
    }
}

onBeforeUnmount(() => {
    reset();
});
</script>

<template>
    <Dialog :open="open" @update:open="(next: boolean) => !next && emit('close')">
        <DialogContent class="max-w-lg" data-testid="credentials-reveal-dialog">
            <DialogHeader>
                <DialogTitle>
                    {{ t("credentials.revealTitle")
                    }}<template v-if="label"> · {{ label }}</template>
                </DialogTitle>
                <DialogDescription>{{ t("credentials.revealDesc") }}</DialogDescription>
            </DialogHeader>

            <form v-if="value === null" class="space-y-4" @submit.prevent="submit">
                <div class="space-y-1.5">
                    <label class="text-sm font-medium" for="credential-reveal-password">{{
                        t("credentials.revealPassword")
                    }}</label>
                    <Input
                        id="credential-reveal-password"
                        v-model="password"
                        data-testid="credentials-reveal-password"
                        type="password"
                        autocomplete="off"
                    />
                </div>
                <p
                    v-if="error"
                    data-testid="credentials-reveal-error"
                    class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                    {{ error }}
                </p>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        data-testid="credentials-reveal-cancel"
                        @click="emit('close')"
                    >
                        {{ t("credentials.cancel") }}
                    </Button>
                    <Button
                        type="submit"
                        data-testid="credentials-reveal-submit"
                        :disabled="submitting"
                    >
                        <LoaderCircle v-if="submitting" class="animate-spin" aria-hidden="true" />
                        {{
                            submitting ? t("credentials.revealBusy") : t("credentials.revealSubmit")
                        }}
                    </Button>
                </DialogFooter>
            </form>

            <div v-else class="space-y-3">
                <div class="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
                    <code
                        data-testid="credentials-reveal-value"
                        class="min-w-0 flex-1 break-all font-mono text-xs"
                        >{{ valueVisible ? value : "••••••••" }}</code
                    >
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        data-testid="credentials-reveal-toggle"
                        :aria-label="
                            valueVisible ? t('credentials.hideValue') : t('credentials.showValue')
                        "
                        @click="valueVisible = !valueVisible"
                    >
                        <EyeOff v-if="valueVisible" aria-hidden="true" />
                        <Eye v-else aria-hidden="true" />
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        data-testid="credentials-reveal-copy"
                        :aria-label="t('credentials.revealCopied')"
                        @click="copyValue"
                    >
                        <Copy aria-hidden="true" />
                    </Button>
                </div>
                <p data-testid="credentials-reveal-countdown" class="text-xs text-muted-foreground">
                    {{ t("credentials.revealAutoHide") }} ({{ countdown }}s) ·
                    {{ t("credentials.revealValueHint") }}
                </p>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        data-testid="credentials-reveal-close"
                        @click="emit('close')"
                    >
                        {{ t("credentials.close") }}
                    </Button>
                </DialogFooter>
            </div>
        </DialogContent>
    </Dialog>
</template>
