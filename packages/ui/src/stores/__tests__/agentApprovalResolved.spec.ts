import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAgentStore } from "../agent";
import type { ApprovalRequest } from "../../types";

/**
 * PLAN-0676 T3（BL-333）：`approval_resolved` 的存储侧语义。
 *
 * 三条性质：①命中待办卡 ⇒ 撤卡；②重复/乱序广播 ⇒ 幂等（返回 false，不改状态）；
 * ③撤掉的卡不会被后到的 `approval_request` 重放复活（tombstone）。
 */
function pendingApproval(requestId: string): ApprovalRequest {
    return {
        requestId,
        sessionId: "sess-1",
        tool: "file_write",
        arguments: {},
        state: "pending",
        createdAt: new Date().toISOString(),
    } as ApprovalRequest;
}

describe("agent store · applyApprovalResolved", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it("removes the card another window already decided and reports it once", () => {
        const store = useAgentStore();
        store.addApprovalRequest(pendingApproval("req-1"));
        expect(store.agentState.pendingApprovals).toHaveLength(1);

        const handled = store.applyApprovalResolved({
            approvalId: "req-1",
            decision: "once",
            approved: true,
        });

        expect(handled).toBe(true);
        expect(store.agentState.pendingApprovals).toHaveLength(0);
        // 一次性提示信号：ChatPanel 用它 toast"已在其他窗口处理"。
        expect(store.approvalResolvedElsewhere).toMatchObject({
            requestId: "req-1",
            approved: true,
        });
    });

    it("is idempotent for duplicate and out-of-order broadcasts", () => {
        const store = useAgentStore();
        store.addApprovalRequest(pendingApproval("req-2"));

        expect(
            store.applyApprovalResolved({
                approvalId: "req-2",
                decision: "reject",
                approved: false,
            }),
        ).toBe(true);
        // 重复广播 / 从未见过的 id ⇒ 不再产生副作用。
        expect(store.applyApprovalResolved({ approvalId: "req-2", approved: false })).toBe(false);
        expect(store.applyApprovalResolved({ approvalId: "never-seen", approved: true })).toBe(
            false,
        );
        expect(store.agentState.pendingApprovals).toHaveLength(0);
    });

    it("keeps the tombstone so a replayed approval_request cannot reopen the card", () => {
        const store = useAgentStore();
        store.addApprovalRequest(pendingApproval("req-3"));
        store.applyApprovalResolved({ approvalId: "req-3", approved: true });

        // 重放：同一条 approval_request 又到一次（另一页的旧事件、或刷新后的回放）。
        store.addApprovalRequest(pendingApproval("req-3"));

        expect(store.agentState.pendingApprovals).toHaveLength(0);
        expect(store.resolvedApprovals["req-3"]?.state).toBe("approved");
    });

    it("keeps the card and the draft when the user had typed feedback (BL-344 class)", () => {
        const store = useAgentStore();
        store.addApprovalRequest(pendingApproval("req-draft"));
        store.setApprovalDraft("req-draft", "这段复核意见不能丢");

        expect(store.applyApprovalResolved({ approvalId: "req-draft", approved: false })).toBe(
            true,
        );

        // 卡片留存（不撤），这样用户已输入的内容不会因为"另一页决定了"被清空。
        expect(store.agentState.pendingApprovals).toHaveLength(1);
        expect(store.resolvedElsewhereRequests["req-draft"]).toBe(true);
        expect(store.approvalDrafts["req-draft"]).toBe("这段复核意见不能丢");
        // tombstone 仍写：后到的 approval_request 重放不会把它变回可提交。
        expect(store.resolvedApprovals["req-draft"]?.state).toBe("rejected");
        store.addApprovalRequest(pendingApproval("req-draft"));
        expect(store.agentState.pendingApprovals).toHaveLength(1);
        // 无一次性 toast 信号：卡片上有内联提示，不需要再弹一条。
        expect(store.approvalResolvedElsewhere).toBeNull();
    });

    it("falls back to the wire decision only when the boolean is absent", () => {
        const store = useAgentStore();
        store.addApprovalRequest(pendingApproval("req-4"));
        store.applyApprovalResolved({ approvalId: "req-4", decision: "always" });
        expect(store.resolvedApprovals["req-4"]?.state).toBe("approved");

        store.addApprovalRequest(pendingApproval("req-5"));
        store.applyApprovalResolved({ approvalId: "req-5", decision: "reject" });
        expect(store.resolvedApprovals["req-5"]?.state).toBe("rejected");
    });
});
