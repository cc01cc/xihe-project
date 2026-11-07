package com.cc01cc.p.xihe.cp.plugin.kv;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.5 (verify.md V4): API-1..API-4 + API-9 CAS semantics of the plugin KV data plane, over
 * real PostgreSQL and real HTTP.
 *
 * <p>What this class is actually pinning down:
 * <ul>
 *   <li><b>API-9</b> — a first write needs no precondition, an overwrite does; the header and the body
 *       field are the same fact and must not disagree; {@code If-Match: *} is the explicit escape
 *       hatch. Each of those is a distinct branch in {@link PluginKvService#write}, and the difference
 *       between "412 required" and "412 failed" is the difference between "you forgot" and "you are
 *       stale" — the two answers a retry loop must distinguish.</li>
 *   <li><b>API-1/API-3</b> — a key that is gone or expired reads as absent, and delete is
 *       version-guarded when asked.</li>
 *   <li><b>API-4</b> — prefix filtering, key ordering and an opaque cursor that survives a page
 *       boundary; the cursor is opaque on purpose, so a forged one is a 400 rather than a query
 *       surprise.</li>
 * </ul>
 */
class PluginKvCasTest extends AbstractPluginKvIntegrationTest {

    private static final String NS = "default";

    // ------------------------------------------------------------------ create / CAS

    @Test
    void firstWriteNeedsNoPreconditionAndStartsAtVersionOne() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");

        ResponseEntity<String> created = put(path, token(binding), putBody("{\"n\":1}"));

        assertEquals(HttpStatus.OK, created.getStatusCode());
        JsonNode body = json(created);
        assertEquals("counter", body.get("key").asText());
        assertEquals(1, body.get("version").asLong());
        assertEquals(1, body.get("value").get("n").asInt());
        assertTrue(body.get("expiresAt").isNull(), "no ttlSeconds means no expiry (QUOTA-3)");
    }

    @Test
    void overwritingWithoutIfMatchIsRejected() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));

        ResponseEntity<String> blind = put(path, token(binding), putBody("{\"n\":2}"));

        // API-9: "you forgot the precondition", not "your version is stale".
        assertEquals(HttpStatus.PRECONDITION_FAILED, blind.getStatusCode());
        assertEquals(PluginKvService.CODE_PRECONDITION_REQUIRED, code(blind));
    }

    @Test
    void matchingIfMatchBumpsTheVersion() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));

        ResponseEntity<String> updated = put(path, token(binding), putBody("{\"n\":2}"), "1");

        assertEquals(HttpStatus.OK, updated.getStatusCode());
        assertEquals(2, json(updated).get("version").asLong());
        assertEquals(2, json(get(path, token(binding))).get("value").get("n").asInt());
    }

    @Test
    void staleIfMatchIsRejected() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));
        put(path, token(binding), putBody("{\"n\":2}"), "1");

        ResponseEntity<String> stale = put(path, token(binding), putBody("{\"n\":3}"), "1");

        assertEquals(HttpStatus.PRECONDITION_FAILED, stale.getStatusCode());
        assertEquals(PluginKvService.CODE_PRECONDITION_FAILED, code(stale));
        // The rejected write must not have moved the stored value.
        assertEquals(2, json(get(path, token(binding))).get("value").get("n").asInt());
    }

    @Test
    void quotedIfMatchIsAccepted() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));

        // HTTP's own If-Match grammar is an entity tag; a client library may quote the version for us.
        ResponseEntity<String> updated = put(path, token(binding), putBody("{\"n\":2}"), "\"1\"");

        assertEquals(HttpStatus.OK, updated.getStatusCode());
        assertEquals(2, json(updated).get("version").asLong());
    }

    @Test
    void ifMatchInTheBodyIsHonoured() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));

        ResponseEntity<String> updated = put(path, token(binding), putBody("{\"n\":2}", null, 1L));

        assertEquals(HttpStatus.OK, updated.getStatusCode());
        assertEquals(2, json(updated).get("version").asLong());
    }

    @Test
    void headerAndBodyPreconditionsMustAgree() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));

        ResponseEntity<String> conflict = put(path, token(binding), putBody("{\"n\":2}", null, 1L), "2");

        // Guessing which of the two the caller meant would silently pick a CAS target.
        assertEquals(HttpStatus.BAD_REQUEST, conflict.getStatusCode());
        assertEquals(PluginKvService.CODE_INVALID_REQUEST, code(conflict));
    }

    @Test
    void forceCannotBeCombinedWithAnExplicitVersion() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));

        ResponseEntity<String> conflict = put(path, token(binding), putBody("{\"n\":2}", null, 1L), "*");

        assertEquals(HttpStatus.BAD_REQUEST, conflict.getStatusCode());
        assertEquals(PluginKvService.CODE_INVALID_REQUEST, code(conflict));
    }

    @Test
    void forceOverwritesWhateverVersionIsStored() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));
        put(path, token(binding), putBody("{\"n\":2}"), "1");

        ResponseEntity<String> forced = put(path, token(binding), putBody("{\"n\":9}"), "*");

        assertEquals(HttpStatus.OK, forced.getStatusCode());
        assertEquals(3, json(forced).get("version").asLong());
        assertEquals(9, json(get(path, token(binding))).get("value").get("n").asInt());
    }

    @Test
    void nonNumericIfMatchIsARequestError() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));

        ResponseEntity<String> bad = put(path, token(binding), putBody("{\"n\":2}"), "not-a-version");

        assertEquals(HttpStatus.BAD_REQUEST, bad.getStatusCode());
        assertEquals(PluginKvService.CODE_INVALID_REQUEST, code(bad));
    }

    @Test
    void missingValueIsARequestError() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> bad = put(kvPath(binding, NS + "/counter"), token(binding), "{}");

        assertEquals(HttpStatus.BAD_REQUEST, bad.getStatusCode());
        assertEquals(PluginKvService.CODE_INVALID_REQUEST, code(bad));
    }

    @Test
    void nonPositiveTtlIsARequestError() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> bad = put(kvPath(binding, NS + "/counter"), token(binding),
                putBody("{\"n\":1}", 0L, null));

        assertEquals(HttpStatus.BAD_REQUEST, bad.getStatusCode());
        assertEquals(PluginKvService.CODE_INVALID_REQUEST, code(bad));
    }

    @Test
    void ttlIsReportedBackAsAnExpiryInstant() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> created = put(kvPath(binding, NS + "/counter"), token(binding),
                putBody("{\"n\":1}", 60L, null));

        assertEquals(HttpStatus.OK, created.getStatusCode());
        assertFalse(json(created).get("expiresAt").isNull(), "ttlSeconds must surface as expiresAt");
    }

    @Test
    void overlongKeyIsARequestError() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> bad = put(kvPath(binding, NS + "/" + "k".repeat(257)),
                token(binding), putBody("{\"n\":1}"));

        assertEquals(HttpStatus.BAD_REQUEST, bad.getStatusCode());
        assertEquals(PluginKvService.CODE_INVALID_REQUEST, code(bad));
    }

    // ------------------------------------------------------------------ read

    @Test
    void readReturnsTheStoredDocumentNotAString() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/doc");
        put(path, token(binding), putBody("{\"nested\":{\"a\":[1,2,3]}}"));

        JsonNode stored = json(get(path, token(binding))).get("value");

        assertTrue(stored.isObject(), "jsonb round-trips as a JSON object, not as text");
        assertEquals(2, stored.get("nested").get("a").get(1).asInt());
    }

    @Test
    void missingKeyReadsAsNotFound() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> absent = get(kvPath(binding, NS + "/nothing"), token(binding));

        assertEquals(HttpStatus.NOT_FOUND, absent.getStatusCode());
        assertEquals(PluginKvService.CODE_NOT_FOUND, code(absent));
    }

    @Test
    void expiredKeyReadsAsAbsent() {
        SeededBinding binding = seedEnabledBinding();
        // Written behind the service on purpose: waiting out a real TTL would need a sleep, and a
        // deterministic past timestamp proves the same SQL predicate (API-1 "expired as absent").
        jdbcTemplate.update("INSERT INTO plugin_kv (binding_id, namespace, key, value, expires_at)"
                        + " VALUES (?, 'default', 'stale', '\"old\"'::jsonb, now() - interval '1 second')",
                binding.bindingId());

        ResponseEntity<String> absent = get(kvPath(binding, NS + "/stale"), token(binding));

        assertEquals(HttpStatus.NOT_FOUND, absent.getStatusCode());
        assertEquals(PluginKvService.CODE_NOT_FOUND, code(absent));
    }

    // ------------------------------------------------------------------ delete

    @Test
    void deleteRemovesTheKey() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));

        ResponseEntity<String> deleted = delete(path, token(binding));

        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, get(path, token(binding)).getStatusCode());
    }

    @Test
    void deleteWithStaleVersionIsRejected() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/counter");
        put(path, token(binding), putBody("{\"n\":1}"));

        ResponseEntity<String> stale = delete(path, token(binding), "99");

        assertEquals(HttpStatus.PRECONDITION_FAILED, stale.getStatusCode());
        assertEquals(PluginKvService.CODE_PRECONDITION_FAILED, code(stale));
        assertEquals(HttpStatus.OK, get(path, token(binding)).getStatusCode(),
                "a rejected delete must leave the row in place");
    }

    @Test
    void deleteOfMissingKeyIsNotFound() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> absent = delete(kvPath(binding, NS + "/nothing"), token(binding));

        assertEquals(HttpStatus.NOT_FOUND, absent.getStatusCode());
        assertEquals(PluginKvService.CODE_NOT_FOUND, code(absent));
    }

    // ------------------------------------------------------------------ list

    @Test
    void listFiltersByPrefixAndOrdersByKey() {
        SeededBinding binding = seedEnabledBinding();
        for (String key : List.of("alpha", "beta", "alphabet")) {
            put(kvPath(binding, NS + "/" + key), token(binding), putBody("{\"k\":\"" + key + "\"}"));
        }
        put(kvPath(binding, "other/alpha"), token(binding), putBody("{\"k\":\"elsewhere\"}"));

        JsonNode page = json(get(kvPath(binding, NS) + "?prefix=alpha", token(binding)));

        assertEquals(List.of("alpha", "alphabet"), keys(page));
        assertTrue(page.get("nextCursor").isNull(), "a single page has no cursor");
        // Namespaces are separate lists: the same prefix under `other` must not leak in.
        assertEquals(1, json(get(kvPath(binding, "other") + "?prefix=alpha", token(binding)))
                .get("items").size());
    }

    @Test
    void listPaginatesWithAnOpaqueCursor() {
        SeededBinding binding = seedEnabledBinding();
        for (String key : List.of("k1", "k2", "k3")) {
            put(kvPath(binding, NS + "/" + key), token(binding), putBody("{\"k\":\"" + key + "\"}"));
        }
        String listPath = kvPath(binding, NS) + "?limit=2";

        JsonNode firstPage = json(get(listPath, token(binding)));
        assertEquals(List.of("k1", "k2"), keys(firstPage));
        String cursor = firstPage.get("nextCursor").asText();
        assertFalse(cursor.isBlank(), "two of three keys must produce a cursor");

        JsonNode secondPage = json(get(listPath + "&cursor=" + cursor, token(binding)));
        assertEquals(List.of("k3"), keys(secondPage));
        assertTrue(secondPage.get("nextCursor").isNull(), "last page has no cursor");
    }

    @Test
    void listLimitAboveTheCeilingIsRejected() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> tooBig = get(kvPath(binding, NS) + "?limit=201", token(binding));

        // API-4: "limit ≤ 200". Silently clamping would hide a client bug.
        assertEquals(HttpStatus.BAD_REQUEST, tooBig.getStatusCode());
        assertEquals(PluginKvService.CODE_INVALID_REQUEST, code(tooBig));
    }

    @Test
    void listRejectsAForgedCursor() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> forged = get(kvPath(binding, NS) + "?cursor=%21%21", token(binding));

        assertEquals(HttpStatus.BAD_REQUEST, forged.getStatusCode());
        assertEquals(PluginKvService.CODE_INVALID_REQUEST, code(forged));
    }

    @Test
    void listSkipsExpiredKeys() {
        SeededBinding binding = seedEnabledBinding();
        put(kvPath(binding, NS + "/live"), token(binding), putBody("{\"k\":\"live\"}"));
        jdbcTemplate.update("INSERT INTO plugin_kv (binding_id, namespace, key, value, expires_at)"
                        + " VALUES (?, 'default', 'dead', '\"old\"'::jsonb, now() - interval '1 second')",
                binding.bindingId());

        JsonNode page = json(get(kvPath(binding, NS), token(binding)));

        assertEquals(List.of("live"), keys(page));
    }

    // ------------------------------------------------------------------ helpers

    private static List<String> keys(JsonNode page) {
        List<String> keys = new ArrayList<>();
        for (JsonNode item : page.get("items")) {
            keys.add(item.get("key").asText());
        }
        return keys;
    }
}
