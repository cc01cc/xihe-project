<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type {
    ProviderFingerprintAgainstOption,
    ProviderRequestFingerprintDiffView,
    ProviderRequestFingerprintDocument,
    ProviderRequestFingerprintErrorMarker,
    ProviderRequestFingerprintLayer,
    ProviderRequestFingerprintLayerDiff,
    ProviderRequestFingerprintRequestMeta,
    ProviderRequestFingerprintView,
} from "../../../types";

/**
 * PLAN-0679 T3.1: provider-request fingerprint block of the Session monitor (design D7).
 *
 * Sits next to the run trace: without a baseline it renders the run's six-layer fingerprint
 * envelope; with a same-session baseline selected it renders the two-run layer diff
 * (unchanged / changed(sameShape|grew|shrank) / added / removed / unavailable — never
 * downgraded to unchanged). Read-only, best-effort: a failed fetch keeps the retry banner
 * without blocking the rest of the monitor.
 */
type FingerprintFetcher = typeof api.getRunProviderRequestFingerprint;

const props = withDefaults(
    defineProps<{
        runId: string;
        againstOptions: ProviderFingerprintAgainstOption[];
        /** Pre-selected baseline (deep link / preview); empty means "no comparison". */
        initialAgainst?: string;
        /**
         * Fetch seam: production always uses `api.getRunProviderRequestFingerprint`; the dev-only
         * UI preview injects a mock fetcher so the block renders with fixture data (no network).
         */
        fetcher?: FingerprintFetcher;
    }>(),
    { initialAgainst: "", fetcher: undefined },
);
const { t } = useI18n();

const LAYER_ORDER = ["systemTemplate", "history", "userInput", "toolSchema", "config"] as const;
const OUTBOUND_LAYER = "outbound";

const data = ref<ProviderRequestFingerprintView | ProviderRequestFingerprintDiffView | null>(null);
const againstId = ref(props.initialAgainst);
const loading = ref(false);
const loadFailed = ref(false);
let generation = 0;

const isDiff = computed(() => data.value !== null && "status" in data.value);
const view = computed<ProviderRequestFingerprintView | null>(() =>
    !isDiff.value ? (data.value as ProviderRequestFingerprintView | null) : null,
);
const diff = computed<ProviderRequestFingerprintDiffView | null>(() =>
    isDiff.value ? (data.value as ProviderRequestFingerprintDiffView) : null,
);

function isErrorMarker(
    fingerprint: ProviderRequestFingerprintView["fingerprint"],
): fingerprint is ProviderRequestFingerprintErrorMarker {
    return fingerprint !== undefined && fingerprint !== null && "status" in fingerprint;
}

function documentOf(
    fingerprint: ProviderRequestFingerprintView["fingerprint"],
): ProviderRequestFingerprintDocument | null {
    if (fingerprint === undefined || fingerprint === null || isErrorMarker(fingerprint)) {
        return null;
    }
    return fingerprint;
}

function layerOf(
    document: ProviderRequestFingerprintDocument | null,
    layer: string,
): ProviderRequestFingerprintLayer | undefined {
    // `outbound` is the whole-body calibration row, kept beside `layers` in the document.
    if (layer === OUTBOUND_LAYER) return document?.outbound;
    return document?.layers?.[layer];
}

function layerDiffOf(
    diffView: ProviderRequestFingerprintDiffView,
    layer: string,
): ProviderRequestFingerprintLayerDiff | undefined {
    if (layer === OUTBOUND_LAYER) return diffView.outbound;
    return diffView.layers?.[layer];
}

function hashShort(hash: string | undefined): string {
    if (!hash) return "—";
    return hash.length <= 12 ? hash : `${hash.slice(0, 8)}…`;
}

function roleEntries(meta: ProviderRequestFingerprintRequestMeta): [string, number][] {
    return Object.entries(meta.roleHistogram ?? {});
}

function formatDelta(delta: number | null | undefined): string {
    if (delta === undefined || delta === null) return "";
    if (delta === 0) return "±0";
    return delta > 0 ? `+${delta}` : String(delta);
}

async function fetchFingerprint(runId: string, against: string): Promise<void> {
    const currentGeneration = ++generation;
    loading.value = true;
    try {
        const response = await (props.fetcher ?? api.getRunProviderRequestFingerprint)(runId, {
            against: against === "" ? undefined : against,
        });
        if (currentGeneration !== generation) return;
        data.value = response;
        loadFailed.value = false;
    } catch (fetchError) {
        if (currentGeneration !== generation) return;
        logger.warn("provider request fingerprint fetch failed", fetchError);
        loadFailed.value = true;
    } finally {
        if (currentGeneration === generation) loading.value = false;
    }
}

watch(
    () => [props.runId, againstId.value] as const,
    ([runId, against]) => {
        fetchFingerprint(runId, against);
    },
    { immediate: true },
);

