package com.cc01cc.p.xihe.cp.plugin.kv;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0691 T1.5: storage access for {@code plugin_kv} (spec/data-plane.md DP-1, API-1..API-4).
 *
 * <p>Plain JDBC rather than a JPA entity, on purpose:
 * <ul>
 *   <li>API-9 CAS is decided by <b>row counts</b> of one conditional statement
 *       ({@code UPDATE … WHERE version = ?}). Under JPA the same rule arrives as an
 *       {@code OptimisticLockException} after a read-modify-write, i.e. as an exception whose
 *       meaning depends on transaction boundaries rather than on the statement that ran.</li>
 *   <li>{@code key} and {@code value} are reserved words in the H2 lane, so an entity would need
 *       quoting everywhere while that lane (flyway disabled, {@code ddl-auto=create-drop}) can never
 *       exercise this table anyway. Verify.md's KV acceptance runs on real PostgreSQL.</li>
 *   <li>{@code value} stays a JSON <b>text</b> on the boundary, so no Jackson-2 node is ever a field
 *       of a type this class hands upward (PLAN-0633 C1).</li>
 * </ul>
 *
 * <p>Every query filters expiry in SQL ({@code expires_at IS NULL OR expires_at > now()}) so "expired
 * means absent" (API-1) holds for reads, listings <b>and</b> the quota count; a row that has expired
 * must not consume a plugin's key budget while it waits for the hourly purge.
 *
 * <p>There is no {@code binding_id} foreign key (DP-6a). This class never <em>stamps</em>
 * {@code orphaned_at} — that is lane A's uninstall/detach path (T1.4) — and it never reads it
 * either: the reader is T3.2's purge job. All it does with the column is clear it back to
 * {@code NULL} on a successful rewrite, because a live write proves the binding came back. See
 * {@link PluginKvService} for the full ownership note.
 */
@Repository
public class PluginKvRepository {

    private static final String COLUMNS = "key, value::text AS value_text, version, expires_at";
    private static final String LIVE = " AND (expires_at IS NULL OR expires_at > now())";

    private static final RowMapper<PluginKvRow> ROW_MAPPER = (rs, rowNum) -> {
        OffsetDateTime expiresAt = rs.getObject("expires_at", OffsetDateTime.class);
        return new PluginKvRow(
                rs.getString("key"),
                rs.getString("value_text"),
                rs.getLong("version"),
                expiresAt == null ? null : expiresAt.toInstant());
    };

    private final JdbcTemplate jdbc;

    public PluginKvRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** API-1: a live row, or empty when missing <em>or</em> expired. */
    public Optional<PluginKvRow> find(UUID bindingId, String namespace, String key) {
        List<PluginKvRow> rows = jdbc.query(
                "SELECT " + COLUMNS + " FROM plugin_kv WHERE binding_id = ? AND namespace = ? AND key = ?" + LIVE,
                ROW_MAPPER, bindingId, namespace, key);
        return rows.stream().findFirst();
    }

    /**
     * Inserts a brand new key at {@code version = 1}.
     *
     * @return {@code true} when this call created the row; {@code false} when another writer won the
     *         race (the caller then re-applies the API-9 preconditions against the existing row)
     */
    public boolean insert(UUID bindingId, String namespace, String key, String valueJson, Instant expiresAt) {
        int rows = jdbc.update("INSERT INTO plugin_kv "
                        + "(binding_id, namespace, key, value, version, expires_at, updated_at) "
                        + "VALUES (?, ?, ?, ?::jsonb, 1, ?, now()) "
                        + "ON CONFLICT (binding_id, namespace, key) DO NOTHING",
                bindingId, namespace, key, valueJson, timestamp(expiresAt));
        return rows == 1;
    }

    /**
     * API-9 CAS write: only updates when the stored version still equals {@code expectedVersion}.
     *
     * <p>{@code orphaned_at = NULL} rides along in the same statement on purpose: a successful write
     * is proof the binding is live again, so the row must stop looking orphaned in that same
     * transaction. This class only ever clears the column — it never stamps it (lane A does, see the
     * class note).
     *
     * @return the number of rows updated ({@code 0} means the precondition no longer holds)
     */
    public int updateWithVersion(UUID bindingId, String namespace, String key, long expectedVersion,
                                 String valueJson, Instant expiresAt) {
        return jdbc.update("UPDATE plugin_kv SET value = ?::jsonb, version = version + 1, expires_at = ?, "
                        + "updated_at = now(), orphaned_at = NULL "
                        + "WHERE binding_id = ? AND namespace = ? AND key = ? AND version = ?",
                valueJson, timestamp(expiresAt), bindingId, namespace, key, expectedVersion);
    }

    /**
     * API-9 escape hatch ({@code If-Match: *}): overwrite whatever version is stored, or create the
     * row when it does not exist.
     */
    public int updateAnyVersion(UUID bindingId, String namespace, String key,
                               String valueJson, Instant expiresAt) {
        return jdbc.update("UPDATE plugin_kv SET value = ?::jsonb, version = version + 1, expires_at = ?, "
                        + "updated_at = now(), orphaned_at = NULL "
                        + "WHERE binding_id = ? AND namespace = ? AND key = ?",
                valueJson, timestamp(expiresAt), bindingId, namespace, key);
    }

