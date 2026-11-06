import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { UserQuestionListResponse, UserQuestionView } from "../../../../types/userQuestion";

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../../composables/api")>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listUserQuestions: vi.fn<() => Promise<UserQuestionListResponse>>(),
            answerUserQuestion: vi.fn<() => Promise<UserQuestionView>>(),
        },
    };
});

import { ApiError, api } from "../../../../composables/api";
import { useUserQuestionsStore } from "../userQuestions";

const listQuestions = vi.mocked(api.listUserQuestions);
const answerQuestion = vi.mocked(api.answerUserQuestion);

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const QUESTION_ID = "22222222-2222-4222-8222-222222222222";

function question(overrides: Partial<UserQuestionView> = {}): UserQuestionView {
    return {
        id: QUESTION_ID,
        sessionId: SESSION_ID,
        runId: "33333333-3333-4333-8333-333333333333",
        state: "pending",
        prompt: "继续执行吗？",
        answer: null,
        expiresAt: null,
        createdAt: "2026-11-06T12:00:00Z",
        firstDeliveredAt: null,
        settledAt: null,
        ...overrides,
    };
}

function listResponse(
    items: UserQuestionView[],
    pendingCount = items.length,
): UserQuestionListResponse {
    return { items, pendingCount };
}

beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
});

afterEach(() => {
    vi.useRealTimers();
});

