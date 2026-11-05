import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSharedEventLeader, type SharedLeaderConnectionContext } from "../useSharedEventLeader";

/**
 * PLAN-0676 T1.2：leader 层的单测。
 *
 * 这里不碰真实浏览器 API：`locks` / `storage` / `BroadcastChannel` / `delay` 全部注入，
 * 时钟用 Vitest 假定时器。目标是把 design §2/§3 的三条硬性质钉死：
 *   ① 并发两页 ⇒ **恰好一个** leader（storage 抢锁的抖动 + 二次比对）
 *   ② follower 空窗 ⇒ `isConnected === false`（不假绿），累计 ≥2 次只 warn 一条
 *   ③ `navigator.locks` 缺失时仍只有 **1 条**上游连接（不允许退化成每页自连）
 */

interface FakeChannel {
    name: string;
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: (value: unknown) => void;
    close: () => void;
}

/** 一个极小的同源频道总线：postMessage 异步投递给**其它**频道的 onmessage。 */
class ChannelBus {
    readonly channels: FakeChannel[] = [];

    factory = (name: string): FakeChannel => {
        const peers = this.channels;
        const channel: FakeChannel = {
            name,
            onmessage: null,
            postMessage: (value: unknown) => {
                queueMicrotask(() => {
                    for (const peer of peers) {
                        if (peer !== channel) {
                            peer.onmessage?.({ data: value });
                        }
                    }
                });
            },
            close: () => {
                const index = peers.indexOf(channel);
                if (index >= 0) {
                    peers.splice(index, 1);
                }
            },
        };
        peers.push(channel);
        return channel;
    };

    /** 直接把一条消息塞进某个频道（模拟来自另一个标签页的 leader）。 */
    deliver(channel: FakeChannel | undefined, data: unknown) {
        channel?.onmessage?.({ data });
    }
}

class FakeStorage {
    private readonly entries = new Map<string, string>();

    getItem = (key: string) => this.entries.get(key) ?? null;
    setItem = (key: string, value: string) => {
        this.entries.set(key, value);
    };
    removeItem = (key: string) => {
        this.entries.delete(key);
    };
    snapshot() {
        return [...this.entries.entries()];
    }
}

interface UpstreamRecord {
    contexts: SharedLeaderConnectionContext[];
    closes: number;
}

function makeUpstream(): UpstreamRecord & {
    connect: (context: SharedLeaderConnectionContext) => { close: () => void };
} {
    const record: UpstreamRecord = { contexts: [], closes: 0 };
    return {
        ...record,
        get contexts() {
            return record.contexts;
        },
        get closes() {
            return record.closes;
        },
        connect: (context: SharedLeaderConnectionContext) => {
            record.contexts.push(context);
            return {
                close: () => {
                    record.closes += 1;
                },
            };
        },
    };
}

function fakeLogger() {
    const warn = vi.fn<(name: string, payload?: Record<string, unknown>) => void>();
    const info = vi.fn<(name: string, payload?: Record<string, unknown>) => void>();
    return { warn, info };
}

