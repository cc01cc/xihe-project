<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { LoaderCircle, Eye, Pencil, Trash2 } from "@lucide/vue";
import Dialog from "../../ui/dialog/Dialog.vue";
import DialogContent from "../../ui/dialog/DialogContent.vue";
import DialogHeader from "../../ui/dialog/DialogHeader.vue";
import DialogTitle from "../../ui/dialog/DialogTitle.vue";
import DialogDescription from "../../ui/dialog/DialogDescription.vue";
import DialogFooter from "../../ui/dialog/DialogFooter.vue";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import CredentialBindingsSection from "./CredentialBindingsSection.vue";
import CredentialAuditSection from "./CredentialAuditSection.vue";
import { ApiError, api } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { useCredentialsStore } from "../../../stores/credentials";
import { credentialErrorText } from "./errorText";
import type { CredentialReference, CredentialSummary } from "../../../types";

const props = withDefaults(
    defineProps<{
        open: boolean;
        credential: CredentialSummary | null;
    }>(),
    { open: false, credential: null },
);

const emit = defineEmits<{
    close: [];
    replace: [];
    reveal: [];
    changed: [];
}>();

const { t } = useI18n(),
    store = useCredentialsStore();

const confirmingDelete = ref(false),
    references = ref<CredentialReference[]>([]),
    referencesLoading = ref(false),
    deleting = ref(false),
    deleteError = ref(""),
    activeTab = ref<"overview" | "bindings" | "audit">("overview");

const fingerprintShort = computed(() => {
    const value = props.credential?.fingerprint ?? "";
    return value.length > 16 ? `${value.slice(0, 16)}…` : value;
});

watch(
    () => props.open,
    () => {
        confirmingDelete.value = false;
        references.value = [];
        deleteError.value = "";
        deleting.value = false;
        activeTab.value = "overview";
    },
);

function referenceLabel(reference: CredentialReference): string {
    return reference.source === "workspace_cap"
        ? t("credentials.refSourceCap")
        : t("credentials.refSourceGrant");
}

async function startDelete() {
    confirmingDelete.value = true;
    deleteError.value = "";
    if (!props.credential) return;
    referencesLoading.value = true;
    try {
        const result = await api.getCredentialReferences(props.credential.id);
        references.value = result.references;
    } catch (e) {
        deleteError.value = credentialErrorText(e, t);
        if (!(e instanceof ApiError)) {
            logger.warn("Failed to load credential references", e);
        }
    } finally {
        referencesLoading.value = false;
    }
}

async function confirmDelete() {
    if (!props.credential) return;
    deleting.value = true;
    deleteError.value = "";
    try {
        await store.remove(props.credential.id);
        toast.success(t("credentials.deleteSuccess"));
        emit("changed");
        emit("close");
    } catch (e) {
        deleteError.value = credentialErrorText(e, t);
        if (!(e instanceof ApiError)) {
            logger.warn("Credential delete failed", e);
        }
    } finally {
        deleting.value = false;
    }
}

function formatTime(value?: string | null): string {
    if (!value) return t("credentials.notAvailable");
    return new Date(value).toLocaleString();
}
</script>

