package com.cc01cc.p.xihe.cp.service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/**
 * PLAN-0641 M4 T5.1: the declaration boundary between a root's slices and the child roots that were
 * declared afterwards, derived from timestamps only — no new column, no migration.
 *
 * <p>Why a derivation and not a stored pointer: a "flattened_before_slice" column would have to be
 * written at declaration time and kept true forever, while both inputs already exist —
 * {@code workspace_roots.created_at} is the declaration instant (the row is created by the
 * declaration) and {@code run_checkpoints.captured_at} is the slice instant. A slice of root R
 * captured before child root C was declared can still carry C's path flat inside R's shadow slice
 * (the pre-declaration flatten); such a restore would write into C's host directory, which the
 * per-root model forbids (PLAN-0639 D39-5 "先定根、再解析").</p>
 *
 * <p>Boundary rule (fail-closed): legacy iff {@code capturedAt <= declaredAt}. Equal instants cannot
 * prove the capture ran after the declaration, so they are treated as legacy. A {@code null}
 * declaration instant (factory fixtures predating JPA {@code @PrePersist}) is treated as legacy too:
 * an unknown boundary is never trusted.</p>
 *
 * <p>The types are plain records on purpose — the CP service maps {@code WorkspaceRoot} entities onto
 * {@link RootRef}, so the derivation stays a pure function and is unit-testable without a database.</p>
 */
public final class LegacySliceBoundary {

    private LegacySliceBoundary() {}

    /** One active root as the boundary derivation sees it. */
    public record RootRef(String rootId, String hostPath, Instant declaredAt) {}

    /**
     * One child root declared after the slice was captured: its path is legacy-flattened inside the
     * slice, and {@code path} is the workspace-relative POSIX path of that child root <b>below the
     * slice's root</b> (e.g. {@code vendor/lib} for a child of the primary root).
     */
    public record LegacyRoot(String rootId, String path, Instant declaredAt) {}

    /**
     * Derives the child roots whose declaration is later than {@code sliceCapturedAt} and whose host
     * path sits strictly inside the slice root's host path.
     *
     * @param roots active roots of the workspace (the slice root included when it is still active)
     * @param sliceRootId the root the slice belongs to; an unknown id yields no conflicts (the caller
     *     already refuses unknown/deleted roots through its own gates)
     * @param sliceCapturedAt the slice instant; {@code null} yields no conflicts (degenerate rows are
     *     not revertable)
     * @return the legacy child roots, sorted by path so responses and tests are stable
     */
    public static List<LegacyRoot> legacyChildRoots(List<RootRef> roots, String sliceRootId,
            Instant sliceCapturedAt) {
        if (roots == null || roots.isEmpty() || sliceRootId == null || sliceCapturedAt == null) {
            return List.of();
        }
        RootRef sliceRoot = roots.stream()
                .filter(Objects::nonNull)
                .filter(root -> sliceRootId.equals(root.rootId()))
                .findFirst()
                .orElse(null);
        if (sliceRoot == null) {
            return List.of();
        }
        String base = normalize(sliceRoot.hostPath());
        if (base.isEmpty()) {
            return List.of();
        }
        List<LegacyRoot> legacy = new ArrayList<>();
        for (RootRef root : roots) {
            if (root == null || root.rootId() == null || root.rootId().equals(sliceRootId)) {
                continue;
            }
            String candidate = normalize(root.hostPath());
            if (candidate.isEmpty() || !candidate.startsWith(base + "/")) {
                continue;
            }
            Instant declaredAt = root.declaredAt();
            if (declaredAt != null && sliceCapturedAt.isAfter(declaredAt)) {
                continue;
            }
            legacy.add(new LegacyRoot(root.rootId(), candidate.substring(base.length() + 1),
                    declaredAt));
        }
        legacy.sort((left, right) -> left.path().compareTo(right.path()));
        return List.copyOf(legacy);
    }

    /** Windows-normalised comparison form: forward slashes, no trailing slash, lowercase. */
    private static String normalize(String path) {
        return path == null
                ? ""
                : path.replace('\\', '/').replaceAll("/+$", "").toLowerCase(Locale.ROOT);
    }
}
