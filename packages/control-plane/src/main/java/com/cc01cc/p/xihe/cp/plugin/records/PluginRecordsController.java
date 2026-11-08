package com.cc01cc.p.xihe.cp.plugin.records;

import com.cc01cc.p.xihe.cp.plugin.kv.PluginKvClaims;
import com.cc01cc.p.xihe.cp.plugin.kv.PluginKvTokenFilter;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * PLAN-0691 T2.3: the four records data-plane routes of {@code spec/data-plane.md} API-5..API-7, all
 * under {@code /internal/v1/plugin-bindings/{bindingId}/records}.
 *
 * <p>D-66: the whole class sits behind {@code cp.plugin.enabled}; with the flag off no handler is mapped
 * and these paths answer 404, exactly like {@link com.cc01cc.p.xihe.cp.plugin.kv.PluginKvController}.
 *
 * <p>Thin by construction (CP architecture gate): no repository, no SQL, no policy. Every decision lives
 * in {@link PluginRecordsService}; the verified claims arrive as a request attribute set by
 * {@link PluginKvTokenFilter} and are handed over as-is, so a missing attribute becomes the service's
 * SEC-2 401 rather than a Spring 500.
 *
 * <p><b>Wire choices the spec leaves open</b> (API-5/6/7 fix methods and query parameters, not bodies):
 * <ul>
 *   <li>The write body is <b>{@code {"doc": {...}}}</b>. API-2 uses the same wrapper style for KV, and a
 *       named field leaves room for the next documented field without reinterpreting the payload; the
 *       {@code doc} object itself is the stored document verbatim.</li>
 *   <li>{@code POST} answers {@code 201} with the stored item ({@code id}, {@code doc}, {@code version},
 *       {@code updatedAt}) because API-10 says the CP mints the id — the caller cannot learn it any other
 *       way. {@code PUT} answers {@code 200} with the same shape: it is an upsert (API-9 L90), so there is
 *       no create/update split worth signalling, and {@code version} is the only meaningful difference.</li>
 *   <li>{@code DELETE} answers {@code 204} with no body; its only other answer is 404.</li>
 *   <li>The list body is {@code {items: [...], nextCursor: string|null}} — API-12 fixes the parameters and
 *       the ceiling but not the envelope.</li>
 *   <li>The §5 grammar the spec names without writing a syntax for (implementation-defined, documented
 *       here and in {@link PluginQueryCompiler}): {@code filter=op(field,literal)} joined by {@code and};
 *       {@code sort=<field>:<asc|desc>} (the space spelling {@code <field> desc} is also accepted);
 *       {@code limit} 1..200; {@code cursor} the opaque {@code nextCursor} of the previous page. Every
 *       violation is 400 {@code INVALID_FILTER}.</li>
 * </ul>
 *
 * <p><b>No preconditions.</b> There is deliberately no {@code If-Match} handling anywhere on this
 * surface: API-9 L90 keeps records on plain id upsert and explicitly scopes the CAS tightening to KV, so
 * a records request can never answer {@code 412} (Lead ruling 2026-11-08).
 */
@RestController
@RequestMapping("/internal/v1/plugin-bindings/{bindingId}/records")
@ConditionalOnProperty(name = "cp.plugin.enabled", havingValue = "true")
public class PluginRecordsController {

    private static final String CLAIMS = PluginKvTokenFilter.CLAIMS_ATTRIBUTE;

    private final PluginRecordsService service;

    public PluginRecordsController(PluginRecordsService service) {
        this.service = service;
    }

    /** API-6 point read: a missing document is 404 {@code PLUGIN_NOT_FOUND}. */
    @GetMapping("/{collection}/{id}")
    public PluginRecordsService.Item read(
            @RequestAttribute(name = CLAIMS, required = false) PluginKvClaims claims,
            @PathVariable UUID bindingId,
            @PathVariable String collection,
            @PathVariable String id) {
        return service.read(claims, bindingId, collection, id);
    }

    /** API-6 list with the §5 filter/sort/limit/cursor grammar. */
    @GetMapping("/{collection}")
    public PluginRecordsService.Page list(
            @RequestAttribute(name = CLAIMS, required = false) PluginKvClaims claims,
            @PathVariable UUID bindingId,
            @PathVariable String collection,
            @RequestParam(required = false) String filter,
            @RequestParam(required = false) String sort,
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) String cursor) {
        return service.list(claims, bindingId, collection, filter, sort, limit, cursor);
    }

    /** API-5 {@code POST}: upsert with a CP-generated id (API-10), so 201 and never idempotent. */
    @PostMapping("/{collection}")
    public ResponseEntity<PluginRecordsService.Item> create(
            @RequestAttribute(name = CLAIMS, required = false) PluginKvClaims claims,
            @PathVariable UUID bindingId,
            @PathVariable String collection,
            @RequestBody PluginRecordsWriteRequest body) {
        PluginRecordsService.Item item =
                service.write(claims, bindingId, collection, null, body.doc());
        return ResponseEntity.status(HttpStatus.CREATED).body(item);
    }

    /** API-5 {@code PUT}: upsert at a caller-chosen id, idempotent per API-10. */
    @PutMapping("/{collection}/{id}")
    public PluginRecordsService.Item write(
            @RequestAttribute(name = CLAIMS, required = false) PluginKvClaims claims,
            @PathVariable UUID bindingId,
            @PathVariable String collection,
            @PathVariable String id,
            @RequestBody PluginRecordsWriteRequest body) {
        return service.write(claims, bindingId, collection, id, body.doc());
    }

    /** API-7: delete one document; 204 on success, 404 when it did not exist. */
    @DeleteMapping("/{collection}/{id}")
    public ResponseEntity<Void> delete(
            @RequestAttribute(name = CLAIMS, required = false) PluginKvClaims claims,
            @PathVariable UUID bindingId,
            @PathVariable String collection,
            @PathVariable String id) {
        service.delete(claims, bindingId, collection, id);
        return ResponseEntity.noContent().build();
    }
}
