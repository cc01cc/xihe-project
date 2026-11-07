package com.cc01cc.p.xihe.cp.plugin.kv;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0691 T1.5: verified claims of a binding-scoped KV service token (spec/data-plane.md SEC-1).
 *
 * <p>SEC-1 fixes the claim set to exactly {@code binding_id / plugin_id / digest / scope / exp};
 * nothing else is minted here. In particular there is no {@code aud}, no {@code workspaceId} and no
 * {@code sessionId} claim: no card defines their meaning for this token, and inventing one would
 * make a signed artefact the authority for a boundary nobody specified.
 *
 * <p>The token is only an authentication artefact. Authorization re-reads the binding row (SEC-2) on
 * every request, so suspending a binding takes effect immediately instead of at token expiry.
 *
 * @param bindingId the binding the token is scoped to; must equal the path segment (SEC-2)
 * @param pluginId  plugin id the binding points at, cross-checked against the binding row
 * @param digest    manifest digest of that binding, cross-checked the same way
 * @param scope     granted scope string as issued (recorded, not this task's enforcement surface)
 * @param expiresAt token expiry ({@code exp}); issued TTL is 300 s (SEC-1)
 */
record PluginKvClaims(UUID bindingId, String pluginId, String digest, String scope, Instant expiresAt) {
}
