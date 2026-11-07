<script setup lang="ts">
/**
 * PLAN-0683 (BL-381) T2.2: attachment preview overlay.
 *
 * Ruling A: the attachment entry (thumbnail/title click) opens this overlay, which reads
 * at most the 8 MiB preview budget through one HTTP range request. When the file is
 * larger, the preview keeps the prefix and shows an explicit truncation prompt with two
 * entries — "load the remaining bytes" and "download the original". Full content is only
 * ever loaded on that explicit action; the budget never pretends to be a full-file cap.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Download, FileText, ImageIcon, LoaderCircle, TriangleAlert } from "@lucide/vue";
import type { AttachmentFile } from "../../../../types";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import ImagePreview from "../../components/ImagePreview.vue";
import {
    ATTACHMENT_PREVIEW_BUDGET_BYTES,
    decodePreviewText,
    fetchAttachmentPreview,
    fetchAttachmentRemainder,
    type AttachmentPreview,
} from "../../composables/fileService";

const props = defineProps<{
    open: boolean;
    attachment: AttachmentFile;
    /** Resolved attachment URL (same resolution the download action uses). */
    url: string;
}>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { t } = useI18n();

const IMAGE_EXTENSIONS = new Set([
    "avif",
    "bmp",
    "gif",
    "ico",
    "jpeg",
    "jpg",
    "png",
    "svg",
    "webp",
]);
const TEXT_EXTENSIONS = new Set([
    "c",
    "cjs",
    "cpp",
    "cs",
    "css",
    "csv",
    "diff",
    "go",
    "h",
    "hpp",
    "htm",
    "html",
    "ini",
    "java",
    "js",
    "json",
    "jsonl",
    "jsx",
    "log",
    "md",
    "mjs",
    "ndjson",
    "patch",
    "ps1",
    "py",
    "rs",
    "scss",
    "sh",
    "sql",
    "toml",
    "ts",
    "tsv",
    "tsx",
    "txt",
    "vue",
    "xml",
    "yaml",
    "yml",
]);

function extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isTextMime(mime: string): boolean {
    return (
        mime.startsWith("text/") ||
        /(json|xml|yaml|csv|markdown|javascript|typescript|x-sh|x-httpd-php)/i.test(mime)
    );
}

function isImageAttachment(mime: string, name: string): boolean {
    return mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extensionOf(name));
}

function isTextAttachment(mime: string, name: string): boolean {
    return isTextMime(mime) || TEXT_EXTENSIONS.has(extensionOf(name));
}

function formatMiB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return formatMiB(bytes);
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function messageOf(error: unknown): string {
    return error instanceof Error && error.message ? error.message : "";
}

type PreviewState = "idle" | "loading" | "ready" | "error";

const state = ref<PreviewState>("idle");
const errorMessage = ref("");
const loadMoreError = ref("");
const loadingMore = ref(false);
const budget = ATTACHMENT_PREVIEW_BUDGET_BYTES;
const mimeType = ref("");
const bytes = ref<Uint8Array>(new Uint8Array());
const totalBytes = ref<number | null>(null);
const truncated = ref(false);
const objectUrl = ref<string | null>(null);
let controller: AbortController | null = null;

const isImage = computed(() => isImageAttachment(mimeType.value, props.attachment.name));
const isText = computed(
    () => !isImage.value && isTextAttachment(mimeType.value, props.attachment.name),
);
const loadedBytes = computed(() => bytes.value.byteLength);
const remainingBytes = computed(() =>
    totalBytes.value === null ? null : Math.max(0, totalBytes.value - loadedBytes.value),
);
const textContent = computed(() => (isText.value ? decodePreviewText(bytes.value) : ""));
const truncationMessage = computed(() =>
    remainingBytes.value === null
        ? t("files.previewTruncatedUnknown", {
              loaded: formatMiB(loadedBytes.value),
              budget: formatMiB(budget),
          })
        : t("files.previewTruncated", {
              loaded: formatMiB(loadedBytes.value),
              budget: formatMiB(budget),
              remaining: formatMiB(remainingBytes.value),
          }),
);
const loadRestLabel = computed(() =>
    remainingBytes.value === null
        ? t("files.previewLoadRestUnknown")
        : t("files.previewLoadRest", { remaining: formatMiB(remainingBytes.value) }),
);

