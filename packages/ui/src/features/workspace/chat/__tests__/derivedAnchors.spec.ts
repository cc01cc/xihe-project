import { describe, expect, it } from "vitest";
import {
    MAX_DERIVED_RUN_ANCHORS,
    buildDerivedRunAnchors,
    spawnChildrenOf,
} from "../derivedAnchors";
import type {
    Session,
    SessionDerivedActiveChild,
    SessionDerivedStateResponse,
    SessionDerivedTerminalNotice,
} from "../../../../types";

/**
 * task-1 / D-1846：派生态 anchor 的**纯投影**。这里钉死契约 A1/A2/A3/A4 的可执行部分：
 *  - 时间锚只来自子会话的 `spawnedAt`（→ `createdAt`），排序稳定；
 *  - 状态经 `runStateView` 归一，未知不猜；
 *  - 身份跨状态变化不变（运行中 → 终态是同一条 anchor，不产生第二条）；
 *  - 上限显式、保留最近 N 条。
 */
function session(overrides: Partial<Session> & { id: string }): Session {
    return {
        title: "父会话",
        createdAt: "2026-11-18T10:00:00.000Z",
        updatedAt: "2026-11-18T10:00:00.000Z",
        kind: null,
        spawnedFromSessionId: null,
        spawnedAt: null,
        agentPrincipalId: null,
        ...overrides,
    } as Session;
}

const PARENT = session({ id: "parent", title: "主会话" });

function child(id: string, spawnedAt: string | null, overrides: Partial<Session> = {}): Session {
    return session({
        id,
        title: "主会话",
        kind: "SPAWN",
        spawnedFromSessionId: "parent",
        spawnedAt,
        ...overrides,
    });
}

function active(
    childSessionId: string,
    runId: string,
    status: SessionDerivedActiveChild["status"],
): SessionDerivedActiveChild {
    return { childSessionId, runId, name: null, status };
}

function terminal(
    childSessionId: string,
    runId: string,
    state: SessionDerivedTerminalNotice["state"],
    terminalAt = "2026-11-18T10:05:00.000Z",
): SessionDerivedTerminalNotice {
    return { childSessionId, runId, name: null, state, terminalAt };
}

function derived(
    activeChildren: SessionDerivedActiveChild[] = [],
    terminalNotices: SessionDerivedTerminalNotice[] = [],
): SessionDerivedStateResponse {
    return { sessionId: "parent", activeChildren, terminalNotices };
}

