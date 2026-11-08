package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T2.2: the runtime index executor against real PostgreSQL 17 — DDL, ledger, audit, rollback
 * and cleanup, on the real migration output (no H2: expression + partial indexes are the whole point).
 *
 * <p>Transaction shape is the thing under test as much as the DDL. The executor demands
 * {@code MANDATORY}, so every call here is made inside an explicit {@link TransactionTemplate} — the
 * same "install transaction" the service supplies — and the tests then assert <b>from outside that
 * transaction</b> what survived it.</p>
 *
 * <p>What each assertion excludes:</p>
 * <ul>
 *   <li>apply → the physical index exists <i>and</i> {@code pg_get_indexdef} shows it is a partial
 *       expression index over {@code doc->>'field'}; a plain index would pass a name-only check.</li>
 *   <li>ledger → {@code state='applied'} plus {@code applied_at}, read back through JDBC, so "the
 *       executor says it wrote it" is not the evidence.</li>
 *   <li>the failure case → the install transaction is rolled back (a marker row inserted in the same
 *       transaction is gone, and no index exists), the {@code failed} ledger row <i>and</i> its audit
 *       row survive, and the recorded error is not a lock timeout or deadlock — which is exactly the
 *       self-lock the ledger transaction exists to avoid.</li>
 *   <li>a declaration refused before any DDL → 422, no index, <i>no</i> ledger row, one
 *       {@code result=rejected} audit row: a refusal has no physical identity to ledger.</li>
 *   <li>cleanup → dropping twice is a no-op, the ledger rows stay (LC-6), and a second binding's index
 *       and ledger rows are untouched.</li>
 * </ul>
 */
class PluginRecordsIndexExecutorTest extends AbstractReusableIntegrationTest {

    private static final String COLLECTION = "contacts";

    @Autowired
    private PluginIndexDdlExecutor executor;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Test
    void applyCreatesAPartialExpressionIndexAndMarksTheLedgerApplied() {
        UUID bindingId = UUID.randomUUID();
        List<PluginIndexDeclaration> declarations = List.of(
                new PluginIndexDeclaration(COLLECTION, "by_email", List.of(field("email")), true));

        List<String> created = inTransaction(
                () -> executor.applyForBinding(bindingId, declarations, null, null));

        assertEquals(1, created.size());
        assertEquals(PluginIndexNaming.physicalName(bindingId, COLLECTION, "by_email"),
                created.get(0), "the returned name must be the one that was created");

        String definition = indexDefinition(created.get(0));
        assertNotNull(definition, "the index must exist in pg_indexes");
        assertTrue(definition.toUpperCase(Locale.ROOT).startsWith("CREATE UNIQUE INDEX"),
                "a declared unique index must be unique: " + definition);
        assertTrue(compact(definition).contains("doc->>'email'"),
                "DP-2: the indexed expression is ((doc->>'field')): " + definition);
        assertTrue(definition.contains("WHERE"),
                "DP-2: the index is partial so two workspaces cannot collide: " + definition);
        assertTrue(definition.contains(bindingId.toString()),
                "the predicate must be scoped to this binding: " + definition);
        assertTrue(definition.contains(COLLECTION),
                "the predicate must be scoped to this collection: " + definition);

        Map<String, Object> row = ledgerRow(bindingId, COLLECTION, "by_email");
        assertEquals("applied", row.get("state"));
        assertNotNull(row.get("applied_at"), "an applied row must carry its timestamp");
        assertNull(row.get("error"), "an applied row must not carry a stale error");
        assertEquals(Boolean.TRUE, row.get("unique_flag"));
        assertEquals(1, auditRows(bindingId, "result=applied"),
                "LC-1: the install face records the index DDL in the durable audit stream");
    }

