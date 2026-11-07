package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Set;

/**
 * PLAN-0691 T1.3 (M1): the policy-side authorization entry for the plugin binding face.
 *
 * <p>Four atoms, one per verb, all named in the UPPER_SNAKE style of the rest of the catalog
 * (the spec's {@code plugin:manage} / {@code plugin:bind} / {@code plugin:invoke} /
 * {@code plugin:data} spelling is the external capability wording — see
 * {@code spec/authz-plugin-atoms.md}). This class owns the two things the atom layer must answer
 * without knowing anything about binding rows, transactions or HTTP:</p>
 *
 * <ol>
 *   <li><b>Which atom an operation needs</b> — {@link #pluginAtoms()} and
 *       {@link #requiredAtom(Op)}. No role-name special case: the caller asks for a verb, never
 *       "is this actor an administrator".</li>
 *   <li><b>What a source grants by default</b> — {@link #defaultAtoms(PluginSource)}. Spec B-4:
 *       a <i>builtin</i> plugin is invokable by default (parity with "install ≠ grant"); a
 *       <i>third-party</i> plugin has no default at all, so it needs an explicit grant. Both land in
 *       the frozen default snapshot ({@link GrantSources#AGENT_DEFAULT}) and in the built-in role
 *       seeds, which is why the seed row in V137 can be one row for both sources.</li>
 * </ol>
 *
 * <p><b>Evaluation ordering (hard requirement).</b> The caller must evaluate this gate
 * <b>before</b> it opens the binding transaction, and this class's decision is part of the
 * pre-effect phase, never a post-commit audit. A denial discovered after the binding row committed
 * is the same defect family as the {@code --plan-only} incident: an effect was already applied
 * before the request was rejected, and undoing it is guesswork. It is also the reason input
 * validation and authorization sit together — an unknown parameter must fail at the same point a
 * missing grant fails, not after the plugin has been enabled. Test anchor:
 * {@code PluginBindingAuthorizationTest#pluginBindingAuthorizationIsEvaluatedBeforeTheBindingTransaction}.</p>
 *
 * <p>Dependency direction: this is a pure policy class. It does not read repositories and does not
 * write the {@code grants} table — the binding write path (lane A, {@code cp/plugin/**}) materializes
 * the {@link GrantSources#PLUGIN_BINDING} rows and hands the resulting holds in as
 * {@link GrantRow}s. That keeps the decision testable without a database and keeps exactly one
 * writer for {@code grants}.</p>
 */
public final class PluginBindingAuthorization {

    /** RFC 9457 {@code code} for "the actor does not hold the required plugin atom". */
    public static final String CODE_PLUGIN_GRANT_DENIED = "PLUGIN_GRANT_DENIED";

    /** The four verbs of the plugin face (spec §"atoms"), in canonical order. */
    private static final List<String> ATOMS = List.of(
            ToolFaceRegistry.ACTION_PLUGIN_MANAGE,
            ToolFaceRegistry.ACTION_PLUGIN_BIND,
            ToolFaceRegistry.ACTION_PLUGIN_INVOKE,
            ToolFaceRegistry.ACTION_PLUGIN_DATA);

    /** Atom→verb lookup used by {@link #requiredAtom(Op)}; a set, so an accidental duplicate fails. */
    private static final Set<String> KNOWN_ATOMS = Set.copyOf(ATOMS);

    /** Spec B-4: only a builtin plugin is invokable by default; third-party needs a grant. */
    private static final List<String> BUILTIN_DEFAULTS = List.of(ToolFaceRegistry.ACTION_PLUGIN_INVOKE);

    private PluginBindingAuthorization() {
    }

    /** The four plugin atoms. Callers use this instead of re-listing registry constants. */
    public static List<String> pluginAtoms() {
        return ATOMS;
    }

    /**
     * The atom a plugin operation requires.
     *
     * @param op the verb being attempted
     * @return the catalog atom name
     */
    public static String requiredAtom(Op op) {
        return switch (op) {
            case INSTALL_OR_ENABLE -> ToolFaceRegistry.ACTION_PLUGIN_MANAGE;
            case BIND_TO_WORKSPACE -> ToolFaceRegistry.ACTION_PLUGIN_BIND;
            case INVOKE_TOOL_FACE -> ToolFaceRegistry.ACTION_PLUGIN_INVOKE;
            case ACCESS_DATA_PLANE -> ToolFaceRegistry.ACTION_PLUGIN_DATA;
        };
    }

