package com.cc01cc.p.xihe.cp.context;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * PLAN-0410 T0.3 — field-matrix §4 frozen taxonomy: registration drives the
 * append fail-closed gate (design #7 step 2).
 */
class EventTypeTaxonomyTest {

    @Test
    void registersEveryFrozenSessionGlobalType() {
        for (String type : new String[] {
                "session.created", "context.source_changed", "context.env_updated",
                "epoch.started", "epoch.replaced", "session.forked"}) {
            assertTrue(EventTypeTaxonomy.isSessionGlobal(type), type + " must be Session/global");
            assertTrue(EventTypeTaxonomy.isRegistered(type), type + " must be registered");
            assertFalse(EventTypeTaxonomy.isRunScoped(type), type + " must not be run-scoped");
        }
    }

    @Test
    void registersEveryFrozenRunScopedTypeIncludingRuledStateCleared() {
        for (String type : new String[] {
                "prompt.admitted", "llm.token", "assistant.responded", "tool.called",
                "tool.result", "context.prune", "compaction.applied",
                "context.compaction_ineffective", "context.compaction_circuit",
                "context.overflow_retry", "llm.usage", "runtime.state_cleared"}) {
            assertTrue(EventTypeTaxonomy.isRunScoped(type), type + " must be ChatRun-scoped");
            assertTrue(EventTypeTaxonomy.isRegistered(type), type + " must be registered");
            assertFalse(EventTypeTaxonomy.isSessionGlobal(type), type + " must not be global");
        }
    }

    @Test
    void registersRunScopedFamiliesByPrefix() {
        assertTrue(EventTypeTaxonomy.isRunScoped("taskplan.created"));
        assertTrue(EventTypeTaxonomy.isRegistered("taskplan.updated"));
        assertTrue(EventTypeTaxonomy.isRunScoped("question.asked"));
        assertTrue(EventTypeTaxonomy.isRegistered("question.answered"));
    }

    @Test
    void registersBranchTargetedManualCompaction() {
        // PLAN-0410 D7-B1=C: third category — no Run, correlation NULL,
        // CP-validated explicit branch (field-matrix §4 row 3).
        assertTrue(EventTypeTaxonomy.isBranchTargeted("compaction.manual_applied"));
        assertTrue(EventTypeTaxonomy.isRegistered("compaction.manual_applied"));
        assertFalse(EventTypeTaxonomy.isRunScoped("compaction.manual_applied"));
        assertFalse(EventTypeTaxonomy.isSessionGlobal("compaction.manual_applied"));
        assertFalse(EventTypeTaxonomy.isBranchTargeted("compaction.applied"));
    }

    @Test
    void rejectsUnregisteredAndBlankTypes() {
        assertFalse(EventTypeTaxonomy.isRegistered("legacy.test"));
        assertFalse(EventTypeTaxonomy.isRegistered("some.future.event"));
        assertFalse(EventTypeTaxonomy.isRegistered(""));
        assertFalse(EventTypeTaxonomy.isRegistered(null));
        assertFalse(EventTypeTaxonomy.isRunScoped(null));
    }
}
