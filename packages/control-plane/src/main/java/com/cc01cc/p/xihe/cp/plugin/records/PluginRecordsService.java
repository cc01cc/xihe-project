package com.cc01cc.p.xihe.cp.plugin.records;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.plugin.Plugin;
import com.cc01cc.p.xihe.cp.plugin.PluginBinding;
import com.cc01cc.p.xihe.cp.plugin.PluginBindingRepository;
import com.cc01cc.p.xihe.cp.plugin.PluginBindingState;
import com.cc01cc.p.xihe.cp.plugin.PluginRepository;
import com.cc01cc.p.xihe.cp.plugin.kv.PluginKvClaims;
import com.cc01cc.p.xihe.cp.plugin.kv.PluginKvRateLimiter;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0691 T2.3: the records data plane's application service (spec/data-plane.md §2 QUOTA, §4 API,
 * §5 read surface) — {@code /internal/v1/plugin-bindings/{bindingId}/records/{collection}}.
 *
 * <p><b>Request order is the security design, not an implementation detail.</b> Every operation walks
 * the same five steps in this order:
 * <ol>
 *   <li><b>SEC-2 authorization</b> — token↔path binding match, binding exists, state is
 *       {@code enabled}, binding's plugin version exists and matches the token's digest.</li>
 *   <li><b>QUOTA-4/QUOTA-5</b> — per-binding rate and concurrency via the shared
 *       {@link PluginKvRateLimiter}: the budget is per binding, so KV and records share it rather than
 *       each getting a private allowance.</li>
 *   <li><b>Collection declared?</b> — the manifest projection is the only whitelist (§5 API-12: 未声明字段
 *       ⇒ 400). An undeclared collection answers 404 {@code PLUGIN_NOT_FOUND}: from the caller's side it
 *       does not exist, and saying "exists but not declared" would leak manifest content.</li>
 *   <li><b>Quota and size</b> — QUOTA-6 document count (429) and QUOTA-7 document bytes (413).</li>
 *   <li><b>The statement</b> — DP-2, one row per {@code (binding_id, collection, id)}.</li>
 * </ol>
 * Authorization and rate limiting precede every read of caller-provided state, so a rejected caller
 * cannot probe another binding's collections, quota or documents.
 *
 * <p><b>SEC-3 / OBS-1 audit.</b> Every operation writes one audit row — success and rejection alike —
 * with {@code action} from OBS-2 ({@code plugin.data.read|write|delete}), the binding as resource id and
 * a detail string carrying the collection, document id, outcome and the authorization source that
 * matched. The actor is left null: a binding token represents a plugin, not a user, and inventing a
 * user id here would put a lie in the audit trail.
 *
 * <p><b>Deliberately absent: CAS.</b> API-9 L90 keeps records on plain {@code id} upsert; {@code PUT}
 * has no {@code If-Match}/{@code 412} and {@code version} is a CP-owned counter (DP-7) that only ever
 * increases. A client cannot pin a version, and no code here pretends otherwise.
 *
 * <p><b>Statement timeout (QUOTA-13).</b> A PostgreSQL {@code 57014} surfaces as
 * {@link QueryTimeoutException} and becomes 429 {@code PLUGIN_RATE_LIMITED} without a
 * {@code Retry-After} header: QUOTA-13 names the status, not a wait time, and the retry hint belongs to
 * the QUOTA-4/5 path that {@code PluginKvProblemAdvice} already renders.
 */
@Service
public class PluginRecordsService {

    /** spec/data-plane.md API-11 error codes used by this surface. */
    public static final String CODE_NOT_FOUND = "PLUGIN_NOT_FOUND";
    public static final String CODE_GRANT_DENIED = "PLUGIN_GRANT_DENIED";
    public static final String CODE_BINDING_INACTIVE = "PLUGIN_BINDING_INACTIVE";
    public static final String CODE_VALUE_TOO_LARGE = "PLUGIN_VALUE_TOO_LARGE";
    public static final String CODE_RECORDS_QUOTA_EXCEEDED = "PLUGIN_RECORDS_QUOTA_EXCEEDED";
    public static final String CODE_RECORD_CONFLICT = "PLUGIN_RECORD_CONFLICT";
    public static final String CODE_INVALID_REQUEST = "INVALID_REQUEST";
    public static final String CODE_RATE_LIMITED = "PLUGIN_RATE_LIMITED";

