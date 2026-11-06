import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { Pinia } from "pinia";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "../../i18n";
import { api } from "../../composables/api";
import type * as apiModule from "../../composables/api";
import { useAuthStore } from "../../stores/auth";
import { useSessionParticipantsStore } from "../../features/workspace/stores/sessionParticipants";
import type {
    SessionParticipantCapabilities,
    SessionParticipantListResponse,
} from "../../types/participant";
import type { UserQuestionListResponse } from "../../types/userQuestion";
import AppLayout from "../AppLayout.vue";

/**
 * PLAN-0660 T5.6 —— user-channel 的**生产接线点**（`AppLayout.vue`）行为证据。
 *
 * 这组用例存在的理由：hook 与 store action 各自早有单测，但"生产 caller = 0"正是 T5.6 要修的病。
 * 所以这里不测 hook 的内部逻辑（`useUserChannelSSE.spec.ts` 已覆盖），只测三件**接线**事实：
 * 1. 登录后的壳挂载时真的发出 `GET /api/v1/user-events`（带 Bearer，不是匿名轮询）；
 * 2. 帧真的流进 `sessionParticipants.onUserChannelHint`（能驱动名单重读，不是接了但丢在半路）；
 * 3. 壳卸载时连接真的被 abort（挂载/卸载成对，不留重连循环）。
 */

vi.mock("../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getPendingApprovals: vi.fn<typeof apiModule.api.getPendingApprovals>(),
            getWorkspace: vi.fn<typeof apiModule.api.getWorkspace>(),
            getSessionParticipants: vi.fn<() => Promise<SessionParticipantListResponse>>(),
            listUserQuestions: vi.fn<() => Promise<UserQuestionListResponse>>(),
        },
    };
});

const getParticipants = vi.mocked(api.getSessionParticipants);
const listQuestions = vi.mocked(api.listUserQuestions);

const CAPS: SessionParticipantCapabilities = {
    view: true,
    manage: false,
    mention: false,
    speakAs: false,
};

function createTestRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: "/workspace/:workspaceId/chat/:sessionId",
                component: { template: '<div data-testid="route-view" />' },
            },
            { path: "/workspace", component: { template: '<div data-testid="route-view" />' } },
            {
                path: "/workspace/:workspaceId",
                component: { template: '<div data-testid="route-view" />' },
            },
        ],
    });
}

interface SseFetchHarness {
    /** 每次 fetch 的 url/header/signal —— 用来断言"真的订阅了、真的用 Bearer、真的 abort 了"。 */
    requests: Array<{
        url: string;
        headers: Record<string, string>;
        signal: AbortSignal | null;
    }>;
    /** 推一帧（`text/event-stream` 原文）进连接。 */
    push: (chunk: string) => void;
}

/**
 * 用一条**手动驱动**的 `ReadableStream` 冒充 SSE 响应：推送时机由用例控制，不靠 sleep。
 */
function installSseFetch(): SseFetchHarness {
    const encoder = new TextEncoder();
    const requests: SseFetchHarness["requests"] = [];
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
        },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init) => {
            requests.push({
                url: String(input),
                headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
                signal: init?.signal ?? null,
            });
            return new Response(body, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        }),
    );
    return {
        requests,
        push(chunk: string) {
            streamController?.enqueue(encoder.encode(chunk));
        },
    };
}

let pinia: Pinia;

