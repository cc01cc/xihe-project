import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError, type ChatRunGuidanceSnapshot } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";

const MAX_GUIDANCE_LENGTH = 8000;

interface UseGuidanceOptions {
    runId: () => string | undefined;
    runStatus: () => string;
}

export function useGuidance(options: UseGuidanceOptions) {
    const { t } = useI18n();
    const snapshot = ref<ChatRunGuidanceSnapshot | null>(null);
    const submitting = ref(false);
    const error = ref<string | null>(null);
    const bannerError = ref<string | null>(null);
    let fetchGeneration = 0;
    let submitGeneration = 0;

    const items = computed(() => snapshot.value?.items ?? []);
    const latestSequence = computed(() => snapshot.value?.latestSequence ?? 0);

    const isActiveRun = computed(() => {
        const status = options.runStatus();
        return status === "executing" || status === "thinking" || status === "awaiting_approval";
    });

    async function refetch(): Promise<void> {
        const runId = options.runId();
        if (!runId) {
            snapshot.value = null;
            return;
        }
        const generation = ++fetchGeneration;
        try {
            const result = await api.getChatRunGuidance(runId);
            if (generation !== fetchGeneration) return;
            snapshot.value = result;
            error.value = null;
        } catch (err) {
            if (generation !== fetchGeneration) return;
            logger.warn("guidance: refetch failed", err);
            error.value = t("chat.guidanceErrorNetwork");
        }
    }

    function errorMessageFor(err: unknown): string {
        if (err instanceof ApiError) {
            const status = err.problem.status;
            if (status === 409) return t("chat.guidanceErrorNotActive");
            if (status === 403) return t("chat.guidanceErrorForbidden");
            if (status === 404) return t("chat.guidanceErrorNotFound");
            if (status === 422) return t("chat.guidanceErrorTooLong");
            if (status === 400) return t("chat.guidanceErrorBadRequest");
            return t("chat.guidanceErrorServer");
        }
        return t("chat.guidanceErrorNetwork");
    }

    async function submit(content: string): Promise<boolean> {
        const runId = options.runId();
        if (!runId || !content.trim() || content.length > MAX_GUIDANCE_LENGTH) {
            return false;
        }
        const generation = ++submitGeneration;
        submitting.value = true;
        bannerError.value = null;
        try {
            await api.submitChatRunGuidance(runId, content, crypto.randomUUID());
            if (generation !== submitGeneration) return false;
            await refetch();
            return true;
        } catch (err) {
            if (generation !== submitGeneration) return false;
            const message = errorMessageFor(err);
            bannerError.value = message;
            logger.warn("guidance: submit failed", err);
            void refetch();
            return false;
        } finally {
            if (generation === submitGeneration) {
                submitting.value = false;
            }
        }
    }

    watch(
        () => options.runId(),
        () => {
            snapshot.value = null;
            void refetch();
        },
    );

    return {
        items,
        latestSequence,
        submitting,
        error,
        bannerError,
        isActiveRun,
        refetch,
        submit,
    };
}
