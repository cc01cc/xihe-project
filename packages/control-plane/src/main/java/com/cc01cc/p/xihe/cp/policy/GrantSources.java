package com.cc01cc.p.xihe.cp.policy;

import java.util.List;

/**
 * PLAN-0610 T1.6: the {@code grants.source} vocabulary and the evaluation source set.
 *
 * <p>V87 widens {@code ck_grants_source} to the union of the legacy and the new values so it can
 * be applied to a live database (round-2 P0); V88 converts the rows and narrows the constraint.
 * This class is the code-side view of that contract:</p>
 *
 * <ul>
 *   <li>{@link #EVALUATION_SOURCES} — the sources whose atoms participate in a decision. It is
 *       deliberately a closed list: {@link #DEFAULT} and {@link #DIRECT} are <b>not</b> in it, so
 *       a leftover row from before V88 is inert rather than silently authorizing.</li>
 *   <li>{@link #DEFAULT} / {@link #DIRECT} — read-only compatibility constants for the migration
 *       window and for the audit of retired rows.</li>
 * </ul>
 */
public final class GrantSources {

    /** Legacy (pre-V87) user default set; converted to {@link #PRESET} by V88/V182. */
    public static final String DEFAULT = "default";
    /** Legacy direct grant; user rows are retired by V88, agent rows become credential bindings. */
    public static final String DIRECT = "direct";
    /**
     * task-933 / R39 (D-1926): the materialized union of the subject's preset bindings.
     * <b>No longer participates in a decision.</b> It is kept purely in the provenance vocabulary
     * (same approach as {@link #SESSION_TEMP}): a historical row (V139/V182 era) whose {@code source}
     * was not rewritten by V186 still has an explainable origin, while it never participates in the
     * {@link #EVALUATION_SOURCES} filter or the DB constraint. New writes use {@link #ASSIGNED}.
     */
    public static final String PRESET = "preset";
    /**
     * task-933 / R39 (D-1926): one imported preset atom, written by
     * {@link PresetGrantMaterializer} on a binding change with {@link #PRESET} as its
     * {@code originPresetId} (only for displaying and comparing/realigning — never participates in
     * the evaluation). The subject can adjust it independently afterwards; changing a preset no
     * longer rewrites these rows.
     */
    public static final String ASSIGNED = "assigned";
    /** Agent-principal spawn snapshot. */
    public static final String SPAWN = "spawn";
    /** Agent-principal template snapshot. */
    public static final String TEMPLATE = "template";
    /** PLAN-0496 credential binding atoms merged onto an agent principal. */
    public static final String CREDENTIAL_BINDING = "credential_binding";
    /** Frozen Session/principal default snapshot ({@code GrantDefaultService}). */
    public static final String AGENT_DEFAULT = "agent_default";

    /**
     * PLAN-0691 T1.3 (M1): atoms a plugin <b>binding</b> confers on its workspace, materialized by
     * the binding write path (lane A) with the same frozen-snapshot semantics as
     * {@link #AGENT_DEFAULT}. The row belongs to one binding, so the atom is only meaningful
     * together with the binding identity that produced it — the audit answers "where did this hold
     * come from" with this source instead of guessing from a role name.
     */
    public static final String PLUGIN_BINDING = "plugin_binding";

    /**
     * task-124 / DSD-1509: the atoms of a live {@code session_temporary_grants} row. It is not in
     * {@link #EVALUATION_SOURCES} or {@link #WRITABLE_SOURCES} on purpose — this source never lives in
     * {@code grants} (the temporary token has its own table, see V180) and it must never be reconciled
     * by {@link PresetGrantMaterializer}, which owns the standing sources. The constant exists so a
     * decision explanation can attribute a matched atom to a temporary token instead of guessing.
     */
    public static final String SESSION_TEMP = "session_temp";

    /**
     * Sources that participate in a decision (design §3.4 step ②). {@code default}/{@code direct}
     * are absent by design — T1.6 deletes the direct branch instead of keeping a second mechanism.
     */
    public static final List<String> EVALUATION_SOURCES = List.of(
            ASSIGNED, SPAWN, TEMPLATE, CREDENTIAL_BINDING, AGENT_DEFAULT, PLUGIN_BINDING);

    /** Sources the product code may write after V88 narrows the constraint. */
    public static final List<String> WRITABLE_SOURCES = List.of(
            ASSIGNED, SPAWN, TEMPLATE, CREDENTIAL_BINDING, AGENT_DEFAULT, PLUGIN_BINDING);

    /**
     * task-87: the {@code org_unit} label of in-memory expanded rows ({@code OrgUnitGrantExpander}).
     * It is <b>not</b> in {@link #EVALUATION_SOURCES} / {@link #WRITABLE_SOURCES} / the DB constraint
     * — such a row never enters {@code grants} — but it is part of the provenance vocabulary so a
     * label is never invented for it.
     */
    public static final String ORG_UNIT = OrgUnitGrantExpander.SOURCE;

    /**
     * task-87: the defensive provenance label. {@code ck_grants_source} (V139) plus
     * {@code source NOT NULL} (V38) mean a persisted row cannot reach this value; it exists only for
     * a mapping/regression that hands an out-of-vocabulary string to the read face, so the wire says
     * "unknown" instead of silently relabelling the row as a real source.
     */
    public static final String UNKNOWN = "unknown";

    /**
     * task-87 / task-933: the labels the grant-row provenance may carry — the six persisted values
     * ({@code assigned} replaced {@code preset} since V186) plus
     * {@link #ORG_UNIT} (in-memory only) and {@link #UNKNOWN} (defensive). {@code session_temp} is
     * absent on purpose: it never lives in {@code grants} (V180 has its own table).
     */
    public static final List<String> PROVENANCE_SOURCES = List.of(
            ASSIGNED, PRESET, SPAWN, TEMPLATE, CREDENTIAL_BINDING, AGENT_DEFAULT, PLUGIN_BINDING,
            ORG_UNIT);

    /**
     * task-87: normalise a stored/expanded {@code source} into a {@link #PROVENANCE_SOURCES} label.
     * Anything outside the vocabulary (including {@code null}) answers {@link #UNKNOWN} — never a
     * default such as {@link #PRESET}: a wrong label is worse than an honest "unknown".
     */
    public static String provenanceSource(String raw) {
        return raw != null && PROVENANCE_SOURCES.contains(raw) ? raw : UNKNOWN;
    }

    private GrantSources() {
    }
}
