package com.cc01cc.p.xihe.cp.policy.guard;

import java.util.List;

/**
 * task-886 outward role vocabulary whitelist — <b>data, in its own file</b>, not inline
 * suppressions in the gate.
 *
 * <p>Contract (enforced by {@link OutwardRoleVocabularyGuardTest}):</p>
 * <ul>
 *   <li>every entry carries {@code reason + owner + reviewDate};</li>
 *   <li><b>only-shrink</b> — an entry whose {@code allowed} count is above the real hit count must
 *       be tightened, and an entry that no longer reproduces must be deleted;</li>
 *   <li>the list is <b>empty</b>: {@code task-880} renamed {@code /roles -> /presets} and
 *       {@code role-bindings -> preset-bindings}, so any hit is a regression.</li>
 * </ul>
 *
 * <p>Scope is deliberately the <b>outward</b> vocabulary only. Internal identifiers
 * ({@code roleId}/{@code roleIds}, BL-638) and the {@code AgentRoleBindingsSection.vue}
 * {@code data-testid} are intentionally not covered: HTTP-facing names are {@code presetId(s)}
 * while component-internal field names keep their existing spelling.</p>
 */
final class OutwardRoleVocabularyWhitelist {

    /** One tolerated residue: an outward file, the forbidden spelling, and the exact count. */
    record Entry(String file, String pattern, int allowed, String reason, String owner,
            String reviewDate) {
    }

    static final List<Entry> ENTRIES = List.of();

    private OutwardRoleVocabularyWhitelist() {
    }
}
