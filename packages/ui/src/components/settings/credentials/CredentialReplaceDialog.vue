<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Eye, EyeOff, LoaderCircle } from "@lucide/vue";
import Dialog from "../../ui/dialog/Dialog.vue";
import DialogContent from "../../ui/dialog/DialogContent.vue";
import DialogHeader from "../../ui/dialog/DialogHeader.vue";
import DialogTitle from "../../ui/dialog/DialogTitle.vue";
import DialogDescription from "../../ui/dialog/DialogDescription.vue";
import DialogFooter from "../../ui/dialog/DialogFooter.vue";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ApiError } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { useCredentialsStore } from "../../../stores/credentials";
import { credentialErrorText } from "./errorText";
import type { CredentialKind } from "../../../types";

const props = withDefaults(
    defineProps<{
        open: boolean;
        credentialId: string;
        kind: CredentialKind;
    }>(),
    { open: false, kind: "token" },
);

const emit = defineEmits<{
    close: [];
    replaced: [];
}>();

const { t } = useI18n(),
    store = useCredentialsStore();

const token = ref(""),
    accessKey = ref(""),
    secretKey = ref(""),
    tokenVisible = ref(false),
    accessKeyVisible = ref(false),
    secretKeyVisible = ref(false),
    submitting = ref(false),
    formError = ref("");

watch(
    () => props.open,
    (open) => {
        if (!open) return;
        token.value = "";
        accessKey.value = "";
        secretKey.value = "";
        tokenVisible.value = false;
        accessKeyVisible.value = false;
        secretKeyVisible.value = false;
        submitting.value = false;
        formError.value = "";
    },
    { immediate: true },
);

function validate(): string {
    if (props.kind === "token") {
        if (!token.value) return t("credentials.errTokenRequired");
    } else if (!accessKey.value || !secretKey.value) {
        return t("credentials.errKeyPairRequired");
    }
    return "";
}

async function submit() {
    const error = validate();
    if (error) {
        formError.value = error;
        return;
    }
    submitting.value = true;
    formError.value = "";
    try {
        const payload =
            props.kind === "token"
                ? { token: token.value }
                : { accessKey: accessKey.value, secretKey: secretKey.value };
        await store.replace(props.credentialId, payload);
        toast.success(t("credentials.replaceSuccess"));
        emit("replaced");
        emit("close");
    } catch (e) {
        formError.value = credentialErrorText(e, t);
        if (!(e instanceof ApiError)) {
            logger.warn("Credential replace failed", e);
        }
    } finally {
        submitting.value = false;
    }
}
</script>

<template>
    <Dialog :open="open" @update:open="(value: boolean) => !value && emit('close')">
        <DialogContent class="max-w-lg" data-testid="credentials-replace-dialog">
            <DialogHeader>
                <DialogTitle>{{ t("credentials.replaceTitle") }}</DialogTitle>
                <DialogDescription>{{ t("credentials.replaceDesc") }}</DialogDescription>
            </DialogHeader>
            <form class="space-y-4" @submit.prevent="submit">
                <div v-if="kind === 'token'" class="space-y-1.5">
                    <label class="text-sm font-medium" for="credential-replace-token">{{
                        t("credentials.token")
                    }}</label>
                    <div class="flex items-center gap-2">
                        <Input
                            id="credential-replace-token"
                            v-model="token"
                            data-testid="credentials-replace-token"
                            :type="tokenVisible ? 'text' : 'password'"
                            autocomplete="off"
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            data-testid="credentials-replace-token-toggle"
                            :aria-label="
                                tokenVisible
                                    ? t('credentials.hideValue')
                                    : t('credentials.showValue')
                            "
                            @click="tokenVisible = !tokenVisible"
                        >
                            <EyeOff v-if="tokenVisible" aria-hidden="true" />
                            <Eye v-else aria-hidden="true" />
                        </Button>
                    </div>
                </div>
                <template v-else>
                    <div class="space-y-1.5">
                        <label class="text-sm font-medium" for="credential-replace-access-key">{{
                            t("credentials.accessKey")
                        }}</label>
                        <div class="flex items-center gap-2">
                            <Input
                                id="credential-replace-access-key"
                                v-model="accessKey"
                                data-testid="credentials-replace-access-key"
                                :type="accessKeyVisible ? 'text' : 'password'"
                                autocomplete="off"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                data-testid="credentials-replace-access-key-toggle"
                                :aria-label="
                                    accessKeyVisible
                                        ? t('credentials.hideValue')
                                        : t('credentials.showValue')
                                "
                                @click="accessKeyVisible = !accessKeyVisible"
                            >
                                <EyeOff v-if="accessKeyVisible" aria-hidden="true" />
                                <Eye v-else aria-hidden="true" />
                            </Button>
                        </div>
                    </div>
                    <div class="space-y-1.5">
                        <label class="text-sm font-medium" for="credential-replace-secret-key">{{
                            t("credentials.secretKey")
                        }}</label>
                        <div class="flex items-center gap-2">
                            <Input
                                id="credential-replace-secret-key"
                                v-model="secretKey"
                                data-testid="credentials-replace-secret-key"
                                :type="secretKeyVisible ? 'text' : 'password'"
                                autocomplete="off"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                data-testid="credentials-replace-secret-key-toggle"
                                :aria-label="
                                    secretKeyVisible
                                        ? t('credentials.hideValue')
                                        : t('credentials.showValue')
                                "
                                @click="secretKeyVisible = !secretKeyVisible"
                            >
                                <EyeOff v-if="secretKeyVisible" aria-hidden="true" />
                                <Eye v-else aria-hidden="true" />
                            </Button>
                        </div>
                    </div>
                </template>

                <p
                    v-if="formError"
                    data-testid="credentials-replace-error"
                    class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                    {{ formError }}
                </p>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        data-testid="credentials-replace-cancel"
                        @click="emit('close')"
                    >
                        {{ t("credentials.cancel") }}
                    </Button>
                    <Button
                        type="submit"
                        data-testid="credentials-replace-submit"
                        :disabled="submitting"
                    >
                        <LoaderCircle v-if="submitting" class="animate-spin" aria-hidden="true" />
                        {{
                            submitting ? t("credentials.replacing") : t("credentials.replaceSubmit")
                        }}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>
</template>