<template>
    <Dialog :open="open" @update:open="(value: boolean) => !value && emit('close')">
        <DialogContent class="max-w-xl" data-testid="credentials-detail-dialog">
            <DialogHeader>
                <DialogTitle data-testid="credentials-detail-title">{{
                    credential?.label ?? t("credentials.detailTitle")
                }}</DialogTitle>
                <DialogDescription>{{ t("credentials.detailDesc") }}</DialogDescription>
            </DialogHeader>

            <div v-if="credential" class="space-y-4">
                <div class="flex gap-2 border-b border-border pb-1">
                    <button
                        type="button"
                        class="rounded-md px-2 py-1 text-xs"
                        :class="
                            activeTab === 'overview'
                                ? 'bg-muted font-medium'
                                : 'text-muted-foreground'
                        "
                        data-testid="credentials-tab-overview"
                        @click="activeTab = 'overview'"
                    >
                        {{ t("credentials.overviewTab") }}
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2 py-1 text-xs"
                        :class="
                            activeTab === 'bindings'
                                ? 'bg-muted font-medium'
                                : 'text-muted-foreground'
                        "
                        data-testid="credentials-tab-bindings"
                        @click="activeTab = 'bindings'"
                    >
                        {{ t("credentials.bindTab") }}
                    </button>
                    <button
                        type="button"
                        class="rounded-md px-2 py-1 text-xs"
                        :class="
                            activeTab === 'audit' ? 'bg-muted font-medium' : 'text-muted-foreground'
                        "
                        data-testid="credentials-tab-audit"
                        @click="activeTab = 'audit'"
                    >
                        {{ t("credentials.auditTab") }}
                    </button>
                </div>

                <template v-if="activeTab === 'overview'">
                    <div class="flex flex-wrap items-center gap-2">
                        <Badge
                            :variant="credential.status === 'active' ? 'secondary' : 'outline'"
                            data-testid="credentials-detail-status"
                        >
                            {{
                                credential.status === "active"
                                    ? t("credentials.statusActive")
                                    : t("credentials.statusDisabled")
                            }}
                        </Badge>
                        <Badge variant="outline" data-testid="credentials-detail-kind">
                            {{
                                credential.kind === "token"
                                    ? t("credentials.kindToken")
                                    : t("credentials.kindKeyPair")
                            }}
                        </Badge>
                        <Badge variant="outline" data-testid="credentials-detail-tier">
                            {{
                                credential.deliveryTier === "lease"
                                    ? t("credentials.tierLease")
                                    : t("credentials.tierReveal")
                            }}
                        </Badge>
                    </div>

                    <dl class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("credentials.fingerprint") }}
                            </dt>
                            <dd
                                class="mt-1 break-all font-mono text-xs"
                                :title="credential.fingerprint"
                                data-testid="credentials-detail-fingerprint"
                            >
                                {{ fingerprintShort }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("credentials.owner") }}
                            </dt>
                            <dd class="mt-1">
                                {{
                                    credential.ownerType === "WORKSPACE"
                                        ? t("credentials.ownerWorkspace")
                                        : t("credentials.ownerUser")
                                }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("credentials.revision") }}
                            </dt>
                            <dd class="mt-1" data-testid="credentials-detail-revision">
                                {{ credential.revision }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("credentials.references") }}
                            </dt>
                            <dd class="mt-1" data-testid="credentials-detail-refcount">
                                {{
                                    credential.referenceCount > 0
                                        ? t("credentials.refCount", {
                                              count: credential.referenceCount,
                                          })
                                        : t("credentials.refEmpty")
                                }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("credentials.createdAt") }}
                            </dt>
                            <dd class="mt-1">{{ formatTime(credential.createdAt) }}</dd>
                        </div>
                        <div>
                            <dt class="text-xs text-muted-foreground">
                                {{ t("credentials.replacedAt") }}
                            </dt>
                            <dd class="mt-1">{{ formatTime(credential.replacedAt) }}</dd>
                        </div>
                    </dl>

                    <div
                        v-if="confirmingDelete"
                        data-testid="credentials-delete-confirm"
                        class="space-y-3 rounded-md border border-destructive/30 bg-destructive/10 p-3"
                    >
                        <p class="text-sm text-destructive">{{ t("credentials.deleteDesc") }}</p>
                        <div v-if="referencesLoading" class="text-xs text-muted-foreground">
                            {{ t("common.loading") }}
                        </div>
                        <ul
                            v-else-if="references.length > 0"
                            data-testid="credentials-delete-references"
                            class="space-y-1 text-xs"
                        >
                            <li
                                v-for="(reference, index) in references"
                                :key="`${reference.source}-${reference.subjectId}-${index}`"
                                class="flex flex-wrap items-center gap-x-2 text-foreground"
                            >
                                <span class="font-medium">{{ referenceLabel(reference) }}</span>
                                <span class="font-mono"
                                    >{{ reference.subjectType }}/{{ reference.subjectId }}</span
                                >
                            </li>
                        </ul>
                        <p
                            v-else
                            data-testid="credentials-delete-no-refs"
                            class="text-xs text-muted-foreground"
                        >
                            {{ t("credentials.deleteNoRefs") }}
                        </p>
                        <p
                            v-if="deleteError"
                            data-testid="credentials-delete-error"
                            class="text-xs text-destructive"
                        >
                            {{ deleteError }}
                        </p>
                        <div class="flex justify-end gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                data-testid="credentials-delete-cancel"
                                @click="confirmingDelete = false"
                            >
                                {{ t("credentials.cancel") }}
                            </Button>
                            <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                data-testid="credentials-delete-submit"
                                :disabled="deleting || referencesLoading"
                                @click="confirmDelete"
                            >
                                <LoaderCircle
                                    v-if="deleting"
                                    class="animate-spin"
                                    aria-hidden="true"
                                />
                                {{
                                    deleting
                                        ? t("credentials.deleting")
                                        : t("credentials.deleteConfirm")
                                }}
                            </Button>
                        </div>
                    </div>
                </template>

                <CredentialBindingsSection
                    v-else-if="activeTab === 'bindings'"
                    :credential-id="credential.id"
                    @changed="emit('changed')"
                />

                <CredentialAuditSection v-else :credential-id="credential.id" />

                <DialogFooter>
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        data-testid="credentials-detail-delete"
                        @click="startDelete"
                    >
                        <Trash2 aria-hidden="true" />
                        {{ t("credentials.delete") }}
                    </Button>
                    <Button
                        v-if="credential.deliveryTier === 'reveal'"
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="credentials-detail-reveal"
                        @click="emit('reveal')"
                    >
                        <Eye aria-hidden="true" />
                        {{ t("credentials.reveal") }}
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="credentials-detail-replace"
                        @click="emit('replace')"
                    >
                        <Pencil aria-hidden="true" />
                        {{ t("credentials.replace") }}
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="credentials-detail-close"
                        @click="emit('close')"
                    >
                        {{ t("credentials.close") }}
                    </Button>
                </DialogFooter>
            </div>
        </DialogContent>
    </Dialog>
</template>
