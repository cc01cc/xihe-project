package com.cc01cc.p.xihe.cp.plugin.records;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0691 T2.3: all SQL against {@code plugin_records} (DP-2; table created by the merged,
 * immutable V142).
 *
 * <p>Plain {@link JdbcTemplate} like {@code PluginKvRepository}: the data plane has no JPA entity, so
 * a plugin document never becomes a managed object and {@code version} stays a CP-owned column
 * (DP-7) rather than something an ORM can dirty.
 *
 * <p><b>Statement timeout (QUOTA-13).</b> Every statement runs inside a short transaction whose first
 * statement is {@code SELECT set_config('statement_timeout', …, true)}. The {@code true} makes the
 * setting transaction-local, so it cannot leak onto the next borrower of a pooled connection, and it
 * is applied per statement rather than once per pool entry. A cancelled statement surfaces as
 * {@code QueryTimeoutException} (PostgreSQL 57014); mapping that to 429 is the service's job, because
 * only the service knows which operation was running.
 *
 * <p>The only caller-shaped SQL is the {@code WHERE}/{@code ORDER BY} fragment a
 * {@link PluginQueryCompiler.Plan} carries; its identifiers are manifest-declared names and its values
 * are bind arguments, never text.
 */
@Repository
public class PluginRecordsRepository {

    private static final String COLUMNS = "id, doc::text AS doc_json, version, updated_at";

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final PluginRecordsLimits limits;

    public PluginRecordsRepository(JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            PluginRecordsLimits limits) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.limits = limits;
    }

    /**
     * One stored document; {@code docJson} is the raw jsonb text, parsed by the service.
     *
     * @param sortKey the sort key of this row projected as text, or {@code null} for point reads
     */
    public record Row(String id, String docJson, long version, Instant updatedAt, String sortKey) {
    }

    /** API-6 point read. */
    public Optional<Row> find(UUID bindingId, String collection, String id) {
        List<Row> rows = timed(() -> jdbc.query(
                "SELECT " + COLUMNS + " FROM plugin_records WHERE binding_id = ?"
                        + " AND collection = ? AND id = ?",
                (rs, index) -> row(rs, false), bindingId, collection, id));
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.getFirst());
    }

    /**
     * API-6 listing.
     *
     * @param fetchLimit one more than the page size, so the caller can tell "has more" without a
     *                   second count query (§5: no unbounded scan, no separate total)
     */
    public List<Row> page(UUID bindingId, String collection, PluginQueryCompiler.Plan plan,
            int fetchLimit) {
        List<Object> args = new ArrayList<>();
        args.add(bindingId);
        args.add(collection);
        args.addAll(plan.whereArgs());
        args.add(fetchLimit);
        String sql = "SELECT " + COLUMNS + ", " + plan.sortKeySql() + " AS sort_key"
                + " FROM plugin_records WHERE binding_id = ?"
                + " AND collection = ? AND " + plan.whereSql() + " " + plan.orderSql() + " LIMIT ?";
        return timed(() -> jdbc.query(sql, (rs, index) -> row(rs, true), args.toArray()));
    }

    /** QUOTA-6: documents currently stored for one binding + collection. */
    public long count(UUID bindingId, String collection) {
        Long count = timed(() -> jdbc.queryForObject(
                "SELECT COUNT(*) FROM plugin_records WHERE binding_id = ? AND collection = ?",
                Long.class, bindingId, collection));
        return count == null ? 0L : count;
    }

    /**
     * API-5 / API-10: upsert by {@code id}, bumping {@code version} (the version is the CP's, DP-7).
     *
     * <p>{@code ON CONFLICT (binding_id, collection, id)} covers exactly the primary key, so a
     * manifest-declared unique index violated by this write is <i>not</i> swallowed here — it propagates
     * as {@code DuplicateKeyException} and becomes 409 {@code PLUGIN_RECORD_CONFLICT}.
     */
    public Row upsert(UUID bindingId, String collection, String id, String docJson) {
        return timed(() -> jdbc.queryForObject(
                "INSERT INTO plugin_records (binding_id, collection, id, doc, version, updated_at)"
                        + " VALUES (?, ?, ?, CAST(? AS jsonb), 1, NOW())"
                        + " ON CONFLICT (binding_id, collection, id) DO UPDATE"
                        + " SET doc = EXCLUDED.doc, version = plugin_records.version + 1,"
                        + " updated_at = NOW()"
                        + " RETURNING " + COLUMNS,
                (rs, index) -> row(rs, false), bindingId, collection, id, docJson));
    }

    /** API-5 {@code POST}: CP generates the id, so the insert is plain and a PK clash is a bug. */
    public Row insert(UUID bindingId, String collection, String id, String docJson) {
        return timed(() -> jdbc.queryForObject(
                "INSERT INTO plugin_records (binding_id, collection, id, doc, version, updated_at)"
                        + " VALUES (?, ?, ?, CAST(? AS jsonb), 1, NOW()) RETURNING " + COLUMNS,
                (rs, index) -> row(rs, false), bindingId, collection, id, docJson));
    }

    /** API-7: {@code true} when a row was removed, {@code false} when there was nothing to remove. */
    public boolean delete(UUID bindingId, String collection, String id) {
        Integer removed = timed(() -> jdbc.update(
                "DELETE FROM plugin_records WHERE binding_id = ? AND collection = ? AND id = ?",
                bindingId, collection, id));
        return removed != null && removed > 0;
    }

    /**
     * The {@code statement_timeout} actually in force for a records statement.
     *
     * <p>Exists for the QUOTA-13 test: whether the timeout is <i>applied</i> and whether a timeout
     * <i>maps to 429</i> are two facts, and only the first one can be asserted without a slow query.
     * Not used by production code.
     */
    String currentStatementTimeout() {
        return timed(() -> jdbc.queryForObject("SELECT current_setting('statement_timeout')",
                String.class));
    }

    private <T> T timed(java.util.function.Supplier<T> body) {
        return transactions.execute(status -> {
            // QUOTA-13 / §2.1 L58: the value is the existing cp.lock-timeout-ms, not a plugin env.
            jdbc.queryForObject("SELECT set_config('statement_timeout', ?, true)", String.class,
                    Integer.toString(limits.statementTimeoutMs()));
            return body.get();
        });
    }

    private static Row row(java.sql.ResultSet rs, boolean withSortKey) throws java.sql.SQLException {
        Timestamp updatedAt = rs.getTimestamp("updated_at");
        return new Row(rs.getString("id"), rs.getString("doc_json"), rs.getLong("version"),
                updatedAt == null ? null
                        : OffsetDateTime.ofInstant(updatedAt.toInstant(), ZoneOffset.UTC).toInstant(),
                withSortKey ? rs.getString("sort_key") : null);
    }
}
