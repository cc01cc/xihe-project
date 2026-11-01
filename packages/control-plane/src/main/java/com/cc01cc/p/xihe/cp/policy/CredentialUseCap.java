package com.cc01cc.p.xihe.cp.policy;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * PLAN-0622 M1.4 (design §2, K2): the agent-principal credential arm as a pure decision.
 *
 * <p>An agent principal carries its own {@code credential_use} atoms (the PLAN-0496 binding path
 * merges them onto the {@code agent_principal} subject, and the M1.3 cap intersects them with the
 * Workspace binding cap). This class answers one question only — "does this cap cover this
 * credential?" — so the answer can be unit-tested without a database and reused by any caller that
 * already holds a cap snapshot.</p>
 *
 * <p>Coverage follows the credential namespace rule of {@link ToolFaceRegistry#resourceCovers}:
 * {@code credential:*} covers any id, an exact {@code credential:<uuid>} covers only itself. A cap
 * that is {@code null}, not an array, or that has no {@code credential_use} atom answers
 * {@code false} (fail closed).</p>
 */
public final class CredentialUseCap {

    private CredentialUseCap() {
    }

    /** True when {@code cap} grants {@code credential_use} on {@code credentialId}. */
    public static boolean grants(JsonNode cap, String credentialId) {
        if (cap == null || credentialId == null || credentialId.isBlank() || !cap.isArray()) {
            return false;
        }
        String resource = ToolFaceRegistry.CREDENTIAL_RESOURCE_PREFIX + credentialId;
        for (JsonNode atom : cap) {
            if (atom == null || !atom.isObject()) {
                continue;
            }
            if (!ToolFaceRegistry.ACTION_CREDENTIAL_USE.equals(atom.path("actionClass").asText(null))) {
                continue;
            }
            String ceiling = atom.hasNonNull("resource")
                    ? atom.get("resource").asText()
                    : PermissionAtomCatalog.WILDCARD;
            if (ToolFaceRegistry.resourceCovers(ToolFaceRegistry.ACTION_CREDENTIAL_USE, ceiling, resource)) {
                return true;
            }
        }
        return false;
    }
}
