import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { toast as sonnerToast } from "vue-sonner";
import { i18n } from "../../../../i18n";
import { ApiError, api } from "../../../../composables/api";
import { useChatStore } from "../stores/chat.ts";
import { useSessionStore } from "../../../../stores/session";
import SessionItem from "../components/SessionItem.vue";
import SessionList from "../components/SessionList.vue";

const { toastError, toastSuccess } = vi.hoisted(() => ({
    toastError: vi.fn<typeof sonnerToast.error>(),
    toastSuccess: vi.fn<typeof sonnerToast.success>(),
}));
vi.mock("vue-sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BRANCH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ANCHOR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CHILD_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function createTestRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: "/workspace/:workspaceId/session/:sessionId",
                component: { setup: () => () => null },
            },
        ],
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    toastError.mockClear();
    toastSuccess.mockClear();
});

describe("SessionList parent-child deletion warning (PLAN-0408 T3.2)", () => {
    it("warns that spawned children continue, and deletes only after confirmation", async () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [
            {
                id: SESSION_ID,
                title: "Parent session",
                createdAt: "2026-09-27T00:00:00Z",
                updatedAt: "2026-09-27T00:00:00Z",
                workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                context: { agents: [] },
            },
        ];
        const deleteSession = vi.spyOn(sessionStore, "deleteSession").mockResolvedValue();
        const clearSession = vi.spyOn(useChatStore(), "clearSession");
        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        const item = wrapper.findComponent(SessionItem);

        item.vm.$emit("delete", SESSION_ID);
        await flushPromises();

        expect(wrapper.get('[data-testid="session-delete-warning"]').text()).toContain(
            "由它派生的子会话和运行会保留，并可继续独立运行",
        );
        expect(deleteSession).not.toHaveBeenCalled();

        await wrapper.get('[data-testid="session-delete-cancel"]').trigger("click");
        expect(deleteSession).not.toHaveBeenCalled();

        item.vm.$emit("delete", SESSION_ID);
        await flushPromises();
        await wrapper.get('[data-testid="session-delete-confirm"]').trigger("click");
        await flushPromises();

        expect(deleteSession).toHaveBeenCalledWith(SESSION_ID);
        expect(clearSession).toHaveBeenCalledWith(SESSION_ID);
        wrapper.unmount();
    });
});