describe("buildDerivedRunAnchors (task-1)", () => {
    it("anchors each direct SPAWN child at its own spawnedAt, sorted ascending", () => {
        const result = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions: [
                PARENT,
                child("child-late", "2026-11-18T10:04:00.000Z"),
                child("child-early", "2026-11-18T10:02:00.000Z"),
            ],
            derivedState: derived([
                active("child-late", "run-late", "running"),
                active("child-early", "run-early", "streaming"),
            ]),
        });

        // N1：两条 anchor 各自锚在自己的 startedAt，不是「都挂最新」。
        expect(result.anchors.map((anchor) => anchor.sessionId)).toEqual([
            "child-early",
            "child-late",
        ]);
        expect(result.anchors.map((anchor) => anchor.startedAt)).toEqual([
            "2026-11-18T10:02:00.000Z",
            "2026-11-18T10:04:00.000Z",
        ]);
        expect(result.anchors.map((anchor) => anchor.runId)).toEqual(["run-early", "run-late"]);
        expect(result.anchors.map((anchor) => anchor.status)).toEqual(["streaming", "running"]);
        expect(result.hiddenCount).toBe(0);
    });

    it("keeps the same identity when a child run turns terminal (N2: no second anchor)", () => {
        const sessions = [PARENT, child("child-a", "2026-11-18T10:02:00.000Z")];
        const running = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions,
            derivedState: derived([active("child-a", "run-a", "running")]),
        });
        const done = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions,
            derivedState: derived([], [terminal("child-a", "run-a", "success")]),
        });

        expect(running.anchors).toHaveLength(1);
        expect(done.anchors).toHaveLength(1);
        // 身份与位置都不变 —— 变的只有状态（这就是「就地更新」的可执行判据）。
        expect(done.anchors[0]!.key).toBe(running.anchors[0]!.key);
        expect(done.anchors[0]!.startedAt).toBe(running.anchors[0]!.startedAt);
        expect(running.anchors[0]!.status).toBe("running");
        expect(done.anchors[0]!.status).toBe("succeeded");
        expect(done.anchors[0]!.terminalAt).toBe("2026-11-18T10:05:00.000Z");
    });

    it("maps derived terminal words through runStateView and surfaces failures (N4)", () => {
        const result = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions: [
                PARENT,
                child("ok", "2026-11-18T10:01:00.000Z"),
                child("bad", "2026-11-18T10:02:00.000Z"),
            ],
            derivedState: derived(
                [],
                [terminal("ok", "run-ok", "success"), terminal("bad", "run-bad", "error")],
            ),
        });

        expect(result.anchors.map((anchor) => anchor.status)).toEqual(["succeeded", "failed"]);
        // 失败态是**显式**的（呈现层据此染红），不是静默的成功。
        expect(result.anchors[1]!.status).toBe("failed");
    });

    it("anchors a child with no readable status at all, without inventing one", () => {
        const result = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions: [PARENT, child("quiet", "2026-11-18T10:03:00.000Z")],
            derivedState: derived(),
        });

        expect(result.anchors).toHaveLength(1);
        expect(result.anchors[0]!.status).toBeNull();
        expect(result.anchors[0]!.runId).toBeNull();
        // 没有 runId 时身份退回子会话 id（仍然稳定，不随时间变化）。
        expect(result.anchors[0]!.key).toBe("quiet");
    });

    it("only covers direct SPAWN children of the current session", () => {
        const result = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions: [
                PARENT,
                child("direct", "2026-11-18T10:02:00.000Z"),
                // 孙辈：父会话的 derived-state 不投影它 ⇒ 不由本会话负责。
                session({
                    id: "grandchild",
                    kind: "SPAWN",
                    spawnedFromSessionId: "direct",
                    spawnedAt: "2026-11-18T10:03:00.000Z",
                }),
                // 别的父会话的子会话。
                session({
                    id: "stranger",
                    kind: "SPAWN",
                    spawnedFromSessionId: "other-parent",
                    spawnedAt: "2026-11-18T10:04:00.000Z",
                }),
                // 普通会话（fork 出来的不是委派）。
                session({ id: "plain", createdAt: "2026-11-18T10:05:00.000Z" }),
            ],
            derivedState: derived([
                active("direct", "run-direct", "running"),
                active("grandchild", "run-grandchild", "running"),
                active("stranger", "run-stranger", "running"),
            ]),
        });

        expect(result.anchors.map((anchor) => anchor.sessionId)).toEqual(["direct"]);
        expect(spawnChildrenOf([PARENT], "parent")).toEqual([]);
    });

    it("falls back to createdAt when spawnedAt is missing, and skips a child with no usable time", () => {
        const result = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions: [
                PARENT,
                child("fallback", null, { createdAt: "2026-11-18T10:06:00.000Z" }),
                child("no-time", null, { createdAt: "" }),
            ],
            derivedState: derived([
                active("fallback", "run-fallback", "queued"),
                active("no-time", "run-no-time", "queued"),
            ]),
        });

        expect(result.anchors.map((anchor) => anchor.sessionId)).toEqual(["fallback"]);
        expect(result.anchors[0]!.startedAt).toBe("2026-11-18T10:06:00.000Z");
    });

    it("resolves principal display names from the roster and never leaks the UUID (N5)", () => {
        const principals = new Map([
            ["principal-xh", "xh lead"],
            ["principal-dsd", "dsd lead"],
        ]);
        const result = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions: [
                PARENT,
                child("c1", "2026-11-18T10:02:00.000Z", { agentPrincipalId: "principal-xh" }),
                child("c2", "2026-11-18T10:03:00.000Z", { agentPrincipalId: "principal-dsd" }),
                child("c3", "2026-11-18T10:04:00.000Z", { agentPrincipalId: "principal-unknown" }),
            ],
            derivedState: derived([
                active("c1", "run-1", "running"),
                active("c2", "run-2", "running"),
                active("c3", "run-3", "running"),
            ]),
            principalNames: principals,
        });

        expect(result.anchors.map((anchor) => anchor.agentPrincipalName)).toEqual([
            "xh lead",
            "dsd lead",
            // 名册里没有 ⇒ null（呈现层退化到短码，不拼 UUID）。
            null,
        ]);
    });

    it("drops an inherited parent title from subject but keeps a real task name", () => {
        const result = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions: [
                PARENT,
                // spawn/delegation 默认继承父标题 ⇒ 重复即噪音。
                child("inherited", "2026-11-18T10:02:00.000Z"),
                child("named", "2026-11-18T10:03:00.000Z", { title: "dsd 迁移方案" }),
            ],
            derivedState: derived([
                active("inherited", "run-1", "running"),
                active("named", "run-2", "running"),
            ]),
        });

        expect(result.anchors.map((anchor) => anchor.subject)).toEqual([null, "dsd 迁移方案"]);
    });

    it("caps the anchor list explicitly, keeping the newest and reporting the hidden count", () => {
        const children = Array.from({ length: 5 }, (_, index) =>
            child(`c${index}`, `2026-11-18T10:0${index}:00.000Z`),
        );
        const result = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions: [PARENT, ...children],
            derivedState: derived(
                children.map((row) => active(row.id, `run-${row.id}`, "running")),
            ),
            maxAnchors: 3,
        });

        expect(result.anchors).toHaveLength(3);
        expect(result.anchors.map((anchor) => anchor.sessionId)).toEqual(["c2", "c3", "c4"]);
        expect(result.hiddenCount).toBe(2);
        expect(MAX_DERIVED_RUN_ANCHORS).toBe(24);
    });

    it("is deterministic for children spawned in the same instant", () => {
        const at = "2026-11-18T10:02:00.000Z";
        const sessions = [PARENT, child("b-child", at), child("a-child", at)];
        const derivedState = derived([
            active("a-child", "run-a", "running"),
            active("b-child", "run-b", "running"),
        ]);
        const first = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions,
            derivedState,
        });
        const second = buildDerivedRunAnchors({
            currentSessionId: "parent",
            sessions: sessions.toReversed(),
            derivedState,
        });

        expect(first.anchors.map((anchor) => anchor.sessionId)).toEqual(["a-child", "b-child"]);
        expect(second.anchors.map((anchor) => anchor.sessionId)).toEqual(["a-child", "b-child"]);
    });
});
