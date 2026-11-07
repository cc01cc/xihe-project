package com.cc01cc.p.xihe.cp.plugin.kv;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.plugin.PluginBinding;
import com.cc01cc.p.xihe.cp.plugin.PluginBindingRepository;
import com.cc01cc.p.xihe.cp.plugin.PluginBindingState;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0691 T1.5: the plugin KV data plane's application service (spec/data-plane.md §2 QUOTA,
 * §4 API/SEC).
 *
 * <p>Responsibilities, in the order a request goes through them:
 * <ol>
 *   <li><b>SEC-2 authorization</b> — token/path binding match, binding exists, state is
 *       {@code enabled}. This is the layer that replaced the foreign key DP-6a removed: nothing in the
 *       database stops a row from existing for a deleted binding, so every write has to prove the
 *       binding is real and live <em>before</em> the row is touched.</li>
 *   <li><b>QUOTA-4/QUOTA-5</b> — per-binding rate and concurrency, via {@link PluginKvRateLimiter}.</li>
 *   <li><b>QUOTA-1/QUOTA-2/QUOTA-3</b> — key budget, value size, TTL ceiling.</li>
 *   <li><b>API-9 CAS</b> — {@code If-Match} semantics, decided by the row count of one conditional
 *       statement so two concurrent writers cannot both "win".</li>
 * </ol>
 *
 * <p>Validation order is deliberate: authorization before quota, quota before storage. A rejected
 * caller must not be able to probe another binding's key budget, and a 413 must not be reported from
 * inside a CAS attempt that already mutated a version.
 *
 * <p><b>Who writes {@code orphaned_at} (DP-6a / LC-6):</b> not this class, and not the purge job
 * either — there are exactly two owners, and neither is here:
 * <ul>
 *   <li><b>writer</b> — lane A's uninstall/detach path ({@code cp/plugin/PluginBindingService},
 *       T1.4), which stamps {@code orphaned_at = now()} at the moment the binding row is physically
 *       deleted. That stamp is the clock LC-6's grace period is measured from;</li>
 *   <li><b>reader</b> — T3.2's purge job, which reclaims rows whose {@code binding_id} no longer
 *       exists <em>and</em> whose stamp (falling back to {@code updated_at} when unset) is older than
 *       604800s.</li>
 * </ul>
 * This class only ever <em>clears</em> the column: {@link PluginKvRepository} sets it back to
 * {@code NULL} when a write succeeds, because a live write is itself proof the binding is back. So
 * "row is orphaned" is never a decision this layer makes, and a missing purge must not be "fixed" by
 * stamping the column here — that would let the data plane silently redefine the grace period.
 */
@Service
public class PluginKvService {

    /** spec/data-plane.md API-11 error codes used by this surface. */
    public static final String CODE_NOT_FOUND = "PLUGIN_NOT_FOUND";
    public static final String CODE_VALUE_TOO_LARGE = "PLUGIN_VALUE_TOO_LARGE";
    public static final String CODE_QUOTA_EXCEEDED = "PLUGIN_KV_QUOTA_EXCEEDED";
    public static final String CODE_PRECONDITION_REQUIRED = "PLUGIN_PRECONDITION_REQUIRED";
    public static final String CODE_PRECONDITION_FAILED = "PLUGIN_PRECONDITION_FAILED";
    public static final String CODE_GRANT_DENIED = "PLUGIN_GRANT_DENIED";
    public static final String CODE_BINDING_INACTIVE = "PLUGIN_BINDING_INACTIVE";
    public static final String CODE_INVALID_REQUEST = "INVALID_REQUEST";
    public static final String CODE_CONCURRENT_MODIFICATION = "CONCURRENT_MODIFICATION";

    /** DP-1 column widths; see V141 for why these numbers are a CP-side guard, not a spec value. */
    static final int MAX_NAMESPACE_LENGTH = 64;
    static final int MAX_KEY_LENGTH = 256;
    /** API-4 ceiling. */
    static final int MAX_LIST_LIMIT = 200;
    /**
     * API-4 gives only the ceiling ("limit ≤ 200"), no default. The ceiling is used as the default
     * rather than inventing a second number that the spec would then have to be reconciled with.
     */
    static final int DEFAULT_LIST_LIMIT = MAX_LIST_LIMIT;

    private final PluginKvRepository repository;
    private final PluginBindingRepository bindingRepository;
    private final PluginKvLimits limits;
    private final PluginKvRateLimiter rateLimiter;
    private final ObjectMapper objectMapper;