    /** OBS-2's data-plane action vocabulary. */
    public static final String ACTION_READ = "plugin.data.read";
    public static final String ACTION_WRITE = "plugin.data.write";
    public static final String ACTION_DELETE = "plugin.data.delete";

    private static final String RESOURCE_TYPE = "plugin_record";

    private final PluginRecordsRepository repository;
    private final PluginRecordsLimits limits;
    private final PluginRecordsCursorCodec cursorCodec;
    private final PluginBindingRepository bindingRepository;
    private final PluginRepository pluginRepository;
    private final PluginKvRateLimiter rateLimiter;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;

    public PluginRecordsService(PluginRecordsRepository repository, PluginRecordsLimits limits,
            PluginRecordsCursorCodec cursorCodec, PluginBindingRepository bindingRepository,
            PluginRepository pluginRepository, PluginKvRateLimiter rateLimiter,
            AuditLogger auditLogger, ObjectMapper objectMapper) {
        this.repository = repository;
        this.limits = limits;
        this.cursorCodec = cursorCodec;
        this.bindingRepository = bindingRepository;
        this.pluginRepository = pluginRepository;
        this.rateLimiter = rateLimiter;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
    }

    /** One document as the wire sees it: the {@code doc} is a Jackson 3 node (PLAN-0633 C1). */
    public record Item(String id, JsonNode doc, long version, Instant updatedAt) {
    }

    /** One page plus the opaque cursor for the next one ({@code null} when this is the last page). */
    public record Page(List<Item> items, String nextCursor) {
    }

    /** API-6 {@code GET /records/{collection}/{id}}; API-7: absent ⇒ 404. */
    public Item read(PluginKvClaims claims, UUID bindingId, String collection, String id) {
        Audit trail = new Audit(ACTION_READ, bindingId, collection, id);
        try {
            Authorized authorized = authorize(claims, bindingId, trail);
            try (PluginKvRateLimiter.Permit permit = rateLimiter.acquire(bindingId)) {
                requireDeclared(authorized, collection);
                return repository.find(bindingId, collection, id)
                        .map(row -> toItem(row, trail))
                        .orElseThrow(() -> notFound(collection, id));
            }
        } catch (CpApiException e) {
            throw trail.rejected(e);
        } finally {
            trail.flush();
        }
    }

    /** API-6 {@code GET /records/{collection}} — filter/sort/limit/cursor per §5 API-12. */
    public Page list(PluginKvClaims claims, UUID bindingId, String collection, String filter,
            String sort, Integer limit, String cursor) {
        Audit trail = new Audit(ACTION_READ, bindingId, collection, null);
        try {
            Authorized authorized = authorize(claims, bindingId, trail);
            try (PluginKvRateLimiter.Permit permit = rateLimiter.acquire(bindingId)) {
                PluginRecordSchema.Collection declared = requireDeclared(authorized, collection);
                PluginQueryCompiler.Sort requestedSort =
                        PluginQueryCompiler.parseSort(declared, sort);
                PluginQueryCompiler.Anchor anchor = anchor(bindingId, collection, requestedSort,
                        cursor);
                PluginQueryCompiler.Plan plan =
                        PluginQueryCompiler.compile(declared, filter, sort, limit, anchor);
                List<PluginRecordsRepository.Row> rows = guardTimeout(
                        () -> repository.page(bindingId, collection, plan, plan.limit() + 1));
                boolean hasMore = rows.size() > plan.limit();
                List<PluginRecordsRepository.Row> pageRows =
                        hasMore ? rows.subList(0, plan.limit()) : rows;
                List<Item> items = new ArrayList<>(pageRows.size());
                for (PluginRecordsRepository.Row row : pageRows) {
                    items.add(toItem(row, trail));
                }
                String next = hasMore
                        ? nextPosition(bindingId, collection, plan, pageRows.getLast())
                        : null;
                return new Page(List.copyOf(items), next);
            }
        } catch (CpApiException e) {
            throw trail.rejected(e);
        } finally {
            trail.flush();
        }
    }

