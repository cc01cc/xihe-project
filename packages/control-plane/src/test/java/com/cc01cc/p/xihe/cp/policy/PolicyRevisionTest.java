package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.repository.PolicyRevisionRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0328 T1.7: the durable policy revision is a monotonic counter — a tightening delete
 * advances it, it survives restarts, and a missing counter row fails closed.
 */
class PolicyRevisionTest {

    private static final short ID = 1;

    private final PolicyRevisionRepository counter = mock(PolicyRevisionRepository.class);
    private final PolicyVersion version = new PolicyVersion();
    private final PolicyRevision revision = new PolicyRevision(counter, version);

    @Test
    void currentReadsTheDurableSequenceAndCachesItPerPolicyVersion() {
        when(counter.currentSeq(ID)).thenReturn(Optional.of(41L));

        assertEquals(41L, revision.current());
        assertEquals(41L, revision.current());
        verify(counter, times(1)).currentSeq(ID);

        // Any writer bump (shared PolicyVersion) invalidates the single-entry cache.
        when(counter.currentSeq(ID)).thenReturn(Optional.of(42L));
        version.bump();

        assertEquals(42L, revision.current());
        verify(counter, times(2)).currentSeq(ID);
    }

    @Test
    void bumpAdvancesTheCounterAndInvalidatesTheCache() {
        when(counter.currentSeq(ID)).thenReturn(Optional.of(7L), Optional.of(8L));
        when(counter.bump(eq(ID), any())).thenReturn(1);

        assertEquals(7L, revision.current());
        revision.bump();
        assertEquals(8L, revision.current());
        verify(counter).bump(eq(ID), any());
        verify(counter, times(2)).currentSeq(ID);
    }

    @Test
    void aNewComponentInstanceReadsTheSameDurableCounter() {
        // Simulated restart: no in-process state is carried over, only the persisted seq.
        when(counter.currentSeq(ID)).thenReturn(Optional.of(19L));
        PolicyRevision restarted = new PolicyRevision(counter, new PolicyVersion());

        assertEquals(revision.current(), restarted.current());
        assertEquals(19L, restarted.current());
    }

    @Test
    void missingCounterRowIsAbsentSoStoredGrantsCannotMatch() {
        when(counter.currentSeq(ID)).thenReturn(Optional.empty());

        assertEquals(PolicyRevision.ABSENT, revision.current());
        assertNotEquals(0L, PolicyRevision.ABSENT);
        // Mirrors the consume-time equality check: a stored revision never equals the sentinel.
        assertNotEquals(5L, revision.current());
    }

    @Test
    void missingCounterRowFailsBumpClosedWithoutBumpingTheProcessVersion() {
        when(counter.bump(eq(ID), any())).thenReturn(0);

        assertThrows(IllegalStateException.class, revision::bump);

        assertEquals(0L, version.current(), "a failed bump must not invalidate caches as if it were durable");
    }
}
