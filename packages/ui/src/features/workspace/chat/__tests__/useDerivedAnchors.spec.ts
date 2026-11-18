import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { api, type WorkspaceAgentBinding } from "../../../../composables/api";
import { useAuthStore } from "../../../../stores/auth";
import { useSessionStore } from "../../../../stores/session";
import type { Session, SessionDerivedStateResponse } from "../../../../types";
import { useDerivedAnchors } from "../composables/useDerivedAnchors";

/**
 * task-1 / D-1846：接线层（读投影取数 + 按需补拉）。纯投影的正确性在
 * `derivedAnchors.spec.ts`；这里只钉**取数契约**：
 *  - 会话列表为空 ⇒ 拉一次；
 *  - derived-state 出现会话列表还不认识的子会话 ⇒ 只补拉**一次**（不轮询、不循环）；
 *  - 主体名册失败 ⇒ 降级（名字为 null），不抛错、不伪造名字。
 */
function session(overrides: Partial<Session> & { id: string }): Session {
    return {
        title: "主会话",
        createdAt: "2026-11-18T10:00:00.000Z",
        updatedAt: "2026-11-18T10:00:00.000Z",
        kind: null,
        spawnedFromSessionId: null,
        spawnedAt: null,
        agentPrincipalId: null,
        ...overrides,
    } as Session;
}

function derived(childSessionId: string, runId: string): SessionDerivedStateResponse {
    return {
        sessionId: "parent",
        activeChildren: [{ childSessionId, runId, name: null, status: "running" }],
        terminalNotices: [],
    };
}

const Harness = defineComponent({
    props: {
        sessionId: { type: String, required: true },
        derivedState: { type: Object as () => SessionDerivedStateResponse | null, default: null },
    },
    setup(props) {
        const { anchors, hiddenCount } = useDerivedAnchors({
            sessionId: () => props.sessionId,
            derivedState: () => props.derivedState,
        });
        return () =>
            h(
                "div",
                { "data-testid": "harness", "data-hidden": hiddenCount.value },
                anchors.value.map((anchor) =>
                    h(
                        "span",
                        {
                            "data-session": anchor.sessionId,
                            "data-status": anchor.status ?? "none",
                            "data-name": anchor.agentPrincipalName ?? "none",
                        },
                        anchor.sessionId,
                    ),
                ),
            );
    },
});

function agents(): WorkspaceAgentBinding[] {
    return [
        { principalId: "principal-xh", name: "xh lead", bound: true, disabled: false },
        { principalId: "principal-dsd", name: "dsd lead", bound: true, disabled: false },
    ] as WorkspaceAgentBinding[];
}