describe("SessionList current-session fork action", () => {
    it("uses the selected server branch and a visible canonical terminal message, reusing its key on retry", async () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [
            {
                id: SESSION_ID,
                title: "Source session",
                createdAt: "2026-09-29T00:00:00Z",
                updatedAt: "2026-09-29T00:00:00Z",
                workspaceId: WORKSPACE_ID,
                context: { agents: [] },
            },
        ];
        sessionStore.selectSession(SESSION_ID);

        const chatStore = useChatStore();
        chatStore.setSessionBranches(SESSION_ID, [
            {
                branchId: BRANCH_ID,
                parentBranchId: null,
                forkPointMessageId: null,
                forkPointRunId: null,
                createdAt: "2026-09-29T00:00:00Z",
            },
        ]);
        chatStore.loadMessages(SESSION_ID, [
            {
                id: ANCHOR_ID,
                sessionId: SESSION_ID,
                role: "user",
                content: "Visible persisted prompt",
                timestamp: "2026-09-29T00:00:00Z",
                runId: "run-anchor",
                runStatus: "succeeded",
            },
            {
                id: "optimistic-client-id",
                sessionId: SESSION_ID,
                role: "assistant",
                content: "Local optimistic content",
                timestamp: "2026-09-29T00:00:01Z",
                runId: "run-local",
                runStatus: "succeeded",
            },
        ]);

        const router = createTestRouter();
        await router.push(`/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`);
        await router.isReady();
        const wrapper = mount(SessionList, {
            global: { plugins: [i18n, router], stubs: { Teleport: true } },
        });

        vi.spyOn(api, "getMessages").mockResolvedValue([
            {
                id: ANCHOR_ID,
                sessionId: SESSION_ID,
                role: "USER",
                content: "Visible persisted prompt",
                createdAt: "2026-09-29T00:00:00Z",
                runId: "run-anchor",
                runStatus: "succeeded",
            },
            {
                id: "server-only-message",
                sessionId: SESSION_ID,
                role: "ASSISTANT",
                content: "Not currently visible",
                createdAt: "2026-09-29T00:00:02Z",
                runId: "run-server-only",
                runStatus: "succeeded",
            },
        ]);
        const forkSession = vi
            .spyOn(api, "forkSession")
            .mockRejectedValueOnce(
                new ApiError({
                    status: 409,
                    code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
                    detail: "Retry this request",
                    requestId: "request-1",
                }),
            )
            .mockResolvedValueOnce({
                id: CHILD_ID,
                title: "Forked session",
                workspaceId: WORKSPACE_ID,
            });
        vi.spyOn(api, "getSessions").mockResolvedValue({
            sessions: [
                { id: SESSION_ID, title: "Source session", workspaceId: WORKSPACE_ID },
                { id: CHILD_ID, title: "Forked session", workspaceId: WORKSPACE_ID },
            ],
        });

        const item = wrapper.findComponent(SessionItem);
        const clickFork = async () => {
            await item.get('[data-testid="session-item"]').trigger("contextmenu");
            await item.get('[data-testid="session-item-fork"]').trigger("click");
            await flushPromises();
        };

        await clickFork();
        // task-45：toast 只给可读文案（改前 `toHaveBeenCalledWith("CODE: english detail")`
        // 把「英文码 + 英文兜底」钉成了契约）。
        const forkErrorText = String(toastError.mock.calls[0]?.[0] ?? "");
        expect(forkErrorText).not.toContain("IDEMPOTENCY_REQUEST_IN_PROGRESS");
        expect(forkErrorText).not.toContain("Retry this request");
        await clickFork();

        expect(api.getMessages).toHaveBeenCalledWith(SESSION_ID, BRANCH_ID);
        expect(forkSession).toHaveBeenCalledTimes(2);
        expect(forkSession).toHaveBeenNthCalledWith(
            1,
            SESSION_ID,
            { sourceBranchId: BRANCH_ID, anchorMessageId: ANCHOR_ID },
            expect.any(String),
        );
        expect(forkSession.mock.calls[1]?.[2]).toBe(forkSession.mock.calls[0]?.[2]);
        expect(sessionStore.currentSessionId).toBe(CHILD_ID);
        expect(router.currentRoute.value.path).toBe(
            `/workspace/${WORKSPACE_ID}/session/${CHILD_ID}`,
        );
        expect(toastSuccess).toHaveBeenCalledWith("已创建并打开分叉会话");
        wrapper.unmount();
    });
});

