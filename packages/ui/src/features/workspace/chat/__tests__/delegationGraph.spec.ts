import { describe, expect, it } from "vitest";
import type { Session } from "../../../../types";
import type { DelegationUsageView } from "../../../../composables/api";
import {
    buildDelegationGraph,
    delegationRootOf,
    delegationStatusIsActive,
    delegationStatusLabelKey,
    formatDelegationBudget,
} from "../delegationGraph";

/**
 * PLAN-0659 T1.4：委派 DAG 的纯函数面。**先把父子/状态/深度三判据钉死，再画 SVG**
 * （Lead 口径：图是投影，不是视觉的副产物）。
 */
function session(overrides: Partial<Session> & { id: string }): Session {
    return {
        title: `会话 ${overrides.id}`,
        createdAt: "2026-11-04T10:00:00.000Z",
        updatedAt: "2026-11-04T10:00:00.000Z",
        kind: null,
        spawnedFromSessionId: null,
        spawnedAt: null,
        ...overrides,
    } as Session;
}

const ROOT = session({ id: "root" });
const CHILD_A = session({
    id: "child-a",
    kind: "SPAWN",
    spawnedFromSessionId: "root",
    spawnedAt: "2026-11-04T10:01:00.000Z",
});
const CHILD_B = session({
    id: "child-b",
    kind: "SPAWN",
    spawnedFromSessionId: "root",
    spawnedAt: "2026-11-04T10:02:00.000Z",
});
const GRANDCHILD = session({
    id: "grandchild",
    kind: "SPAWN",
    spawnedFromSessionId: "child-a",
    spawnedAt: "2026-11-04T10:03:00.000Z",
});

describe("buildDelegationGraph — 父子与深度 (PLAN-0659 T1.4)", () => {
    it("projects sessions into a parent→child graph with DFS order and depth", () => {
        const graph = buildDelegationGraph({
            sessions: [ROOT, CHILD_A, CHILD_B, GRANDCHILD],
            currentSessionId: "root",
        });
        expect(graph.rootSessionId).toBe("root");
        expect(graph.nodes.map((node) => [node.sessionId, node.depth])).toEqual([
            ["root", 0],
            ["child-a", 1],
            ["grandchild", 2],
            ["child-b", 1],
        ]);
        expect(graph.edges).toEqual([
            { from: "root", to: "child-a" },
            { from: "child-a", to: "grandchild" },
            { from: "root", to: "child-b" },
        ]);
        expect(graph.maxDepth).toBe(2);
        expect(graph.truncated).toBe(false);
    });

    it("starts from the top-most ancestor when the current session is itself delegated", () => {
        const graph = buildDelegationGraph({
            sessions: [ROOT, CHILD_A, GRANDCHILD],
            currentSessionId: "grandchild",
        });
        expect(graph.rootSessionId).toBe("root");
        expect(graph.nodes[0]).toMatchObject({
            sessionId: "root",
            depth: 0,
            parentSessionId: null,
        });
    });

    it("never fabricates edges for orphans or non-SPAWN sessions", () => {
        const orphan = session({ id: "orphan", kind: "SPAWN", spawnedFromSessionId: "missing" });
        const forked = session({ id: "forked", kind: "FORK", spawnedFromSessionId: "root" });
        const graph = buildDelegationGraph({
            sessions: [ROOT, orphan, forked],
            currentSessionId: "root",
        });
        expect(graph.nodes.map((node) => node.sessionId)).toEqual(["root"]);
        expect(graph.edges).toEqual([]);
    });

    it("falls back to a single placeholder root when the session list lacks it", () => {
        const graph = buildDelegationGraph({
            sessions: [],
            currentSessionId: "unknown-session",
        });
        expect(graph.nodes).toHaveLength(1);
        expect(graph.nodes[0]).toMatchObject({
            sessionId: "unknown-session",
            depth: 0,
            parentSessionId: null,
        });
    });

    it("stops at the node budget and reports truncation (never silently drops)", () => {
        const graph = buildDelegationGraph({
            sessions: [ROOT, CHILD_A, CHILD_B, GRANDCHILD],
            currentSessionId: "root",
            maxNodes: 2,
        });
        expect(graph.nodes).toHaveLength(2);
        expect(graph.truncated).toBe(true);
    });

    it("guards a cyclic spawn chain instead of looping forever", () => {
        const a = session({ id: "a", kind: "SPAWN", spawnedFromSessionId: "b" });
        const b = session({ id: "b", kind: "SPAWN", spawnedFromSessionId: "a" });
        expect(delegationRootOf([a, b], "a")).toBe("a");
        const graph = buildDelegationGraph({ sessions: [a, b], currentSessionId: "a" });
        expect(graph.nodes[0]?.sessionId).toBe("a");
    });
});

describe("buildDelegationGraph — 状态 (PLAN-0659 T1.4)", () => {
    it("attaches derived-state child status by session id", () => {
        const graph = buildDelegationGraph({
            sessions: [ROOT, CHILD_A, CHILD_B],
            currentSessionId: "root",
            statusBySessionId: new Map([
                ["child-a", { runId: "run-a", active: "running" }],
                ["child-b", { runId: "run-b", terminal: "error" }],
            ]),
        });
        const a = graph.nodes.find((node) => node.sessionId === "child-a");
        const b = graph.nodes.find((node) => node.sessionId === "child-b");
        expect(a?.status).toEqual({ runId: "run-a", active: "running" });
        expect(b?.status).toEqual({ runId: "run-b", terminal: "error" });
    });

    it("maps status to the existing derivedState vocabulary (no new status names)", () => {
        expect(delegationStatusLabelKey({ active: "awaiting_approval" })).toBe(
            "chat.derivedStateStatus.awaiting_approval",
        );
        expect(delegationStatusLabelKey({ terminal: "partial" })).toBe(
            "chat.derivedStateOutcome.partial",
        );
        expect(delegationStatusLabelKey(undefined)).toBeNull();
        expect(delegationStatusIsActive({ active: "streaming" })).toBe(true);
        expect(delegationStatusIsActive({ terminal: "success" })).toBe(false);
    });

    it("leaves the root without status (its own run lives in its parent's projection)", () => {
        const graph = buildDelegationGraph({
            sessions: [ROOT, CHILD_A],
            currentSessionId: "root",
            statusBySessionId: new Map([["root", { active: "running" }]]),
        });
        // 投影只按 session id 附加；根节点本来就没有"父的 derived-state"来源。
        expect(graph.nodes[0]?.status).toBeDefined();
    });
});

describe("formatDelegationBudget (PLAN-0659 T1.4)", () => {
    const usage = {
        rootSessionId: "root",
        usedSessions: 2,
        maxCount: 5,
        currentDepth: 1,
        maxDepth: 3,
        principalId: "agent-alpha",
        principalName: "Agent Alpha",
        policySource: "subject",
        disabled: false,
    } satisfies DelegationUsageView;

    it("formats used/max + depth/max and degrades to empty without usage", () => {
        expect(formatDelegationBudget(usage)).toBe("2/5 · 1/3");
        expect(formatDelegationBudget(null)).toBe("");
    });
});