describe("useUserQuestionsStore（PLAN-0660 T5.19 投影 store）", () => {
    it("拉取 addressee 投影，pendingCount 取服务端值而不本地累加", async () => {
        const pending = question();
        listQuestions.mockResolvedValue(listResponse([pending], 1));
        const store = useUserQuestionsStore();

        await store.load();

        expect(listQuestions).toHaveBeenCalledWith({ state: "pending" });
        expect(store.items).toEqual([pending]);
        expect(store.pendingCount).toBe(1);
        expect(store.hasPending).toBe(true);
        expect(store.loading).toBe(false);
        expect(store.error).toBe("");
        expect(store.forbidden).toBe(false);
    });

    it("「未加载」(null) 与「没有待答问题」(空数组) 是两种状态", async () => {
        const store = useUserQuestionsStore();
        expect(store.items).toBeNull();

        listQuestions.mockResolvedValue(listResponse([]));
        await store.load();

        expect(store.items).toEqual([]);
        expect(store.pendingCount).toBe(0);
        expect(store.hasPending).toBe(false);
    });

    it("403 归入 forbidden，其它失败归入可重试的 error", async () => {
        listQuestions.mockRejectedValueOnce(new ApiError({ status: 403, code: "FORBIDDEN" }));
        const store = useUserQuestionsStore();
        await store.load();
        expect(store.forbidden).toBe(true);
        expect(store.error).toBe("");
        expect(store.items).toBeNull();

        listQuestions.mockRejectedValueOnce(new Error("network down"));
        await store.load();
        expect(store.forbidden).toBe(false);
        // `String(error)` 带 "Error: " 前缀 —— 与 `sessionParticipants` 同款写法，断言只看信息在不在。
        expect(store.error).toContain("network down");
    });

    it("同一 hint 重复到达只触发一次重拉，且不重复追加条目（T5.19 判据）", async () => {
        vi.useFakeTimers();
        listQuestions.mockResolvedValue(listResponse([question()]));
        const store = useUserQuestionsStore();

        // 三个同 id 的 `user_question` 帧落在同一合并窗内（多 tab / 服务端重投的典型形状）。
        expect(store.onUserChannelHint(QUESTION_ID, SESSION_ID, "pending")).toBe(true);
        expect(store.onUserChannelHint(QUESTION_ID, SESSION_ID, "pending")).toBe(true);
        expect(store.onUserChannelHint(QUESTION_ID, SESSION_ID, "pending")).toBe(true);
        expect(listQuestions).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(300);

        expect(listQuestions).toHaveBeenCalledTimes(1);
        expect(store.items).toHaveLength(1);
        store.dispose();
    });

    it("重拉是整体替换，服务端只给一条时不会变成两条", async () => {
        listQuestions.mockResolvedValueOnce(listResponse([question()]));
        const store = useUserQuestionsStore();
        await store.load();
        expect(store.items).toHaveLength(1);

        listQuestions.mockResolvedValueOnce(listResponse([question()]));
        await store.reload();
        expect(store.items).toHaveLength(1);
        expect(store.pendingCount).toBe(1);
    });

    it("用 POST /answer 返回的结案投影就地结算，pendingCount 同步下降", async () => {
        const pending = question();
        listQuestions.mockResolvedValue(listResponse([pending], 1));
        const store = useUserQuestionsStore();
        await store.load();

        const settled = question({
            state: "answered",
            answer: "继续",
            settledAt: "2026-11-06T12:00:05Z",
        });
        answerQuestion.mockResolvedValue(settled);

        const result = await store.answer(QUESTION_ID, "继续");

        expect(answerQuestion).toHaveBeenCalledWith(QUESTION_ID, "继续");
        expect(result).toEqual(settled);
        expect(store.items).toEqual([]);
        expect(store.pendingCount).toBe(0);
        expect(store.hasPending).toBe(false);
    });

    it("502 AGENT_QUESTION_DELIVERY_FAILED 时本地保持 pending（fail-closed 可重试）", async () => {
        listQuestions.mockResolvedValue(listResponse([question()], 1));
        const store = useUserQuestionsStore();
        await store.load();

        answerQuestion.mockRejectedValue(
            new ApiError({ status: 502, code: "AGENT_QUESTION_DELIVERY_FAILED" }),
        );

        await expect(store.answer(QUESTION_ID, "继续")).rejects.toBeInstanceOf(ApiError);
        expect(store.items).toHaveLength(1);
        expect(store.items?.[0]?.state).toBe("pending");
        expect(store.pendingCount).toBe(1);
    });

    it("结案一条已不在投影里的问题不会凭空造行", async () => {
        listQuestions.mockResolvedValue(listResponse([], 0));
        const store = useUserQuestionsStore();
        await store.load();

        store.applySettled(question({ id: "44444444-4444-4444-8444-444444444444" }));

        expect(store.items).toEqual([]);
        expect(store.pendingCount).toBe(0);
    });

    it("无 workspace / session 上下文仍可用（用户级通道只按 Bearer 认证）", async () => {
        listQuestions.mockResolvedValue(listResponse([question()], 1));
        const store = useUserQuestionsStore();

        // store 的入口不接受任何 workspace/session 入参 —— 这正是用户级投影的契约形状。
        await store.ensureLoaded();

        expect(listQuestions).toHaveBeenCalledTimes(1);
        expect(store.items).toHaveLength(1);
        expect(store.pendingCount).toBe(1);
    });

    it("ensureLoaded 幂等：已加载且无错时不再发请求", async () => {
        listQuestions.mockResolvedValue(listResponse([question()], 1));
        const store = useUserQuestionsStore();

        await store.ensureLoaded();
        await store.ensureLoaded();

        expect(listQuestions).toHaveBeenCalledTimes(1);
    });

    it("请求在途时到达的 hint 不被吞：结算后自动补拉一次（P2-1）", async () => {
        vi.useFakeTimers();
        const store = useUserQuestionsStore();
        let releaseFirst: (value: UserQuestionListResponse) => void = () => {};
        listQuestions.mockReturnValueOnce(
            new Promise<UserQuestionListResponse>((resolve) => {
                releaseFirst = resolve;
            }),
        );
        listQuestions.mockResolvedValueOnce(listResponse([question()], 1));

        const slow = store.reload();
        // 慢请求尚未结算时通道来了一个 hint。
        store.onUserChannelHint(QUESTION_ID, SESSION_ID, "pending");
        await vi.advanceTimersByTimeAsync(300);

        // 合并窗到点，但它在途 ⇒ 只记账，不发第二个请求（也不丢）。
        expect(listQuestions).toHaveBeenCalledTimes(1);

        releaseFirst(listResponse([], 0));
        await slow;

        // 结算后补拉一次：hint 的失效最终被覆盖到，而不是等下一个事件。
        expect(listQuestions).toHaveBeenCalledTimes(2);
        expect(store.items).toHaveLength(1);
        expect(store.pendingCount).toBe(1);
    });

    it("dispose 作废在途响应：迟到的旧响应不写回，投影复位成未加载（P2-2）", async () => {
        const store = useUserQuestionsStore();
        let release: (value: UserQuestionListResponse) => void = () => {};
        listQuestions.mockReturnValueOnce(
            new Promise<UserQuestionListResponse>((resolve) => {
                release = resolve;
            }),
        );

        const slow = store.reload();
        // 登出 / 换账号：在途请求仍然会回来，但它已属于上一个世代。
        store.dispose();
        release(listResponse([question()], 1));
        await slow;

        expect(store.items).toBeNull();
        expect(store.pendingCount).toBe(0);
        expect(store.loading).toBe(false);
        expect(store.error).toBe("");
    });

    it("dispose 之后的新请求不会被旧世代吞掉（换账号重拉照常生效）", async () => {
        const store = useUserQuestionsStore();
        let releaseOld: (value: UserQuestionListResponse) => void = () => {};
        listQuestions.mockReturnValueOnce(
            new Promise<UserQuestionListResponse>((resolve) => {
                releaseOld = resolve;
            }),
        );
        const old = store.reload();
        store.dispose();

        // 新账号登录：同一 store 单例上重新拉取。
        listQuestions.mockResolvedValueOnce(listResponse([question({ id: "new-1" })], 1));
        const fresh = store.reload();
        releaseOld(listResponse([question({ id: "old-1" })], 1));
        await old;
        await fresh;

        expect(store.items?.map((item) => item.id)).toEqual(["new-1"]);
        expect(store.pendingCount).toBe(1);
    });
});
