<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, RefreshCw } from "@lucide/vue";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import CredentialCreateDialog from "./CredentialCreateDialog.vue";
import CredentialDetailDialog from "./CredentialDetailDialog.vue";
import CredentialReplaceDialog from "./CredentialReplaceDialog.vue";
import CredentialRevealDialog from "./CredentialRevealDialog.vue";
import { useCredentialsStore } from "../../../stores/credentials";
import type { CredentialSummary } from "../../../types";

const { t } = useI18n(),
    store = useCredentialsStore();

const createOpen = ref(false),
    activeDialog = ref<"detail" | "replace" | "reveal" | null>(null),
    selectedId = ref<string | null>(null),
    reloading = ref(false);

const selected = computed<CredentialSummary | null>(
    () => store.credentials.find((item) => item.id === selectedId.value) ?? null,
);

function selectRow(credential: CredentialSummary) {
    selectedId.value = credential.id;
    activeDialog.value = "detail";
}

function closeDialogs() {
    activeDialog.value = null;
}

/** PLAN-0498: bind/unbind keeps the detail dialog open — refresh the list only.
 *  Deletion closes the detail dialog itself (the detail emits `close` after `changed`). */
function refreshAfterChange() {
    void store.load();
}

async function refresh() {
    reloading.value = true;
    try {
        await store.load();
    } finally {
        reloading.value = false;
    }
}

function fingerprintShort(value: string): string {
    return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function ownerLabel(credential: CredentialSummary): string {
    return credential.ownerType === "WORKSPACE"
        ? t("credentials.ownerWorkspace")
        : t("credentials.ownerUser");
}

onMounted(() => {
    void store.load();
});
</script>

<template>
    <div>
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
                <p class="mb-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    XH / Credentials
                </p>
                <h1 data-testid="credentials-heading" class="text-xl font-semibold tracking-tight">
                    {{ t("credentials.heading") }}
                </h1>
                <p class="mt-1 text-sm text-muted-foreground">{{ t("credentials.desc") }}</p>
            </div>
            <div class="flex items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="credentials-refresh"
                    :disabled="reloading"
                    @click="refresh"
                >
                    <RefreshCw aria-hidden="true" />
                    {{ t("credentials.refresh") }}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    data-testid="credentials-create-button"
                    @click="createOpen = true"
                >
                    <Plus aria-hidden="true" />
                    {{ t("credentials.create") }}
                </Button>
            </div>
        </header>

        <div
            v-if="store.error"
            data-testid="credentials-error"
            class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
            {{ store.error.message }}
        </div>

        <section class="min-w-0 rounded-lg border border-border bg-card">
            <div class="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 class="text-sm font-medium">{{ t("credentials.heading") }}</h2>
                <span class="text-xs text-muted-foreground">{{ store.credentials.length }}</span>
            </div>
            <div v-if="store.loading" class="p-4 text-sm text-muted-foreground">
                {{ t("common.loading") }}
            </div>
            <div
                v-else-if="store.credentials.length === 0"
                data-testid="credentials-empty"
                class="p-8 text-center text-sm text-muted-foreground"
            >
                {{ t("credentials.empty") }}
            </div>
            <ul v-else data-testid="credentials-list" class="divide-y divide-border">
                <li v-for="credential in store.credentials" :key="credential.id">
                    <button
                        type="button"
                        class="w-full px-4 py-3 text-left transition-colors hover:bg-muted/50"
                        :data-testid="`credentials-row-${credential.id}`"
                        @click="selectRow(credential)"
                    >
                        <div class="flex items-start justify-between gap-3">
                            <span
                                class="min-w-0 truncate text-sm font-medium"
                                :data-testid="`credentials-row-label-${credential.id}`"
                            >
                                {{ credential.label }}
                            </span>
                            <Badge
                                v-if="credential.status === 'active'"
                                variant="secondary"
                                data-testid="credentials-row-status-active"
                            >
                                {{ t("credentials.statusActive") }}
                            </Badge>
                            <Badge
                                v-else
                                variant="outline"
                                data-testid="credentials-row-status-disabled"
                            >
                                {{ t("credentials.statusDisabled") }}
                            </Badge>
                        </div>
                        <div
                            class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
                        >
                            <span>{{
                                credential.kind === "token"
                                    ? t("credentials.kindToken")
                                    : t("credentials.kindKeyPair")
                            }}</span>
                            <span>{{
                                credential.deliveryTier === "lease"
                                    ? t("credentials.tierLease")
                                    : t("credentials.tierReveal")
                            }}</span>
                            <span>{{ ownerLabel(credential) }}</span>
                            <span class="font-mono" :title="credential.fingerprint">
                                {{ fingerprintShort(credential.fingerprint) }}
                            </span>
                            <span>{{
                                credential.referenceCount > 0
                                    ? t("credentials.refCount", {
                                          count: credential.referenceCount,
                                      })
                                    : t("credentials.refEmpty")
                            }}</span>
                        </div>
                    </button>
                </li>
            </ul>
        </section>

        <CredentialCreateDialog :open="createOpen" @close="createOpen = false" />
        <CredentialDetailDialog
            :open="activeDialog === 'detail'"
            :credential="selected"
            @close="closeDialogs"
            @replace="activeDialog = 'replace'"
            @reveal="activeDialog = 'reveal'"
            @changed="refreshAfterChange"
        />
        <CredentialReplaceDialog
            :open="activeDialog === 'replace'"
            :credential-id="selectedId ?? ''"
            :kind="selected?.kind ?? 'token'"
            @close="activeDialog = selected ? 'detail' : null"
            @replaced="activeDialog = selected ? 'detail' : null"
        />
        <CredentialRevealDialog
            :open="activeDialog === 'reveal'"
            :credential-id="selectedId ?? ''"
            :label="selected?.label ?? ''"
            @close="activeDialog = selected ? 'detail' : null"
        />
    </div>
</template>
