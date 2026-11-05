import {
    getCurrentInstance,
    onBeforeUnmount,
    ref,
    toValue,
    watch,
    type MaybeRefOrGetter,
    type Ref,
} from "vue";
import { logger } from "@/lib/logger";

/**
 * PLAN-0676 T1（BL-332）：**同一 channelKey 的多个标签页共享一条上游连接**。
 *
 * <p>为什么需要它：workspace SSE 的订阅上限是"每 workspace 8 条连接"且连接没有身份
 * （`WorkspaceEventManager.java:36,43`），同一批人复制几个标签页就会把自己挤出额度，超额后
 * 事件流静默中断。本层把"连接数"压回"用户数"：一个标签页当 leader 持有唯一连接，其余标签页
 * 通过 `BroadcastChannel` 收同一份事件。</p>
 *
 * <p>选主：优先 Web Locks（独占锁持有到页面卸载，锁释放即故障转移）；缺失时退到
 * `localStorage` 心跳锁（TTL 5s、TTL/3 续期、**抢占前随机抖动 + 二次比对 nonce**，否则两个
 * 标签页可能同时判定过期而双双当选，产生双连接）。两者都不可用时才 `degraded-local`
 * （每页自连 + 一条 warn）——这是唯一允许退化的情形。</p>
 *
 * <p>连接态不变式（design §2）：`isConnected === true` **只能**表示"我是 leader 且上游已 open"，
 * 或"我是 follower 且最近 peerTimeoutMs 内收到过 leader 的心跳"。空窗期必须降级为 false，
 * 不允许假绿；累计 ≥2 次空窗留一条 warn（排障用，不静默）。</p>
 */

export type SharedLeaderRole =
    | "idle"
    | "acquiring"
    | "leader"
    | "storage-leader"
    | "follower"
    | "degraded-local";

export interface SharedLeaderConnectionContext {
    /** 已知的最大 sequence；0 表示"没有已知进度"——上游必须据此走"拉全量"路径（design §1）。 */
    resumeFrom: number;
    /** 上游收到一条事件：本层负责本地应用 + 扇出。 */
    emit: (event: unknown) => void;
    /** 上游连接态变化（open/closed）。 */
    setConnected: (connected: boolean) => void;
}

export interface SharedLeaderConnection {
    close: () => void;
}

interface LockLike {
    request: (
        name: string,
        options: { mode: "exclusive" },
        callback: () => Promise<void>,
    ) => Promise<unknown>;
}

interface ChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: (value: unknown) => void;
    close: () => void;
}

interface StorageLike {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
}