    /**
     * API-5 {@code POST}/{@code PUT}. A {@code null} {@code id} means {@code POST} (CP mints one); a
     * present id means {@code PUT}, which upserts and increments {@code version} (API-10).
     */
    public Item write(PluginKvClaims claims, UUID bindingId, String collection, String id,
            JsonNode doc) {
        Audit trail = new Audit(ACTION_WRITE, bindingId, collection, id);
        try {
            Authorized authorized = authorize(claims, bindingId, trail);
            try (PluginKvRateLimiter.Permit permit = rateLimiter.acquire(bindingId)) {
                PluginRecordSchema.Collection declared = requireDeclared(authorized, collection);
                if (doc == null || !doc.isObject()) {
                    throw invalidRequest("a record document must be a JSON object");
                }
                String docJson = serialise(doc);
                requireWithinDocBytes(declared, docJson);
                String targetId = id == null ? mintId() : id;
                trail.documentId(targetId);
                if (id == null) {
                    long stored = guardTimeout(
                            () -> repository.count(bindingId, collection));
                    if (stored >= limits.maxDocs()) {
                        throw recordsQuota();
                    }
                }
                PluginRecordsRepository.Row row = guardTimeout(() -> id == null
                        ? repository.insert(bindingId, collection, targetId, docJson)
                        : repository.upsert(bindingId, collection, targetId, docJson));
                return toItem(row, trail);
            }
        } catch (CpApiException e) {
            throw trail.rejected(e);
        } finally {
            trail.flush();
        }
    }

    /** API-7 {@code DELETE}: 404 when there was nothing to remove, 204 on success. */
    public void delete(PluginKvClaims claims, UUID bindingId, String collection, String id) {
        Audit trail = new Audit(ACTION_DELETE, bindingId, collection, id);
        try {
            Authorized authorized = authorize(claims, bindingId, trail);
            try (PluginKvRateLimiter.Permit permit = rateLimiter.acquire(bindingId)) {
                requireDeclared(authorized, collection);
                boolean removed = guardTimeout(() -> repository.delete(bindingId, collection, id));
                if (!removed) {
                    throw notFound(collection, id);
                }
                trail.succeeded();
            }
        } catch (CpApiException e) {
            throw trail.rejected(e);
        } finally {
            trail.flush();
        }
    }