describe("useSharedEventLeader", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    });

    function makeOptions(
        bus: ChannelBus,
        storage: FakeStorage,
        logger: ReturnType<typeof fakeLogger>,
    ) {
        return {
            sequenceOf: (event: { seq: number }) => event.seq,
            onEvent: vi.fn<(event: { seq: number }, meta: { source: string }) => void>(),
            log: logger,
            logTag: "test",
            deps: {
                locks: null, // 强制 storage 路径
                storage,
                channelFactory: bus.factory,
                now: () => Date.now(),
                delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
            },
        };
    }

    it("two concurrent tabs pick exactly one storage leader, and only one upstream opens", async () => {
        const bus = new ChannelBus();
        const storage = new FakeStorage();
        const logger = fakeLogger();
        const upstream = makeUpstream();

        const a = useSharedEventLeader(
            "ws:one",
            upstream.connect,
            makeOptions(bus, storage, logger),
        );
        const b = useSharedEventLeader(
            "ws:one",
            upstream.connect,
            makeOptions(bus, storage, logger),
        );

        a.start();
        b.start();
        await vi.advanceTimersByTimeAsync(400);

        const leaders = [a.role.value, b.role.value].filter((role) => role === "storage-leader");
        expect(leaders).toHaveLength(1);
        expect(upstream.contexts).toHaveLength(1);

        a.stop();
        b.stop();
    });

    it("leader close hands the lock back so a follower takes over well inside 1.5s", async () => {
        const bus = new ChannelBus();
        const storage = new FakeStorage();
        const logger = fakeLogger();
        const upstream = makeUpstream();

        const leader = useSharedEventLeader(
            "ws:two",
            upstream.connect,
            makeOptions(bus, storage, logger),
        );
        leader.start();
        await vi.advanceTimersByTimeAsync(400);
        expect(leader.role.value).toBe("storage-leader");

        const follower = useSharedEventLeader(
            "ws:two",
            upstream.connect,
            makeOptions(bus, storage, logger),
        );
        follower.start();
        await vi.advanceTimersByTimeAsync(50);
        expect(follower.role.value).toBe("follower");

        const closedAt = Date.now();
        leader.stop();
        await vi.advanceTimersByTimeAsync(1000);

        expect(follower.role.value).toBe("storage-leader");
        expect(Date.now() - closedAt).toBeLessThan(1500);
        expect(upstream.contexts).toHaveLength(2);
        follower.stop();
    });

    it("a follower that stops hearing the leader is not connected, and recovers on the next heartbeat", async () => {
        const bus = new ChannelBus();
        const storage = new FakeStorage();
        const logger = fakeLogger();
        const upstream = makeUpstream();
        // 预置一个"别的标签页已经持有锁"的记录 ⇒ 本页是 follower。
        storage.setItem(
            "xihe-sse-leader:ws:three",
            JSON.stringify({ tabId: "peer", nonce: "peer-nonce", expiresAt: Date.now() + 5000 }),
        );

        const follower = useSharedEventLeader(
            "ws:three",
            upstream.connect,
            makeOptions(bus, storage, logger),
        );
        follower.start();
        await vi.advanceTimersByTimeAsync(50);
        expect(follower.role.value).toBe("follower");
        expect(upstream.contexts).toHaveLength(0);

        const peer = bus.channels[0];
        bus.deliver(peer, { type: "heartbeat", seq: 0 });
        await vi.advanceTimersByTimeAsync(10);
        expect(follower.isConnected.value).toBe(true);

        // 空窗 2s（peerTimeoutMs 默认 1500）⇒ 必须降级为 false，不允许假绿。
        await vi.advanceTimersByTimeAsync(2000);
        expect(follower.isConnected.value).toBe(false);

        bus.deliver(peer, { type: "heartbeat", seq: 0 });
        await vi.advanceTimersByTimeAsync(10);
        expect(follower.isConnected.value).toBe(true);
        follower.stop();
    });

    it("two gaps produce exactly one flap warning (no log storm, but not silent either)", async () => {
        const bus = new ChannelBus();
        const storage = new FakeStorage();
        const logger = fakeLogger();
        const upstream = makeUpstream();
        storage.setItem(
            "xihe-sse-leader:ws:four",
            JSON.stringify({ tabId: "peer", nonce: "peer-nonce", expiresAt: Date.now() + 5000 }),
        );

        const follower = useSharedEventLeader(
            "ws:four",
            upstream.connect,
            makeOptions(bus, storage, logger),
        );
        follower.start();
        await vi.advanceTimersByTimeAsync(50);
        const peer = bus.channels[0];

        for (let round = 0; round < 2; round += 1) {
            bus.deliver(peer, { type: "heartbeat", seq: 0 });
            await vi.advanceTimersByTimeAsync(10);
            await vi.advanceTimersByTimeAsync(2000);
        }

        expect(follower.flapCount.value).toBeGreaterThanOrEqual(2);
        expect(logger.warn.mock.calls.filter(([name]) => name === "test_flap")).toHaveLength(1);
        follower.stop();
    });

    it("with no Web Locks it still opens exactly one upstream (never one connection per tab)", async () => {
        const bus = new ChannelBus();
        const storage = new FakeStorage();
        const logger = fakeLogger();
        const upstream = makeUpstream();

        const tabs = [0, 1, 2].map(() => {
            const tab = useSharedEventLeader(
                "ws:five",
                upstream.connect,
                makeOptions(bus, storage, logger),
            );
            tab.start();
            return tab;
        });
        await vi.advanceTimersByTimeAsync(500);

        expect(tabs.filter((tab) => tab.role.value === "storage-leader")).toHaveLength(1);
        expect(upstream.contexts).toHaveLength(1);
        tabs.forEach((tab) => tab.stop());
    });

    it("with Web Locks but no BroadcastChannel it still opens the upstream and warns", async () => {
        // Lead 在 T2 复审时点名的组合：T1 曾被"无 BC 时预置 degraded-local"短路掉连接，
        // 这条用例把这个组合钉住（有锁 ⇒ 能当选；无通道 ⇒ 只能自己连 + 一条 warn）。
        const storage = new FakeStorage();
        const logger = fakeLogger();
        const upstream = makeUpstream();
        const leader = useSharedEventLeader("ws:nine", upstream.connect, {
            ...makeOptions(new ChannelBus(), storage, logger),
            deps: {
                locks: {
                    request: (_name, _options, callback) => callback().then(() => undefined),
                },
                storage: null,
                channelFactory: () => null,
                now: () => Date.now(),
            },
        });

        leader.start();
        await vi.advanceTimersByTimeAsync(50);

        expect(leader.role.value).toBe("leader");
        expect(upstream.contexts).toHaveLength(1);
        expect(leader.isConnected.value).toBe(false);
        upstream.contexts[0]!.setConnected(true);
        expect(leader.isConnected.value).toBe(true);
        leader.stop();
    });

    it("with no BroadcastChannel at all it degrades to local and warns once", async () => {
        const storage = new FakeStorage();
        const logger = fakeLogger();
        const upstream = makeUpstream();
        const leader = useSharedEventLeader("ws:six", upstream.connect, {
            ...makeOptions(new ChannelBus(), storage, logger),
            deps: {
                locks: null,
                storage,
                channelFactory: () => null,
                now: () => Date.now(),
                delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
            },
        });

        leader.start();
        await vi.advanceTimersByTimeAsync(50);

        expect(leader.role.value).toBe("degraded-local");
        expect(
            logger.warn.mock.calls.filter(([name]) => name === "test_degraded_local"),
        ).toHaveLength(1);
        expect(upstream.contexts).toHaveLength(1);
        leader.stop();
    });

    it("duplicate and out-of-order upstream events are applied once, in sequence order", async () => {
        const bus = new ChannelBus();
        const storage = new FakeStorage();
        const logger = fakeLogger();
        const upstream = makeUpstream();
        const onResync = vi.fn<(reason: string) => void>();
        const options = { ...makeOptions(bus, storage, logger), onResync };

        const leader = useSharedEventLeader("ws:seven", upstream.connect, options);
        leader.start();
        await vi.advanceTimersByTimeAsync(400);
        expect(leader.role.value).toBe("storage-leader");

        const emit = upstream.contexts[0]!.emit;
        emit({ seq: 1 });
        emit({ seq: 3 }); // 缺口 ⇒ 一次 onResync
        emit({ seq: 3 }); // 重复 ⇒ 丢弃
        emit({ seq: 2 }); // 过期 ⇒ 丢弃

        const applied = (options.onEvent as ReturnType<typeof vi.fn>).mock.calls.map(
            ([event]) => event.seq,
        );
        expect(applied).toEqual([1, 3]);
        expect(onResync).toHaveBeenCalledTimes(1);
        leader.stop();
    });

    it("a follower cannot publish (only the leader fans out)", async () => {
        const bus = new ChannelBus();
        const storage = new FakeStorage();
        const logger = fakeLogger();
        const upstream = makeUpstream();
        storage.setItem(
            "xihe-sse-leader:ws:eight",
            JSON.stringify({ tabId: "peer", nonce: "peer-nonce", expiresAt: Date.now() + 5000 }),
        );
        const options = makeOptions(bus, storage, logger);
        const follower = useSharedEventLeader("ws:eight", upstream.connect, options);
        follower.start();
        await vi.advanceTimersByTimeAsync(50);

        follower.publish({ seq: 9 });

        expect(options.onEvent).not.toHaveBeenCalled();
        expect(follower.lastSeq.value).toBe(0);
        follower.stop();
    });
});
