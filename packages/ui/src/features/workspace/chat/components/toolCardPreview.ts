/**
 * PLAN-0688 T1.3: shared text-preview policy for tool-call cards.
 *
 * Command streams and raw results use the 2000-character cap; read content
 * additionally caps at 200 lines. Cards project the returned refs directly and
 * do not re-implement truncation.
 */
import { computed, type Ref } from "vue";

export const RESULT_PREVIEW_CHARS = 2000;
export const CONTENT_PREVIEW_LINES = 200;

export function useCharPreview(source: Ref<string>, maxChars = RESULT_PREVIEW_CHARS) {
    const preview = computed(() => source.value.slice(0, maxChars));
    const truncated = computed(() => source.value.length > maxChars);
    return { preview, truncated };
}

export function useLinePreview(
    source: Ref<string>,
    maxLines = CONTENT_PREVIEW_LINES,
    maxChars = RESULT_PREVIEW_CHARS,
) {
    const lineLimited = computed(() => source.value.split("\n").slice(0, maxLines).join("\n"));
    const preview = computed(() => lineLimited.value.slice(0, maxChars));
    const truncated = computed(() => preview.value !== source.value);
    return { preview, truncated };
}
