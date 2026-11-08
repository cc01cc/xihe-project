package com.cc01cc.p.xihe.cp.plugin.records;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0691 T2.3: the opaque listing cursor of {@code GET /records/{collection}} (spec/data-plane.md
 * §5 API-12: "不透明 cursor，禁 offset 深翻页").
 *
 * <p><b>Shape.</b> {@code base64url(JSON{v,c,b,s,k,l}) + "." + hex(HMAC-SHA256(..)[0..8])}. The payload
 * is the keyset position — version, collection, binding, sort spec, last sort value, last id — and the
 * tag is 8 bytes (16 hex chars) of an HMAC over the base64url part. The tag is what makes the cursor
 * <i>opaque</i> rather than merely unreadable: without it a caller could base64-decode, edit the
 * position and replay it, which is exactly the "client supplies the page offset" pattern API-12 bans.
 *
 * <p><b>Key.</b> Lead ruling 2026-11-08: derive from the existing JWT signing key, no new env, no
 * hardcoded constant. The derivation mirrors {@code PluginKvTokenService} ({@code cp.jwt.secret} +
 * a purpose suffix), so one secret yields disjoint keys per purpose and a cursor tag can never be
 * confused with a token signature.
 *
 * <p><b>Failures.</b> Bad base64, bad JSON, wrong version, bad tag ⇒ 400 {@code INVALID_FILTER} — the
 * cursor is part of the query grammar, and API-11 has no cursor-specific code. Binding/collection
 * <i>mismatch</i> is checked by the caller after a successful decode, because the right status there
 * depends on the fact: a cursor for another binding is 403 {@code PLUGIN_GRANT_DENIED} (SEC-2 wins
 * over a 400), while a cursor for another collection in the same binding is 400 {@code INVALID_FILTER}.
 */
@Component
public class PluginRecordsCursorCodec {

    /** Bumping this invalidates every outstanding cursor; only a breaking payload change needs it. */
    static final int VERSION = 1;

    private static final String KEY_SUFFIX = "-plugin-records-cursor";
    private static final String ALGORITHM = "HmacSHA256";
    /** 8 bytes of tag: birthday-safe far beyond a 7-day retention window, and short enough to eyeball. */
    private static final int TAG_BYTES = 8;

    private final ObjectMapper objectMapper;
    private final SecretKeySpec key;

    public PluginRecordsCursorCodec(
            @Value("${cp.jwt.secret:xihe-cp-jwt-secret-key-change-in-production}") String secret,
            ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.key = new SecretKeySpec(
                (secret + KEY_SUFFIX).getBytes(StandardCharsets.UTF_8), ALGORITHM);
    }

    /**
     * One decoded position.
     *
     * <p>{@code version} is returned rather than validated here on purpose: the version check is a 400
     * while the binding check is a 403, and SEC-2 requires the 403 to win (Lead ruling 2026-11-08, "403
     * before 400"), so the caller has to see both facts before deciding which status to send.
     *
     * @param version    payload version the cursor was issued with
     * @param collection collection the page was listed from
     * @param bindingId  binding the page was listed for (SEC-2: a cursor is binding-scoped)
     * @param sort       sort wire form {@code <field>:<asc|desc>}, so the position cannot be replayed
     *                   against a different ordering
     * @param lastKey    sort-field value of the last row, {@code null} when sorting by {@code id}
     * @param lastId     {@code id} of the last row, always present (the tie breaker)
     */
    public record Cursor(int version, String collection, UUID bindingId, String sort, String lastKey,
            String lastId) {
    }

    /** Encodes one position. Throws nothing a caller can trigger — the position is CP-built. */
    public String encode(Cursor cursor) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("v", cursor.version());
        payload.put("c", cursor.collection());
        payload.put("b", cursor.bindingId().toString());
        payload.put("s", cursor.sort());
        payload.put("k", cursor.lastKey());
        payload.put("l", cursor.lastId());
        String json;
        try {
            json = objectMapper.writeValueAsString(payload);
        } catch (JacksonException e) {
            // The payload is built from a UUID, a collection name and two strings, so this is a server
            // invariant break, not a request error.
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                    "could not serialise the listing cursor", e);
        }
        String encoded = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(json.getBytes(StandardCharsets.UTF_8));
        return encoded + "." + tag(encoded);
    }

    /**
     * Decodes and authenticates one cursor.
     *
     * @throws CpApiException 400 {@code INVALID_FILTER} for anything that is not a cursor this service
     *                        issued; the detail never distinguishes "wrong tag" from "malformed", so a
     *                        caller learns nothing about the payload
     */
    public Cursor decode(String token) {
        if (token == null || token.isBlank()) {
            throw invalid();
        }
        int separator = token.lastIndexOf('.');
        if (separator <= 0 || separator == token.length() - 1) {
            throw invalid();
        }
        String encoded = token.substring(0, separator);
        String presentedTag = token.substring(separator + 1);
        if (!MessageDigest.isEqual(tag(encoded).getBytes(StandardCharsets.US_ASCII),
                presentedTag.getBytes(StandardCharsets.US_ASCII))) {
            throw invalid();
        }
        JsonNode payload;
        try {
            payload = objectMapper.readTree(java.util.Base64.getUrlDecoder().decode(encoded));
        } catch (IllegalArgumentException | JacksonException e) {
            throw invalid();
        }
        if (payload == null || !payload.isObject()) {
            throw invalid();
        }
        JsonNode versionNode = payload.path("v");
        if (!versionNode.isNumber()) {
            throw invalid();
        }
        String collection = text(payload, "c");
        String binding = text(payload, "b");
        String sort = text(payload, "s");
        String lastId = text(payload, "l");
        if (collection == null || binding == null || sort == null || lastId == null) {
            throw invalid();
        }
        UUID bindingId;
        try {
            bindingId = UUID.fromString(binding);
        } catch (IllegalArgumentException e) {
            throw invalid();
        }
        return new Cursor(versionNode.asInt(-1), collection, bindingId, sort, text(payload, "k"),
                lastId);
    }

    private static String text(JsonNode payload, String field) {
        JsonNode value = payload.path(field);
        if (value.isNull() || value.isMissingNode()) {
            return null;
        }
        return value.isTextual() ? value.asText() : null;
    }

    private String tag(String encoded) {
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(key);
            byte[] digest = mac.doFinal(encoded.getBytes(StandardCharsets.UTF_8));
            byte[] truncated = new byte[TAG_BYTES];
            System.arraycopy(digest, 0, truncated, 0, TAG_BYTES);
            return HexFormat.of().formatHex(truncated);
        } catch (GeneralSecurityException e) {
            // HmacSHA256 is mandatory in every JRE; a failure here means the platform is broken.
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                    "could not sign the listing cursor", e);
        }
    }

    private static CpApiException invalid() {
        return new CpApiException(HttpStatus.BAD_REQUEST, PluginQueryCompiler.CODE_INVALID_FILTER,
                "cursor is not a listing cursor issued by this binding");
    }
}