onBeforeUnmount(() => {
    generation++;
});

function selectAgainst(value: string): void {
    againstId.value = value;
}

function retry(): void {
    fetchFingerprint(props.runId, againstId.value);
}
</script>

<template>
    <div class="space-y-2" data-testid="provider-fingerprint">
        <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium">{{ t("monitor.fingerprint.title") }}</span>
            <Select
                :model-value="againstId || '__none__'"
                @update:model-value="
                    (value) => selectAgainst(value === '__none__' ? '' : String(value ?? ''))
                "
            >
                <SelectTrigger
                    class="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
                    :aria-label="t('monitor.fingerprint.againstLabel')"
                    data-testid="provider-fingerprint-against-select"
                >
                    <SelectValue>{{
                        againstId
                            ? t("monitor.fingerprint.againstOption", {
                                  label:
                                      againstOptions.find((option) => option.runId === againstId)
                                          ?.label ?? againstId,
                              })
                            : t("monitor.fingerprint.againstNone")
                    }}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="__none__">{{
                        t("monitor.fingerprint.againstNone")
                    }}</SelectItem>
                    <SelectItem
                        v-for="option in againstOptions"
                        :key="option.runId"
                        :value="option.runId"
                    >
                        {{ t("monitor.fingerprint.againstOption", { label: option.label }) }}
                    </SelectItem>
                </SelectContent>
            </Select>
        </div>

        <p v-if="loading" class="py-1 text-center text-xs text-muted-foreground">
            {{ t("monitor.fingerprint.loading") }}
        </p>
        <template v-else-if="loadFailed">
            <p class="py-1 text-center text-xs text-muted-foreground">
                {{ t("monitor.fingerprint.failed") }}
            </p>
            <button
                type="button"
                class="text-xs text-muted-foreground underline"
                data-testid="provider-fingerprint-retry"
                @click="retry"
            >
                {{ t("monitor.fingerprint.retry") }}
            </button>
        </template>

        <!-- Single-run envelope -->
        <template v-else-if="view">
            <p
                v-if="!view.available"
                class="py-1 text-center text-xs text-muted-foreground"
                data-testid="provider-fingerprint-not-captured"
            >
                {{ t("monitor.fingerprint.notCaptured") }}
            </p>
            <template v-else-if="view.fingerprint">
                <p
                    v-if="isErrorMarker(view.fingerprint)"
                    class="py-1 text-center text-xs text-muted-foreground"
                    data-testid="provider-fingerprint-error"
                >
                    {{
                        t("monitor.fingerprint.error", {
                            reasonCode: view.fingerprint.reasonCode ?? "unknown",
                        })
                    }}
                </p>
                <template v-if="documentOf(view.fingerprint)">
                    <dl
                        v-if="view.request"
                        class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs"
                        data-testid="provider-fingerprint-meta"
                    >
                        <dt class="text-muted-foreground">{{ t("monitor.trace.apiType") }}</dt>
                        <dd data-testid="provider-fingerprint-api-type">
                            {{ view.request.apiTypeId }}
                        </dd>
                        <dt class="text-muted-foreground">{{ t("monitor.trace.model") }}</dt>
                        <dd data-testid="provider-fingerprint-model">{{ view.request.model }}</dd>
                        <dt class="text-muted-foreground">
                            {{ t("monitor.fingerprint.messageCount") }}
                        </dt>
                        <dd>{{ view.request.messageCount }}</dd>
                        <dt class="text-muted-foreground">
                            {{ t("monitor.fingerprint.toolCount") }}
                        </dt>
                        <dd>{{ view.request.toolCount }}</dd>
                        <dt class="text-muted-foreground">
                            {{ t("monitor.fingerprint.bytesTotal") }}
                        </dt>
                        <dd>{{ view.request.bytesTotal }}</dd>
                    </dl>
                    <div
                        v-if="view.request && roleEntries(view.request).length > 0"
                        class="flex flex-wrap gap-1"
                        data-testid="provider-fingerprint-roles"
                    >
                        <span
                            v-for="[role, count] in roleEntries(view.request)"
                            :key="role"
                            class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                            {{ t("monitor.fingerprint.roleEntry", { role, count }) }}
                        </span>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-xs">
                            <thead>
                                <tr class="text-left text-muted-foreground">
                                    <th class="py-0.5 pr-2 font-medium">
                                        {{ t("monitor.fingerprint.layerColumn") }}
                                    </th>
                                    <th class="py-0.5 pr-2 font-medium">
                                        {{ t("monitor.fingerprint.hashColumn") }}
                                    </th>
                                    <th class="py-0.5 pr-2 text-right font-medium">
                                        {{ t("monitor.fingerprint.countColumn") }}
                                    </th>
                                    <th class="py-0.5 text-right font-medium">
                                        {{ t("monitor.fingerprint.bytesColumn") }}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="layer in [...LAYER_ORDER, OUTBOUND_LAYER]"
                                    :key="layer"
                                    class="border-t border-border/60"
                                    :data-testid="`provider-fingerprint-layer-${layer}`"
                                >
                                    <td class="py-0.5 pr-2">{{ layer }}</td>
                                    <td class="py-0.5 pr-2 font-mono">
                                        {{
                                            hashShort(
                                                layerOf(documentOf(view.fingerprint), layer)?.hash,
                                            )
                                        }}
                                    </td>
                                    <td class="py-0.5 pr-2 text-right">
                                        {{
                                            layerOf(documentOf(view.fingerprint), layer)?.count ??
                                            "—"
                                        }}
                                    </td>
                                    <td class="py-0.5 text-right">
                                        {{
                                            layerOf(documentOf(view.fingerprint), layer)?.bytes ??
                                            "—"
                                        }}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </template>
            </template>
        </template>

        <!-- Two-run diff -->
        <template v-else-if="diff">
            <div
                v-if="diff.sides && diff.sides.length > 0"
                class="space-y-0.5"
                data-testid="provider-fingerprint-diff-sides"
            >
                <p
                    v-for="side in diff.sides"
                    :key="side.side"
                    class="text-xs text-muted-foreground"
                >
                    {{
                        t(`monitor.fingerprint.side.${side.side}`, {
                            reason: side.reason ?? side.reasonCode ?? "",
                        })
                    }}
                </p>
            </div>
            <dl
                v-if="diff.against && diff.current"
                class="grid grid-cols-3 gap-x-2 gap-y-0.5 text-xs"
                data-testid="provider-fingerprint-diff-meta"
            >
                <dt />
                <dd class="text-xs text-muted-foreground">
                    {{ t("monitor.fingerprint.againstColumn") }}
                </dd>
                <dd class="text-xs text-muted-foreground">
                    {{ t("monitor.fingerprint.currentColumn") }}
                </dd>
                <dt class="text-muted-foreground">{{ t("monitor.trace.model") }}</dt>
                <dd>{{ diff.against.model }}</dd>
                <dd>{{ diff.current.model }}</dd>
                <dt class="text-muted-foreground">{{ t("monitor.fingerprint.toolCount") }}</dt>
                <dd>{{ diff.against.toolCount }}</dd>
                <dd>{{ diff.current.toolCount }}</dd>
                <dt class="text-muted-foreground">{{ t("monitor.fingerprint.bytesTotal") }}</dt>
                <dd>{{ diff.against.bytesTotal }}</dd>
                <dd>{{ diff.current.bytesTotal }}</dd>
            </dl>
            <div v-if="diff.summary && diff.summary.changedLayers.length > 0" class="text-xs">
                <span class="text-muted-foreground">{{
                    t("monitor.fingerprint.summaryChanged")
                }}</span>
                {{ diff.summary.changedLayers.join(", ") }}
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead>
                        <tr class="text-left text-muted-foreground">
                            <th class="py-0.5 pr-2 font-medium">
                                {{ t("monitor.fingerprint.layerColumn") }}
                            </th>
                            <th class="py-0.5 pr-2 font-medium">
                                {{ t("monitor.fingerprint.statusColumn") }}
                            </th>
                            <th class="py-0.5 pr-2 text-right font-medium">
                                {{ t("monitor.fingerprint.countDeltaColumn") }}
                            </th>
                            <th class="py-0.5 text-right font-medium">
                                {{ t("monitor.fingerprint.bytesDeltaColumn") }}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="layer in [...LAYER_ORDER, OUTBOUND_LAYER]"
                            :key="layer"
                            class="border-t border-border/60"
                            :data-testid="`provider-fingerprint-diff-layer-${layer}`"
                        >
                            <td class="py-0.5 pr-2">{{ layer }}</td>
                            <td class="py-0.5 pr-2">
                                {{
                                    t(
                                        `monitor.fingerprint.status.${
                                            layerDiffOf(diff, layer)?.status ?? "unavailable"
                                        }`,
                                    )
                                }}
                                <span
                                    v-if="layerDiffOf(diff, layer)?.againstReason"
                                    class="text-muted-foreground"
                                >
                                    ·
                                    {{
                                        t("monitor.fingerprint.sideReason", {
                                            reason: layerDiffOf(diff, layer)?.againstReason ?? "",
                                        })
                                    }}
                                </span>
                            </td>
                            <td class="py-0.5 pr-2 text-right">
                                {{ formatDelta(layerDiffOf(diff, layer)?.countDelta) || "—" }}
                            </td>
                            <td class="py-0.5 text-right">
                                {{ formatDelta(layerDiffOf(diff, layer)?.bytesDelta) || "—" }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </template>
    </div>
</template>
