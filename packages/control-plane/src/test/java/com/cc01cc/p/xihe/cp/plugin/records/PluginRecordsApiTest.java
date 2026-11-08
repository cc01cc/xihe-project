package com.cc01cc.p.xihe.cp.plugin.records;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T2.3: the records data plane end to end (spec/data-plane.md API-5..API-7, §5 API-12,
 * SEC-1..SEC-3, QUOTA-4..QUOTA-13, DP-2/DP-7).
 *
 * <p>Cases are labelled E1–E11. What each one is <i>for</i>, and what it excludes:
 * <ul>
 *   <li><b>E1–E3 CRUD</b> — 201/200/204/404 and the version counter. Excludes: any CAS behaviour
 *       (E10 asserts its absence), any id-format guarantee (API-10 lets the CP mint one and §11 L168
 *       leaves the format undecided, so only "non-empty and unique" is asserted).</li>
 *   <li><b>E4–E6 query surface</b> — filter/limit/sort/cursor against real PostgreSQL. E6 is the
 *       decisive one: it proves ranges are <b>textual</b>, so {@code gt(n,"9")} returns {@code "99"} and
 *       not the numerically-larger {@code 10} (Lead ruling 2026-11-08).</li>
 *   <li><b>E7 refusals</b> — every §5 violation is 400 {@code INVALID_FILTER}, not a silently widened
 *       query.</li>
 *   <li><b>E8 authorization</b> — the SEC-2 split between 401 and the two 403 codes.</li>
 *   <li><b>E9 quotas</b> — the 413 branch of QUOTA-7. The 429 branches (QUOTA-6 count, QUOTA-13 timeout)
 *       are unit-tested in {@link PluginRecordsServiceTest}: reaching the real count ceiling would mean
 *       inserting 50 000 rows, and a real statement timeout cannot be triggered deterministically in a
 *       test container. Not claimed here.</li>
 *   <li><b>E10 no preconditions</b> — API-9 L90 keeps records on plain upsert, so a records request can
 *       never answer 412 even when the client sends {@code If-Match}.</li>
 *   <li><b>E11 audit</b> — SEC-3 records refusals as well as successes, so both a 200 and a 403 leave a
 *       row in {@code audit_logs} with the binding as resource id.</li>
 * </ul>
 *
 * <p><b>Known gap, stated rather than hidden</b>: the seeded manifest declares a unique index, but the
 * physical index is created by the install/bind path ({@code PluginIndexDdlExecutor}, T2.2), which this
 * task does not run. So the 409 {@code PLUGIN_RECORD_CONFLICT} branch is proven in
 * {@link PluginRecordsServiceTest} and <i>not</i> here.
 */
class PluginRecordsApiTest extends AbstractPluginRecordsIntegrationTest {

    // ---------------------------------------------------------------- E1–E3: documents

