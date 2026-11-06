import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { ApiError, api } from "../../../composables/api";
import type { UserQuestionView } from "../../../types/userQuestion";

/** Hint 合并窗：同窗内的多个 `user_question` 帧只换一次列表请求。 */
const HINT_COALESCE_MS = 300;

/**
 * PLAN-0660 T5.19（M5-D）：当前**用户**的问答投影。
 *
 * 与 `sessionParticipants` 的差别**只在作用域**：用户通道是用户级的
 * （`spec/session/user-channel.md` §1/§4 —— 只按 Bearer 认证、不要求 `X-Workspace-Id`、切
 * workspace 不重建连接），所以这里**不按 session 过滤** hint：任何 `user_question` 帧都只说明
 * 「某条 addressed 给我的问题变了」，一律合并成一次投影重拉。
 *
 * 状态语义照 `sessionParticipants`（N3）：
 * - `items === null` = **还没加载**（不是「空列表」）；
 * - `forbidden` = 403；
 * - `error` = 其它失败（可重试）。
 *
 * 三条刻意的性质（对应 T5.19 的「同一 hint 重复到达不重复追加条目」）：
 * 1. **hint 只做失效提示**：不追加条目、不猜正文，条目只来自 `GET /user-questions`；
 * 2. 因此重复帧天然幂等 —— 合并窗内的 N 个 hint 只发 1 次请求，且 `items` 是**整体替换**，
 *    不存在「追加两次」的路径；
 * 3. `pendingCount` 恒取服务端值，本地不累加（服务端保证它与 `items` 同过滤条件，本地另算
 *    必然分叉，正是 `spec/session/user-channel.md` §3 禁止的第二事实源）。
 */
export const useUserQuestionsStore = defineStore("userQuestions", () => {
    const items = ref<UserQuestionView[] | null>(null);
    const pendingCount = ref(0);
    const loading = ref(false);
    const error = ref("");
    const forbidden = ref(false);
    let inflight: Promise<void> | null = null;
    let hintTimer: ReturnType<typeof setTimeout> | null = null;

    /** 只有真有待答问题才值得渲染徽标 —— 未加载（`null`）不等于 0，调用方用 `items` 区分。 */
    const hasPending = computed(() => pendingCount.value > 0);

    async function load(): Promise<void> {
        loading.value = true;
        error.value = "";
        forbidden.value = false;
        try {
            // `state=pending` 是 CP 目前唯一接受的过滤值（其余 400）；徽标与列表同源。
            const response = await api.listUserQuestions({ state: "pending" });
            items.value = response.items;
            pendingCount.value = response.pendingCount;
        } catch (cause) {
            items.value = null;
            pendingCount.value = 0;
            forbidden.value = cause instanceof ApiError && cause.problem.status === 403;
            if (!forbidden.value)
                error.value = cause instanceof ApiError ? cause.message : String(cause);
        } finally {
            loading.value = false;
        }
    }

    /** 幂等：已加载且无错时直接复用，避免壳与面板各发一次请求。 */
    async function ensureLoaded(): Promise<void> {
        if (items.value !== null && !error.value) return;
        return reload();
    }

    async function reload(): Promise<void> {
        if (inflight) return inflight;
        inflight = load().finally(() => {
            inflight = null;
        });
        return inflight;
    }

    /**
     * 一个 `user_question` hint 到达（`{questionId, sessionId, state}`，见 §4 的封闭事件集）。
     *
     * 用户级通道没有「不是当前会话就该忽略」的情形：这不带正文，只标记投影失效，所以恒接受。
     * 合并窗内重复到达是幂等的 —— 它们只会让**同一次**重拉发生。
     *
     * @returns 恒 `true`（签名与 SSE 的 `onQuestion` 钩子对齐，便于调用方直接断言）。
     */
    function onUserChannelHint(_questionId: string, _sessionId: string, _state: string): boolean {
        if (hintTimer !== null) return true;
        hintTimer = setTimeout(() => {
            hintTimer = null;
            void reload();
        }, HINT_COALESCE_MS);
        return true;
    }

    /**
     * 用一条**结案投影**就地结算，`pendingCount` 跟随服务端语义（只数 `pending`）。
     *
     * 已不在列表里的 id 被忽略：列表是 CP 投影，凭空多出一行会是本地发明的问题。
     */
    function applySettled(settled: UserQuestionView): void {
        if (items.value === null) return;
        const index = items.value.findIndex((item) => item.id === settled.id);
        if (index < 0) return;
        if (settled.state === "pending") {
            items.value[index] = settled;
            return;
        }
        items.value.splice(index, 1);
        pendingCount.value = Math.max(0, pendingCount.value - 1);
    }

    /**
     * 提交答案（`POST …/answer`）。成功返回**结案投影**（不是 204），据此就地结算、不必再拉一次。
     *
     * 冲突码原样抛给调用方映射本地化文案：`QUESTION_ALREADY_SETTLED` / `QUESTION_EXPIRED` /
     * `AGENT_QUESTION_DELIVERY_FAILED`。最后一个表示**回传失败、行仍是 `pending`**
     * （fail-closed，可重试），所以失败路径一律不动本地状态。
     */
    async function answer(id: string, answerText: string): Promise<UserQuestionView> {
        const settled = await api.answerUserQuestion(id, answerText);
        applySettled(settled);
        return settled;
    }

    /** 丢弃挂起的合并窗（登出 / 壳卸载）。在途请求由调用方决定是否需要 abort。 */
    function dispose(): void {
        if (hintTimer !== null) {
            clearTimeout(hintTimer);
            hintTimer = null;
        }
    }

    return {
        items,
        pendingCount,
        loading,
        error,
        forbidden,
        hasPending,
        load,
        ensureLoaded,
        reload,
        onUserChannelHint,
        answer,
        applySettled,
        dispose,
    };
});
