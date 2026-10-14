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
import { api, ApiError, type ApiWorkspace } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { useCredentialsStore } from "../../../stores/credentials";
import { credentialErrorText } from "./errorText";
import type { CredentialDeliveryTier, CredentialKind, CredentialOwnerType } from "../../../types";

const props = withDefaults(
    defineProps<{
        open: boolean;
    }>(),
    { open: false },
);

const emit = defineEmits<{
    close: [];
    created: [];
}>();

const { t } = useI18n(),
    store = useCredentialsStore();

const label = ref(""),
    kind = ref<CredentialKind>("token"),
    deliveryTier = ref<CredentialDeliveryTier>("lease"),
    ownerType = ref<CredentialOwnerType>("USER"),
    workspaceId = ref(""),
    token = ref(""),
    accessKey = ref(""),
    secretKey = ref(""),
    tokenVisible = ref(false),
    accessKeyVisible = ref(false),
    secretKeyVisible = ref(false),
    submitting = ref(false),
    formError = ref("");

const workspaces = ref<ApiWorkspace[]>([]),
    workspacesLoading = ref(false);

function reset() {
    label.value = "";
    kind.value = "token";
    deliveryTier.value = "lease";
    ownerType.value = "USER";
    workspaceId.value = "";
    token.value = "";
    accessKey.value = "";
    secretKey.value = "";
    tokenVisible.value = false;
    accessKeyVisible.value = false;
    secretKeyVisible.value = false;
    submitting.value = false;
    formError.value = "";
}

watch(
    () => props.open,
    (open) => {
        if (!open) return;
        reset();
        if (ownerType.value === "WORKSPACE") void ensureWorkspaces();
    },
    { immediate: true },
);

watch(ownerType, (value) => {
    if (value === "WORKSPACE") void ensureWorkspaces();
});

async function ensureWorkspaces() {
    if (workspaces.value.length > 0 || workspacesLoading.value) return;
    workspacesLoading.value = true;
    try {
        workspaces.value = await api.listWorkspaces();
    } catch (e) {
        logger.warn("Failed to load workspaces for the credential owner picker", e);
    } finally {
        workspacesLoading.value = false;
    }
}

function validate(): string {
    if (!label.value.trim()) return t("credentials.errLabelRequired");
    if (kind.value === "token") {
        if (!token.value) return t("credentials.errTokenRequired");
    } else if (!accessKey.value || !secretKey.value) {
        return t("credentials.errKeyPairRequired");
    }
    if (ownerType.value === "WORKSPACE" && !workspaceId.value) {
        return t("credentials.errWorkspaceRequired");
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
        await store.create({
            label: label.value.trim(),
            kind: kind.value,
            deliveryTier: deliveryTier.value,
            ...(ownerType.value === "WORKSPACE"
                ? { ownerType: ownerType.value, ownerId: workspaceId.value }
                : {}),
            ...(kind.value === "token"
                ? { token: token.value }
                : { accessKey: accessKey.value, secretKey: secretKey.value }),
        });
        toast.success(t("credentials.createSuccess"));
        emit("created");
        emit("close");
    } catch (e) {
        formError.value = credentialErrorText(e, t);
        if (!(e instanceof ApiError)) {
            logger.warn("Credential create failed", e);
        }
    } finally {
        submitting.value = false;
    }
}
</script>