    /** SEC-2, in the order {@code PluginKvService.authorize} established for the KV surface. */
    private Authorized authorize(PluginKvClaims claims, UUID bindingId, Audit trail) {
        if (claims == null) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "a binding-scoped token is required on the plugin records data plane (SEC-1)");
        }
        if (!bindingId.equals(claims.bindingId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, CODE_GRANT_DENIED,
                    "token is not scoped to this binding (SEC-2)");
        }
        trail.matchedSource("binding-token");
        PluginBinding binding = bindingRepository.findById(bindingId)
                .orElseThrow(() -> new CpApiException(HttpStatus.FORBIDDEN, CODE_BINDING_INACTIVE,
                        "plugin binding is not enabled (SEC-2)"));
        trail.workspaceId(binding.getWorkspaceId() == null ? null
                : binding.getWorkspaceId().toString());
        if (binding.state() != PluginBindingState.ENABLED) {
            throw new CpApiException(HttpStatus.FORBIDDEN, CODE_BINDING_INACTIVE,
                    "plugin binding is not enabled (SEC-2)");
        }
        if (!binding.getPluginId().equals(claims.pluginId())
                || !binding.getDigest().equals(claims.digest())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, CODE_GRANT_DENIED,
                    "token was issued for a different plugin version (SEC-2)");
        }
        Plugin plugin = pluginRepository.findVersion(binding.getPluginId(), binding.getDigest())
                .orElseThrow(() -> new CpApiException(HttpStatus.FORBIDDEN, CODE_BINDING_INACTIVE,
                        "plugin version is no longer installed (SEC-2)"));
        return new Authorized(binding, plugin, PluginRecordSchema.from(plugin.getManifest()));
    }

    /** The manifest projection is the whitelist for both the collection name and its fields. */
    private PluginRecordSchema.Collection requireDeclared(Authorized authorized, String collection) {
        return authorized.schema().find(collection).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, CODE_NOT_FOUND,
                "collection '" + collection + "' is not declared by the manifest (API-12)"));
    }

    /**
     * Decodes the cursor and decides its status in SEC-2-first order (Lead ruling 2026-11-08):
     * a cursor that belongs to another binding is 403 {@code PLUGIN_GRANT_DENIED} even if some other
     * aspect of it would be a 400, because the binding check is the security decision.
     */
    private PluginQueryCompiler.Anchor anchor(UUID bindingId, String collection,
            PluginQueryCompiler.Sort sort, String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return null;
        }
        PluginRecordsCursorCodec.Cursor decoded = cursorCodec.decode(cursor);
        if (!bindingId.equals(decoded.bindingId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, CODE_GRANT_DENIED,
                    "cursor was issued for another binding (SEC-2)");
        }
        if (decoded.version() != PluginRecordsCursorCodec.VERSION) {
            throw invalidFilter("cursor version " + decoded.version() + " is not supported");
        }
        if (!collection.equals(decoded.collection())) {
            throw invalidFilter("cursor was issued for another collection");
        }
        if (!sort.wire().equals(decoded.sort())) {
            throw invalidFilter("cursor was issued for sort '" + decoded.sort()
                    + "' but this request sorts by '" + sort.wire() + "'");
        }
        return new PluginQueryCompiler.Anchor(decoded.lastKey(), decoded.lastId());
    }

    private String nextPosition(UUID bindingId, String collection, PluginQueryCompiler.Plan plan,
            PluginRecordsRepository.Row last) {
        String key = "id".equals(plan.sort().field()) ? null : last.sortKey();
        return cursorCodec.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION, collection, bindingId, plan.sort().wire(), key,
                last.id()));
    }

    private Item toItem(PluginRecordsRepository.Row row, Audit trail) {
        JsonNode doc;
        try {
            doc = objectMapper.readTree(row.docJson());
        } catch (JacksonException e) {
            // jsonb is validated on write, so unreadable text means the database or the casting layer
            // broke; it is never the caller's fault.
            throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                    "stored record is not valid JSON", e);
        }
        trail.succeeded();
        return new Item(row.id(), doc, row.version(), row.updatedAt());
    }

    private String serialise(JsonNode doc) {
        try {
            return objectMapper.writeValueAsString(doc);
        } catch (JacksonException e) {
            throw invalidRequest("record document could not be serialised");
        }
    }

    /**
     * QUOTA-7: the deployment ceiling ({@code cp.plugin.records.doc-bytes-max}) and the manifest's own
     * {@code docBytesMax} both apply, and the smaller one wins — a manifest may narrow the deployment
     * limit but never widen it (§2.1 L59: 不得高于上限).
     */
    private void requireWithinDocBytes(PluginRecordSchema.Collection declared, String docJson) {
        int ceiling = declared.docBytesMax() == null ? limits.docBytesMax()
                : Math.min(limits.docBytesMax(), declared.docBytesMax());
        int bytes = docJson.getBytes(StandardCharsets.UTF_8).length;
        if (bytes > ceiling) {
            throw new CpApiException(HttpStatus.CONTENT_TOO_LARGE, CODE_VALUE_TOO_LARGE,
                    "document is " + bytes + " bytes; collection '" + declared.name()
                            + "' allows " + ceiling + " (QUOTA-7)");
        }
    }

    /**
     * QUOTA-13 / API-5: database-level refusals that are part of the data plane's contract.
     *
     * <p>A cancelled statement (QUOTA-13, DP-7's {@code statement_timeout}) is a resource refusal, not a
     * server error. A unique violation is the only way a manifest-declared unique index can answer, and
     * API-11 names it: 409 {@code PLUGIN_RECORD_CONFLICT}. Mapping it here rather than relying on the
     * shared handler keeps the code the spec named — the generic handler answers 409 with a code of its
     * own (or none), which would satisfy the status but not the contract.
     */
    private <T> T guardTimeout(java.util.function.Supplier<T> body) {
        try {
            return body.get();
        } catch (QueryTimeoutException e) {
            throw new CpApiException(HttpStatus.TOO_MANY_REQUESTS, CODE_RATE_LIMITED,
                    "the statement exceeded the plugin statement timeout (QUOTA-13)", e);
        } catch (DuplicateKeyException e) {
            throw new CpApiException(HttpStatus.CONFLICT, CODE_RECORD_CONFLICT,
                    "the document collides with a declared unique index (API-5)", e);
        }
    }

    /**
     * API-5 {@code POST} mints the id.
     *
     * <p>TODO(§11 L168): the id format (ULID vs UUIDv7) is explicitly undecided in the spec. This uses
     * the platform's existing generator and asserts only "non-empty and unique"; switching formats is a
     * one-line change here once §11 is decided.
     */
    private String mintId() {
        return UUID.randomUUID().toString();
    }

    private static CpApiException notFound(String collection, String id) {
        return new CpApiException(HttpStatus.NOT_FOUND, CODE_NOT_FOUND,
                "record '" + id + "' does not exist in collection '" + collection + "' (API-7)");
    }

    private static CpApiException invalidRequest(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, CODE_INVALID_REQUEST, detail);
    }

    private static CpApiException invalidFilter(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, PluginQueryCompiler.CODE_INVALID_FILTER,
                detail);
    }

    private CpApiException recordsQuota() {
        return new CpApiException(HttpStatus.TOO_MANY_REQUESTS, CODE_RECORDS_QUOTA_EXCEEDED,
                "binding already holds " + limits.maxDocs() + " records (QUOTA-6)");
    }

    /** The resolved binding + plugin + manifest projection, carried through one request. */
    private record Authorized(PluginBinding binding, Plugin plugin, PluginRecordSchema schema) {
    }

    /**
     * Mutable per-request audit state. One instance per call, filled as the request progresses and
     * written in a {@code finally} so a rejection is recorded as faithfully as a success (SEC-3).
     */
    private final class Audit {

        private final String action;
        private final UUID bindingId;
        private final String collection;
        private String documentId;
        private String matchedSource = "none";
        private String result = "ok";
        private String workspaceId;

        Audit(String action, UUID bindingId, String collection, String documentId) {
            this.action = action;
            this.bindingId = bindingId;
            this.collection = collection;
            this.documentId = documentId;
        }

        void matchedSource(String source) {
            this.matchedSource = source;
        }

        void workspaceId(String id) {
            this.workspaceId = id;
        }

        void documentId(String id) {
            this.documentId = id;
        }

        void succeeded() {
            this.result = "ok";
        }

        /** Records the refusal and returns the same exception, so call sites stay one-liners. */
        CpApiException rejected(CpApiException e) {
            this.result = "denied:" + e.getCode();
            return e;
        }

        void flush() {
            auditLogger.recordDurableChange(null, workspaceId, action, RESOURCE_TYPE,
                    bindingId.toString(), detail());
        }

        private String detail() {
            return "op=" + action + "; result=" + result + "; matchedSource=" + matchedSource
                    + "; collection=" + collection
                    + "; id=" + (documentId == null ? "-" : documentId);
        }
    }
}