    /** API-3 unconditional delete (no {@code If-Match} given). */
    public int delete(UUID bindingId, String namespace, String key) {
        return jdbc.update("DELETE FROM plugin_kv WHERE binding_id = ? AND namespace = ? AND key = ?",
                bindingId, namespace, key);
    }

    /** API-3 delete guarded by the stored version; {@code 0} rows means the precondition failed. */
    public int deleteWithVersion(UUID bindingId, String namespace, String key, long expectedVersion) {
        return jdbc.update("DELETE FROM plugin_kv "
                        + "WHERE binding_id = ? AND namespace = ? AND key = ? AND version = ?",
                bindingId, namespace, key, expectedVersion);
    }

    /** QUOTA-1: live keys of one binding (expired rows do not count, see class javadoc). */
    public long countLiveKeys(UUID bindingId) {
        Long count = jdbc.queryForObject("SELECT count(*) FROM plugin_kv WHERE binding_id = ?" + LIVE,
                Long.class, bindingId);
        return count == null ? 0L : count;
    }

    /**
     * API-4 prefix listing ordered by key.
     *
     * <p>Optional filters are appended together with their own placeholder, never as a fixed
     * {@code (? IS NULL OR …)} pair, so the statement keeps working with a partial argument list and
     * the prefix comparison can use {@code idx_plugin_kv_prefix} ({@code text_pattern_ops}).
     *
     * @param likePattern SQL {@code LIKE} pattern already escaped by the caller, or {@code null}
     * @param afterKey    keys must sort strictly after this one (the opaque cursor), or {@code null}
     * @param limit       hard row cap; the caller has already clamped it to the API-4 maximum
     */
    public List<PluginKvRow> list(UUID bindingId, String namespace, String likePattern,
                                  String afterKey, int limit) {
        StringBuilder sql = new StringBuilder("SELECT " + COLUMNS
                + " FROM plugin_kv WHERE binding_id = ? AND namespace = ?" + LIVE);
        List<Object> args = new ArrayList<>();
        args.add(bindingId);
        args.add(namespace);
        if (likePattern != null) {
            sql.append(" AND key LIKE ?");
            args.add(likePattern);
        }
        if (afterKey != null) {
            sql.append(" AND key > ?");
            args.add(afterKey);
        }
        sql.append(" ORDER BY key ASC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), ROW_MAPPER, args.toArray());
    }

    /**
     * PLAN-0691 T3.2 (DP-6a / LC-6): deletes one bounded batch of <b>orphaned</b> rows.
     *
     * <p>Orphan means two things at once, and both are required: the {@code binding_id} is no longer
     * present in {@code plugin_bindings} (there is no foreign key to lean on — DP-6a deliberately does
     * not create one, so "the binding still exists" is an application-level fact), <b>and</b> the row
     * is past its grace period. DP-6a names the clock as {@code orphaned_at} with an explicit
     * fallback to {@code updated_at} "when it was never written"; since this repository still has no
     * writer for {@code orphaned_at} (see the class note), the fallback is what actually decides today
     * and the two clocks are combined in a single {@code COALESCE}.
     *
     * <p>{@code expires_at} is deliberately not part of the predicate. An expired row is already
     * invisible to every reader (API-1) and its own reclamation is a separate concern; deleting it
     * here would also remove the row that a fresh re-write of the same key bumps, which changes
     * {@code version} after expiry. V141's "expired rows are recycled hourly" promise is therefore
     * <b>not</b> fulfilled by this method; see {@code PluginDataRetentionService}.
     *
     * <p>Shape: {@code DELETE … WHERE ctid IN (SELECT … LIMIT ?)}. PostgreSQL has no
     * {@code DELETE … LIMIT}, and the {@code ctid} rewrite bounds the batch without re-joining the
     * target of the same statement. {@code idx_plugin_kv_orphaned_at} cannot serve this predicate
     * while {@code orphaned_at} has no writer (the expression is {@code COALESCE}, not the bare
     * column), so the bound comes from {@code limit} and not from that index.
     *
     * @param cutoff rows strictly older than this instant are eligible
     * @return rows actually deleted by this batch; {@code 0} means the table is clean
     */
    public int deleteOrphanedBefore(Instant cutoff, int limit) {
        return jdbc.update(
                "DELETE FROM plugin_kv k WHERE k.ctid IN ("
                        + " SELECT o.ctid FROM plugin_kv o"
                        + " WHERE NOT EXISTS (SELECT 1 FROM plugin_bindings b"
                        + " WHERE b.id = o.binding_id)"
                        + " AND COALESCE(o.orphaned_at, o.updated_at) < ?"
                        + " LIMIT ?)",
                timestamp(cutoff), limit);
    }

    /** {@code timestamptz} binding: PostgreSQL JDBC accepts {@code OffsetDateTime}, not {@code Instant}. */
    private static OffsetDateTime timestamp(Instant instant) {
        return instant == null ? null : OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }
}