    /** E1 (API-5/API-10): POST stores a document and mints its id; the item comes back as stored. */
    @Test
    void postCreatesDocumentWithGeneratedId() {
        SeededBinding binding = seedEnabledBinding();
        ResponseEntity<String> created = post(recordsPath(binding, "notes"), token(binding),
                body("{\"status\":\"live\",\"n\":\"1\"}"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode());
        JsonNode item = json(created);
        String id = item.get("id").asText();
        assertFalse(id.isBlank(), "the CP must mint a non-empty id (API-10)");
        assertEquals(1, item.get("version").asInt());
        assertEquals("live", item.get("doc").get("status").asText());

        ResponseEntity<String> read = get(recordsPath(binding, "notes/" + id), token(binding));
        assertEquals(HttpStatus.OK, read.getStatusCode());
        assertEquals("live", json(read).get("doc").get("status").asText());
        assertEquals(1, storedRows(binding, "notes"));
    }

    /** E2 (API-5/API-10): PUT on the same id upserts in place and increments {@code version}. */
    @Test
    void putIsAnIdempotentUpsertThatIncrementsVersion() {
        SeededBinding binding = seedEnabledBinding();
        ResponseEntity<String> first = put(recordsPath(binding, "notes/doc-1"), token(binding),
                body("{\"status\":\"draft\"}"));
        ResponseEntity<String> second = put(recordsPath(binding, "notes/doc-1"), token(binding),
                body("{\"status\":\"live\"}"));
        assertEquals(HttpStatus.OK, first.getStatusCode());
        assertEquals(HttpStatus.OK, second.getStatusCode());
        assertEquals(1, json(first).get("version").asInt());
        assertEquals(2, json(second).get("version").asInt());
        assertEquals(1, storedRows(binding, "notes"));
        assertEquals("live",
                json(get(recordsPath(binding, "notes/doc-1"), token(binding))).get("doc")
                        .get("status").asText());
    }

    /** E3 (API-7): a missing document is 404 on read and on delete; a deleted one is gone. */
    @Test
    void missingDocumentIsNotFoundAndDeleteRemovesIt() {
        SeededBinding binding = seedEnabledBinding();
        String path = recordsPath(binding, "notes/doc-1");
        ResponseEntity<String> missingRead = get(path, token(binding));
        assertEquals(HttpStatus.NOT_FOUND, missingRead.getStatusCode());
        assertEquals("PLUGIN_NOT_FOUND", code(missingRead));
        ResponseEntity<String> missingDelete = delete(path, token(binding));
        assertEquals(HttpStatus.NOT_FOUND, missingDelete.getStatusCode());
        assertEquals("PLUGIN_NOT_FOUND", code(missingDelete));

        put(path, token(binding), body("{\"status\":\"live\"}"));
        assertEquals(HttpStatus.NO_CONTENT, delete(path, token(binding)).getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, get(path, token(binding)).getStatusCode());
        assertEquals(0, storedRows(binding, "notes"));
    }

    // ---------------------------------------------------------------- E4–E6: query surface

    /** E4 (§5 L102–L104): filter narrows, limit bounds, sort orders — and rows stay collection-scoped. */
    @Test
    void listFiltersSortsAndLimitsWithinOneCollection() {
        SeededBinding binding = seedEnabledBinding();
        String token = token(binding);
        put(recordsPath(binding, "notes/a"), token, body("{\"status\":\"live\",\"name\":\"a\"}"));
        put(recordsPath(binding, "notes/b"), token, body("{\"status\":\"draft\",\"name\":\"b\"}"));
        put(recordsPath(binding, "notes/c"), token, body("{\"status\":\"live\",\"name\":\"c\"}"));
        put(recordsPath(binding, "tags/t1"), token, body("{\"label\":\"other\"}"));

        JsonNode live = items(get(recordsPath(binding, "notes?filter=eq(status,\"live\")"), token));
        assertEquals(2, live.size());
        for (JsonNode item : live) {
            assertEquals("live", item.get("doc").get("status").asText());
        }

        JsonNode sorted = items(get(recordsPath(binding, "notes?sort=name:desc&limit=2"), token));
        assertEquals(2, sorted.size());
        assertEquals("c", sorted.get(0).get("doc").get("name").asText());
        assertEquals("b", sorted.get(1).get("doc").get("name").asText());

        // The tags collection is a different key space: nothing written to notes appears there.
        JsonNode tags = items(get(recordsPath(binding, "tags"), token));
        assertEquals(1, tags.size());
        assertEquals("other", tags.get(0).get("doc").get("label").asText());
    }

    /**
     * E5 (§5 L104): the cursor pages without gaps or repeats and ends with {@code nextCursor: null}.
     *
     * <p>The ids are deliberately not zero-padded: if the implementation ever swapped the keyset for an
     * offset, the page boundaries here would overlap because the sort key changes with each write.
     */
    @Test
    void cursorPagesThroughEveryDocumentExactlyOnce() {
        SeededBinding binding = seedEnabledBinding();
        String token = token(binding);
        for (int i = 1; i <= 5; i++) {
            put(recordsPath(binding, "notes/id-" + i), token,
                    body("{\"status\":\"live\",\"name\":\"" + i + "\"}"));
        }
        Set<String> seen = new LinkedHashSet<>();
        String cursor = null;
        int pages = 0;
        do {
            String query = "notes?sort=name:asc&limit=2" + (cursor == null ? ""
                    : "&cursor=" + cursor);
            JsonNode page = json(get(recordsPath(binding, query), token));
            pages++;
            for (JsonNode item : itemsOf(page, query)) {
                assertTrue(seen.add(item.get("id").asText()),
                        "page " + pages + " repeated " + item.get("id").asText());
            }
            cursor = page.get("nextCursor") == null || page.get("nextCursor").isNull() ? null
                    : page.get("nextCursor").asText();
        } while (cursor != null);
        assertEquals(5, seen.size());
        assertEquals(3, pages);
    }

    /**
     * E6 (Lead ruling 2026-11-08; §5 L102 {@code gt/lt}): range comparisons are <b>textual</b>.
     *
     * <p>This is the assertion that would fail if someone "helpfully" cast to a number: with text
     * ordering {@code "9" < "99"} while {@code "10" < "9"}, so {@code gt(n,"9")} must return
     * {@code "99"} and must <b>not</b> return {@code "10"}.
     */
    @Test
    void rangeComparisonIsLexicographicNotNumeric() {
        SeededBinding binding = seedEnabledBinding();
        String token = token(binding);
        put(recordsPath(binding, "notes/nine"), token, body("{\"n\":\"9\"}"));
        put(recordsPath(binding, "notes/ten"), token, body("{\"n\":\"10\"}"));
        put(recordsPath(binding, "notes/ninety-nine"), token, body("{\"n\":\"99\"}"));

        JsonNode greater = json(get(recordsPath(binding, "notes?filter=gt(n,\"9\")"), token));
        List<String> values = new ArrayList<>();
        for (JsonNode item : greater.get("items")) {
            values.add(item.get("doc").get("n").asText());
        }
        assertEquals(List.of("99"), values, "text order: \"10\" < \"9\" < \"99\"");

        JsonNode less = json(get(recordsPath(binding, "notes?filter=lt(n,\"9\")"), token));
        assertEquals(1, less.get("items").size());
        assertEquals("10", less.get("items").get(0).get("doc").get("n").asText());
    }

    // ---------------------------------------------------------------- E7: refusals

    /** E7 (§5 L102–L104, API-11): every grammar violation is 400 {@code INVALID_FILTER}. */
    @Test
    void queryGrammarViolationsAreInvalidFilter() {
        SeededBinding binding = seedEnabledBinding();
        String token = token(binding);
        for (String query : List.of(
                "notes?filter=eq(secret,\"x\")",
                "notes?filter=eq(status,\"live\")%20OR%20eq(n,\"1\")",
                "notes?filter=eq(owner.name,\"x\")",
                "notes?sort=secret",
                "notes?sort=secret:desc",
                "notes?sort=name:sideways",
                "notes?sort=name,status",
                "notes?limit=201",
                "notes?limit=0",
                "notes?cursor=not-a-cursor")) {
            ResponseEntity<String> response = get(recordsPath(binding, query), token);
            assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), query);
            assertEquals("INVALID_FILTER", code(response), query);
        }
        // A declared field with a well-formed filter still works — the refusals above are grammar,
        // not a blanket rejection.
        assertEquals(HttpStatus.OK,
                get(recordsPath(binding, "notes?filter=prefix(status,\"li\")"), token).getStatusCode());
    }

    // ---------------------------------------------------------------- E8: authorization

    /** E8 (SEC-1/SEC-2): 401 without a binding token, and the two 403 codes for a bad binding. */
    @Test
    void authorizationSplitMatchesSec2() {
        SeededBinding binding = seedEnabledBinding();
        String path = recordsPath(binding, "notes/doc-1");

        ResponseEntity<String> anonymous = get(path, null);
        assertEquals(HttpStatus.UNAUTHORIZED, anonymous.getStatusCode());
        assertEquals("AUTHORIZATION_REQUIRED", code(anonymous));

        // SEC-1: the global internal service token is not a binding token.
        ResponseEntity<String> serviceToken = get(path, internalServiceToken);
        assertEquals(HttpStatus.FORBIDDEN, serviceToken.getStatusCode());

        // SEC-2: a token minted for a different binding.
        SeededBinding other = seedEnabledBinding();
        ResponseEntity<String> foreign = get(path, token(other));
        assertEquals(HttpStatus.FORBIDDEN, foreign.getStatusCode());
        assertEquals("PLUGIN_GRANT_DENIED", code(foreign));

        // SEC-2: a token whose digest no longer matches the installed version.
        ResponseEntity<String> staleDigest = get(path, token(binding, binding.pluginId(),
                "sha256:deadbeef"));
        assertEquals(HttpStatus.FORBIDDEN, staleDigest.getStatusCode());

        // SEC-2: a suspended binding.
        SeededBinding suspended = seedBinding("suspended");
        ResponseEntity<String> suspendedResponse = get(recordsPath(suspended, "notes/doc-1"),
                token(suspended));
        assertEquals(HttpStatus.FORBIDDEN, suspendedResponse.getStatusCode());
        assertEquals("PLUGIN_BINDING_INACTIVE", code(suspendedResponse));

        // A token whose signature does not verify is unauthenticated, not forbidden. Token expiry/TTL
        // itself is T1.5's tested path — the records route reuses the same filter, so it is not
        // re-proven here.
        assertEquals(HttpStatus.UNAUTHORIZED, get(path, token(binding) + "tampered").getStatusCode());
    }

    // ---------------------------------------------------------------- E9: quotas

    /** E9 (QUOTA-7): the manifest's {@code docBytesMax} narrows the deployment ceiling → 413. */
    @Test
    void documentOverCollectionCeilingIsTooLarge() {
        SeededBinding binding = seedEnabledBinding();
        String big = "{\"pad\":\"" + "x".repeat(4200) + "\"}";
        ResponseEntity<String> response = put(recordsPath(binding, "notes/big"), token(binding),
                body(big));
        assertEquals(HttpStatus.CONTENT_TOO_LARGE, response.getStatusCode());
        assertEquals("PLUGIN_VALUE_TOO_LARGE", code(response));
        assertEquals(0, storedRows(binding, "notes"), "a refused write must not become a row");

        // A collection that declares no ceiling is bounded by the deployment limit only, so the same
        // payload fits there — this is the "manifest narrows, never widens" half of QUOTA-7.
        assertEquals(HttpStatus.OK, put(recordsPath(binding, "tags/big"), token(binding), body(big))
                .getStatusCode());
    }

    /** E9b (API-5): a document must be a JSON object. */
    @Test
    void nonObjectDocumentIsInvalidRequest() {
        SeededBinding binding = seedEnabledBinding();
        ResponseEntity<String> response = put(recordsPath(binding, "notes/arr"), token(binding),
                body("[1,2,3]"));
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals("INVALID_REQUEST", code(response));
        assertEquals(0, storedRows(binding, "notes"));
    }

    // ---------------------------------------------------------------- E10: no CAS

    /**
     * E10 (API-9 L90, Lead ruling 2026-11-08 #3): records have no preconditions.
     *
     * <p>{@code If-Match} is sent on every mutating verb and is ignored: a records request can never
     * answer 412, and a stale-looking version does not block a write.
     */
    @Test
    void recordsNeverAnswerPreconditionStatuses() {
        SeededBinding binding = seedEnabledBinding();
        String token = token(binding);
        String path = recordsPath(binding, "notes/doc-1");

        ResponseEntity<String> putWithPrecondition =
                send(org.springframework.http.HttpMethod.PUT, path, token, body("{\"status\":\"a\"}"),
                        "999");
        assertEquals(HttpStatus.OK, putWithPrecondition.getStatusCode());
        assertNotEquals(HttpStatus.PRECONDITION_FAILED, putWithPrecondition.getStatusCode());

        // The version keeps increasing on its own; the header is not an input to it.
        ResponseEntity<String> again =
                send(org.springframework.http.HttpMethod.PUT, path, token, body("{\"status\":\"b\"}"),
                        "\"1\"");
        assertEquals(2, json(again).get("version").asInt());

        ResponseEntity<String> deleted =
                send(org.springframework.http.HttpMethod.DELETE, path, token, null, "999");
        assertEquals(HttpStatus.NO_CONTENT, deleted.getStatusCode());

        ResponseEntity<String> posted = send(org.springframework.http.HttpMethod.POST,
                recordsPath(binding, "notes"), token, body("{\"status\":\"c\"}"), "999");
        assertEquals(HttpStatus.CREATED, posted.getStatusCode());
    }

    // ---------------------------------------------------------------- E11: audit

    /** E11 (SEC-3/OBS-1/OBS-2): successes and refusals both leave one audit row on the binding. */
    @Test
    void everyRequestIsAuditedIncludingRefusals() {
        SeededBinding binding = seedEnabledBinding();
        String token = token(binding);
        put(recordsPath(binding, "notes/doc-1"), token, body("{\"status\":\"live\"}"));
        get(recordsPath(binding, "notes/doc-1"), token);
        assertEquals(HttpStatus.NOT_FOUND, delete(recordsPath(binding, "notes/absent"), token)
                .getStatusCode());

        List<String> actions = jdbcTemplate.queryForList(
                "SELECT action FROM audit_logs WHERE resource_id = ? AND resource_type = ?",
                String.class, binding.bindingId().toString(), "plugin_record");
        assertEquals(3, actions.size(), actions.toString());
        assertTrue(actions.contains("plugin.data.write"), actions.toString());
        assertTrue(actions.contains("plugin.data.read"), actions.toString());
        assertTrue(actions.contains("plugin.data.delete"), actions.toString());

        List<String> details = jdbcTemplate.queryForList(
                "SELECT details FROM audit_logs WHERE resource_id = ? AND action = ?",
                String.class, binding.bindingId().toString(), "plugin.data.delete");
        assertNotNull(details.getFirst());
        assertTrue(details.getFirst().contains("result=denied:PLUGIN_NOT_FOUND"),
                details.getFirst());
        assertTrue(details.getFirst().contains("matchedSource=binding-token"), details.getFirst());
        assertNull(jdbcTemplate.queryForObject(
                "SELECT user_id FROM audit_logs WHERE resource_id = ? AND action = ?", Object.class,
                binding.bindingId().toString(), "plugin.data.delete"),
                "a binding token is not a user; the audit actor stays null rather than invented");
    }

    // ---------------------------------------------------------------- helpers

    /**
     * The {@code items} array of a list response. Asserted through this helper rather than inline so a
     * failure shows the response body — a list call that answers 400 (grammar) or 500 looks exactly
     * like an empty page otherwise.
     */
    private JsonNode items(ResponseEntity<String> response) {
        return itemsOf(json(response), response.getBody());
    }

    private JsonNode itemsOf(JsonNode page, String context) {
        JsonNode items = page.get("items");
        assertNotNull(items, "list response has no items: " + context);
        return items;
    }
}