    /**
     * The recovery property the naming formula exists for: a ledger row alone is enough to recompute
     * the physical name, so a crashed install can be swept with {@code DROP INDEX IF EXISTS}.
     */
    @Test
    void thePhysicalNameIsRecomputableFromTheLedgerRowAlone() {
        UUID bindingId = UUID.randomUUID();
        inTransaction(() -> executor.applyForBinding(bindingId,
                List.of(new PluginIndexDeclaration(COLLECTION, "by_phone", List.of(field("phone")),
                        false)),
                null, null));

        Map<String, Object> row = ledgerRow(bindingId, COLLECTION, "by_phone");
        String recomputed = PluginIndexNaming.physicalName(bindingId,
                String.valueOf(row.get("collection")), String.valueOf(row.get("index_name")));
        assertEquals(1, jdbc.queryForObject(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = ?",
                Integer.class, recomputed),
                "the name recomputed from the ledger row must be the index that actually exists");
    }

    /**
     * An upgrade changes the declaration's fields but not its identity. {@code CREATE INDEX IF NOT
     * EXISTS} would silently keep the old definition, so the executor must rebuild under the same name
     * — this is the discriminating assertion for that decision.
     */
    @Test
    void aChangedDefinitionRebuildsTheSameNamedIndexInsteadOfKeepingTheStaleOne() {
        UUID bindingId = UUID.randomUUID();
        String name = inTransaction(() -> executor.applyForBinding(bindingId,
                List.of(new PluginIndexDeclaration(COLLECTION, "by_contact",
                        List.of(field("email")), false)), null, null)).get(0);
        assertTrue(compact(indexDefinition(name)).contains("doc->>'email'"));

        inTransaction(() -> executor.applyForBinding(bindingId,
                List.of(new PluginIndexDeclaration(COLLECTION, "by_contact",
                        List.of(field("phone")), false)), null, null));

        String rebuilt = compact(indexDefinition(name));
        assertTrue(rebuilt.contains("doc->>'phone'"),
                "the new definition must be in force: " + rebuilt);
        assertFalse(rebuilt.contains("doc->>'email'"),
                "the stale definition must be gone, not merely shadowed: " + rebuilt);
        assertEquals(1, indexCount(bindingId),
                "the rebuild must not leave two indexes for one declaration");
        assertEquals(List.of("phone"), jdbc.query("SELECT fields FROM plugin_index_declarations"
                        + " WHERE binding_id = ? AND collection = ? AND index_name = ?",
                (rs, rowNumber) -> List.of((String[]) rs.getArray(1).getArray()),
                bindingId, COLLECTION, "by_contact").get(0),
                "the ledger must describe the definition that is now in force");
    }

    /**
     * DP-3 keeps field <b>types</b> in the manifest only (the ledger stores names), so an upgrade that
     * keeps a declaration's name, fields and uniqueness but changes one field's type is invisible to
     * the ledger. The cast is the physical evidence: a {@code number} declaration must not silently
     * keep the {@code text} expression, or the index would order {@code "10" < "9"}.
     */
    @Test
    void aChangedFieldTypeRebuildsTheIndexWithTheNewCast() {
        UUID bindingId = UUID.randomUUID();
        List<PluginIndexDeclaration> textVersion = List.of(new PluginIndexDeclaration(COLLECTION,
                "by_age", List.of(new PluginIndexDeclaration.DeclaredField("age", "string")),
                false));
        String name = inTransaction(() -> executor.applyForBinding(bindingId, textVersion, null,
                null)).get(0);
        assertFalse(compact(indexDefinition(name)).contains("::numeric"),
                "a string declaration must not produce a numeric cast: " + indexDefinition(name));

        List<PluginIndexDeclaration> numberVersion = List.of(new PluginIndexDeclaration(COLLECTION,
                "by_age", List.of(new PluginIndexDeclaration.DeclaredField("age", "number")),
                false));
        inTransaction(() -> executor.applyForBinding(bindingId, numberVersion, null, null));

        String rebuilt = compact(indexDefinition(name));
        assertTrue(rebuilt.contains("::numeric"),
                "the type change must replace the text expression in place: " + rebuilt);
        assertEquals(1, indexCount(bindingId),
                "the rebuild must not leave two indexes for one declaration");
        assertEquals(List.of("age"), jdbc.query("SELECT fields FROM plugin_index_declarations"
                        + " WHERE binding_id = ? AND collection = ? AND index_name = ?",
                (rs, rowNumber) -> List.of((String[]) rs.getArray(1).getArray()),
                bindingId, COLLECTION, "by_age").get(0),
                "the ledger keeps the names only (DP-3), unchanged by the type change");
    }