async function mountLayout() {
    const router = createTestRouter();
    await router.push("/workspace/workspace-1/chat/current");
    await router.isReady();
    const wrapper = mount(AppLayout, {
        global: {
            plugins: [router, i18n, pinia],
            stubs: {
                Sidebar: { template: '<aside data-testid="sidebar-stub" />' },
                "router-view": { template: '<div data-testid="route-view" />' },
            },
        },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(async () => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    const { writeTabWorkspaceId } = await import("../../lib/workspaceContext");
    writeTabWorkspaceId("workspace-1");
    vi.mocked(api.getPendingApprovals).mockResolvedValue([]);
    vi.mocked(api.getWorkspace).mockResolvedValue({ id: "workspace-1", name: "Workspace" });
    getParticipants.mockResolvedValue({ participants: [], capabilities: CAPS });
    listQuestions.mockResolvedValue({ items: [], pendingCount: 0 });
    useAuthStore().$patch({
        token: "token-1",
        user: { id: "user-1", email: "test@xihe.local" },
        workspace: { id: "workspace-1", name: "Workspace" },
    });
});

describe("AppLayout user-channel subscription (PLAN-0660 T5.6)", () => {
    it("opens the user channel with the Bearer token once the shell mounts", async () => {
        const harness = installSseFetch();

        const wrapper = await mountLayout();

        await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
        expect(harness.requests[0].url).toBe("/api/v1/user-events");
        expect(harness.requests[0].headers.Authorization).toBe("Bearer token-1");
        expect(harness.requests[0].headers.Accept).toBe("text/event-stream");

        wrapper.unmount();
    });

    it("feeds a participant_notified frame into the participants store (hint ⇒ one roster reload)", async () => {
        const store = useSessionParticipantsStore();
        await store.load("session-1");
        expect(getParticipants).toHaveBeenCalledTimes(1);

        const harness = installSseFetch();
        const wrapper = await mountLayout();
        await vi.waitFor(() => expect(harness.requests).toHaveLength(1));

        harness.push(
            'event: connected\ndata: {"serverTime":"2026-11-05T00:00:00Z"}\n\n' +
                'event: participant_notified\ndata: {"sessionId":"session-1","participantId":"p-1"}\n\n',
        );

        // 合并窗口（既有 300ms）之后应恰好重读一次名单 —— 走的是真 store action，不是桩。
        await vi.waitFor(() => expect(getParticipants).toHaveBeenCalledTimes(2));
        wrapper.unmount();
    });

    it("refetches the question projection on every handshake (T5.18: no replay, so reconnect ⇒ reload)", async () => {
        const harness = installSseFetch();
        const wrapper = await mountLayout();
        await vi.waitFor(() => expect(harness.requests).toHaveLength(1));

        // 通道不 replay：握手本身（首连与重连同一条路径）就是"现在把投影对齐"的信号。
        harness.push('event: connected\ndata: {"serverTime":"t"}\n\n');
        await vi.waitFor(() => expect(listQuestions).toHaveBeenCalledTimes(1));

        wrapper.unmount();
    });

    it("feeds a user_question frame into the questions store (hint ⇒ one projection refetch)", async () => {
        const harness = installSseFetch();
        const wrapper = await mountLayout();
        await vi.waitFor(() => expect(harness.requests).toHaveLength(1));

        harness.push('event: connected\ndata: {"serverTime":"t"}\n\n');
        await vi.waitFor(() => expect(listQuestions).toHaveBeenCalledTimes(1));

        harness.push(
            'event: user_question\ndata: {"questionId":"q-1","sessionId":"s-1","state":"pending"}\n\n',
        );

        // T5.19：hint 只标脏，投影在 300ms 合并窗后**整体重拉**（不是本地追加条目）。
        await vi.waitFor(() => expect(listQuestions).toHaveBeenCalledTimes(2));
        expect(listQuestions).toHaveBeenLastCalledWith({ state: "pending" });

        wrapper.unmount();
    });

    it("aborts the stream when the shell unmounts (mount/unmount stay paired)", async () => {
        const harness = installSseFetch();
        const wrapper = await mountLayout();
        await vi.waitFor(() => expect(harness.requests).toHaveLength(1));

        wrapper.unmount();

        expect(harness.requests[0].signal).not.toBeNull();
        expect(harness.requests[0].signal?.aborted).toBe(true);
    });

    it("does not open the channel without a token", async () => {
        const harness = installSseFetch();
        useAuthStore().$patch({ token: null });

        const wrapper = await mountLayout();
        await flushPromises();

        expect(harness.requests).toHaveLength(0);
        wrapper.unmount();
    });
});