describe("useDerivedAnchors (task-1 wiring)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    function seedAuth(): void {
        useAuthStore().workspace = { id: "ws-1" } as never;
    }

    it("projects anchors from the session list, derived-state and the principal roster", async () => {
        const pinia = createPinia();
        setActivePinia(pinia);
        seedAuth();
        const store = useSessionStore();
        store.sessions = [
            session({ id: "parent" }),
            session({
                id: "child-xh",
                kind: "SPAWN",
                spawnedFromSessionId: "parent",
                spawnedAt: "2026-11-18T10:02:00.000Z",
                agentPrincipalId: "principal-xh",
            }),
        ];
        vi.spyOn(api, "getWorkspaceAgents").mockResolvedValue(agents());
        const wrapper = mount(Harness, {
            props: { sessionId: "parent", derivedState: derived("child-xh", "run-xh") },
            global: { plugins: [pinia] },
        });
        await flushPromises();

        const rows = wrapper.findAll("[data-session]");
        expect(rows.map((row) => row.attributes("data-session"))).toEqual(["child-xh"]);
        expect(rows[0]!.attributes("data-status")).toBe("running");
        expect(rows[0]!.attributes("data-name")).toBe("xh lead");
        expect(vi.mocked(api.getWorkspaceAgents)).toHaveBeenCalledWith("ws-1");
    });

    it("loads the session list once when the store is empty", async () => {
        const pinia = createPinia();
        setActivePinia(pinia);
        seedAuth();
        vi.spyOn(api, "getWorkspaceAgents").mockResolvedValue(agents());
        const getSessions = vi
            .spyOn(api, "getSessions")
            .mockResolvedValue({ sessions: [] } as never);

        mount(Harness, {
            props: { sessionId: "parent", derivedState: null },
            global: { plugins: [pinia] },
        });
        await flushPromises();

        expect(getSessions).toHaveBeenCalledTimes(1);
    });

    it("fetches the list once for a child the list does not know yet, then stops (no polling)", async () => {
        const pinia = createPinia();
        setActivePinia(pinia);
        seedAuth();
        const store = useSessionStore();
        store.sessions = [session({ id: "parent" })];
        vi.spyOn(api, "getWorkspaceAgents").mockResolvedValue(agents());
        // 补拉到的是「仍然没有该子会话」的列表：不得因此反复请求。
        const getSessions = vi
            .spyOn(api, "getSessions")
            .mockResolvedValue({ sessions: [] } as never);

        mount(Harness, {
            props: { sessionId: "parent", derivedState: derived("child-new", "run-new") },
            global: { plugins: [pinia] },
        });
        await flushPromises();
        await flushPromises();

        expect(getSessions).toHaveBeenCalledTimes(1);
    });

    it("degrades to anonymous principals when the roster is unreadable", async () => {
        const pinia = createPinia();
        setActivePinia(pinia);
        seedAuth();
        const store = useSessionStore();
        store.sessions = [
            session({ id: "parent" }),
            session({
                id: "child-xh",
                kind: "SPAWN",
                spawnedFromSessionId: "parent",
                spawnedAt: "2026-11-18T10:02:00.000Z",
                agentPrincipalId: "principal-xh",
            }),
        ];
        vi.spyOn(api, "getWorkspaceAgents").mockRejectedValue(new Error("roster down"));

        const wrapper = mount(Harness, {
            props: { sessionId: "parent", derivedState: derived("child-xh", "run-xh") },
            global: { plugins: [pinia] },
        });
        await flushPromises();

        const rows = wrapper.findAll("[data-session]");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.attributes("data-name")).toBe("none");
    });

    /**
     * task-70 双向钉（来自一次真实读数，不是假想）：395 个文件全绿的一轮 `test:unit` 仍然
     * `exit 1` —— 因为 `useDerivedAnchors` 的 watcher 抛了 `Cannot read properties of undefined
     * (reading 'map')`，vitest 记 1 个 unhandled error。成因：读面空壳（`{}`）被当成完整载荷。
     *  正向 —— 空壳/老版本载荷 ⇒ 安静地没有 anchor（不抛、不崩、不吞错到看不见：这里断言的是
     *          不抛，抛了这条就红）；
     *  反向 —— 也不许因为缺席就凭空补拉会话列表 / 伪造 id。
     */
    it("tolerates a partial derived-state payload: no anchors, no crash, no fabricated fetch", async () => {
        const pinia = createPinia();
        setActivePinia(pinia);
        seedAuth();
        const store = useSessionStore();
        store.sessions = [session({ id: "parent" })];
        const loadSessions = vi.spyOn(store, "loadSessions").mockResolvedValue(undefined as never);
        vi.spyOn(api, "getWorkspaceAgents").mockResolvedValue(agents());

        const wrapper = mount(Harness, {
            props: { sessionId: "parent", derivedState: {} as SessionDerivedStateResponse },
        });
        await flushPromises();

        expect(wrapper.findAll("[data-session]"), "空壳 ⇒ 没有 anchor").toEqual([]);
        expect(loadSessions, "缺席不是「有新子会话」的证据 ⇒ 不许补拉").not.toHaveBeenCalled();
        wrapper.unmount();
    });
});
