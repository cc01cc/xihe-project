<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { credentialErrorText } from "./errorText";
import type { CredentialEventView, CredentialReference } from "../../../types";

const props = defineProps<{
    credentialId: string;
}>();

const { t } = useI18n();

const references = ref<CredentialReference[]>([]),
    events = ref<CredentialEventView[]>([]),
    loading = ref(false),
    error = ref("");

const EVENT_LABEL_KEYS: Record<string, string> = {
    created: "credentials.eventCreated",
    replaced: "credentials.eventReplaced",
    deleted: "credentials.eventDeleted",
    lease_issued: "credentials.eventLeaseIssued",
    lease_redeemed: "credentials.eventLeaseRedeemed",
    revealed: "credentials.eventRevealed",
};

function eventLabel(eventType: string): string {
    const key = EVENT_LABEL_KEYS[eventType];
    return key ? t(key) : eventType;
}

function referenceSource(reference: CredentialReference): string {
    return reference.source === "workspace_cap"
        ? t("credentials.refSourceCap")
        : t("credentials.refSourceGrant");
}

function formatTime(value: string): string {
    return value ? new Date(value).toLocaleString() : "—";
}

async function load() {
    if (!props.credentialId) return;
    loading.value = true;
    error.value = "";
    try {
        const [referenceResult, eventResult] = await Promise.all([
            api.getCredentialReferences(props.credentialId),
            api.getCredentialEvents(props.credentialId),
        ]);
        references.value = Array.isArray(referenceResult.references)
            ? referenceResult.references
            : [];
        events.value = Array.isArray(eventResult.events) ? eventResult.events : [];
    } catch (e) {
        references.value = [];
        events.value = [];
        error.value = credentialErrorText(e, t);
        if (!(e instanceof ApiError)) {
            logger.warn("Failed to load credential references/events", e);
        }
    } finally {
        loading.value = false;
    }
}

watch(
    () => props.credentialId,
    () => void load(),
    { immediate: true },
);
</script>

<template>
    <div class="space-y-4" data-testid="credential-audit">
        <div v-if="loading" class="text-xs text-muted-foreground">
            {{ t("common.loading") }}
        </div>
        <template v-else>
            <p
                v-if="error"
                data-testid="credential-audit-error"
                class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
                {{ error }}
            </p>

            <section class="space-y-2">
                <h4 class="text-xs font-medium">{{ t("credentials.auditReferences") }}</h4>
                <ul
                    v-if="references.length > 0"
                    data-testid="credential-audit-references"
                    class="space-y-1 text-xs"
                >
                    <li
                        v-for="(reference, index) in references"
                        :key="`${reference.source}-${reference.subjectId}-${index}`"
                        class="flex flex-wrap items-center gap-x-2"
                    >
                        <span class="font-medium">{{ referenceSource(reference) }}</span>
                        <span class="font-mono"
                            >{{ reference.subjectType }}/{{ reference.subjectId }}</span
                        >
                        <span class="text-muted-foreground">{{ reference.resource }}</span>
                    </li>
                </ul>
                <p
                    v-else
                    data-testid="credential-audit-no-references"
                    class="text-xs text-muted-foreground"
                >
                    {{ t("credentials.auditNoReferences") }}
                </p>
            </section>

            <section class="space-y-2">
                <h4 class="text-xs font-medium">{{ t("credentials.auditEvents") }}</h4>
                <ul
                    v-if="events.length > 0"
                    data-testid="credential-audit-events"
                    class="max-h-48 space-y-1 overflow-auto text-xs"
                >
                    <li
                        v-for="event in events"
                        :key="event.id"
                        class="flex flex-wrap items-center gap-x-2"
                    >
                        <span class="font-medium">{{ eventLabel(event.eventType) }}</span>
                        <span class="text-muted-foreground">{{ formatTime(event.createdAt) }}</span>
                        <span class="font-mono text-muted-foreground">{{ event.actor }}</span>
                    </li>
                </ul>
                <p
                    v-else
                    data-testid="credential-audit-no-events"
                    class="text-xs text-muted-foreground"
                >
                    {{ t("credentials.auditNoEvents") }}
                </p>
            </section>
        </template>
    </div>
</template>