    /**
     * Two fields <b>trading</b> types keeps the ledger, the field names and the multiset of casts
     * identical — only which field carries which cast changes. A comparison over the set of casts
     * would accept the stale index; the executor compares per field, so this must rebuild.
     */
    @Test
    void aSwapOfTwoFieldTypesRebuildsTheIndexInsteadOfKeepingTheStaleCasts() {
        UUID bindingId = UUID.randomUUID();
        List<PluginIndexDeclaration> before = List.of(new PluginIndexDeclaration(COLLECTION,
                "by_pair",
                List.of(new PluginIndexDeclaration.DeclaredField("tag", "string"),
                        new PluginIndexDeclaration.DeclaredField("score", "number")),
                false));
        String name = inTransaction(() -> executor.applyForBinding(bindingId, before, null, null))
                .get(0);
        assertTrue(compact(indexDefinition(name)).contains("::numeric"),
                "the numeric cast belongs to score in the first definition: "
                        + indexDefinition(name));

        List<PluginIndexDeclaration> swapped = List.of(new PluginIndexDeclaration(COLLECTION,
                "by_pair",
                List.of(new PluginIndexDeclaration.DeclaredField("tag", "number"),
                        new PluginIndexDeclaration.DeclaredField("score", "string")),
                false));
        inTransaction(() -> executor.applyForBinding(bindingId, swapped, null, null));

        String rebuilt = compact(indexDefinition(name));
        assertTrue(rebuilt.contains("'tag'::text))::numeric"),
                "tag must carry the numeric cast after the swap: " + rebuilt);
        assertFalse(rebuilt.contains("'score'::text))::"),
                "score must be plain text after the swap, not the stale numeric: " + rebuilt);
        assertEquals(1, indexCount(bindingId),
                "the rebuild must not leave two indexes for one declaration");
        assertEquals(List.of("tag", "score"), jdbc.query("SELECT fields FROM"
                        + " plugin_index_declarations WHERE binding_id = ? AND collection = ?"
                        + " AND index_name = ?",
                (rs, rowNumber) -> List.of((String[]) rs.getArray(1).getArray()),
                bindingId, COLLECTION, "by_pair").get(0),
                "the ledger stores names only (DP-3), so the swap is invisible to it");
    }

    /**
     * The {@code date} lane (task-203, direction B) on a real server, because the whole reason it is
     * "no cast" is a server refusal: casting the document text to {@code timestamptz} needs
     * {@code timestamptz_in}, which is {@code STABLE}, and PostgreSQL answers
     * {@code functions in index expression must be marked IMMUTABLE} instead of creating the index.
     *
     * <p>So this asserts more than "the index exists": the definition carries no cast, and the index
     * actually answers a range query ({@code EXPLAIN} under {@code enable_seqscan=off}, so the plan is
     * about usability rather than about how small the test table is). The ordering assertion is the
     * contract's premise, measured: the canonical fixed-width form orders identically as text and as
     * {@code timestamptz} — which is exactly why the write path insists on that form.</p>
     */
    @Test
    void aDateDeclarationBuildsAnIndexAPlainTextRangeQueryCanUse() {
        UUID bindingId = UUID.randomUUID();
        String name = inTransaction(() -> executor.applyForBinding(bindingId,
                List.of(new PluginIndexDeclaration("events", "by_when",
                        List.of(new PluginIndexDeclaration.DeclaredField("when", "date")), false)),
                null, null)).get(0);

        String definition = compact(indexDefinition(name));
        assertNotNull(definition, "the date index must exist on the real server");
        assertTrue(definition.contains("doc->>'when'"),
                "the date index is the plain text extraction: " + definition);
        assertFalse(definition.contains("'when'::text))::"),
                "lane B: no cast after the element — the server refuses timestamptz_in in an index"
                        + " expression: " + definition);

        for (String value : List.of("2026-01-02T00:00:00Z", "2026-01-10T00:00:00Z",
                "2025-12-31T23:59:59Z", "2026-11-08T13:40:00Z")) {
            jdbc.update("INSERT INTO plugin_records (binding_id, collection, id, doc)"
                    + " VALUES (?, 'events', ?, '{\"when\":\"" + value + "\"}'::jsonb)",
                    bindingId, "e-" + value);
        }

        List<String> plan = inTransaction(() -> {
            jdbc.execute("SET LOCAL enable_seqscan = off");
            return jdbc.query("EXPLAIN SELECT id FROM plugin_records WHERE binding_id = ?"
                    + " AND collection = 'events' AND (doc ->> 'when') >= ?",
                    (rs, rowNumber) -> rs.getString(1), bindingId, "2026-01-01T00:00:00Z");
        });
        assertTrue(plan.stream().anyMatch(line -> line.contains(name)),
                "the date index must be usable for a range query, plan was: " + plan);

        // Lexicographic == chronological for the canonical form: the same rows come back in the same
        // order whether they are sorted as text or as timestamptz.
        List<String> sortedAsText = jdbc.query("SELECT doc ->> 'when' FROM plugin_records"
                + " WHERE binding_id = ? AND collection = 'events' ORDER BY (doc ->> 'when')",
                (rs, rowNumber) -> rs.getString(1), bindingId);
        List<String> sortedAsInstant = jdbc.query("SELECT doc ->> 'when' FROM plugin_records"
                + " WHERE binding_id = ? AND collection = 'events'"
                + " ORDER BY (doc ->> 'when')::timestamptz",
                (rs, rowNumber) -> rs.getString(1), bindingId);
        assertEquals(sortedAsInstant, sortedAsText,
                "the fixed-width UTC form is the premise of indexing date as text");
        assertEquals(List.of("2025-12-31T23:59:59Z", "2026-01-02T00:00:00Z",
                "2026-01-10T00:00:00Z", "2026-11-08T13:40:00Z"), sortedAsText,
                "measured order of the four canonical instants");
        assertEquals(1, indexCount(bindingId));
    }

