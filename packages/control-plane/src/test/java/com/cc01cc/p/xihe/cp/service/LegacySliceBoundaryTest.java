package com.cc01cc.p.xihe.cp.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Instant;
import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * PLAN-0641 M4 T5.1 judges: the legacy-slice set is derived from {@code workspace_roots.created_at}
 * (the declaration instant) and {@code run_checkpoints.captured_at} (the slice instant) — no new
 * column — and the same-instant boundary is explicit (fail-closed: legacy).
 */
class LegacySliceBoundaryTest {

    private static final String WS_ROOT = "11111111-1111-4111-8111-111111111111";
    private static final String CHILD_A = "22222222-2222-4222-8222-222222222222";
    private static final String CHILD_B = "33333333-3333-4333-8333-333333333333";
    private static final String CHILD_C = "44444444-4444-4444-8444-444444444444";
    private static final String OUTSIDE = "55555555-5555-4555-8555-555555555555";

    private static final Instant T0 = Instant.parse("2026-01-01T00:00:00Z");
    private static final Instant T_A = Instant.parse("2026-02-01T00:00:00Z");
    private static final Instant T_B = Instant.parse("2026-03-01T00:00:00Z");
    private static final Instant T_C = Instant.parse("2026-04-01T00:00:00Z");

    private static List<LegacySliceBoundary.RootRef> roots() {
        return List.of(
                new LegacySliceBoundary.RootRef(WS_ROOT, "H:/ws", T0),
                new LegacySliceBoundary.RootRef(CHILD_A, "H:/ws/vendor/lib", T_A),
                new LegacySliceBoundary.RootRef(CHILD_B, "H:/ws/tools", T_B),
                new LegacySliceBoundary.RootRef(CHILD_C, "H:/ws/vendor/lib/inner", T_C),
                new LegacySliceBoundary.RootRef(OUTSIDE, "H:/elsewhere/repo", T_A));
    }

    @Test
    void everyDescendantDeclaredAfterTheCaptureIsLegacy() {
        List<LegacySliceBoundary.LegacyRoot> legacy =
                LegacySliceBoundary.legacyChildRoots(roots(), WS_ROOT, T0.plusSeconds(60));

        assertEquals(List.of(CHILD_B, CHILD_A, CHILD_C),
                legacy.stream().map(LegacySliceBoundary.LegacyRoot::rootId).toList(),
                "all active descendants declared after the slice are legacy: " + legacy);
        assertEquals(List.of("tools", "vendor/lib", "vendor/lib/inner"),
                legacy.stream().map(LegacySliceBoundary.LegacyRoot::path).toList(),
                "paths are relative to the slice root and sorted");
        assertTrue(legacy.stream().allMatch(root -> root.declaredAt() != null));
    }

    @Test
    void aCaptureAfterTheDeclarationIsNotLegacy() {
        // After child A's declaration (so the parent capture already excluded it) but before B / C.
        List<LegacySliceBoundary.LegacyRoot> legacy =
                LegacySliceBoundary.legacyChildRoots(roots(), WS_ROOT, T_B.minusSeconds(1));

        assertEquals(List.of(CHILD_B, CHILD_C), legacy.stream()
                .map(LegacySliceBoundary.LegacyRoot::rootId).toList(), String.valueOf(legacy));
        // A capture strictly after every declaration has no legacy children at all.
        assertEquals(List.of(),
                LegacySliceBoundary.legacyChildRoots(roots(), WS_ROOT, T_C.plusSeconds(1)));
    }

    @Test
    void sameInstantIsLegacyFailClosed() {
        List<LegacySliceBoundary.LegacyRoot> legacy =
                LegacySliceBoundary.legacyChildRoots(roots(), WS_ROOT, T_A);

        assertTrue(legacy.stream().anyMatch(root -> CHILD_A.equals(root.rootId())),
                "captured_at == declared_at cannot prove the child was excluded: " + legacy);
        assertTrue(legacy.stream().noneMatch(root -> !CHILD_A.equals(root.rootId())
                        && T_A.isAfter(root.declaredAt())),
                "only same-or-later declarations are legacy: " + legacy);
    }

    @Test
    void aDeclaredRootOnlySeesItsOwnDescendants() {
        // A slice of the child root A: only A's own descendant C is legacy; the sibling B is not.
        List<LegacySliceBoundary.LegacyRoot> legacy =
                LegacySliceBoundary.legacyChildRoots(roots(), CHILD_A, T0.plusSeconds(60));

        assertEquals(List.of(CHILD_C), legacy.stream()
                .map(LegacySliceBoundary.LegacyRoot::rootId).toList(), String.valueOf(legacy));
        assertEquals("inner", legacy.get(0).path());
    }

    @Test
    void aNullDeclarationInstantIsNeverTrusted() {
        List<LegacySliceBoundary.RootRef> withNull =
                List.of(new LegacySliceBoundary.RootRef(WS_ROOT, "H:/ws", T0),
                        new LegacySliceBoundary.RootRef(CHILD_A, "H:/ws/vendor/lib", null));

        List<LegacySliceBoundary.LegacyRoot> legacy =
                LegacySliceBoundary.legacyChildRoots(withNull, WS_ROOT, T_C.plusSeconds(1));

        assertEquals(List.of(CHILD_A), legacy.stream()
                .map(LegacySliceBoundary.LegacyRoot::rootId).toList(), String.valueOf(legacy));
    }

    @Test
    void windowsSeparatorsAndCaseAreNormalised() {
        List<LegacySliceBoundary.RootRef> windows =
                List.of(new LegacySliceBoundary.RootRef(WS_ROOT, "H:\\WS\\", T0),
                        new LegacySliceBoundary.RootRef(CHILD_A, "h:/ws/Vendor/Lib", T_A));

        List<LegacySliceBoundary.LegacyRoot> legacy =
                LegacySliceBoundary.legacyChildRoots(windows, WS_ROOT, T0.plusSeconds(60));

        assertEquals("vendor/lib", legacy.get(0).path(), String.valueOf(legacy));
    }

    @Test
    void anUnknownSliceRootOrMissingCaptureInstantYieldsNoConflicts() {
        assertEquals(List.of(),
                LegacySliceBoundary.legacyChildRoots(roots(), "99999999-9999-4999-8999-999999999999", T0));
        assertEquals(List.of(), LegacySliceBoundary.legacyChildRoots(roots(), WS_ROOT, null));
        assertEquals(List.of(), LegacySliceBoundary.legacyChildRoots(List.of(), WS_ROOT, T0));
    }
}
