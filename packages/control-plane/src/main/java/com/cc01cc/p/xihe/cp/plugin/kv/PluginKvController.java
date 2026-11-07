package com.cc01cc.p.xihe.cp.plugin.kv;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * PLAN-0691 T1.5: the four KV data-plane routes of {@code spec/data-plane.md} API-1..API-4, all under
 * {@code /internal/v1/plugin-bindings/{bindingId}/kv}.
 *
 * <p>D-66: the whole class is behind {@code cp.plugin.enabled}. With the flag off no handler is
 * mapped, so these paths answer <b>404</b> — the same "this build has no plugin feature" answer the
 * catalog and binding surfaces give, and the reason {@code SecurityConfig} must let a flagged-off
 * request fall through to the dispatcher instead of answering 401/403.
 *
 * <p>Thin by construction (CP architecture gate): no repository, no SQL, no policy. Every decision —
 * SEC-2 authorization, QUOTA-1..5, API-9 CAS — lives in {@link PluginKvService}, and the verified
 * claims arrive as a request attribute set by {@link PluginKvTokenFilter} rather than being
 * re-parsed here.
 *
 * <p>Token claims are read with {@code required = false} and handed to the service as-is: if a future
 * matcher change ever routed a request here without the filter, the service's SEC-2 check answers
 * 401 {@code AUTHORIZATION_REQUIRED} instead of Spring turning a missing attribute into a 500.
 *
 * <p>Status codes that the spec leaves open, and what this controller chose:
 * <ul>
 *   <li>PUT answers {@code 200} with the stored item (key, value, version, expiresAt). API-2 is a
 *       single "create/overwrite" semantic, so there is no create/update split to signal with
 *       201-vs-200; returning the new {@code version} is what makes the next CAS usable.</li>
 *   <li>DELETE answers {@code 204} with no body: API-3's only payload is an error (404/412).</li>
 *   <li>The GET list body is {@code {items: [...], nextCursor: string|null}} — the spec fixes the
 *       query parameters and the ceiling but not the envelope, so this stays the smallest shape that
 *       can carry API-4's opaque cursor.</li>
 * </ul>
 */
@RestController
@RequestMapping("/internal/v1/plugin-bindings/{bindingId}/kv")
@ConditionalOnProperty(name = "cp.plugin.enabled", havingValue = "true")
public class PluginKvController {

    private static final String CLAIMS = PluginKvTokenFilter.CLAIMS_ATTRIBUTE;
    private static final String IF_MATCH = "If-Match";
    private static final String FORCE = "*";

    private final PluginKvService service;

    public PluginKvController(PluginKvService service) {
        this.service = service;
    }

    /** API-1: read one key; a missing or expired key is 404 {@code PLUGIN_NOT_FOUND}. */
    @GetMapping("/{namespace}/{key}")
    public PluginKvService.Item read(
            @RequestAttribute(name = CLAIMS, required = false) PluginKvClaims claims,
            @PathVariable UUID bindingId,
            @PathVariable String namespace,
            @PathVariable String key) {
        return service.read(claims, bindingId, namespace, key);
    }

    /** API-2 + API-9: create/overwrite one key, `If-Match` in the header or `ifMatch` in the body. */
    @PutMapping("/{namespace}/{key}")
    public PluginKvService.Item write(
            @RequestAttribute(name = CLAIMS, required = false) PluginKvClaims claims,
            @PathVariable UUID bindingId,
            @PathVariable String namespace,
            @PathVariable String key,
            @RequestHeader(name = IF_MATCH, required = false) String ifMatchHeader,
            @RequestBody PluginKvPutRequest body) {
        Long headerVersion = null;
        boolean force = false;
        if (ifMatchHeader != null && !ifMatchHeader.isBlank()) {
            String trimmed = ifMatchHeader.trim();
            if (FORCE.equals(trimmed)) {
                force = true;
            } else {
                headerVersion = parseVersion(trimmed, IF_MATCH);
            }
        }
        Long bodyVersion = body.ifMatch();
        if (force && bodyVersion != null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, PluginKvService.CODE_INVALID_REQUEST,
                    "If-Match: * forces an overwrite and cannot be combined with ifMatch in the body");
        }
        if (headerVersion != null && bodyVersion != null && !headerVersion.equals(bodyVersion)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, PluginKvService.CODE_INVALID_REQUEST,
                    "If-Match header and body ifMatch disagree");
        }
        Long expectedVersion = headerVersion != null ? headerVersion : bodyVersion;
        return service.write(claims, bindingId, namespace, key, body.value(), body.ttlSeconds(),
                expectedVersion, force);
    }

    /** API-3 + API-9: delete one key; a version mismatch is 412. */
    @DeleteMapping("/{namespace}/{key}")
    public ResponseEntity<Void> delete(
            @RequestAttribute(name = CLAIMS, required = false) PluginKvClaims claims,
            @PathVariable UUID bindingId,
            @PathVariable String namespace,
            @PathVariable String key,
            @RequestHeader(name = IF_MATCH, required = false) String ifMatchHeader) {
        Long expectedVersion = null;
        if (ifMatchHeader != null && !ifMatchHeader.isBlank()) {
            expectedVersion = parseVersion(ifMatchHeader.trim(), IF_MATCH);
        }
        service.delete(claims, bindingId, namespace, key, expectedVersion);
        return ResponseEntity.noContent().build();
    }

    /** API-4: prefix listing with an opaque cursor; {@code limit} is capped at 200 by the service. */
    @GetMapping("/{namespace}")
    public PluginKvService.Page list(
            @RequestAttribute(name = CLAIMS, required = false) PluginKvClaims claims,
            @PathVariable UUID bindingId,
            @PathVariable String namespace,
            @RequestParam(required = false) String prefix,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false) Integer limit) {
        return service.list(claims, bindingId, namespace, prefix, cursor, limit);
    }

    /**
     * API-9 {@code If-Match}: the wire form is a bare version number.
     *
     * <p>Quoting is tolerated because HTTP's own {@code If-Match} grammar is an entity tag
     * ({@code "3"}) and a client library may add the quotes for us; anything else is a request error
     * rather than a silent "no precondition", which would let a stale writer overwrite blindly.
     */
    private static long parseVersion(String raw, String headerName) {
        String candidate = raw;
        if (candidate.length() >= 2 && candidate.startsWith("\"") && candidate.endsWith("\"")) {
            candidate = candidate.substring(1, candidate.length() - 1);
        }
        try {
            long version = Long.parseLong(candidate);
            if (version < 1) {
                throw new NumberFormatException("version must be positive");
            }
            return version;
        } catch (NumberFormatException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, PluginKvService.CODE_INVALID_REQUEST,
                    headerName + " must be a version number or * (API-9)");
        }
    }
}
