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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { FieldControl, FieldError, FieldLabel, FieldRoot, FormRoot } from "reka-ui";
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
    /** PLAN-0753 M2: server-side errors keyed by field name, cleared by reka on edit. */
    serverErrors = ref<Record<string, string | string[]>>({});

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
    serverErrors.value = {};
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

/** PLAN-0753 M2: field rules — one per `FieldRoot.validate`, each a pure function of the value. */
function validateLabel(value: unknown): string | null {
    const raw = typeof value === "string" ? value : "";
    return raw.trim() ? null : t("credentials.errLabelRequired");
}
function validateToken(value: unknown): string | null {
    return typeof value === "string" && value ? null : t("credentials.errTokenRequired");
}
function validateKeyPair(value: unknown): string | null {
    const raw = typeof value === "string" ? value : "";
    return raw ? null : t("credentials.errKeyPairRequired");
}
function validateWorkspace(value: unknown): string | null {
    const raw = typeof value === "string" ? value : "";
    return raw ? null : t("credentials.errWorkspaceRequired");
}

async function submit() {
    submitting.value = true;
    serverErrors.value = {};
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
        serverErrors.value = { __form: credentialErrorText(e, t) };
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
            <FormRoot
                class="space-y-4"
                :errors="serverErrors"
                @form-submit="submit"
            >
                <FieldRoot name="label" class="space-y-1.5" :validate="validateLabel" required>
                    <FieldLabel class="text-sm font-medium">
                        {{ t("credentials.label") }}
                    </FieldLabel>
                    <FieldControl as-child>
                        <Input
                            v-model="label"
                            data-testid="credentials-create-label"
                            :maxlength="128"
                            autocomplete="off"
                        />
                    </FieldControl>
                    <FieldError
                        class="text-xs text-destructive"
                        data-testid="credentials-create-label-error"
                    />
                </FieldRoot>

                <div class="grid gap-4 sm:grid-cols-2">
                    <FieldRoot name="kind" class="space-y-1.5">
                        <FieldLabel class="text-sm font-medium">
                            {{ t("credentials.kind") }}
                        </FieldLabel>
                        <Select
                            :model-value="kind"
                            @update:model-value="
                                (value) => (kind = String(value) as CredentialKind)
                            "
                        >
                            <SelectTrigger
                                data-testid="credentials-create-kind"
                                class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="token">{{
                                    t("credentials.kindToken")
                                }}</SelectItem>
                                <SelectItem value="key_pair">{{
                                    t("credentials.kindKeyPair")
                                }}</SelectItem>
                            </SelectContent>
                        </Select>
                    </FieldRoot>
                    <FieldRoot name="deliveryTier" class="space-y-1.5">
                        <FieldLabel class="text-sm font-medium">
                            {{ t("credentials.tier") }}
                        </FieldLabel>
                        <Select
                            :model-value="deliveryTier"
                            @update:model-value="
                                (value) => (deliveryTier = String(value) as CredentialDeliveryTier)
                            "
                        >
                            <SelectTrigger
                                data-testid="credentials-create-tier"
                                class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="lease">{{
                                    t("credentials.tierLease")
                                }}</SelectItem>
                                <SelectItem value="reveal">{{
                                    t("credentials.tierReveal")
                                }}</SelectItem>
                            </SelectContent>
                        </Select>
                    </FieldRoot>
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
                    <FieldRoot name="ownerType" class="space-y-1.5">
                        <FieldLabel class="text-sm font-medium">
                            {{ t("credentials.owner") }}
                        </FieldLabel>
                        <Select
                            :model-value="ownerType"
                            @update:model-value="
                                (value) => (ownerType = String(value) as CredentialOwnerType)
                            "
                        >
                            <SelectTrigger
                                data-testid="credentials-create-owner"
                                class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="USER">{{
                                    t("credentials.ownerUser")
                                }}</SelectItem>
                                <SelectItem value="WORKSPACE">{{
                                    t("credentials.ownerWorkspace")
                                }}</SelectItem>
                            </SelectContent>
                        </Select>
                    </FieldRoot>
                    <FieldRoot
                        v-if="ownerType === 'WORKSPACE'"
                        name="workspaceId"
                        class="space-y-1.5"
                        :validate="validateWorkspace"
                        required
                    >
                        <FieldLabel class="text-sm font-medium">
                            {{ t("credentials.ownerWorkspaceSelect") }}
                        </FieldLabel>
                        <Select
                            :model-value="workspaceId"
                            :disabled="workspacesLoading"
                            @update:model-value="(value) => (workspaceId = String(value))"
                        >
                            <SelectTrigger
                                data-testid="credentials-create-workspace"
                                class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                            >
                                <SelectValue
                                    :placeholder="
                                        workspaces.find((ws) => ws.id === workspaceId)?.name ?? '—'
                                    "
                                />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem v-for="ws in workspaces" :key="ws.id" :value="ws.id">
                                    {{ ws.name }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <FieldError
                            class="text-xs text-destructive"
                            data-testid="credentials-create-workspace-error"
                        />
                    </FieldRoot>
                </div>

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
                                data-testid="credentials-create-token"
                                :type="tokenVisible ? 'text' : 'password'"
                                autocomplete="off"
                            />
                        </FieldControl>
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
                    <FieldError
                        class="text-xs text-destructive"
                        data-testid="credentials-create-token-error"
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
                                    data-testid="credentials-create-access-key"
                                    :type="accessKeyVisible ? 'text' : 'password'"
                                    autocomplete="off"
                                />
                            </FieldControl>
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
                        <FieldError
                            class="text-xs text-destructive"
                            data-testid="credentials-create-access-key-error"
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
                                    data-testid="credentials-create-secret-key"
                                    :type="secretKeyVisible ? 'text' : 'password'"
                                    autocomplete="off"
                                />
                            </FieldControl>
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
                        <FieldError
                            class="text-xs text-destructive"
                            data-testid="credentials-create-secret-key-error"
                        />
                    </FieldRoot>
                </template>

                <p
                    v-if="serverErrors.__form"
                    data-testid="credentials-create-error"
                    class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                    {{ serverErrors.__form }}
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
            </FormRoot>
        </DialogContent>
    </Dialog>
</template>
