import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatTransport } from "@/services/chatTransport";
import { useWorkspaceSSE, type WorkspaceSSEOptions } from "../composables/useWorkspaceSSE";
import type { SharedLeaderDeps } from "../../../../composables/useSharedEventLeader";

vi.mock("@/services/chatTransport", () => ({
    chatTransport: {
        sendMessages: vi.fn<typeof chatTransport.sendMessages>().mockResolvedValue(undefined),
        stop: vi.fn<typeof chatTransport.stop>(),
    },
}));

/**
 * 测试用的"立刻授权"锁：PLAN-0676 之后上游连接只在 leader 上建立，所以单页测试必须让
 * 选举成功，否则 `sendMessages` 永远不会被调用。`channelFactory: () => null` 让这一页直接
 * 成为唯一 leader（无 peer 通道），`storage: null` 避免碰真实 localStorage。
 */
function leaderDeps(): SharedLeaderDeps {
    return {
        locks: {
            request: (_name, _options, callback) => callback().then(() => undefined),
        },
        storage: null,
        channelFactory: () => null,
    };
}

function options(extra: Partial<WorkspaceSSEOptions> = {}): WorkspaceSSEOptions {
    return { leaderDeps: leaderDeps(), ...extra };
}

describe("useWorkspaceSSE", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("subscribes with an isolated workspace key and forwards valid events", async () => {
        const onEvent = vi.fn<NonNullable<WorkspaceSSEOptions["onEvent"]>>();
        useWorkspaceSSE("ws-1", options({ onEvent }));
        await flushPromises();

        expect(chatTransport.sendMessages).toHaveBeenCalledWith(
            "workspace:ws-1",
            expect.objectContaining({
                url: "/api/v1/workspaces/ws-1/events",
            }),
        );
        const sent = vi.mocked(chatTransport.sendMessages).mock.calls[0]![1];
        await sent.onmessage?.({
            id: "1",
            event: "file_changed",
            data: JSON.stringify({
                workspaceId: "ws-1",
                sequence: 1,
                kind: "file_changed",
                path: "src/main.ts",
                changeType: "modified",
                source: "runtime",
            }),
        });

        expect(onEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                sequence: 1,
                path: "src/main.ts",
            }),
        );
    });

    it("requests a snapshot when a local sequence gap is observed", async () => {
        const onEvent = vi.fn<NonNullable<WorkspaceSSEOptions["onEvent"]>>();
        useWorkspaceSSE("ws-1", options({ onEvent }));
        await flushPromises();
        const sent = vi.mocked(chatTransport.sendMessages).mock.calls[0]![1];
        const event = (sequence: number) =>
            sent.onmessage?.({
                id: String(sequence),
                event: "file_changed",
                data: JSON.stringify({
                    workspaceId: "ws-1",
                    sequence,
                    kind: "file_changed",
                    path: "src/main.ts",
                    changeType: "modified",
                    source: "runtime",
                }),
            });

        await event(1);
        await event(3);

        expect(onEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: "snapshot_required",
                source: "ui-sequence-gap",
            }),
        );
    });

    it("treats the server's snapshot_required as a full refresh, not a normal append", async () => {
        const onEvent = vi.fn<NonNullable<WorkspaceSSEOptions["onEvent"]>>();
        useWorkspaceSSE("ws-1", options({ onEvent }));
        await flushPromises();
        const sent = vi.mocked(chatTransport.sendMessages).mock.calls[0]![1];

        await sent.onmessage?.({
            id: "7",
            event: "snapshot_required",
            data: JSON.stringify({
                workspaceId: "ws-1",
                sequence: 7,
                kind: "snapshot_required",
                source: "control-plane",
                reason: "sequence_gap",
            }),
        });

        // 原样转发给上层：`stores/workspace.ts` 与 `stores/scheduledTasks.ts` 对
        // `kind === "snapshot_required"` 的消费就是"拉全量"，绝不能当普通增量吞掉。
        expect(onEvent).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "snapshot_required", sequence: 7 }),
        );
    });

    it("two tabs of the same workspace open exactly one upstream connection", async () => {
        const storage = (() => {
            const entries = new Map<string, string>();
            return {
                getItem: (key: string) => entries.get(key) ?? null,
                setItem: (key: string, value: string) => void entries.set(key, value),
                removeItem: (key: string) => void entries.delete(key),
            };
        })();
        const channelBus: { handler?: (event: { data: unknown }) => void } = {};
        const deps: SharedLeaderDeps = {
            // 强制 storage 选举路径：T2 的判据是"多标签页共享一条连接"，与 locks 无关。
            locks: null,
            storage,
            channelFactory: () => ({
                onmessage: null,
                postMessage: () => undefined,
                close: () => undefined,
            }),
            delay: () => Promise.resolve(),
        };
        void channelBus;

        const first = useWorkspaceSSE("ws-2", { leaderDeps: deps });
        const second = useWorkspaceSSE("ws-2", { leaderDeps: deps });
        await flushPromises();
        await flushPromises();

        const leaders = [first.role.value, second.role.value].filter(
            (role) => role === "storage-leader",
        );
        expect(leaders).toHaveLength(1);
        expect(vi.mocked(chatTransport.sendMessages)).toHaveBeenCalledTimes(1);
    });

    it("does not send the optional client tag header unless asked", async () => {
        useWorkspaceSSE("ws-3", options());
        await flushPromises();
        const withoutTag = vi.mocked(chatTransport.sendMessages).mock.calls[0]![1];
        expect(withoutTag.headers).not.toHaveProperty("X-Workspace-SSE-Client");

        vi.clearAllMocks();
        useWorkspaceSSE("ws-4", options({ clientTag: "cli" }));
        await flushPromises();
        const withTag = vi.mocked(chatTransport.sendMessages).mock.calls[0]![1];
        expect(withTag.headers).toMatchObject({ "X-Workspace-SSE-Client": "cli" });
    });
});
