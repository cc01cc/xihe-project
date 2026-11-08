package com.cc01cc.p.xihe.cp.plugin.records;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T2.3: the cursor half of §5 API-12 line 104 — "不透明 cursor，禁 offset 深翻页".
 *
 * <p>"Opaque" has to mean something checkable, so the properties here are the ones that make opacity
 * real rather than a naming choice:
 * <ul>
 *   <li><b>C1 round-trip</b> — a cursor written by this deployment reads back byte-identical.</li>
 *   <li><b>C2 tamper-evidence</b> — an edited payload is refused, because the tag is computed over it.</li>
 *   <li><b>C3 key derivation</b> — the tag depends on the deployment's JWT secret, so a cursor from
 *       another deployment does not verify here (no new env var was introduced: Lead ruling
 *       2026-11-08 derived the key from the existing signing key).</li>
 *   <li><b>C4 malformed input</b> — anything that is not a cursor is 400 {@code INVALID_FILTER}, never
 *       a 500 and never a silently ignored parameter.</li>
 *   <li><b>C5 version is surfaced, not enforced</b> — the codec reports an unknown version so the
 *       service can answer 403-before-400 (a cursor from another binding must be refused as a security
 *       decision even when its version is also wrong).</li>
 *   <li><b>C6 no offset semantics</b> — the payload carries the last sort key and id, and nothing
 *       else; there is no "skip N" field that a later change could quietly start honouring.</li>
 * </ul>
 */
class PluginQueryCompilerCursorTest {

    private static final String SECRET = "unit-test-jwt-secret";
    private static final UUID BINDING = UUID.fromString("11111111-2222-3333-4444-555555555555");
    private static final String COLLECTION = "notes";

    private final ObjectMapper mapper = new ObjectMapper();
    private final PluginRecordsCursorCodec codec = new PluginRecordsCursorCodec(SECRET, mapper);