    public PluginKvService(PluginKvRepository repository, PluginBindingRepository bindingRepository,
                           PluginKvLimits limits, PluginKvRateLimiter rateLimiter,
                           ObjectMapper objectMapper) {
        this.repository = repository;
        this.bindingRepository = bindingRepository;
        this.limits = limits;
        this.rateLimiter = rateLimiter;
        this.objectMapper = objectMapper;
    }

    /** API-1: read one key; expired rows are reported as absent (404 {@code PLUGIN_NOT_FOUND}). */
    public Item read(PluginKvClaims claims, UUID bindingId, String namespace, String key) {
        authorize(claims, bindingId);
        requireName(namespace, MAX_NAMESPACE_LENGTH, "namespace");
        requireName(key, MAX_KEY_LENGTH, "key");
        try (PluginKvRateLimiter.Permit ignored = rateLimiter.acquire(bindingId)) {
            return repository.find(bindingId, namespace, key)
                    .map(this::toItem)
                    .orElseThrow(() -> notFound(namespace, key));
        }
    }

    /**
     * API-2 / API-9: create or overwrite one key.
     *
     * @param ifMatchVersion the {@code version} the caller expects, or {@code null} when it sent
     *                       neither the header nor the body field
     * @param force          {@code If-Match: *} — overwrite whatever version is stored
     */
    public Item write(PluginKvClaims claims, UUID bindingId, String namespace, String key,
                      JsonNode value, Long ttlSeconds, Long ifMatchVersion, boolean force) {
        authorize(claims, bindingId);
        requireName(namespace, MAX_NAMESPACE_LENGTH, "namespace");
        requireName(key, MAX_KEY_LENGTH, "key");
        try (PluginKvRateLimiter.Permit ignored = rateLimiter.acquire(bindingId)) {
            String valueJson = requireValueJson(value);
            Instant expiresAt = resolveExpiresAt(ttlSeconds);
            Optional<PluginKvRow> current = repository.find(bindingId, namespace, key);
            if (force) {
                if (repository.updateAnyVersion(bindingId, namespace, key, valueJson, expiresAt) == 0) {
                    requireKeyBudget(bindingId);
                    if (!repository.insert(bindingId, namespace, key, valueJson, expiresAt)
                            && repository.updateAnyVersion(bindingId, namespace, key, valueJson, expiresAt) == 0) {
                        throw concurrentModification(key);
                    }
                }
            } else if (current.isPresent()) {
                long storedVersion = current.get().version();
                if (ifMatchVersion == null) {
                    throw preconditionRequired(namespace, key, storedVersion);
                }
                if (ifMatchVersion != storedVersion) {
                    throw preconditionFailed(key, ifMatchVersion, storedVersion);
                }
                if (repository.updateWithVersion(bindingId, namespace, key, ifMatchVersion, valueJson,
                        expiresAt) == 0) {
                    throw preconditionFailed(key, ifMatchVersion, null);
                }
            } else {
                // API-9: a brand new key may omit If-Match; overwriting an existing one may not.
                requireKeyBudget(bindingId);
                if (!repository.insert(bindingId, namespace, key, valueJson, expiresAt)) {
                    // Lost the create race: the key now exists, so the CAS rules apply to it.
                    if (ifMatchVersion == null) {
                        throw preconditionRequired(namespace, key, null);
                    }
                    if (repository.updateWithVersion(bindingId, namespace, key, ifMatchVersion, valueJson,
                            expiresAt) == 0) {
                        throw preconditionFailed(key, ifMatchVersion, null);
                    }
                }
            }
            return repository.find(bindingId, namespace, key)
                    .map(this::toItem)
                    .orElseThrow(() -> new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                            "INTERNAL_ERROR", "plugin kv row vanished after write"));
        }
    }

    /** API-3 / API-9: delete one key, optionally guarded by {@code If-Match}. */
    public void delete(PluginKvClaims claims, UUID bindingId, String namespace, String key,
                       Long ifMatchVersion) {
        authorize(claims, bindingId);
        requireName(namespace, MAX_NAMESPACE_LENGTH, "namespace");
        requireName(key, MAX_KEY_LENGTH, "key");
        try (PluginKvRateLimiter.Permit ignored = rateLimiter.acquire(bindingId)) {
            PluginKvRow current = repository.find(bindingId, namespace, key)
                    .orElseThrow(() -> notFound(namespace, key));
            if (ifMatchVersion != null && ifMatchVersion != current.version()) {
                throw preconditionFailed(key, ifMatchVersion, current.version());
            }
            int deleted = ifMatchVersion == null
                    ? repository.delete(bindingId, namespace, key)
                    : repository.deleteWithVersion(bindingId, namespace, key, ifMatchVersion);
            if (deleted == 0) {
                // The row changed between the read and the delete; report the same 412 as a stale CAS.
                throw preconditionFailed(key, ifMatchVersion, null);
            }
        }
    }

    /** API-4: prefix listing with an opaque cursor (the last key of the previous page). */
    public Page list(PluginKvClaims claims, UUID bindingId, String namespace, String prefix,
                     String cursor, Integer limit) {
        authorize(claims, bindingId);
        requireName(namespace, MAX_NAMESPACE_LENGTH, "namespace");
        int effectiveLimit = limit == null ? DEFAULT_LIST_LIMIT : limit;
        if (effectiveLimit < 1 || effectiveLimit > MAX_LIST_LIMIT) {
            throw invalidRequest("limit must be between 1 and " + MAX_LIST_LIMIT + " (API-4)");
        }
        String likePattern = prefix == null || prefix.isEmpty() ? null : escapeLike(prefix) + "%";
        String afterKey = decodeCursor(cursor);
        try (PluginKvRateLimiter.Permit ignored = rateLimiter.acquire(bindingId)) {
            List<PluginKvRow> rows = repository.list(bindingId, namespace, likePattern, afterKey,
                    effectiveLimit + 1);
            boolean hasMore = rows.size() > effectiveLimit;
            List<PluginKvRow> pageRows = hasMore ? rows.subList(0, effectiveLimit) : rows;
            List<Item> items = new ArrayList<>(pageRows.size());
            for (PluginKvRow row : pageRows) {
                items.add(toItem(row));
            }
            String nextCursor = hasMore ? encodeCursor(pageRows.get(pageRows.size() - 1).key()) : null;
            return new Page(List.copyOf(items), nextCursor);
        }
    }

    /**
     * SEC-2: everything that can make a request forbidden, checked against the live binding row.
     *
     * <p>Both halves of SEC-2 answer 403 and neither reveals whether the key exists — a caller must not
     * be able to tell "wrong binding" from "binding suspended" from the shape of the error, and both
     * must be checked before any data statement runs.
     */
    private void authorize(PluginKvClaims claims, UUID bindingId) {
        if (claims == null) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "a binding-scoped token is required on the plugin KV data plane (SEC-1)");
        }
        if (!bindingId.equals(claims.bindingId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, CODE_GRANT_DENIED,
                    "token is not scoped to this binding (SEC-2)");
        }
        PluginBinding binding = bindingRepository.findById(bindingId)
                .orElseThrow(() -> new CpApiException(HttpStatus.FORBIDDEN, CODE_BINDING_INACTIVE,
                        "plugin binding is not enabled (SEC-2)"));
        if (binding.state() != PluginBindingState.ENABLED) {
            throw new CpApiException(HttpStatus.FORBIDDEN, CODE_BINDING_INACTIVE,
                    "plugin binding state is " + binding.state().wire() + " (SEC-2)");
        }
        if (!binding.getPluginId().equals(claims.pluginId()) || !binding.getDigest().equals(claims.digest())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, CODE_GRANT_DENIED,
                    "token does not match the binding's plugin/digest (SEC-2)");
        }
    }

    /** QUOTA-2: serialise once, measure UTF-8 bytes, keep the text for storage. */
    private String requireValueJson(JsonNode value) {
        if (value == null || value.isNull()) {
            throw invalidRequest("value is required (API-2)");
        }
        String valueJson;
        try {
            valueJson = objectMapper.writeValueAsString(value);
        } catch (JacksonException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, CODE_INVALID_REQUEST,
                    "value is not serialisable JSON", e);
        }
        int bytes = valueJson.getBytes(StandardCharsets.UTF_8).length;
        if (bytes > limits.maxValueBytes()) {
            throw new CpApiException(HttpStatus.CONTENT_TOO_LARGE, CODE_VALUE_TOO_LARGE,
                    "value is " + bytes + " bytes, kv.maxValueBytes is " + limits.maxValueBytes()
                            + " (QUOTA-2)");
        }
        return valueJson;
    }

    /** QUOTA-3: TTL ceiling; a non-positive TTL is a request error, not "no expiry". */
    private Instant resolveExpiresAt(Long ttlSeconds) {
        if (ttlSeconds == null) {
            return null;
        }
        if (ttlSeconds < 1) {
            throw invalidRequest("ttlSeconds must be a positive integer");
        }
        if (ttlSeconds > limits.ttlSecondsMax()) {
            throw new CpApiException(HttpStatus.TOO_MANY_REQUESTS, CODE_QUOTA_EXCEEDED,
                    "ttlSeconds " + ttlSeconds + " exceeds kv.ttlSecondsMax " + limits.ttlSecondsMax()
                            + " (QUOTA-3)");
        }
        return Instant.now().plusSeconds(ttlSeconds);
    }

    /** QUOTA-1: one more key would exceed the per-binding budget. */
    private void requireKeyBudget(UUID bindingId) {
        long live = repository.countLiveKeys(bindingId);
        if (live >= limits.maxKeys()) {
            throw new CpApiException(HttpStatus.TOO_MANY_REQUESTS, CODE_QUOTA_EXCEEDED,
                    "binding already holds " + live + " keys, kv.maxKeys is " + limits.maxKeys()
                            + " (QUOTA-1)");
        }
    }

    private Item toItem(PluginKvRow row) {
        return new Item(row.key(), readTree(row.valueJson()), row.version(), row.expiresAt());
    }

    private JsonNode readTree(String valueJson) {
        try {
            return objectMapper.readTree(valueJson);
        } catch (JacksonException e) {
            // jsonb guarantees valid JSON on read; a failure here means the column was written by
            // something other than this service, so it is a server-side invariant break, not a 400.
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                    "stored plugin kv value is not valid JSON", e);
        }
    }

    private static void requireName(String value, int maxLength, String what) {
        if (value == null || value.isBlank()) {
            throw invalidRequest(what + " is required");
        }
        if (value.length() > maxLength) {
            throw invalidRequest(what + " must be at most " + maxLength + " characters");
        }
    }

    private static CpApiException notFound(String namespace, String key) {
        return new CpApiException(HttpStatus.NOT_FOUND, CODE_NOT_FOUND,
                "no live value for " + namespace + "/" + key);
    }

    private static CpApiException invalidRequest(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, CODE_INVALID_REQUEST, detail);
    }

    /** API-9: an existing key cannot be overwritten blind. */
    private static CpApiException preconditionRequired(String namespace, String key, Long storedVersion) {
        return new CpApiException(HttpStatus.PRECONDITION_FAILED, CODE_PRECONDITION_REQUIRED,
                "key " + namespace + "/" + key + " already exists (version "
                        + (storedVersion == null ? "unknown" : storedVersion)
                        + "); send If-Match with the current version or If-Match: * to force (API-9)");
    }

    /** API-9: the caller's expected version is not the stored one. */
    private static CpApiException preconditionFailed(String key, Long expected, Long stored) {
        return new CpApiException(HttpStatus.PRECONDITION_FAILED, CODE_PRECONDITION_FAILED,
                "version mismatch for key " + key + ": expected " + expected + ", stored "
                        + (stored == null ? "changed concurrently" : stored) + " (API-9)");
    }

    private static CpApiException concurrentModification(String key) {
        return new CpApiException(HttpStatus.CONFLICT, CODE_CONCURRENT_MODIFICATION,
                "key " + key + " changed concurrently; retry the request");
    }

    /** API-4: the cursor is opaque, so it is only ever produced and consumed here. */
    private static String encodeCursor(String key) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(key.getBytes(StandardCharsets.UTF_8));
    }

    private static String decodeCursor(String cursor) {
        if (cursor == null || cursor.isEmpty()) {
            return null;
        }
        try {
            return new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            throw invalidRequest("cursor is not a valid listing cursor");
        }
    }

    /** PostgreSQL {@code LIKE} with the default backslash escape: escape the metacharacters. */
    private static String escapeLike(String raw) {
        StringBuilder escaped = new StringBuilder(raw.length() + 8);
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '\\' || c == '%' || c == '_') {
                escaped.append('\\');
            }
            escaped.append(c);
        }
        return escaped.toString();
    }

    /**
     * One KV entry as it reaches the wire.
     *
     * <p>{@code value} is a Jackson <b>3</b> node, which is the mapper Boot 4 serialises for HTTP, so
     * the document is emitted as JSON rather than as a bean projection (PLAN-0633 C1).
     */
    public record Item(String key, JsonNode value, long version, Instant expiresAt) {
    }

    /** API-4 response: items plus the opaque cursor for the next page ({@code null} on the last). */
    public record Page(List<Item> items, String nextCursor) {
    }
}