    /**
     * <b>Regression evidence for ruling C1 (2026-11-08)</b>: this test does not detect a swap, it
     * proves that a swap needs no detection. Because {@code date} is the same text expression as
     * {@code string}, swapping the two types leaves the physical definition <b>byte for byte</b>
     * identical, so there is no index (and no name) to rebuild — rebuilding would be an invalid
     * action over an identical object. The type's only effect is the write-side form check, which
     * re-reads the persisted manifest on every write; the upgrade caveat is that after
     * {@code string→date} existing un-normalized values no longer satisfy the new invariant, so data
     * that is not already canonical must block the upgrade rather than be re-normalized.
     */
    @Test
    void aStringToDateSwapLeavesTheSamePhysicalDefinition() {
        UUID bindingId = UUID.randomUUID();
        List<PluginIndexDeclaration> before = List.of(new PluginIndexDeclaration(COLLECTION,
                "by_pair", List.of(
                        new PluginIndexDeclaration.DeclaredField("tag", "string"),
                        new PluginIndexDeclaration.DeclaredField("score", "date")), false));
        String name = inTransaction(() -> executor.applyForBinding(bindingId, before, null, null))
                .get(0);
        String definitionBefore = compact(indexDefinition(name));

        List<PluginIndexDeclaration> swapped = List.of(new PluginIndexDeclaration(COLLECTION,
                "by_pair", List.of(
                        new PluginIndexDeclaration.DeclaredField("tag", "date"),
                        new PluginIndexDeclaration.DeclaredField("score", "string")), false));
        inTransaction(() -> executor.applyForBinding(bindingId, swapped, null, null));

        assertEquals(definitionBefore, compact(indexDefinition(name)),
                "string⇄date swap: the physical definition cannot change, both elements are text");
        assertEquals(1, indexCount(bindingId),
                "no second index is created for the same declaration identity");
        assertEquals(List.of("tag", "score"), jdbc.query("SELECT fields FROM"
                        + " plugin_index_declarations WHERE binding_id = ? AND collection = ?"
                        + " AND index_name = ?",
                (rs, rowNumber) -> List.of((String[]) rs.getArray(1).getArray()),
                bindingId, COLLECTION, "by_pair").get(0),
                "the ledger (names only, DP-3) is unchanged by the swap");
    }