    /**
     * The default grant set for a plugin source (spec B-4). Builtin ⇒ the base invocation atom;
     * third-party ⇒ empty, i.e. explicit grant only.
     *
     * @param source which kind of plugin the binding refers to
     * @return an immutable atom list
     */
    public static List<String> defaultAtoms(PluginSource source) {
        return switch (source) {
            case BUILTIN -> BUILTIN_DEFAULTS;
            case THIRD_PARTY -> List.of();
        };
    }

    /**
     * Evaluate the gate: does the actor hold the required atom, and through which grant source.
     *
     * <p>Rows whose {@code source} is not in {@link GrantSources#EVALUATION_SOURCES} are inert and
     * cannot authorize: a leftover {@code default}/{@code direct} row from before V88 must not
     * silently grant a plugin verb (same rule as the grant evaluator).</p>
     *
     * @param held the actor's grant holds
     * @param requiredAtom the atom from {@link #requiredAtom(Op)}
     * @return the decision, with {@code matchedSource} null when denied
     */
    public static Decision evaluate(List<GrantRow> held, String requiredAtom) {
        if (!KNOWN_ATOMS.contains(requiredAtom)) {
            // A programming error, not a user error: the caller must ask for a plugin atom.
            throw new IllegalArgumentException("Unknown plugin atom: " + requiredAtom);
        }
        for (GrantRow row : held) {
            if (requiredAtom.equals(row.actionClass())
                    && GrantSources.EVALUATION_SOURCES.contains(row.source())) {
                return new Decision(true, requiredAtom, row.source());
            }
        }
        return new Decision(false, requiredAtom, null);
    }

    /**
     * {@link #evaluate} as a gate: throws {@code 403 PLUGIN_GRANT_DENIED} when the actor does not
     * hold the atom. Call it before opening the binding transaction (see the class javadoc).
     *
     * @param held the actor's grant holds
     * @param requiredAtom the atom from {@link #requiredAtom(Op)}
     * @return the granted decision (never denied)
     */
    public static Decision require(List<GrantRow> held, String requiredAtom) {
        Decision decision = evaluate(held, requiredAtom);
        if (!decision.allowed()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, CODE_PLUGIN_GRANT_DENIED,
                    "missing plugin grant: " + requiredAtom
                            + " (installing a plugin does not grant its use; a third-party plugin"
                            + " needs an explicit grant)");
        }
        return decision;
    }

    /** The plugin verbs, mapped 1:1 onto {@link #pluginAtoms()}. */
    public enum Op {
        /** PLUGIN_MANAGE — instance-level install / enable / disable. */
        INSTALL_OR_ENABLE,
        /** PLUGIN_BIND — create the workspace binding row. */
        BIND_TO_WORKSPACE,
        /** PLUGIN_INVOKE — call the bound plugin's tool face. */
        INVOKE_TOOL_FACE,
        /** PLUGIN_DATA — read/write the plugin's data plane (service principal). */
        ACCESS_DATA_PLANE
    }

    /** Which kind of plugin a binding refers to; decides the default grant set (spec B-4). */
    public enum PluginSource {
        /** Ships with the instance; invokable by default. */
        BUILTIN,
        /** Operator-installed; explicit grant only. */
        THIRD_PARTY
    }

    /**
     * One grant hold.
     *
     * @param actionClass the atom (e.g. {@link ToolFaceRegistry#ACTION_PLUGIN_INVOKE})
     * @param source the {@link GrantSources} value that produced the hold — this is the audit answer
     *               ("where did this hold come from"), not a role name
     * @param bindingId the plugin binding that produced the hold, or null for role/default holds
     */
    public record GrantRow(String actionClass, String source, String bindingId) {
    }

    /**
     * The outcome of one evaluation.
     *
     * @param allowed whether the atom is held
     * @param actionClass the atom that was evaluated
     * @param matchedSource the winning {@link GrantSources} value, or null when denied
     */
    public record Decision(boolean allowed, String actionClass, String matchedSource) {
    }
}
