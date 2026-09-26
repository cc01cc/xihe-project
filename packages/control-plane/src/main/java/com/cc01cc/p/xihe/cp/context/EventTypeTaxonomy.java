package com.cc01cc.p.xihe.cp.context;

import java.util.Set;

/**
 * PLAN-0410 T0.3 — frozen event-type taxonomy (field-matrix §4).
 *
 * <p>CP is the single choke point for {@code context_events} appends: any type
 * that is not registered here is rejected before a row is written (design #7
 * two-step tightening, step 2 — the inventory pass found no production writer
 * outside this set, see PLAN-0410 {@code evidence/t0-3-taxonomy-freeze.md}).
 *
 * <p>The classification drives branch derivation: Session/global events keep
 * {@code correlation_id}/{@code branch_id} NULL, ChatRun-scoped events must
 * carry {@code correlation_id = ChatRun.id} and CP derives the branch from that
 * durable Run. {@code taskplan.*} / {@code question.*} are run-scoped families
 * registered by prefix.
 */
public final class EventTypeTaxonomy {

    /** field-matrix §4 row 1 — both slots stay NULL. */
    private static final Set<String> SESSION_GLOBAL = Set.of(
            "session.created",
            "context.source_changed",
            "context.env_updated",
            "epoch.started",
            "epoch.replaced",
            "session.forked");

    /** field-matrix §4 row 2 — {@code correlation_id = ChatRun.id}. */
    private static final Set<String> RUN_SCOPED = Set.of(
            "prompt.admitted",
            "llm.token",
            "assistant.responded",
            "tool.called",
            "tool.result",
            "context.prune",
            "compaction.applied",
            "context.compaction_ineffective",
            "context.compaction_circuit",
            "context.overflow_retry",
            "llm.usage",
            "runtime.state_cleared");

    /**
     * field-matrix §4 row 3 (D7-B1=C, 2026-09-26): branch-targeted events are
     * written by a user-triggered action with no Run — {@code correlation_id}
     * stays NULL and {@code branch_id} is the CP-validated explicit branch
     * (field-matrix §6 {@code POST compact + branchId}).
     */
    private static final Set<String> BRANCH_TARGETED = Set.of(
            "compaction.manual_applied");

    private static final String TASKPLAN_PREFIX = "taskplan.";
    private static final String QUESTION_PREFIX = "question.";

    private EventTypeTaxonomy() {
    }

    public static boolean isSessionGlobal(String eventType) {
        return eventType != null && SESSION_GLOBAL.contains(eventType);
    }

    public static boolean isRunScoped(String eventType) {
        if (eventType == null) {
            return false;
        }
        return RUN_SCOPED.contains(eventType)
                || eventType.startsWith(TASKPLAN_PREFIX)
                || eventType.startsWith(QUESTION_PREFIX);
    }

    public static boolean isBranchTargeted(String eventType) {
        return eventType != null && BRANCH_TARGETED.contains(eventType);
    }

    /**
     * field-matrix §4 row 4: an unregistered type must never default to
     * global — it is rejected at the append choke point instead.
     */
    public static boolean isRegistered(String eventType) {
        return isSessionGlobal(eventType) || isRunScoped(eventType)
                || isBranchTargeted(eventType);
    }
}
