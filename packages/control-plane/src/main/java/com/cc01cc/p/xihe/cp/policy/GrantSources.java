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

    /** Legacy (pre-V87) user default set; converted to {@link #ROLE} by V88. */
    public static final String DEFAULT = "default";
    /** Legacy direct grant; user rows are retired by V88, agent rows become credential bindings. */
    public static final String DIRECT = "direct";
    /** Materialized union of the subject's role bindings ({@link RoleGrantMaterializer}). */
    public static final String ROLE = "role";
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
     * Sources that participate in a decision (design §3.4 step ②). {@code default}/{@code direct}
     * are absent by design — T1.6 deletes the direct branch instead of keeping a second mechanism.
     */
    public static final List<String> EVALUATION_SOURCES = List.of(
            ROLE, SPAWN, TEMPLATE, CREDENTIAL_BINDING, AGENT_DEFAULT, PLUGIN_BINDING);

    /** Sources the product code may write after V88 narrows the constraint. */
    public static final List<String> WRITABLE_SOURCES = List.of(
            ROLE, SPAWN, TEMPLATE, CREDENTIAL_BINDING, AGENT_DEFAULT, PLUGIN_BINDING);

    private GrantSources() {
    }
}
