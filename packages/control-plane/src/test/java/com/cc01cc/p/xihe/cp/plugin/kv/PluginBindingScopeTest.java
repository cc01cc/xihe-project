package com.cc01cc.p.xihe.cp.plugin.kv;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * PLAN-0691 T1.5 (verify.md V8): SEC-1 credential shape and SEC-2 binding scope on the KV data plane.
 *
 * <p>This is the test class for the half of the contract that DP-6a moved out of the database. With no
 * foreign key between {@code plugin_kv} and {@code plugin_bindings}, "does this row's binding still
 * exist and is it live" is answered only here — so the negative cases are the product, not the
 * edge cases:
 * <ul>
 *   <li><b>SEC-1</b> — the only accepted credential is a binding-scoped token. Anonymous, garbage and
 *       expired tokens are 401; the global {@code ROLE_INTERNAL_SERVICE} token is <b>403</b>, because
 *       "service authentication is not plugin authorization".</li>
 *   <li><b>SEC-2</b> — a valid token still cannot reach a binding it is not scoped to (403
 *       {@code PLUGIN_GRANT_DENIED}), a binding that is not {@code enabled} (403
 *       {@code PLUGIN_BINDING_INACTIVE}), or a plugin/digest other than the one it was minted for.</li>
 * </ul>
 *
 * <p>Both 403 codes are checked against a key that exists <em>and</em> one that does not, so the error
 * shape cannot be used to probe for stored keys.
 */
class PluginBindingScopeTest extends AbstractPluginKvIntegrationTest {

    private static final String NS = "default";

    // ------------------------------------------------------------------ SEC-1: credential

    @Test
    void missingTokenIsUnauthorized() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> response = get(kvPath(binding, NS + "/any"), null);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
        assertEquals("AUTHORIZATION_REQUIRED", code(response));
    }

    @Test
    void garbageTokenIsUnauthorized() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> response = get(kvPath(binding, NS + "/any"), "not-a-jwt");

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
        assertEquals("AUTHORIZATION_REQUIRED", code(response));
    }

    @Test
    void expiredTokenIsUnauthorized() {
        SeededBinding binding = seedEnabledBinding();
        // SEC-1: TTL 300s. A token minted 10 minutes in the past must not be usable even though its
        // signature is valid.
        ResponseEntity<String> response = get(kvPath(binding, NS + "/any"), expiredToken(binding));

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
        assertEquals("AUTHORIZATION_REQUIRED", code(response));
    }

    @Test
    void internalServiceTokenIsForbiddenNotAuthorized() {
        SeededBinding binding = seedEnabledBinding();

        // SEC-1: the CP-wide service credential authenticates the request but authorizes nothing on
        // this surface — 403, not 401 and definitely not 200.
        ResponseEntity<String> response = get(kvPath(binding, NS + "/any"), internalServiceToken);

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        assertFalse(response.getBody() == null || response.getBody().contains("items"));
    }

    @Test
    void aTokenMintedForAnotherBindingIsForbidden() {
        SeededBinding mine = seedEnabledBinding();
        SeededBinding other = seedEnabledBinding();

        ResponseEntity<String> response = get(kvPath(other, NS + "/any"), token(mine));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        assertEquals(PluginKvService.CODE_GRANT_DENIED, code(response));
    }

    @Test
    void aTokenMintedForAnotherPluginVersionIsForbidden() {
        SeededBinding binding = seedEnabledBinding();
        String wrongPlugin = token(binding, "official.somebody-else", binding.digest());
        String wrongDigest = token(binding, binding.pluginId(), "sha256:0000000000000000");

        assertEquals(HttpStatus.FORBIDDEN, get(kvPath(binding, NS + "/any"), wrongPlugin).getStatusCode());
        assertEquals(PluginKvService.CODE_GRANT_DENIED,
                code(get(kvPath(binding, NS + "/any"), wrongPlugin)));
        assertEquals(HttpStatus.FORBIDDEN, get(kvPath(binding, NS + "/any"), wrongDigest).getStatusCode());
        assertEquals(PluginKvService.CODE_GRANT_DENIED,
                code(get(kvPath(binding, NS + "/any"), wrongDigest)));
    }

    // ------------------------------------------------------------------ SEC-2: binding state

    @Test
    void everyNonEnabledStateIsForbidden() {
        // SEC-2: the five-state machine, and only `enabled` may serve data. `degraded` is deliberately
        // in this list: a plugin that failed its health check must not keep reading its KV.
        for (String state : List.of("pending", "degraded", "suspended", "disabled")) {
            SeededBinding binding = seedBinding(state);
            ResponseEntity<String> response = get(kvPath(binding, NS + "/any"), token(binding));

            assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), "state " + state);
            assertEquals(PluginKvService.CODE_BINDING_INACTIVE, code(response), "state " + state);
        }
    }

    @Test
    void aDeletedBindingIsForbidden() {
        SeededBinding binding = seedEnabledBinding();
        jdbcTemplate.update("DELETE FROM plugin_bindings WHERE id = ?", binding.bindingId());

        // DP-6a in practice: the KV rows (if any) survive the binding, so this 403 is the only thing
        // standing between a stale token and orphan data.
        ResponseEntity<String> response = get(kvPath(binding, NS + "/any"), token(binding));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        assertEquals(PluginKvService.CODE_BINDING_INACTIVE, code(response));
    }

    @Test
    void forbiddenAnswersDoNotRevealWhetherTheKeyExists() {
        SeededBinding suspended = seedBinding("suspended");
        jdbcTemplate.update("INSERT INTO plugin_kv (binding_id, namespace, key, value)"
                + " VALUES (?, 'default', 'stored', '{\"secret\":true}'::jsonb)",
                suspended.bindingId());

        ResponseEntity<String> existing = get(kvPath(suspended, NS + "/stored"), token(suspended));
        ResponseEntity<String> missing = get(kvPath(suspended, NS + "/absent"), token(suspended));

        assertEquals(existing.getStatusCode(), missing.getStatusCode());
        assertEquals(code(existing), code(missing));
        assertFalse(existing.getBody() != null && existing.getBody().contains("secret"),
                "a 403 must not carry stored data");
    }

    // ------------------------------------------------------------------ SEC-2 on every verb

    @Test
    void writeAndDeleteAndListAreScopeCheckedToo() {
        SeededBinding mine = seedEnabledBinding();
        SeededBinding other = seedEnabledBinding();

        assertEquals(HttpStatus.FORBIDDEN,
                put(kvPath(other, NS + "/k"), token(mine), putBody("{\"n\":1}")).getStatusCode());
        assertEquals(HttpStatus.FORBIDDEN,
                delete(kvPath(other, NS + "/k"), token(mine)).getStatusCode());
        assertEquals(HttpStatus.FORBIDDEN, get(kvPath(other, NS), token(mine)).getStatusCode());
        // Nothing was written under the other binding by the rejected calls.
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM plugin_kv WHERE binding_id = ?", Integer.class,
                other.bindingId()));
    }

    @Test
    void anEnabledBindingWithAMatchingTokenIsAllowed() {
        // The positive control: without it every 403 above could be produced by a broken token path.
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/control");

        assertEquals(HttpStatus.OK, put(path, token(binding), putBody("{\"n\":1}")).getStatusCode());
        assertEquals(HttpStatus.OK, get(path, token(binding)).getStatusCode());
    }
}
