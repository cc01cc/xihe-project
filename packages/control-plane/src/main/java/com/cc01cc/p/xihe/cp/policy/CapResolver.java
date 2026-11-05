package com.cc01cc.p.xihe.cp.policy;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.UUID;

/**
 * Reads the workspace {@code cap} of one agent principal.
 *
 * <p>PLAN-0673 M1: the role-update path ({@code RoleAdminService}, package {@code policy}) must run
 * the <b>same</b> cap gate the binding path runs, but it must not depend on
 * {@code AgentPrincipalService} (package {@code service}) — that would invert the package direction
 * and risk the ArchUnit boundary. The dependency is therefore inverted here: this interface lives in
 * {@code policy}, the adapter that reaches {@code AgentPrincipalService#resolveCapFor} lives in
 * {@code service}.</p>
 *
 * @author PLAN-0673 M1
 */
@FunctionalInterface
public interface CapResolver {

    /**
     * The cap of {@code principalId} inside {@code workspaceId}, or {@code null} when the principal
     * has no cap there (the "no cap configured" case the caller treats as "no atoms allowed").
     *
     * @param principalId agent principal
     * @param workspaceId workspace the cap is resolved for
     * @return the cap JSON array node, or {@code null}
     */
    JsonNode resolveCapFor(UUID principalId, UUID workspaceId);
}