function releaseObjectUrl() {
    if (objectUrl.value !== null) {
        URL.revokeObjectURL(objectUrl.value);
        objectUrl.value = null;
    }
}

function abortInFlight() {
    if (controller !== null) {
        controller.abort();
        controller = null;
    }
}

function refreshObjectUrl() {
    releaseObjectUrl();
    if (!isImage.value || truncated.value) return;
    const buffer = bytes.value.buffer.slice(
        bytes.value.byteOffset,
        bytes.value.byteOffset + bytes.value.byteLength,
    ) as ArrayBuffer;
    objectUrl.value = URL.createObjectURL(new Blob([buffer], { type: mimeType.value }));
}

function applyPreview(preview: AttachmentPreview) {
    mimeType.value =
        preview.mimeType && preview.mimeType !== "application/octet-stream"
            ? preview.mimeType
            : props.attachment.type;
    bytes.value = preview.bytes;
    totalBytes.value = preview.totalBytes;
    truncated.value = preview.truncated;
    state.value = "ready";
    refreshObjectUrl();
}

function reset() {
    abortInFlight();
    releaseObjectUrl();
    state.value = "idle";
    errorMessage.value = "";
    loadMoreError.value = "";
    loadingMore.value = false;
    mimeType.value = "";
    bytes.value = new Uint8Array();
    totalBytes.value = null;
    truncated.value = false;
}

async function load() {
    reset();
    if (!props.url) {
        state.value = "error";
        errorMessage.value = t("files.previewFailed");
        return;
    }
    const current = new AbortController();
    controller = current;
    state.value = "loading";
    try {
        const preview = await fetchAttachmentPreview(props.url, { signal: current.signal });
        if (current.signal.aborted) return;
        applyPreview(preview);
    } catch (error) {
        if (current.signal.aborted || isAbortError(error)) return;
        errorMessage.value = messageOf(error) || t("files.previewFailed");
        state.value = "error";
    } finally {
        if (controller === current) controller = null;
    }
}

/** Explicit user action: load the remainder, never triggered by the preview itself. */
async function loadRemainder() {
    if (loadingMore.value || !truncated.value) return;
    const current = new AbortController();
    controller = current;
    loadingMore.value = true;
    loadMoreError.value = "";
    try {
        const rest = await fetchAttachmentRemainder(props.url, loadedBytes.value, {
            signal: current.signal,
        });
        if (current.signal.aborted) return;
        const merged = new Uint8Array(bytes.value.byteLength + rest.bytes.byteLength);
        merged.set(bytes.value, 0);
        merged.set(rest.bytes, bytes.value.byteLength);
        bytes.value = merged;
        // Audit B2: one continue step does not necessarily finish the file — CP clamps every
        // response to the preview budget, so an attachment larger than 2× the budget is still
        // partial here. Only clear the prompt when the merged length proves completeness; an
        // unknown total keeps the previous (conservative) state.
        const total = rest.totalBytes ?? totalBytes.value;
        totalBytes.value = total;
        if (total !== null) truncated.value = merged.byteLength < total;
        refreshObjectUrl();
    } catch (error) {
        if (current.signal.aborted || isAbortError(error)) return;
        loadMoreError.value = messageOf(error) || t("files.previewLoadMoreFailed");
    } finally {
        if (controller === current) controller = null;
        loadingMore.value = false;
    }
}

function download() {
    const anchor = document.createElement("a");
    anchor.href = props.url;
    anchor.download = props.attachment.name;
    anchor.click();
}

watch(
    () => props.open,
    (open) => {
        if (open) void load();
        else reset();
    },
    // The dialog is mounted already-open (the entry sets attachment + open in one tick),
    // so the initial state must load too.
    { immediate: true },
);
watch(
    () => props.url,
    () => {
        if (props.open) void load();
    },
);
onBeforeUnmount(reset);
</script>