export interface SharedLeaderDeps {
    /** `null` 强制走 storage 路径；`undefined` 读取 `globalThis.navigator.locks`（测试注入点）。 */
    locks?: LockLike | null;
    storage?: StorageLike | null;
    channelFactory?: (name: string) => ChannelLike | null;
    now?: () => number;
    random?: () => number;
    delay?: (ms: number) => Promise<void>;
    setInterval?: (callback: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
}

export interface SharedEventLeaderOptions<T> {
    /** 事件落地（leader 自己的上游事件、follower 收到的 peer 事件、本地 publish 都走这里一次）。 */
    onEvent?: (event: T, meta: { source: "upstream" | "peer" | "local" }) => void;
    /** 取事件的单调 sequence（无 sequence 的事件返回 undefined ⇒ 不做缺口判定）。 */
    sequenceOf?: (event: T) => number | undefined;
    /** 检测到缺口 / leader 更替时需要"拉全量"（design §1：不能从 0 起连重放）。 */
    onResync?: (reason: "gap" | "leader-lost") => void;
    deps?: SharedLeaderDeps;
    heartbeatMs?: number;
    peerTimeoutMs?: number;
    tickMs?: number;
    ttlMs?: number;
    skewMs?: number;
    jitterMs?: readonly [number, number];
    log?: Pick<typeof logger, "warn" | "info">;
    logTag?: string;
}

export interface SharedEventLeader<T> {
    role: Ref<SharedLeaderRole>;
    isConnected: Ref<boolean>;
    lastSeq: Ref<number>;
    leaderAgeMs: Ref<number>;
    flapCount: Ref<number>;
    /** leader 专属：本地应用并扇出（follower 调用是 no-op）。 */
    publish: (event: T) => void;
    start: () => void;
    stop: () => void;
}

interface LeaderRecord {
    tabId: string;
    nonce: string;
    expiresAt: number;
}

const DEFAULTS = {
    heartbeatMs: 500,
    peerTimeoutMs: 1500,
    tickMs: 250,
    ttlMs: 5000,
    skewMs: 300,
    jitterMs: [50, 150] as const,
    channelPrefix: "xihe-sse-events:",
    lockPrefix: "xihe-sse-leader:",
};

function randomId(): string {
    const cryptoObject = globalThis.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
        return cryptoObject.randomUUID();
    }
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param channelKey 逻辑频道（如 `ws:<workspaceId>`）；同 key 的标签页共享一条上游连接。
 * @param connect    仅 leader 调用：打开真实上游并返回关闭句柄。
 */
export function useSharedEventLeader<T>(
    channelKey: MaybeRefOrGetter<string | null | undefined>,
    connect: (context: SharedLeaderConnectionContext) => SharedLeaderConnection,
    options: SharedEventLeaderOptions<T> = {},
): SharedEventLeader<T> {
    const role = ref<SharedLeaderRole>("idle"),
        isConnected = ref(false),
        lastSeq = ref(0),
        leaderAgeMs = ref(0),
        flapCount = ref(0);

    const log = options.log ?? logger,
        tag = options.logTag ?? "shared_sse_leader",
        heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs,
        peerTimeoutMs = options.peerTimeoutMs ?? DEFAULTS.peerTimeoutMs,
        tickMs = options.tickMs ?? DEFAULTS.tickMs,
        ttlMs = options.ttlMs ?? DEFAULTS.ttlMs,
        skewMs = options.skewMs ?? DEFAULTS.skewMs,
        jitterMs = options.jitterMs ?? DEFAULTS.jitterMs,
        deps = options.deps ?? {},
        now = deps.now ?? (() => Date.now()),
        random = deps.random ?? Math.random,
        delay =
            deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
        setTimer =
            deps.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms)),
        clearTimer =
            deps.clearInterval ??
            ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>)),
        channelFactory =
            deps.channelFactory ??
            ((name: string) => new BroadcastChannel(name) as unknown as ChannelLike),
        storage =
            deps.storage ??
            (typeof globalThis.localStorage === "undefined"
                ? null
                : (globalThis.localStorage as StorageLike));

    /** 本标签页的身份：写进 storage 锁记录，用于"读回来还是不是我"的二次比对。 */
    const tabId = randomId();

    let channel: ChannelLike | null = null,
        upstream: SharedLeaderConnection | null = null,
        tickHandle: unknown = null,
        heartbeatHandle: unknown = null,
        renewHandle: unknown = null,
        acquireToken = 0,
        nonce = "",
        leaderSince = 0,
        lastPeerAt = 0,
        peerSeqMax = 0,
        started = false,
        flapping = false,
        warnedFlap = false,
        gapEpisodes = 0,
        releaseLock: (() => void) | null = null,
        lockHeld = false;

    const locksAvailable = () => {
        if (deps.locks !== undefined) {
            return deps.locks;
        }
        const candidate = (globalThis.navigator as unknown as { locks?: LockLike } | undefined)
            ?.locks;
        return candidate ?? null;
    };

    const channelName = () => `${DEFAULTS.channelPrefix}${toValue(channelKey) ?? ""}`;
    const lockName = () => `${DEFAULTS.lockPrefix}${toValue(channelKey) ?? ""}`;
    const storageKey = () => `${DEFAULTS.lockPrefix}${toValue(channelKey) ?? ""}`;

    function post(message: unknown) {
        try {
            channel?.postMessage(message);
        } catch (error) {
            log.warn(`${tag}_post_failed`, { error });
        }
    }

    function sequenceOf(event: T): number | undefined {
        return options.sequenceOf?.(event);
    }

    /** 单调去重 + 缺口检测（缺口语义：要求上层拉一次全量，绝不从 0 重放）。 */
    function accept(event: T): { apply: boolean } {
        const seq = sequenceOf(event);
        if (seq === undefined) {
            return { apply: true };
        }
        if (seq <= lastSeq.value) {
            return { apply: false };
        }
        if (lastSeq.value > 0 && seq > lastSeq.value + 1 && gapEpisodes++ === 0) {
            options.onResync?.("gap");
        }
        if (seq > peerSeqMax) {
            peerSeqMax = seq;
        }
        lastSeq.value = seq;
        return { apply: true };
    }

    function applyUpstream(event: T) {
        if (!accept(event).apply) {
            return;
        }
        options.onEvent?.(event, { source: "upstream" });
        post({ type: "event", seq: lastSeq.value, payload: event });
    }

    /** leader 家族：三者都"自己持有上游"，其余（follower/acquiring/idle）不是。 */
    function leaderLike(): boolean {
        return (
            role.value === "leader" ||
            role.value === "storage-leader" ||
            role.value === "degraded-local"
        );
    }

    function becomeLeader(kind: "leader" | "storage-leader" | "degraded-local") {
        if (leaderLike()) {
            return;
        }
        role.value = kind;
        leaderSince = now();
        upstream = connect({
            resumeFrom: Math.max(lastSeq.value, peerSeqMax),
            emit: (event) => applyUpstream(event as T),
            setConnected: (connected) => {
                if (leaderLike()) {
                    isConnected.value = connected;
                }
            },
        });
        heartbeatHandle = setTimer(() => {
            post({ type: "heartbeat", seq: lastSeq.value });
        }, heartbeatMs);
        if (kind === "storage-leader") {
            renewHandle = setTimer(() => renewStorageLock(), Math.max(1, Math.floor(ttlMs / 3)));
        }
    }

    function noteFlap(reason: string) {
        if (leaderLike()) {
            return;
        }
        flapCount.value += 1;
        if (flapCount.value >= 2 && !warnedFlap) {
            warnedFlap = true;
            log.warn(`${tag}_flap`, { reason, flaps: flapCount.value, channel: channelName() });
        }
    }

    function stepDown(reason: "lost" | "closed" | "storage-lost") {
        upstream?.close();
        upstream = null;
        if (heartbeatHandle !== null) {
            clearTimer(heartbeatHandle);
            heartbeatHandle = null;
        }
        if (renewHandle !== null) {
            clearTimer(renewHandle);
            renewHandle = null;
        }
        isConnected.value = false;
        if (leaderLike()) {
            const heldStorageLock = role.value === "storage-leader";
            role.value = channel ? "follower" : "degraded-local";
            leaderSince = 0;
            if (role.value === "follower") {
                noteFlap(reason);
            } else {
                flapCount.value += 1;
            }
            options.onResync?.("leader-lost");
            if (heldStorageLock) {
                releaseStorageLock();
            }
        }
    }

    /** 干净关闭时立刻交还锁，让 follower 不必等 TTL 过期（崩溃仍由 TTL 兜底）。 */
    function releaseStorageLock() {
        const current = readRecord();
        if (current && current.nonce === nonce) {
            try {
                storage?.removeItem(storageKey());
            } catch (error) {
                log.warn(`${tag}_storage_remove_failed`, { error });
            }
        }
        post({ type: "leader-released" });
    }

    function readRecord(): LeaderRecord | null {
        if (!storage) {
            return null;
        }
        try {
            const raw = storage.getItem(storageKey());
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw) as Partial<LeaderRecord>;
            if (
                !parsed ||
                typeof parsed.nonce !== "string" ||
                typeof parsed.expiresAt !== "number"
            ) {
                return null;
            }
            return {
                tabId: String(parsed.tabId ?? ""),
                nonce: parsed.nonce,
                expiresAt: parsed.expiresAt,
            };
        } catch (error) {
            log.warn(`${tag}_storage_read_failed`, { error });
            return null;
        }
    }

    function writeRecord(expiresAt: number) {
        if (!storage) {
            return;
        }
        try {
            storage.setItem(
                storageKey(),
                JSON.stringify({ tabId, nonce, expiresAt } satisfies LeaderRecord),
            );
        } catch (error) {
            log.warn(`${tag}_storage_write_failed`, { error });
        }
    }

    function jitter(): number {
        const [min, max] = jitterMs;
        return min + Math.floor(random() * Math.max(1, max - min));
    }

    /**
     * storage 抢锁（design §2 的 7 步）：写自己的 nonce → 抖动 50–150ms → **二次比对**
     * （只认"读回来还是我的 nonce"）→ 成功才当 leader。抖动 + 二次比对是为了让两个同时
     * 判定过期的标签页不会双双当选（localStorage 没有 CAS）。
     */
    async function acquireStorageLock(): Promise<boolean> {
        const token = ++acquireToken;
        const existing = readRecord();
        if (existing && existing.expiresAt > now() + skewMs) {
            return false;
        }
        nonce = randomId();
        writeRecord(now() + ttlMs);
        await delay(jitter());
        const after = readRecord();
        const won = after?.nonce === nonce && token === acquireToken;
        if (!won) {
            return false;
        }
        becomeLeader("storage-leader");
        return true;
    }

    function renewStorageLock() {
        const current = readRecord();
        if (current && current.nonce !== nonce) {
            stepDown("storage-lost");
            return;
        }
        writeRecord(now() + ttlMs);
    }

    function degradeLocal() {
        log.warn(`${tag}_degraded_local`, {
            channel: channelName(),
            reason: "no_web_locks_and_no_broadcast_channel",
        });
        becomeLeader("degraded-local");
    }

    function onChannelMessage(event: { data: unknown }) {
        const message = event.data as { type?: string; seq?: number; payload?: unknown } | null;
        if (!message || typeof message.type !== "string") {
            return;
        }
        lastPeerAt = now();
        if (typeof message.seq === "number" && message.seq > peerSeqMax) {
            peerSeqMax = message.seq;
        }
        if (message.type === "heartbeat") {
            if (!leaderLike()) {
                isConnected.value = now() - lastPeerAt <= peerTimeoutMs;
            }
            return;
        }
        if (message.type === "event" && message.payload !== undefined) {
            const payload = message.payload as T;
            if (accept(payload).apply) {
                options.onEvent?.(payload, { source: "peer" });
            }
            return;
        }
        if (message.type === "resync-request") {
            options.onResync?.("gap");
            return;
        }
        if (message.type === "leader-released") {
            // 干净关闭会立刻交还锁：follower 收到就抢，不必等 TTL 过期（T1.2「<1.5s 接管」）。
            if (role.value === "follower" && storage) {
                void acquireStorageLock();
            }
            return;
        }
    }

    function tick() {
        if (leaderLike()) {
            leaderAgeMs.value = leaderSince > 0 ? now() - leaderSince : 0;
            return;
        }
        leaderAgeMs.value = 0;
        const fresh = lastPeerAt > 0 && now() - lastPeerAt <= peerTimeoutMs;
        if (isConnected.value !== fresh) {
            isConnected.value = fresh;
        }
        if (lastPeerAt > 0 && !fresh && !flapping) {
            flapping = true;
            noteFlap("peer-timeout");
            options.onResync?.("leader-lost");
        }
        if (fresh) {
            flapping = false;
        }
    }

    function start() {
        const key = toValue(channelKey);
        if (started || !key) {
            return;
        }
        started = true;
        role.value = "acquiring";
        lastPeerAt = 0;
        peerSeqMax = 0;
        try {
            channel = channelFactory(channelName());
        } catch (error) {
            channel = null;
            log.warn(`${tag}_channel_unavailable`, { error });
        }
        if (channel) {
            channel.onmessage = onChannelMessage;
        }
        tickHandle = setTimer(tick, tickMs);

        const locks = locksAvailable();
        if (locks) {
            // 有通道 ⇒ 等锁期间就是 follower；没通道 ⇒ 只能等锁（acquiring），**不能**预置
            // `degraded-local`：那是 leader 家族，会让 becomeLeader 直接短路、连接永远不开。
            role.value = channel ? "follower" : "acquiring";
            void locks
                .request(lockName(), { mode: "exclusive" }, async () => {
                    lockHeld = true;
                    becomeLeader("leader");
                    await new Promise<void>((resolve) => {
                        releaseLock = resolve;
                    });
                    lockHeld = false;
                })
                .catch((error: unknown) => {
                    log.warn(`${tag}_locks_failed`, { error });
                    void tryStorageOrDefault();
                });
            return;
        }
        void tryStorageOrDefault();
    }

    async function tryStorageOrDefault() {
        if (storage && channel) {
            if (await acquireStorageLock()) {
                return;
            }
            role.value = "follower";
            return;
        }
        degradeLocal();
    }

    function publish(event: T) {
        if (!leaderLike()) {
            return;
        }
        accept(event);
        options.onEvent?.(event, { source: "local" });
        post({ type: "event", seq: lastSeq.value, payload: event });
    }

    function stop() {
        started = false;
        acquireToken += 1;
        releaseLock?.();
        releaseLock = null;
        if (lockHeld) {
            lockHeld = false;
        }
        stepDown("closed");
        if (tickHandle !== null) {
            clearTimer(tickHandle);
            tickHandle = null;
        }
        try {
            channel?.close();
        } catch (error) {
            log.warn(`${tag}_channel_close_failed`, { error });
        }
        channel = null;
        role.value = "idle";
        isConnected.value = false;
    }

    watch(
        () => toValue(channelKey),
        (key, previous) => {
            if (key === previous) {
                return;
            }
            stop();
            if (key) {
                start();
            }
        },
    );

    if (getCurrentInstance()) {
        onBeforeUnmount(stop);
    }

    return {
        role,
        isConnected,
        lastSeq,
        leaderAgeMs,
        flapCount,
        publish,
        start,
        stop,
    };
}
