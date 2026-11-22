package com.cc01cc.p.xihe.cp.policy.guard;

import java.util.List;

/**
 * task-837 L1 whitelist — <b>data, kept in its own file</b>, not scattered {@code @Disabled} or
 * inline suppressions in the gate.
 *
 * <p>Contract (enforced by {@link L1ControllerSourceScanGuardTest}):</p>
 * <ul>
 *   <li>every entry carries {@code reason + owner + reviewDate};</li>
 *   <li><b>only-shrink</b> — an entry whose {@code allowed} count is above the real hit count must be
 *       tightened, and an entry that no longer reproduces must be deleted;</li>
 *   <li>no entry may be owned by {@code task-859}: that delivery must leave zero role/owner
 *       judgements in {@code controller/*.java}.</li>
 * </ul>
 */
final class L1ScanWhitelist {

    /** One whitelisted residue: a file, a forbidden pattern, and the exact count still tolerated. */
    record Entry(String file, String pattern, int allowed, String reason, String owner, String reviewDate) {
    }

    static final List<Entry> ENTRIES = List.of(
            new Entry("WorkspaceEnvironmentController.java", "userId.equals(", 1,
                    "deprecated visibleHostPath(4-arg) test seam added by task-859 so the task-837 "
                            + "test tree kept compiling; production calls visibleHostPath(Workspace, "
                            + "boolean) only. Removing it is a src/main/java change owned by task-863.",
                    "task-863", "2026-12-08"));

    private L1ScanWhitelist() {
    }
}