<template>
    <Dialog :open="props.open" @update:open="emit('update:open', $event)">
        <DialogContent class="sm:max-w-2xl" data-testid="attachment-preview-dialog">
            <DialogHeader>
                <DialogTitle class="truncate pr-6" :title="props.attachment.name">
                    {{ props.attachment.name }}
                </DialogTitle>
                <DialogDescription>
                    {{ formatSize(props.attachment.size) }}
                    <template v-if="props.attachment.type">
                        · {{ props.attachment.type }}
                    </template>
                </DialogDescription>
            </DialogHeader>

            <div
                v-if="state === 'loading'"
                data-testid="attachment-preview-loading"
                class="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
            >
                <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
                {{ t("files.previewLoading") }}
            </div>

            <div
                v-else-if="state === 'error'"
                data-testid="attachment-preview-error"
                class="flex flex-col items-start gap-3 py-6"
            >
                <p class="flex items-center gap-2 text-sm text-destructive" role="alert">
                    <TriangleAlert class="size-4" aria-hidden="true" />
                    {{ errorMessage || t("files.previewFailed") }}
                </p>
                <div class="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" @click="load">
                        {{ t("files.previewRetry") }}
                    </Button>
                    <Button size="sm" variant="outline" @click="download">
                        <Download class="size-4" />
                        {{ t("files.previewDownloadOriginal") }}
                    </Button>
                </div>
            </div>

            <template v-else-if="state === 'ready'">
                <div
                    v-if="isImage && !truncated && objectUrl"
                    data-testid="attachment-preview-image"
                    class="max-h-[70vh] overflow-auto"
                >
                    <ImagePreview :content="objectUrl" :file-name="props.attachment.name" />
                </div>
                <div
                    v-else-if="isImage"
                    data-testid="attachment-preview-image-truncated"
                    class="flex flex-col items-center gap-2 py-10 text-center"
                >
                    <ImageIcon class="size-12 text-muted-foreground/40" aria-hidden="true" />
                    <p class="text-sm text-muted-foreground">
                        {{ t("files.previewImageTruncated", { budget: formatMiB(budget) }) }}
                    </p>
                </div>
                <div
                    v-else-if="isText"
                    class="max-h-[60vh] overflow-auto rounded-lg border bg-muted/20"
                    data-testid="attachment-preview-text"
                >
                    <pre class="p-3 font-mono text-xs break-words whitespace-pre-wrap">{{
                        textContent
                    }}</pre>
                </div>
                <div v-else class="flex flex-col items-center gap-2 py-10 text-center">
                    <FileText class="size-12 text-muted-foreground/40" aria-hidden="true" />
                    <p class="text-sm text-muted-foreground">
                        {{ t("files.previewUnsupported") }}
                    </p>
                </div>

                <div
                    v-if="truncated"
                    data-testid="attachment-preview-truncated"
                    class="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
                >
                    <p>{{ truncationMessage }}</p>
                    <p v-if="loadMoreError" class="text-destructive" role="alert">
                        {{ loadMoreError }}
                    </p>
                    <div class="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            class="bg-amber-600 text-white hover:bg-amber-700"
                            :disabled="loadingMore"
                            data-testid="attachment-preview-load-rest"
                            @click="loadRemainder"
                        >
                            <LoaderCircle
                                v-if="loadingMore"
                                class="size-4 animate-spin"
                                aria-hidden="true"
                            />
                            {{ loadingMore ? t("files.previewLoadingMore") : loadRestLabel }}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            data-testid="attachment-preview-download"
                            @click="download"
                        >
                            <Download class="size-4" />
                            {{ t("files.previewDownloadOriginal") }}
                        </Button>
                    </div>
                </div>
                <DialogFooter v-else class="items-center justify-between gap-2">
                    <span class="text-xs text-muted-foreground">
                        {{ t("files.previewBudgetNote", { budget: formatMiB(budget) }) }}
                    </span>
                    <Button size="sm" variant="outline" @click="download">
                        <Download class="size-4" />
                        {{ t("files.previewDownloadOriginal") }}
                    </Button>
                </DialogFooter>
            </template>
        </DialogContent>
    </Dialog>
</template>