    /** C1: round-trip preserves every field, including a sort key that is not an id. */
    @Test
    void cursorRoundTrips() {
        PluginRecordsCursorCodec.Cursor cursor = new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION, COLLECTION, BINDING, "name:desc", "m", "id-7");
        PluginRecordsCursorCodec.Cursor decoded = codec.decode(codec.encode(cursor));
        assertEquals(cursor, decoded);
        assertEquals(PluginRecordsCursorCodec.VERSION, decoded.version());
        assertEquals("name:desc", decoded.sort());
        assertEquals("m", decoded.lastKey());
        assertEquals("id-7", decoded.lastId());
    }

    /** C1b: the encoding is URL-safe and padding-free so it can sit in a query string unchanged. */
    @Test
    void cursorIsUrlSafe() {
        String encoded = codec.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION, COLLECTION, BINDING, "id:asc", null, "id-1"));
        assertTrue(encoded.matches("[A-Za-z0-9_\\-.]+"), encoded);
        assertTrue(encoded.contains("."), "payload and tag are dot-separated");
    }

    /** C2: editing the payload invalidates the tag — that is the whole point of signing it. */
    @Test
    void tamperedPayloadIsRefused() {
        String encoded = codec.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION, COLLECTION, BINDING, "id:asc", null, "id-1"));
        int dot = encoded.lastIndexOf('.');
        byte[] payload = Base64.getUrlDecoder().decode(encoded.substring(0, dot));
        String json = new String(payload, StandardCharsets.UTF_8);
        // The attacker swaps the last id for a bigger one, hoping to skip pages.
        String forged = json.replace("id-1", "id-9");
        assertNotEquals(json, forged);
        String rebuilt = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(forged.getBytes(StandardCharsets.UTF_8)) + encoded.substring(dot);
        assertInvalidCursor(rebuilt);
    }

    /** C2b: editing the tag is refused too (bit flip in the truncated MAC). */
    @Test
    void tamperedTagIsRefused() {
        String encoded = codec.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION, COLLECTION, BINDING, "id:asc", null, "id-1"));
        char last = encoded.charAt(encoded.length() - 1);
        String forged = encoded.substring(0, encoded.length() - 1) + (last == 'a' ? 'b' : 'a');
        assertInvalidCursor(forged);
    }

    /** C3: the key is derived from the deployment's signing secret, not from a constant. */
    @Test
    void cursorFromAnotherDeploymentIsRefused() {
        PluginRecordsCursorCodec other = new PluginRecordsCursorCodec("another-secret", mapper);
        String foreign = other.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION, COLLECTION, BINDING, "id:asc", null, "id-1"));
        assertInvalidCursor(foreign);
    }

    /** C4: everything that is not a well-formed cursor is 400 {@code INVALID_FILTER}. */
    @Test
    void malformedCursorsAreRefused() {
        assertInvalidCursor("");
        assertInvalidCursor("   ");
        assertInvalidCursor("not-a-cursor");
        assertInvalidCursor("abc.def");
        assertInvalidCursor("e30.");            // empty JSON object, empty tag
        assertInvalidCursor(".abcdef0123456789");
        // Well-signed but structurally wrong payloads: missing fields and a non-object body.
        assertInvalidCursor(signed("[]"));
        assertInvalidCursor(signed("{\"v\":1}"));
        assertInvalidCursor(signed("{\"v\":1,\"c\":\"notes\",\"b\":\"not-a-uuid\",\"s\":\"id:asc\",\"l\":\"id-1\"}"));
        assertInvalidCursor(signed("{\"v\":\"1\",\"c\":\"notes\",\"b\":\"" + BINDING
                + "\",\"s\":\"id:asc\",\"l\":\"id-1\"}"));
    }

    /**
     * C5: an unknown version is reported, not thrown by the codec.
     *
     * <p>The order matters: the service checks the binding first (403) and the version second (400), so
     * the codec must not pre-empt a security answer with a validation error.
     */
    @Test
    void unknownVersionIsSurfacedToTheCaller() {
        String future = codec.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION + 1, COLLECTION, BINDING, "id:asc", null, "id-1"));
        assertEquals(PluginRecordsCursorCodec.VERSION + 1, codec.decode(future).version());
    }

    /**
     * C6: the payload is a keyset, not an offset — decode exposes exactly lastKey/lastId and no count.
     */
    @Test
    void payloadCarriesNoOffset() throws Exception {
        String encoded = codec.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION, COLLECTION, BINDING, "name:asc", "m", "id-3"));
        int dot = encoded.lastIndexOf('.');
        String json = new String(Base64.getUrlDecoder().decode(encoded.substring(0, dot)),
                StandardCharsets.UTF_8);
        // Assert on the key set rather than on a substring: an added field must fail this test.
        java.util.Set<String> keys = mapper.readTree(json).propertyNames().stream()
                .map(name -> name).collect(java.util.stream.Collectors.toSet());
        assertEquals(java.util.Set.of("v", "c", "b", "s", "k", "l"), keys);
    }

    // ---------------------------------------------------------------- helpers

    /** Signs an arbitrary payload with the same key the codec uses, to test structure checks. */
    private String signed(String json) {
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(json.getBytes(StandardCharsets.UTF_8));
        return payload + "." + tag(payload);
    }

    private String tag(String payload) {
        try {
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(
                    (SECRET + "-plugin-records-cursor").getBytes(StandardCharsets.UTF_8),
                    "HmacSHA256"));
            byte[] full = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 8; i++) {
                hex.append(String.format("%02x", full[i]));
            }
            return hex.toString();
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private void assertInvalidCursor(String cursor) {
        CpApiException e = assertThrows(CpApiException.class, () -> codec.decode(cursor));
        assertEquals(HttpStatus.BAD_REQUEST, e.getStatus());
        assertEquals(PluginQueryCompiler.CODE_INVALID_FILTER, e.getCode());
    }
}