describe("SessionList delegation tree (PLAN-0655 T1.5)", () => {
    const PARENT_ID = "11111111-1111-4111-8111-111111111111";
    const DELEGATED_ID = "22222222-2222-4222-8222-222222222222";

    function usage() {
        return {
            rootSessionId: PARENT_ID,
            usedSessions: 1,
            maxCount: 1,
            currentDepth: 1,
            maxDepth: 2,
            principalId: "33333333-3333-4333-8333-333333333333",
            principalName: "Promo Agent B",
            policySource: "subject" as const,
            disabled: false,
        };
    }

    function baseSession(id: string, title: string) {
        return {
            id,
            title,
            createdAt: "2026-11-04T00:00:00Z",
            updatedAt: "2026-11-04T00:00:00Z",
            workspaceId: WORKSPACE_ID,
            context: { agents: [] },
        };
    }

    it("renders a delegated child indented under its parent with badge, chip and one usage fetch", async () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [
            { ...baseSession(PARENT_ID, "Promo 启动"), kind: null, spawnedFromSessionId: null },
            {
                ...baseSession(DELEGATED_ID, "翻译校对"),
                kind: "SPAWN",
                spawnedFromSessionId: PARENT_ID,
            },
        ];
        const usageSpy = vi.spyOn(api, "delegationUsage").mockResolvedValue(usage());

        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        await flushPromises();

        const rows = wrapper.findAll('[data-testid="session-item"]');
        expect(rows).toHaveLength(2);
        expect(rows[0].text()).toContain("Promo 启动");
        expect(rows[1].text()).toContain("翻译校对");
        expect(rows[1].get('[data-testid="session-delegated-badge"]').text()).toContain("委派");
        expect(rows[1].get('[data-testid="session-delegation-chip"]').text()).toContain(
            "Promo Agent B",
        );
        expect(rows[1].get('[data-testid="session-delegation-chip"]').text()).toContain("1/1");
        expect(rows[1].attributes("style") ?? "").toContain("padding-left: 2rem");
        expect(usageSpy).toHaveBeenCalledTimes(1);
        expect(usageSpy).toHaveBeenCalledWith(DELEGATED_ID);
        wrapper.unmount();
    });

    it("keeps a child row when its parent is not in the list (filtering never hides delegation)", async () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [
            {
                ...baseSession(DELEGATED_ID, "翻译校对"),
                kind: "SPAWN",
                spawnedFromSessionId: "99999999-9999-4999-8999-999999999999",
            },
        ];
        vi.spyOn(api, "delegationUsage").mockResolvedValue(usage());

        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        await flushPromises();

        const rows = wrapper.findAll('[data-testid="session-item"]');
        expect(rows).toHaveLength(1);
        expect(rows[0].text()).toContain("翻译校对");
        expect(rows[0].get('[data-testid="session-delegated-badge"]').exists()).toBe(true);
        expect(rows[0].attributes("style") ?? "").not.toContain("padding-left");
        wrapper.unmount();
    });

    // PLAN-0668 T2.4：三处消费点（会话树层级 / 委派徽标 / DAG 数据源）必须从
    // api.getSessions 的真实投影链路拿到 lineage，而不是靠测试直接塞 store 状态。
    it("keeps the api projection → session tree chain for delegated children (PLAN-0668 T2.4)", async () => {
        const wire = {
            sessions: [
                {
                    id: PARENT_ID,
                    title: "Promo 启动",
                    workspaceId: WORKSPACE_ID,
                    archived: false,
                    kind: null,
                    spawnedFromSessionId: null,
                    spawnedAt: null,
                    createdAt: "2026-11-05T00:00:00Z",
                    updatedAt: "2026-11-05T00:00:00Z",
                },
                {
                    id: DELEGATED_ID,
                    title: "翻译校对",
                    workspaceId: WORKSPACE_ID,
                    archived: false,
                    kind: "SPAWN",
                    spawnedFromSessionId: PARENT_ID,
                    spawnedAt: "2026-11-05T00:01:00Z",
                    createdAt: "2026-11-05T00:01:00Z",
                    updatedAt: "2026-11-05T00:01:00Z",
                },
            ],
        };
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(wire),
        } as Response);
        const response = await api.getSessions();
        fetchSpy.mockRestore();

        expect(response.sessions[1]).toMatchObject({
            id: DELEGATED_ID,
            kind: "SPAWN",
            spawnedFromSessionId: PARENT_ID,
            spawnedAt: "2026-11-05T00:01:00Z",
        });

        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = response.sessions;
        const usageSpy = vi.spyOn(api, "delegationUsage").mockResolvedValue(usage());

        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        await flushPromises();

        const rows = wrapper.findAll('[data-testid="session-item"]');
        expect(rows).toHaveLength(2);
        expect(rows[1].get('[data-testid="session-delegated-badge"]').exists()).toBe(true);
        expect(rows[1].get('[data-testid="session-delegation-chip"]').text()).toContain(
            "Promo Agent B",
        );
        expect(rows[1].attributes("style") ?? "").toContain("padding-left: 2rem");
        expect(usageSpy).toHaveBeenCalledWith(DELEGATED_ID);
        wrapper.unmount();
    });
});