<template>
    <Dialog :open="open" @update:open="(value: boolean) => !value && emit('close')">
        <DialogContent class="max-w-lg" data-testid="credentials-create-dialog">
            <DialogHeader>
                <DialogTitle>{{ t("credentials.createTitle") }}</DialogTitle>
                <DialogDescription>{{ t("credentials.createDesc") }}</DialogDescription>
            </DialogHeader>
            <form class="space-y-4" @submit.prevent="submit">
                <div class="space-y-1.5">
                    <label class="text-sm font-medium" for="credential-label">{{
                        t("credentials.label")
                    }}</label>
                    <Input
                        id="credential-label"
                        v-model="label"
                        data-testid="credentials-create-label"
                        :maxlength="128"
                        autocomplete="off"
                    />
                </div>

                <div class="grid gap-4 sm:grid-cols-2">
                    <div class="space-y-1.5">
                        <label class="text-sm font-medium" for="credential-kind">{{
                            t("credentials.kind")
                        }}</label>
                        <select
                            id="credential-kind"
                            v-model="kind"
                            data-testid="credentials-create-kind"
                            class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                        >
                            <option value="token">{{ t("credentials.kindToken") }}</option>
                            <option value="key_pair">{{ t("credentials.kindKeyPair") }}</option>
                        </select>
                    </div>
                    <div class="space-y-1.5">
                        <label class="text-sm font-medium" for="credential-tier">{{
                            t("credentials.tier")
                        }}</label>
                        <select
                            id="credential-tier"
                            v-model="deliveryTier"
                            data-testid="credentials-create-tier"
                            class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                        >
                            <option value="lease">{{ t("credentials.tierLease") }}</option>
                            <option value="reveal">{{ t("credentials.tierReveal") }}</option>
                        </select>
                    </div>
                </div>
                <p
                    data-testid="credentials-create-tier-hint"
                    class="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                >
                    {{
                        deliveryTier === "lease"
                            ? t("credentials.tierLeaseHint")
                            : t("credentials.tierRevealHint")
                    }}
                </p>

                <div class="grid gap-4 sm:grid-cols-2">
                    <div class="space-y-1.5">
                        <label class="text-sm font-medium" for="credential-owner">{{
                            t("credentials.owner")
                        }}</label>
                        <select
                            id="credential-owner"
                            v-model="ownerType"
                            data-testid="credentials-create-owner"
                            class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                        >
                            <option value="USER">{{ t("credentials.ownerUser") }}</option>
                            <option value="WORKSPACE">{{ t("credentials.ownerWorkspace") }}</option>
                        </select>
                    </div>
                    <div v-if="ownerType === 'WORKSPACE'" class="space-y-1.5">
                        <label class="text-sm font-medium" for="credential-workspace">{{
                            t("credentials.ownerWorkspaceSelect")
                        }}</label>
                        <select
                            id="credential-workspace"
                            v-model="workspaceId"
                            data-testid="credentials-create-workspace"
                            class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                            :disabled="workspacesLoading"
                        >
                            <option value="">—</option>
                            <option v-for="ws in workspaces" :key="ws.id" :value="ws.id">
                                {{ ws.name }}
                            </option>
                        </select>
                    </div>
                </div>

                <div v-if="kind === 'token'" class="space-y-1.5">
                    <label class="text-sm font-medium" for="credential-token">{{
                        t("credentials.token")
                    }}</label>
                    <div class="flex items-center gap-2">
                        <Input
                            id="credential-token"
                            v-model="token"
                            data-testid="credentials-create-token"
                            :type="tokenVisible ? 'text' : 'password'"
                            autocomplete="off"
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            data-testid="credentials-create-token-toggle"
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
                        <label class="text-sm font-medium" for="credential-access-key">{{
                            t("credentials.accessKey")
                        }}</label>
                        <div class="flex items-center gap-2">
                            <Input
                                id="credential-access-key"
                                v-model="accessKey"
                                data-testid="credentials-create-access-key"
                                :type="accessKeyVisible ? 'text' : 'password'"
                                autocomplete="off"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                data-testid="credentials-create-access-key-toggle"
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
                        <label class="text-sm font-medium" for="credential-secret-key">{{
                            t("credentials.secretKey")
                        }}</label>
                        <div class="flex items-center gap-2">
                            <Input
                                id="credential-secret-key"
                                v-model="secretKey"
                                data-testid="credentials-create-secret-key"
                                :type="secretKeyVisible ? 'text' : 'password'"
                                autocomplete="off"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                data-testid="credentials-create-secret-key-toggle"
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
                    data-testid="credentials-create-error"
                    class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                    {{ formError }}
                </p>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        data-testid="credentials-create-cancel"
                        @click="emit('close')"
                    >
                        {{ t("credentials.cancel") }}
                    </Button>
                    <Button
                        type="submit"
                        data-testid="credentials-create-submit"
                        :disabled="submitting"
                    >
                        <LoaderCircle v-if="submitting" class="animate-spin" aria-hidden="true" />
                        {{ submitting ? t("credentials.creating") : t("credentials.createSubmit") }}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>
</template>