    @Test
    void anIllegalDeclarationIsRefusedBeforeAnyDdlWithoutALedgerRow() {
        UUID bindingId = UUID.randomUUID();
        List<PluginIndexDeclaration> illegal = List.of(
                new PluginIndexDeclaration(COLLECTION, "by_email", List.of(), false));

        CpApiException refused = assertThrows(CpApiException.class,
                () -> inTransaction(() -> executor.applyForBinding(bindingId, illegal, null, null)));

        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, refused.getStatus());
        assertEquals(PluginManifestValidator.ERROR_CODE, refused.getCode(),
                "QUOTA-8: an un-installable declaration is a manifest error, not a 500");
        assertEquals(0, indexCount(bindingId), "no DDL may run for a refused declaration");
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM plugin_index_declarations"
                        + " WHERE binding_id = ?", Integer.class, bindingId),
                "a refused declaration has no physical identity to ledger");
        assertEquals(1, auditRows(bindingId, "result=rejected"),
                "the refusal itself must be durably recorded, or the 422 leaves no trace");
        assertEquals(0, auditRows(bindingId, "result=applied"));
        assertEquals(0, auditRows(bindingId, "result=failed"));
    }

    /**
     * LC-8: a DDL failure fails the install and rolls back, with no half index. The unique collision is
     * used because it is a failure the server itself raises during {@code CREATE UNIQUE INDEX}, so the
     * assertion cannot be satisfied by a pre-check that never runs the DDL.
     *
     * <p>The marker row proves the rollback rather than assuming it: it is inserted in the same
     * transaction as the DDL and must be gone afterwards.</p>
     */
    @Test
    void aDdlFailureRollsBackTheInstallAndRecordsOnlyTheFailure() {
        UUID bindingId = UUID.randomUUID();
        jdbc.update("INSERT INTO plugin_records (binding_id, collection, id, doc)"
                + " VALUES (?, ?, 'dup-1', '{\"email\":\"same@example.test\"}'::jsonb)",
                bindingId, COLLECTION);
        jdbc.update("INSERT INTO plugin_records (binding_id, collection, id, doc)"
                + " VALUES (?, ?, 'dup-2', '{\"email\":\"same@example.test\"}'::jsonb)",
                bindingId, COLLECTION);

        RuntimeException failure = assertThrows(RuntimeException.class, () -> {
            inTransaction(() -> {
                jdbc.update("INSERT INTO plugin_records (binding_id, collection, id, doc)"
                        + " VALUES (?, ?, 'tx-marker', '{}'::jsonb)", bindingId, COLLECTION);
                return executor.applyForBinding(bindingId, List.of(new PluginIndexDeclaration(
                        COLLECTION, "by_email", List.of(field("email")), true)), null, null);
            });
        });

        // 1. the install transaction is gone, including the row it wrote itself
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM plugin_records"
                        + " WHERE binding_id = ? AND id = 'tx-marker'", Integer.class, bindingId),
                "the install transaction must have rolled back, marker row included");
        assertEquals(0, indexCount(bindingId), "LC-8: no half index may survive a failed install");

        // 2. the failure survives it, in its own transaction
        Map<String, Object> row = ledgerRow(bindingId, COLLECTION, "by_email");
        assertEquals("failed", row.get("state"));
        String error = String.valueOf(row.get("error"));
        assertFalse(error.isBlank(), "the ledger row must carry the server's error");
        assertEquals(1, auditRows(bindingId, "result=failed"),
                "the failure must be audited durably, not only logged");
        assertEquals(0, auditRows(bindingId, "result=applied"));

        // 3. the ledger write did not fight the install transaction for a lock: a self-deadlock or a
        // 3s lock timeout here would mean the failure record was written while the install tx still
        // held the row lock, which is precisely the shape this design avoids.
        String lower = (error + " " + failure.getMessage()).toLowerCase(Locale.ROOT);
        assertFalse(lower.contains("deadlock"), "the ledger write must not self-deadlock: " + error);
        assertFalse(lower.contains("lock timeout") || lower.contains("lock_timeout"),
                "the ledger write must not inherit the 3s DDL lock budget: " + error);
        assertFalse(lower.contains("canceling statement due to statement timeout"),
                "the ledger write must not inherit the 5s statement budget: " + error);
    }

    /**
     * Uninstall/cleanup path: drop is idempotent, keeps the ledger (LC-6), and never touches another
     * binding's index — the predicate scoping is what makes "drop everything named like this" wrong.
     */
    @Test
    void dropIsIdempotentKeepsTheLedgerAndLeavesOtherBindingsAlone() {
        UUID bindingId = UUID.randomUUID();
        UUID otherBinding = UUID.randomUUID();
        List<PluginIndexDeclaration> declarations = List.of(
                new PluginIndexDeclaration(COLLECTION, "by_email", List.of(field("email")), false),
                new PluginIndexDeclaration("notes", "by_title", List.of(field("title")), false));
        inTransaction(() -> executor.applyForBinding(bindingId, declarations, null, null));
        inTransaction(() -> executor.applyForBinding(otherBinding, declarations, null, null));
        assertEquals(2, indexCount(bindingId));
        assertEquals(2, indexCount(otherBinding));

        assertEquals(2, inTransaction(() -> executor.dropForBinding(bindingId)).intValue(),
                "both declarations of the binding are swept");
        assertEquals(0, indexCount(bindingId), "the dropped indexes must be gone");
        assertEquals(2, indexCount(otherBinding),
                "another binding's indexes must be untouched — the predicate is binding-scoped");

        // Second sweep: no error, same count, ledger intact (LC-6: the ledger is not purged).
        assertEquals(2, inTransaction(() -> executor.dropForBinding(bindingId)).intValue(),
                "a retried cleanup must be a no-op, not an error");
        assertEquals(2, jdbc.queryForObject(
                "SELECT count(*) FROM plugin_index_declarations WHERE binding_id = ?",
                Integer.class, bindingId), "LC-6: the ledger survives the cleanup");
        assertEquals(2, jdbc.queryForObject(
                "SELECT count(*) FROM plugin_index_declarations WHERE binding_id = ? AND"
                        + " state = 'applied'", Integer.class, bindingId),
                "the ledger still describes what was installed");
        assertEquals(2, indexCount(otherBinding));
    }

    // ------------------------------------------------------------------ helpers

    private <T> T inTransaction(java.util.function.Supplier<T> body) {
        return new TransactionTemplate(transactionManager).execute(status -> body.get());
    }

    private int indexCount(UUID bindingId) {
        // The partial predicate carries the binding id, so this counts exactly this binding's declared
        // indexes and never the table's primary key.
        Integer count = jdbc.queryForObject("SELECT count(*) FROM pg_indexes"
                + " WHERE schemaname = 'public' AND indexdef LIKE ?", Integer.class,
                "%" + bindingId + "%");
        return count == null ? 0 : count;
    }

    private String indexDefinition(String name) {
        List<String> definitions = jdbc.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ?",
                String.class, name);
        return definitions.isEmpty() ? null : definitions.get(0);
    }

    /**
     * {@code pg_get_indexdef} re-renders the expression with the server's own spacing
     * ({@code ((doc ->> 'email'::text))}), so the assertions compare on a whitespace-free form of the
     * definition instead of on the text this code submitted.
     */
    private static String compact(String definition) {
        return definition == null ? "" : definition.replaceAll("\\s+", "");
    }

    private Map<String, Object> ledgerRow(UUID bindingId, String collection, String indexName) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT collection, index_name, fields, unique_flag, state, applied_at, error"
                        + " FROM plugin_index_declarations WHERE binding_id = ? AND collection = ?"
                        + " AND index_name = ?", bindingId, collection, indexName);
        assertFalse(rows.isEmpty(), "expected a ledger row for " + collection + "/" + indexName);
        return rows.get(0);
    }

    /** PLAN-0691 §5.2: declared fields carry a type; these tests exercise identifiers, not casts. */
    private static PluginIndexDeclaration.DeclaredField field(String name) {
        return new PluginIndexDeclaration.DeclaredField(name, "string");
    }

    private int auditRows(UUID bindingId, String detailFragment) {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM audit_logs WHERE action = ?"
                        + " AND resource_id = ? AND details LIKE ?", Integer.class,
                PluginIndexDdlExecutor.ACTION, bindingId.toString(), "%" + detailFragment + "%");
        return count == null ? 0 : count;
    }
}