/**
 * task-906：真栈读数里「`aria-current="page"` 落在 XIHE-E2E-SPAWN…」并不是子会话抢高亮 ——
 * 父会话建出来叫「未命名会话」，CP 按 `D-1866`/`SessionTitleDeriver` 从首条用户消息派生标题，
 * 子会话又继承父标题 ⇒ 父行与子行的可见标题**逐字相同**，光看标题分不出哪一行是高亮行。
 *
 * <p>本组钉的是组件侧的判据：高亮只认 `sessionStore.currentSessionId` 这一处
 * （`rowProps` 与 `v-else` 分支同源），子行即使与父行同名也不得抢。若哪天有人把「最近活动」
 * 或父子关系塞进高亮判定，这两条立即红。</p>
 */
describe("SessionList aria-current 只认当前会话（task-906）", () => {
    const PARENT = "66666666-6666-4666-8666-666666666666";
    const CHILD = "77777777-7777-4777-8777-777777777777";
    const OTHER = "88888888-8888-4888-8888-888888888888";

    function row(
        id: string,
        title: string,
        extra: { kind?: string | null; spawnedFromSessionId?: string | null } = {},
    ) {
        return {
            id,
            title,
            createdAt: "2026-11-23T00:00:00Z",
            updatedAt: "2026-11-23T00:00:00Z",
            workspaceId: WORKSPACE_ID,
            kind: extra.kind ?? null,
            spawnedFromSessionId: extra.spawnedFromSessionId ?? null,
            context: { agents: [] },
        };
    }

    it("选中父会话时，`aria-current` 只出现在父行（子行标题不同）", () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [
            row(PARENT, "父会话"),
            row(CHILD, "子会话", { kind: "SPAWN", spawnedFromSessionId: PARENT }),
            row(OTHER, "无关会话"),
        ];
        sessionStore.selectSession(PARENT);

        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });

        const current = wrapper.findAll('[data-testid="session-item"][aria-current="page"]');
        expect(current).toHaveLength(1);
        expect(current[0]!.attributes("aria-label")).toBe("父会话");

        const child = wrapper.findAll('[data-testid="session-item"]')[1]!;
        expect(child.attributes("aria-label")).toBe("子会话");
        expect(child.attributes("aria-current")).toBeUndefined();
        wrapper.unmount();
    });

    it("父行与子行同名（CP 派生标题的真实形态）时，高亮仍只落在父行", () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        const derivedTitle = "XIHE-E2E-SPAWN spawn-mwsmiw9k";
        sessionStore.sessions = [
            row(PARENT, derivedTitle),
            row(CHILD, derivedTitle, { kind: "SPAWN", spawnedFromSessionId: PARENT }),
        ];
        sessionStore.selectSession(PARENT);

        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        const rows = wrapper.findAll('[data-testid="session-item"]');
        expect(rows).toHaveLength(2);
        // 行序 = 父行 + 其子行（`rowsFor` 的不变量）；同名时只能靠位置区分。
        expect(rows[0]!.attributes("aria-current")).toBe("page");
        expect(rows[1]!.attributes("aria-current")).toBeUndefined();
        expect(rows[1]!.attributes("style") ?? "").toContain("padding-left: 2rem");
        wrapper.unmount();
    });
});

/**
 * task-152 / `D-1221` ④：独立会话（L3）的可排序能力 —— 卡面判据 1/4/6 的组件侧。
 *
 * <p>只钉三件事：① `sortable` 默认关时**不产生任何新 DOM**（判据 1 的形态：L2 零变化）；
 * ② `order` 投影与「未知 id 落最前」；③ 子行随父（一个拖拽单元 = 父行 + 其子行）。</p>
 *
 * <p>真拖拽由 e2e 钉（jsdom 没有布局，Sortable 的落点计算不成立）；这里只验数据与结构。</p>
 */
