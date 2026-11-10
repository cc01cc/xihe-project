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
import { FieldControl, FieldError, FieldLabel, FieldRoot, FormRoot } from "reka-ui";
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
    /** PLAN-0753 M2: server-side errors keyed by field name, cleared by reka on edit. */
    serverErrors = ref<Record<string, string | string[]>>({});

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
        serverErrors.value = {};
    },
    { immediate: true },
);

/** PLAN-0753 M2: field rules — one per FieldRoot.validate, pure functions of the value. */
function validateToken(value: unknown): string | null {
    return typeof value === "string" && value ? null : t("credentials.errTokenRequired");
}
function validateKeyPair(value: unknown): string | null {
    const raw = typeof value === "string" ? value : "";
    return raw ? null : t("credentials.errKeyPairRequired");
}

async function submit() {
    submitting.value = true;
    serverErrors.value = {};
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
        serverErrors.value = { __form: credentialErrorText(e, t) };
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
            <FormRoot class="space-y-4" :errors="serverErrors" @form-submit="submit">
                <FieldRoot
                    v-if="kind === 'token'"
                    name="token"
                    class="space-y-1.5"
                    :validate="validateToken"
                    required
                >
                    <FieldLabel class="text-sm font-medium">
                        {{ t("credentials.token") }}
                    </FieldLabel>
                    <div class="flex items-center gap-2">
                        <FieldControl as-child>
                            <Input
                                v-model="token"
                                data-testid="credentials-replace-token"
                                :type="tokenVisible ? 'text' : 'password'"
                                autocomplete="off"
                            />
                        </FieldControl>
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
                    <FieldError
                        class="text-xs text-destructive"
                        data-testid="credentials-replace-token-error"
                    />
                </FieldRoot>
                <template v-else>
                    <FieldRoot
                        name="accessKey"
                        class="space-y-1.5"
                        :validate="validateKeyPair"
                        required
                    >
                        <FieldLabel class="text-sm font-medium">
                            {{ t("credentials.accessKey") }}
                        </FieldLabel>
                        <div class="flex items-center gap-2">
                            <FieldControl as-child>
                                <Input
                                    v-model="accessKey"
                                    data-testid="credentials-replace-access-key"
                                    :type="accessKeyVisible ? 'text' : 'password'"
                                    autocomplete="off"
                                />
                            </FieldControl>
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
                        <FieldError
                            class="text-xs text-destructive"
                            data-testid="credentials-replace-access-key-error"
                        />
                    </FieldRoot>
                    <FieldRoot
                        name="secretKey"
                        class="space-y-1.5"
                        :validate="validateKeyPair"
                        required
                    >
                        <FieldLabel class="text-sm font-medium">
                            {{ t("credentials.secretKey") }}
                        </FieldLabel>
                        <div class="flex items-center gap-2">
                            <FieldControl as-child>
                                <Input
                                    v-model="secretKey"
                                    data-testid="credentials-replace-secret-key"
                                    :type="secretKeyVisible ? 'text' : 'password'"
                                    autocomplete="off"
                                />
                            </FieldControl>
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
                        <FieldError
                            class="text-xs text-destructive"
                            data-testid="credentials-replace-secret-key-error"
                        />
                    </FieldRoot>
                </template>

                <p
                    v-if="serverErrors.__form"
                    data-testid="credentials-replace-error"
                    class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                    {{ serverErrors.__form }}
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
            </FormRoot>
        </DialogContent>
    </Dialog>
</template>
