package com.cc01cc.p.xihe.cp.support;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;

import java.util.UUID;

/**
 * task-173 (V170, user ruling 40C; Lead ruling on the entity default): the only sanctioned way for a
 * test fixture to materialise an {@link AgentPrincipal} literal.
 *
 * <p>Why this class exists: {@code agent_principals.ownership} is {@code NOT NULL} with <b>no</b>
 * database default and no Java field initializer, on purpose — a write site that forgets to name the
 * side must fail loudly instead of being silently labelled {@code USER} (that silent label is exactly
 * what the ruling forbids: it would turn a fail-closed column into a fail-open default). Production
 * code has a single writer ({@code AgentPrincipalService.createPrincipal(...)}) that takes the
 * ownership as a required argument. Test fixtures that construct the entity directly would otherwise
 * each have to remember the column, so they name their intent here instead:</p>
 *
 * <ul>
 *   <li>{@link #newUserAgentPrincipal()} — the default for fixtures: a user-door row. Equivalent to
 *       what {@code POST /api/v1/agent-principals} writes.</li>
 *   <li>{@link #newInstanceAgentPrincipal()} — a platform agent of this deployment. Use it when the
 *       fixture must really be INSTANCE-owned (a builtin preset guard, an instance-door row); the
 *       cross-axis CHECK refuses a {@code SYSTEM_PRESET} origin on a USER-owned row, so a preset
 *       fixture that forgets this fails loudly at insert time rather than drifting.</li>
 * </ul>
 */
public final class TestAgentPrincipals {

    private TestAgentPrincipals() {
    }

    /** A user-door principal literal (ownership = USER), the fixture default. */
    public static AgentPrincipal newUserAgentPrincipal() {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setOwnership(AgentPrincipal.OWNERSHIP_USER);
        return principal;
    }

    /** An instance-door principal literal (ownership = INSTANCE). */
    public static AgentPrincipal newInstanceAgentPrincipal() {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setOwnership(AgentPrincipal.OWNERSHIP_INSTANCE);
        return principal;
    }

    /** Convenience for the common {@code constructor + id} shape used by fixtures. */
    public static AgentPrincipal newUserAgentPrincipalWithId() {
        AgentPrincipal principal = newUserAgentPrincipal();
        principal.setId(UUID.randomUUID());
        return principal;
    }

    /**
     * A preset-guard literal: {@code origin = SYSTEM_PRESET} and {@code ownership = INSTANCE}, i.e. the
     * shape V95's provenance CHECK and V170's cross-axis CHECK require together. Fixtures that seed a
     * guard by mutating a user row must use this instead of setting the origin alone.
     */
    public static AgentPrincipal newPresetGuardPrincipal(String presetId) {
        AgentPrincipal principal = newInstanceAgentPrincipal();
        principal.setOrigin(AgentPrincipal.ORIGIN_SYSTEM_PRESET);
        principal.setPresetId(presetId);
        return principal;
    }
}