describe("SessionList 独立会话排序（task-152）", () => {
    function session(id: string, title: string, kind = "CHAT", spawnedFromSessionId?: string) {
        return {
            id,
            title,
            createdAt: "2026-11-17T00:00:00Z",
            updatedAt: "2026-11-17T00:00:00Z",
            workspaceId: null,
            kind,
            spawnedFromSessionId,
            context: { agents: [] },
        };
    }

    function mountList(props: Record<string, unknown>) {
        setActivePinia(createPinia());
        return mount(SessionList, {
            props,
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
    }

    function renderedTitles(wrapper: ReturnType<typeof mountList>): string[] {
        return wrapper
            .findAll('[data-testid="session-item"]')
            .map((row) => row.attributes("aria-label")!);
    }

    it("sortable 默认关 ⇒ 不产生任何新 DOM（L2 零变化，判据 1）", () => {
        const wrapper = mountList({ sessions: [session("a", "A"), session("b", "B")] });
        expect(wrapper.findAll("[data-session-id]")).toHaveLength(0);
        expect(wrapper.findAll('[data-testid="session-order-status"]')).toHaveLength(0);
        expect(renderedTitles(wrapper)).toEqual(["A", "B"]);
    });

    it("sortable 开 ⇒ 每行包一个拖拽单元（子行在同一单元内，不可单独拖）", () => {
        const wrapper = mountList({
            sessions: [session("a", "A"), session("b", "B", "SPAWN", "a"), session("c", "C")],
            sortable: true,
            order: [],
        });
        const units = wrapper.findAll("[data-session-id]");
        expect(units.map((unit) => unit.attributes("data-session-id"))).toEqual(["a", "c"]);
        expect(units[0]!.findAll('[data-testid="session-item"]')).toHaveLength(2);
    });

    it("order 投影：已知按名次、未知落最前（判据 4）", () => {
        const wrapper = mountList({
            sessions: [session("a", "A"), session("b", "B"), session("c", "C")],
            sortable: true,
            order: ["c", "a", "b"],
        });
        expect(renderedTitles(wrapper)).toEqual(["C", "A", "B"]);
    });

    it("未知 id 落最前而不是追加末尾", () => {
        const wrapper = mountList({
            sessions: [session("a", "A"), session("b", "B"), session("c", "C")],
            sortable: true,
            order: ["b"],
        });
        expect(renderedTitles(wrapper)).toEqual(["A", "C", "B"]);
    });

    it("Alt+↓ 发出新顺序，Alt+Home 到首位，已在首位时不发", async () => {
        const wrapper = mountList({
            sessions: [session("a", "A"), session("b", "B"), session("c", "C")],
            sortable: true,
            order: [],
        });
        const innerA = wrapper.get('[data-session-id="a"] [data-testid="session-item"]');

        await innerA.trigger("keydown", { key: "ArrowDown", altKey: true });
        expect(wrapper.emitted("reorder")?.at(-1)).toEqual([["b", "a", "c"]]);

        await innerA.trigger("keydown", { key: "Home", altKey: true });
        // 已经在首位：不发新顺序（也不 preventDefault）
        expect(wrapper.emitted("reorder")).toHaveLength(1);

        await wrapper
            .get('[data-session-id="c"] [data-testid="session-item"]')
            .trigger("keydown", { key: "Home", altKey: true });
        expect(wrapper.emitted("reorder")?.at(-1)).toEqual([["c", "a", "b"]]);
    });

    it("不带 Alt 的方向键不接管（行内导航语义不变）", async () => {
        const wrapper = mountList({
            sessions: [session("a", "A"), session("b", "B")],
            sortable: true,
            order: [],
        });
        await wrapper
            .get('[data-session-id="a"] [data-testid="session-item"]')
            .trigger("keydown", { key: "ArrowDown" });
        expect(wrapper.emitted("reorder")).toBeUndefined();
    });
});
