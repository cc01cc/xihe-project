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
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.http.HttpStatus;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0691 T2.3: the decision order inside {@link PluginRecordsService}.
 *
 * <p>The integration test proves the happy path on PostgreSQL; this test proves the <b>order</b>, which
 * a database cannot observe. SEC-2 has to run before the data plane is touched (so a 403 does not leak
 * whether a collection or a document exists), QUOTA-6/QUOTA-7 have to run before the write (so an
 * over-quota write never becomes a row), and every refusal has to leave an audit trail (SEC-3).
 *
 * <p>Cases are labelled S1–S14 to keep them distinct from the compiler's A/B/C/D groups and the API's
 * E group; each javadoc line cites the clause it holds the implementation to.
 */
class PluginRecordsServiceTest {

    private static final UUID BINDING = UUID.fromString("11111111-2222-3333-4444-555555555555");
    private static final UUID OTHER_BINDING = UUID.fromString("66666666-7777-8888-9999-aaaaaaaaaaaa");
    private static final UUID WORKSPACE = UUID.fromString("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    private static final String PLUGIN_ID = "notes-plugin";
    private static final String DIGEST = "sha256:abc";
    private static final String COLLECTION = "notes";
    private static final String DOC_JSON = "{\"status\":\"live\",\"n\":9}";

    private static final ObjectMapper MAPPER2 = new ObjectMapper();
    private static final tools.jackson.databind.ObjectMapper MAPPER3 =
            new tools.jackson.databind.ObjectMapper();

    /**
     * A manifest that declares one collection with a narrowed {@code docBytesMax} (QUOTA-7 says a
     * manifest may only narrow the deployment ceiling).
     */
    private static final com.fasterxml.jackson.databind.JsonNode MANIFEST = manifest(64);

    private PluginRecordsRepository repository;
    private PluginRecordsLimits limits;
    private PluginRecordsCursorCodec cursorCodec;
    private PluginBindingRepository bindingRepository;
    private PluginRepository pluginRepository;
    private PluginKvRateLimiter rateLimiter;
    private AuditLogger auditLogger;
    private PluginRecordsService service;

    @BeforeEach
    void setUp() {
        repository = mock(PluginRecordsRepository.class);
        limits = mock(PluginRecordsLimits.class);
        cursorCodec = new PluginRecordsCursorCodec("unit-test-secret", MAPPER3);
        bindingRepository = mock(PluginBindingRepository.class);
        pluginRepository = mock(PluginRepository.class);
        rateLimiter = mock(PluginKvRateLimiter.class);
        auditLogger = mock(AuditLogger.class);
        service = new PluginRecordsService(repository, limits, cursorCodec, bindingRepository,
                pluginRepository, rateLimiter, auditLogger, MAPPER3);
        when(limits.maxDocs()).thenReturn(50_000);
        when(limits.docBytesMax()).thenReturn(262_144);
        when(limits.maxDocs()).thenReturn(50_000);
    }

    /** S1 (SEC-1): no binding token ⇒ 401, and the refusal is audited like any other request. */
    @Test
    void missingClaimsIsUnauthorizedAndAudited() {
        assertProblem(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                () -> service.read(null, BINDING, COLLECTION, "id-1"));
        assertAudited("plugin.data.read", "denied:AUTHORIZATION_REQUIRED");
        verify(repository, never()).find(any(), any(), any());
    }

    /** S2 (SEC-2): a token for another binding is 403 and the data plane is never read. */
    @Test
    void foreignTokenIsForbiddenBeforeAnyLookup() {
        PluginKvClaims claims = claims(OTHER_BINDING);
        assertProblem(HttpStatus.FORBIDDEN, "PLUGIN_GRANT_DENIED",
                () -> service.read(claims, BINDING, COLLECTION, "id-1"));
        verify(repository, never()).find(any(), any(), any());
        verify(bindingRepository, never()).findById(any());
        assertAudited("plugin.data.read", "denied:PLUGIN_GRANT_DENIED");
    }

    /** S3 (SEC-2 状态词表): a binding that is not {@code enabled} is 403, not 404. */
    @Test
    void inactiveBindingIsForbidden() {
        PluginBinding suspended = mockBinding(PluginBindingState.SUSPENDED);
        when(bindingRepository.findById(BINDING)).thenReturn(Optional.of(suspended));
        assertProblem(HttpStatus.FORBIDDEN, "PLUGIN_BINDING_INACTIVE",
                () -> service.read(claims(BINDING), BINDING, COLLECTION, "id-1"));
    }

    /** S4 (SEC-2): a token minted for a superseded plugin version is 403. */
    @Test
    void staleDigestIsForbidden() {
        PluginBinding enabled = mockBinding(PluginBindingState.ENABLED);
        when(bindingRepository.findById(BINDING)).thenReturn(Optional.of(enabled));
        when(pluginRepository.findVersion(PLUGIN_ID, DIGEST)).thenReturn(Optional.empty());
        assertProblem(HttpStatus.FORBIDDEN, "PLUGIN_BINDING_INACTIVE",
                () -> service.read(claims(BINDING), BINDING, COLLECTION, "id-1"));
    }

    /** S5 (§5 API-12 whitelist): an undeclared collection does not exist from the caller's side. */
    @Test
    void undeclaredCollectionIsNotFound() {
        authorize();
        assertProblem(HttpStatus.NOT_FOUND, "PLUGIN_NOT_FOUND",
                () -> service.read(claims(BINDING), BINDING, "secrets", "id-1"));
    }

    /** S6 (API-5: one document): the payload must be a JSON object. */
    @Test
    void nonObjectDocumentIsRejected() {
        authorize();
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.write(claims(BINDING), BINDING, COLLECTION, "id-1",
                        MAPPER3.readTree("[]")));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                () -> service.write(claims(BINDING), BINDING, COLLECTION, "id-1", null));
        verify(repository, never()).upsert(any(), any(), any(), any());
    }

    /** S7 (QUOTA-7): the manifest's own {@code docBytesMax} narrows the deployment ceiling. */
    @Test
    void documentOverCollectionCeilingIsTooLarge() {
        authorize();
        JsonNode big = MAPPER3.readTree("{\"pad\":\"" + "x".repeat(80) + "\"}");
        CpApiException e = assertProblem(HttpStatus.CONTENT_TOO_LARGE, "PLUGIN_VALUE_TOO_LARGE",
                () -> service.write(claims(BINDING), BINDING, COLLECTION, "id-1", big));
        assertTrue(e.getMessage().contains("64"), e.getMessage());
        verify(repository, never()).upsert(any(), any(), any(), any());
    }

    /** S8 (QUOTA-6 每 collection): at the ceiling a POST is refused and nothing is inserted. */
    @Test
    void recordsQuotaIsRefusedBeforeInsert() {
        authorize();
        when(limits.maxDocs()).thenReturn(2);
        when(repository.count(BINDING, COLLECTION)).thenReturn(2L);
        assertProblem(HttpStatus.TOO_MANY_REQUESTS, "PLUGIN_RECORDS_QUOTA_EXCEEDED",
                () -> service.write(claims(BINDING), BINDING, COLLECTION, null,
                        MAPPER3.readTree(DOC_JSON)));
        verify(repository, never()).insert(any(), any(), any(), any());
        // A PUT is not subject to the count ceiling: the document already exists.
        when(repository.upsert(eq(BINDING), eq(COLLECTION), eq("id-1"), anyString()))
                .thenReturn(row("id-1"));
        assertEquals("id-1", service.write(claims(BINDING), BINDING, COLLECTION, "id-1",
                MAPPER3.readTree(DOC_JSON)).id());
    }

    /** S9 (QUOTA-13): a cancelled statement is 429 {@code PLUGIN_RATE_LIMITED}, not a 500. */
    @Test
    void statementTimeoutBecomesRateLimited() {
        authorize();
        when(repository.upsert(any(), any(), any(), any()))
                .thenThrow(new QueryTimeoutException("canceling statement due to statement timeout"));
        assertProblem(HttpStatus.TOO_MANY_REQUESTS, "PLUGIN_RATE_LIMITED",
                () -> service.write(claims(BINDING), BINDING, COLLECTION, "id-1",
                        MAPPER3.readTree(DOC_JSON)));
        assertAudited("plugin.data.write", "denied:PLUGIN_RATE_LIMITED");
    }

    /**
     * S9b (API-5 + API-11): a manifest-declared unique index conflict is 409
     * {@code PLUGIN_RECORD_CONFLICT} — the code API-11 names, not whatever the shared handler would
     * have chosen.
     */
    @Test
    void uniqueConflictIsRecordConflict() {
        authorize();
        when(repository.upsert(any(), any(), any(), any()))
                .thenThrow(new org.springframework.dao.DuplicateKeyException("23505"));
        assertProblem(HttpStatus.CONFLICT, "PLUGIN_RECORD_CONFLICT",
                () -> service.write(claims(BINDING), BINDING, COLLECTION, "id-1",
                        MAPPER3.readTree(DOC_JSON)));
    }

    /**
     * The write half of the date lane (task-203, direction B): a {@code date} is stored as a normalized
     * fixed-width UTC instant because that is the only text form whose lexicographic order is its
     * chronological order — which is what lets the index stay a plain text expression (a
     * {@code timestamptz} cast is impossible: {@code timestamptz_in} is {@code STABLE} and PostgreSQL
     * refuses it in an index expression).
     */
    @Test
    void aDateFieldIsStoredOnlyAsTheCanonicalFixedWidthUtcInstant() {
        authorize();
        assertEquals("id-1", service.write(claims(BINDING), BINDING, COLLECTION, "id-1",
                MAPPER3.readTree("{\"when\":\"2026-11-08T13:40:00Z\"}")).id(),
                "the canonical instant must be accepted unchanged");
        // A declared field is optional: absent and explicitly-null are not values to judge.
        assertEquals("id-1", service.write(claims(BINDING), BINDING, COLLECTION, "id-1",
                MAPPER3.readTree("{\"status\":\"live\"}")).id(),
                "a document without the date field is legal");
        assertEquals("id-1", service.write(claims(BINDING), BINDING, COLLECTION, "id-1",
                MAPPER3.readTree("{\"when\":null}")).id(), "an explicit null is not a malformed date");
    }

    /**
     * Every non-canonical shape (2026-11-08 ruling): an offset with or without a colon, a fraction,
     * a space separator, a bare date, a lowercase {@code z}, and a naive local time. All refused with
     * 400 {@code INVALID_REQUEST} and <b>never normalized</b> — the row is not written, so the stored
     * bytes are always the caller's own canonical string.
     */
    @Test
    void everyNonCanonicalDateFormIsRefusedWithoutRewriting() {
        authorize();
        List<String> refused = List.of(
                "2026-11-08T13:40:00+08:00",
                "2026-11-08T13:40:00+0800",
                "2026-11-08T13:40:00.123Z",
                "2026-11-08T13:40:00.123456Z",
                "2026-11-08 13:40:00Z",
                "2026-11-08",
                "2026-11-08T13:40:00z",
                "2026-11-08T13:40:00");
        for (String value : refused) {
            CpApiException refusal = assertProblem(HttpStatus.BAD_REQUEST,
                    PluginRecordsService.CODE_INVALID_REQUEST,
                    () -> service.write(claims(BINDING), BINDING, COLLECTION, "id-1",
                            MAPPER3.readTree("{\"when\":\"" + value + "\"}")));
            assertTrue(refusal.getMessage().contains("'when'"),
                    "the refusal must name the field: " + refusal.getMessage());
        }
        verify(repository, never()).upsert(any(), any(), any(), any());
        assertProblem(HttpStatus.BAD_REQUEST, PluginRecordsService.CODE_INVALID_REQUEST,
                () -> service.write(claims(BINDING), BINDING, COLLECTION, "id-1",
                        MAPPER3.readTree("{\"when\":1720000000}")));
        // Every refusal is audited (SEC-3), one row per rejected write: 8 malformed strings + 1 number.
        verify(auditLogger, times(9)).recordDurableChange(any(), any(), eq("plugin.data.write"),
                eq("plugin_record"), eq(BINDING.toString()), contains("denied:INVALID_REQUEST"));
    }

    /** S10 (Lead ruling 2026-11-08, 403-before-400): a cursor from another binding is refused as a
     * <b>security</b> decision even when its version is also unknown.
     */
    @Test
    void foreignCursorIsForbiddenBeforeValidation() {
        authorize();
        String foreign = cursorCodec.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION + 1, COLLECTION, OTHER_BINDING, "id:asc", null,
                "id-1"));
        assertProblem(HttpStatus.FORBIDDEN, "PLUGIN_GRANT_DENIED",
                () -> service.list(claims(BINDING), BINDING, COLLECTION, null, null, null, foreign));
        verify(repository, never()).page(any(), any(), any(), anyInt());
    }

    /** S11 (§5 L104): a cursor is only valid for the collection and sort that produced it. */
    @Test
    void cursorForAnotherSortIsInvalidFilter() {
        authorize();
        String byName = cursorCodec.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION, COLLECTION, BINDING, "n:asc", "1", "id-1"));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_FILTER",
                () -> service.list(claims(BINDING), BINDING, COLLECTION, null, null, null, byName));
        String otherCollection = cursorCodec.encode(new PluginRecordsCursorCodec.Cursor(
                PluginRecordsCursorCodec.VERSION, "other", BINDING, "id:asc", null, "id-1"));
        assertProblem(HttpStatus.BAD_REQUEST, "INVALID_FILTER",
                () -> service.list(claims(BINDING), BINDING, COLLECTION, null, null, null,
                        otherCollection));
    }

    /** S12 (API-7): deleting a document that is not there is 404 and audited as a refusal. */
    @Test
    void missingDocumentDeleteIsNotFound() {
        authorize();
        when(repository.delete(BINDING, COLLECTION, "id-9")).thenReturn(false);
        assertProblem(HttpStatus.NOT_FOUND, "PLUGIN_NOT_FOUND",
                () -> service.delete(claims(BINDING), BINDING, COLLECTION, "id-9"));
        assertAudited("plugin.data.delete", "denied:PLUGIN_NOT_FOUND");
    }

    /**
     * S13 (SEC-3 / OBS-1 / OBS-2): a successful write is audited with the OBS-2 action, the binding as
     * resource id and the collection + document id in the detail; no actor is invented.
     */
    @Test
    void successfulWriteIsAudited() {
        authorize();
        when(repository.upsert(eq(BINDING), eq(COLLECTION), eq("id-1"), anyString()))
                .thenReturn(row("id-1"));
        service.write(claims(BINDING), BINDING, COLLECTION, "id-1", MAPPER3.readTree(DOC_JSON));
        verify(auditLogger).recordDurableChange(isNull(), eq(WORKSPACE.toString()),
                eq("plugin.data.write"), eq("plugin_record"), eq(BINDING.toString()),
                contains("result=ok"));
        verify(auditLogger).recordDurableChange(any(), any(), any(), any(), any(),
                contains("id=id-1"));
    }

    /** S14 (API-10): {@code POST} mints the id — two writes get two different, non-empty ids. */
    @Test
    void postMintsDistinctIds() {
        authorize();
        when(repository.insert(eq(BINDING), eq(COLLECTION), anyString(), anyString()))
                .thenAnswer(call -> row(call.getArgument(2)));
        PluginRecordsService.Item first = service.write(claims(BINDING), BINDING, COLLECTION, null,
                MAPPER3.readTree(DOC_JSON));
        PluginRecordsService.Item second = service.write(claims(BINDING), BINDING, COLLECTION, null,
                MAPPER3.readTree(DOC_JSON));
        assertTrue(first.id() != null && !first.id().isEmpty());
        assertNotEquals(first.id(), second.id());
        verify(repository, times(2)).insert(eq(BINDING), eq(COLLECTION), anyString(), anyString());
        verify(repository, never()).upsert(any(), any(), any(), any());
    }

    // ---------------------------------------------------------------- helpers

    private void authorize() {
        PluginBinding enabled = mockBinding(PluginBindingState.ENABLED);
        when(bindingRepository.findById(BINDING)).thenReturn(Optional.of(enabled));
        Plugin installed = mockPlugin();
        when(pluginRepository.findVersion(PLUGIN_ID, DIGEST)).thenReturn(Optional.of(installed));
        when(repository.upsert(any(), any(), any(), any())).thenReturn(row("id-1"));
        when(repository.insert(any(), any(), any(), any())).thenReturn(row("id-1"));
        when(repository.find(any(), any(), any())).thenReturn(Optional.empty());
        when(repository.page(any(), any(), any(), anyInt())).thenReturn(List.of());
    }

    private void assertAudited(String action, String resultFragment) {
        verify(auditLogger).recordDurableChange(any(), any(), eq(action), eq("plugin_record"),
                eq(BINDING.toString()), contains(resultFragment));
    }

    private static CpApiException assertProblem(HttpStatus status, String code,
            Executable call) {
        CpApiException e = assertThrows(CpApiException.class, call);
        assertEquals(status, e.getStatus(), e.getCode() + ": " + e.getMessage());
        assertEquals(code, e.getCode());
        return e;
    }

    private static PluginKvClaims claims(UUID binding) {
        return new PluginKvClaims(binding, PLUGIN_ID, DIGEST, "records:rw",
                Instant.now().plusSeconds(300));
    }

    private static PluginBinding mockBinding(PluginBindingState state) {
        PluginBinding binding = mock(PluginBinding.class);
        when(binding.getId()).thenReturn(BINDING);
        when(binding.getPluginId()).thenReturn(PLUGIN_ID);
        when(binding.getDigest()).thenReturn(DIGEST);
        when(binding.getWorkspaceId()).thenReturn(WORKSPACE);
        when(binding.state()).thenReturn(state);
        return binding;
    }

    private static Plugin mockPlugin() {
        Plugin plugin = mock(Plugin.class);
        when(plugin.getId()).thenReturn(PLUGIN_ID);
        when(plugin.getDigest()).thenReturn(DIGEST);
        when(plugin.getManifest()).thenReturn(MANIFEST);
        return plugin;
    }

    private static PluginRecordsRepository.Row row(String id) {
        return new PluginRecordsRepository.Row(id, DOC_JSON, 1L, Instant.parse("2026-11-08T00:00:00Z"),
                "live");
    }

    /** Builds {@code {"storage":{"collections":[{name, docBytesMax, fields, indexes}]}}}. */
    private static com.fasterxml.jackson.databind.JsonNode manifest(int docBytesMax) {
        try {
            return MAPPER2.readTree("""
                    {"storage":{"collections":[{
                      "name":"notes",
                      "docBytesMax":%d,
                      "fields":[{"name":"status","type":"string"},{"name":"n","type":"number"},
                                {"name":"when","type":"date"}],
                      "indexes":[{"name":"uniq_status","fields":["status"],"unique":true}]
                    }]}}""".formatted(docBytesMax));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
