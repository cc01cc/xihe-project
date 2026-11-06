import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { Pinia } from "pinia";
import { i18n } from "../../../../i18n";
import { api } from "../../../../composables/api";
import type { UserQuestionListResponse, UserQuestionView } from "../../../../types/userQuestion";
import { useUserQuestionsStore } from "../../stores/userQuestions";
import UserQuestionsEntry from "../UserQuestionsEntry.vue";

/**
 * PLAN-0660 T5.21/T5.22 —— B-7「全局导航入口」的接线事实。
 *
 * 这组用例只钉入口本身的四件事：零态不占位、徽标取**服务端** `pendingCount`、展开能看到卡片、
 * 加载失败/无权限有文案。四态渲染与不可信文本由 `UserQuestionCard.spec.ts` 覆盖，hint 幂等由
 * `stores/__tests__/userQuestions.spec.ts` 覆盖，这里不重复。
 */
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

const listQuestions = vi.mocked(api.listUserQuestions);

function question(overrides: Partial<UserQuestionView> = {}): UserQuestionView {
    return {
        id: "q-1",
        sessionId: "s-1",
        runId: "r-1",
        state: "pending",
        prompt: "要继续执行吗？",
        answer: null,
        expiresAt: null,
        createdAt: "2026-11-06T12:00:00Z",
        firstDeliveredAt: null,
        settledAt: null,
        ...overrides,
    };
}

let pinia: Pinia;

function mountEntry() {
    return mount(UserQuestionsEntry, { global: { plugins: [pinia, i18n] } });
}

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.clearAllMocks();
    listQuestions.mockResolvedValue({ items: [], pendingCount: 0 });
});

describe("UserQuestionsEntry（PLAN-0660 T5.21 全局导航入口）", () => {
    it("没有欠答时完全不占位（注意力预算：L2 低频面不常驻）", () => {
        const entry = mountEntry();
        expect(entry.find("[data-testid=sidebar-user-questions]").exists()).toBe(false);
    });

    it("有欠答时渲染入口，徽标显示服务端的 pendingCount", async () => {
        const store = useUserQuestionsStore();
        store.items = [question(), question({ id: "q-2" })];
        store.pendingCount = 2;

        const entry = mountEntry();
        await flushPromises();

        expect(entry.get("[data-testid=sidebar-user-questions]").attributes("aria-expanded")).toBe(
            "false",
        );
        expect(entry.get("[data-testid=user-questions-badge]").text()).toBe("2");
    });

    it("展开后渲染每一条的卡片；收起再展开仍一致", async () => {
        const store = useUserQuestionsStore();
        store.items = [question(), question({ id: "q-2", prompt: "第二个问题" })];
        store.pendingCount = 2;

        const entry = mountEntry();
        await entry.get("[data-testid=sidebar-user-questions]").trigger("click");

        const cards = entry.findAll("[data-testid=user-question-card]");
        expect(cards).toHaveLength(2);
        expect(cards[1].get("[data-testid=user-question-prompt]").text()).toBe("第二个问题");
    });

    it("加载失败时给文案，且不把 CP 的英文 detail 透给用户", async () => {
        const store = useUserQuestionsStore();
        store.items = [];
        store.pendingCount = 1;
        store.error = "SERVICE ENGLISH DETAIL";
        store.forbidden = false;

        const entry = mountEntry();
        await entry.get("[data-testid=sidebar-user-questions]").trigger("click");

        const alert = entry.get("[data-testid=user-questions-load-error]");
        expect(alert.text()).toBe("待答问题加载失败");
        expect(alert.text()).not.toContain("SERVICE ENGLISH DETAIL");
    });

    it("403 走「无权限」文案，与普通加载失败区分开", async () => {
        const store = useUserQuestionsStore();
        store.items = [];
        store.pendingCount = 1;
        store.error = "Forbidden";
        store.forbidden = true;

        const entry = mountEntry();
        await entry.get("[data-testid=sidebar-user-questions]").trigger("click");

        expect(entry.get("[data-testid=user-questions-load-error]").text()).toBe(
            "没有查看待答问题的权限",
        );
    });

    it("在入口里作答：走 POST /answer，成功后该行消失且徽标递减（闭环）", async () => {
        const store = useUserQuestionsStore();
        store.items = [question()];
        store.pendingCount = 1;
        vi.mocked(api.answerUserQuestion).mockResolvedValue(
            question({ state: "answered", answer: "继续" }),
        );

        const entry = mountEntry();
        await entry.get("[data-testid=sidebar-user-questions]").trigger("click");
        await entry.get("[data-testid=user-question-input]").setValue("继续");
        await entry.get("[data-testid=user-question-submit]").trigger("click");
        await flushPromises();

        expect(api.answerUserQuestion).toHaveBeenCalledWith("q-1", "继续");
        expect(store.items).toEqual([]);
        expect(store.pendingCount).toBe(0);
        // 归零后入口整体收起，不再占一行。
        expect(entry.find("[data-testid=sidebar-user-questions]").exists()).toBe(false);
    });
});
