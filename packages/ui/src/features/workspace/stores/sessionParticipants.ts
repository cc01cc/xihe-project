import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { ApiError, api } from "../../../composables/api";
import type {
    ParticipantReadCursor,
    SessionParticipantCapabilities,
    SessionParticipantView,
} from "../../../types/participant";

const FALLBACK_CAPABILITIES: SessionParticipantCapabilities = {
    view: false,
    manage: false,
    mention: false,
    speakAs: false,
};

/**
 * PLAN-0623：会话参与者**单一数据源**。
 *
 * dock 的「成员」面板与 composer 的「代发」下拉都需要同一份 `participants + capabilities`；
 * 若各自 `GET` 一次，两份数据会各自过期（典型症状：面板已显示某行，下拉里没有它）。
 * ⇒ 统一走这里，`ensureLoaded()` 幂等复用同一次响应。
 *
 * 状态语义与面板一致（N3）：
 * - `participants === null` = **还没加载**（不是"空列表"）；
 * - `forbidden` = 403 / `view === false`；
 * - `error` = 其它失败（可重试）。
 */
import { createHintCoalescer } from "../chat/userChannelHintCoalescer";

export const useSessionParticipantsStore = defineStore("sessionParticipants", () => {
    const sessionId = ref<string | null>(null);
    const participants = ref<SessionParticipantView[] | null>(null);
    const capabilities = ref<SessionParticipantCapabilities>({ ...FALLBACK_CAPABILITIES });
    const loading = ref(false);
    const error = ref("");
    const forbidden = ref(false);
    let inflight: Promise<void> | null = null;

    /**
     * D23-27：代发候选 = 我拥有的、且未停用的参与者。
     *
     * `selfOwned` 在 CP 侧已经排除了停用行（HUMAN 被停用 agent 也一样），这里再判一次
     * `disabledAt` 是**双保险**：即使 CP 的归约将来变了，UI 也不会替一个停用参与者发言
     * （服务端会 403 `PARTICIPANT_DISABLED`，那是"根本不接受"，不该做成可点入口）。
     */
    const speakAsCandidates = computed(() =>
        (participants.value ?? []).filter((item) => item.selfOwned === true && !item.disabledAt),
    );

    /** `speakAs` 是**同一个响应**里的归约结果，与 `speakAsCandidates` 必须一致。 */
    const canSpeakAs = computed(
        () => capabilities.value.speakAs && speakAsCandidates.value.length > 0,
    );

    async function load(id: string | null): Promise<void> {
        sessionId.value = id;
        if (!id) {
            participants.value = null;
            capabilities.value = { ...FALLBACK_CAPABILITIES };
            loading.value = false;
            error.value = "";
            forbidden.value = false;
            return;
        }
        loading.value = true;
        error.value = "";
        forbidden.value = false;
        try {
            const response = await api.getSessionParticipants(id);
            participants.value = response.participants;
            capabilities.value = response.capabilities;
        } catch (cause) {
            participants.value = null;
            capabilities.value = { ...FALLBACK_CAPABILITIES };
            // T3.7：403 是"没有权限"，与"空列表"和"加载失败"分开呈现。
            forbidden.value = cause instanceof ApiError && cause.problem.status === 403;
            if (!forbidden.value)
                error.value = cause instanceof ApiError ? cause.message : String(cause);
        } finally {
            loading.value = false;
        }
    }

    /** 幂等：同一会话已加载过就直接复用，避免面板与下拉各发一次请求。 */
    async function ensureLoaded(id: string | null): Promise<void> {
        if (id && id === sessionId.value && participants.value !== null && !error.value) return;
        if (inflight) return inflight;
        inflight = load(id).finally(() => {
            inflight = null;
        });
        return inflight;
    }

    async function reload(): Promise<void> {
        await load(sessionId.value);
    }

    /** PLAN-0660 T5.6: coalesces user-channel hints into one roster reload per window. */
    const hintCoalescer = createHintCoalescer(() => sessionId.value, {
        onFlush: () => {
            void reload();
        },
    });

    /** 本地失效（例如刚 `DELETE` 过某行）：下一次 `ensureLoaded` 会重新拉取。 */
    function invalidate(): void {
        participants.value = null;
    }

    /**
     * PLAN-0660 T5.6: a `user-events` hint arrived. The channel only says "something changed for
     * this participant" — the badge keeps rendering the CP-derived `readCursor.mentionCount`, so the
     * only thing to do here is re-read the roster, coalesced so a burst of hints costs ONE reload.
     *
     * @returns `true` when the hint belongs to the session currently rendered.
     */
    function onUserChannelHint(hintSessionId: string, participantId: string): boolean {
        return hintCoalescer.push(hintSessionId, participantId);
    }

    /**
     * PLAN-0660 T5.6: adopt the cursor `PATCH …/cursor` returned for a row already on screen. The
     * number is the **server-clamped** one (`advance-only` + ceiling = session max sequence), so this
     * never computes unread itself — it replaces the row's `readCursor` and lets the badge derive
     * from it again.
     *
     * A row that is no longer in the list (session switched under us) is left alone: the roster is a
     * CP projection, so a cursor without a row would be a locally invented participant.
     */
    function applyCursor(participantId: string, cursor: ParticipantReadCursor): void {
        const row = participants.value?.find((item) => item.participantId === participantId);
        if (!row) return;
        row.readCursor = { ...cursor };
    }

    return {
        sessionId,
        participants,
        capabilities,
        loading,
        error,
        forbidden,
        speakAsCandidates,
        canSpeakAs,
        load,
        ensureLoaded,
        reload,
        invalidate,
        onUserChannelHint,
        applyCursor,
    };
});
