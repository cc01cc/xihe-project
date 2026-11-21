package com.cc01cc.p.xihe.cp.scheduled;

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
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * task-163 (DSD-1518 A): opaque keyset cursor for the two automation read faces.
 *
 * <p>Why a cursor at all: the aggregate face merges rows across every workspace the caller belongs
 * to, so offset pagination would drift as rows land between pages. Position is
 * {@code (created_at, id)} in descending order — the instant is not unique, the id breaks ties.
 *
 * <p>Why signed rather than plain Base64url ({@code MessageReadService}'s {@code before} cursor is
 * unsigned and positional only): a caller must not be able to move the position, and a cursor issued
 * for one scope must not be replayable against another — the aggregate face and the session face
 * answer different authorization questions, so a crossed cursor would silently widen the read set.
 * The construction mirrors {@code PluginRecordsCursorCodec} (HMAC-SHA256 over the encoded payload,
 * 8-byte tag in the clear) but deliberately is its own component: that codec's payload is bound to a
 * plugin binding and a query sort, and reusing it would entangle two unrelated permission models.
 *
 * <p>A stale or foreign cursor is a 400 {@code INVALID_CURSOR} — the same code
 * {@code MessageReadService} uses for its own hand-rolled cursor, so a client branches on one code
 * for "your cursor is not ours" across the read faces.
 */
@Component
public class ScheduledTaskCursorCodec {

    /** Bumping this invalidates every outstanding cursor. */
    static final int VERSION = 1;

    /** Aggregate face: rows merged over the caller's member workspaces. */
    static final String SCOPE_AGGREGATE = "aggregate";
    /** Session face: rows whose target session is this session. */
    static final String SCOPE_SESSION = "session";

    private static final String KEY_SUFFIX = "-scheduled-task-cursor";
    private static final String ALGORITHM = "HmacSHA256";
    /** 8 bytes of tag: birthday-safe far beyond any pagination session. */
    private static final int TAG_BYTES = 8;
    private static final String CODE_INVALID_CURSOR = "INVALID_CURSOR";
    private static final String DETAIL_INVALID_CURSOR =
            "cursor is not an automation cursor issued by this endpoint";

    private final ObjectMapper objectMapper;
    private final SecretKeySpec key;

    public ScheduledTaskCursorCodec(
            @Value("${cp.jwt.secret:xihe-cp-jwt-secret-key-change-in-production}") String secret,
            ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.key = new SecretKeySpec(
                (secret + KEY_SUFFIX).getBytes(StandardCharsets.UTF_8), ALGORITHM);
    }

    /**
     * One decoded position.
     *
     * @param version    payload version the cursor was issued with
     * @param scope      read face the cursor was issued for ({@code aggregate} / {@code session})
     * @param binding    subject the cursor belongs to: the caller's user id for the aggregate face,
     *                   the target session id for the session face
     * @param lastCreatedAt {@code created_at} of the last row of the page that produced the cursor
     * @param lastId     {@code id} of that same row, the tie breaker
     */
    public record Position(int version, String scope, String binding, Instant lastCreatedAt,
            UUID lastId) {
    }

    /** Encodes one position. The arguments are CP-built, so this throws no request-shaped error. */
    public String encode(Position position) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("v", position.version());
        payload.put("s", position.scope());
        payload.put("b", position.binding());
        payload.put("k", position.lastCreatedAt().toString());
        payload.put("l", position.lastId().toString());
        String json;
        try {
            json = objectMapper.writeValueAsString(payload);
        } catch (JacksonException e) {
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                    "could not serialise the automation cursor", e);
        }
        String encoded = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(json.getBytes(StandardCharsets.UTF_8));
        return encoded + "." + tag(encoded);
    }

    /**
     * Decodes, authenticates and scope-checks one cursor.
     *
     * @param token   the opaque {@code cursor} query parameter
     * @param scope   the read face being served; a cursor for the other face is rejected
     * @param binding the subject this face expects ({@code userId} / {@code sessionId})
     * @throws CpApiException 400 {@code INVALID_CURSOR} for anything this service did not issue for
     *                        exactly this scope and binding; the detail never says which check failed
     */
    public Position decode(String token, String scope, String binding) {
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
        String scopeText = text(payload, "s");
        String bindingText = text(payload, "b");
        String lastCreatedAt = text(payload, "k");
        String lastId = text(payload, "l");
        if (scopeText == null || bindingText == null || lastCreatedAt == null || lastId == null) {
            throw invalid();
        }
        if (!scopeText.equals(scope) || !bindingText.equals(binding)) {
            throw invalid();
        }
        Instant createdAt;
        try {
            createdAt = Instant.parse(lastCreatedAt);
        } catch (DateTimeParseException e) {
            throw invalid();
        }
        UUID id;
        try {
            id = UUID.fromString(lastId);
        } catch (IllegalArgumentException e) {
            throw invalid();
        }
        return new Position(versionNode.asInt(-1), scopeText, bindingText, createdAt, id);
    }

    /** The version check a caller owning a multi-version rollout may need; 1 today. */
    static int currentVersion() {
        return VERSION;
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
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                    "could not sign the automation cursor", e);
        }
    }

    private static CpApiException invalid() {
        return new CpApiException(HttpStatus.BAD_REQUEST, CODE_INVALID_CURSOR,
                DETAIL_INVALID_CURSOR);
    }
}
