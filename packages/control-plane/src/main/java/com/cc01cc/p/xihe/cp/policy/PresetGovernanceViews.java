package com.cc01cc.p.xihe.cp.policy;

import java.util.List;
import java.util.UUID;

/**
 * task-996 / task-948: wire views of the preset governance face (compare / realign).
 *
 * <p>The four buckets are the <b>same</b> classification the reconciliation kernel acts on
 * ({@link PresetGovernanceService#classifyDiff}), so a caller never sees a difference the replay
 * would not perform:</p>
 *
 * <ul>
 *   <li>{@code missing} — the preset template carries the atom in one of its import groups, but the
 *       subject has no {@code source='assigned'} row for {@code (scope, atom, originPresetId)};
 *       a realign creates it.</li>
 *   <li>{@code extra} — an attributed row whose group no longer carries the atom (or a malformed
 *       row); a realign deletes it.</li>
 *   <li>{@code localAdded} — an unattributed row ({@code origin_preset_id = NULL}); local work that
 *       no group rewrite may delete, so a realign never touches it.</li>
 *   <li>{@code overridden} — a missing atom that the subject also holds from a {@code localAdded}
 *       row in the same scope: 「我删了导入行又手加了一个」. A realign restores the import row and
 *       leaves the local row; this bucket exists so the UI can say so instead of showing a
 *       duplicate atom as a surprise.</li>
 * </ul>
 */
public final class PresetGovernanceViews {

    private PresetGovernanceViews() {
    }

    /** One atom in wire form ({@code resource} is canonical; {@code *} means unrestricted). */
    public record AtomView(String actionClass, String resource) {
    }

    /** A missing atom and every bound preset group that would import it. */
    public record MissingAtomView(String actionClass, String resource,
                                  List<UUID> originPresetIds) {
    }

    /** An attributed row the owning preset group no longer carries (realign deletes it). */
    public record ExtraAtomView(String actionClass, String resource, UUID originPresetId) {
    }

    /** Per-scope difference; {@code inSync} is true when all four buckets are empty. */
    public record ScopeDiffView(String scopeType, UUID scopeId,
                                List<MissingAtomView> missing,
                                List<ExtraAtomView> extra,
                                List<AtomView> localAdded,
                                List<AtomView> overridden,
                                boolean inSync) {
    }

    /** Totals across scopes; {@code changed} is true when a realign would write. */
    public record SummaryView(int missing, int extra, int localAdded, int overridden,
                              boolean changed) {
    }

    /** {@code GET /api/v1/presets/governance/compare} response. */
    public record CompareView(String subjectType, UUID subjectId,
                              List<ScopeDiffView> scopes, SummaryView summary) {
    }

    /**
     * {@code POST /api/v1/presets/governance/realign} response. {@code source} is always
     * {@code assigned}: an import writes that source and a realign never rewrites provenance.
     */
    public record RealignView(int created, int deleted, boolean changed, int scopes, String source) {
    }
}
