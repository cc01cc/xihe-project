package com.cc01cc.p.xihe.cp.policy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Storage access for {@code session_temporary_grants} (V180 / task-124 / DSD-1509).
 *
 * <p>Plain JDBC rather than a JPA entity, following {@code plugin.kv.PluginKvRepository}: the row's
 * whole meaning is decided by SQL predicates ({@code expires_at > ?} plus {@code revoked_at IS NULL})
 * and by the row-count of one conditional UPDATE for revocation, which is exactly the semantics JPA
 * would turn into an exception after a read-modify-write. It also keeps the new type inside the
 * {@code policy} capability package instead of adding a second name for the same table in
 * {@code cp.entity}.</p>
 *
 * <p>Every read filters expiry in SQL, so "expired means absent" holds for the decision path, the
 * listing and the revocation count without a scheduled sweep. The instant is a parameter rather than
 * {@code now()} so a test can move the clock without sleeping.</p>
 *
 * <p>The decision-side reads also take the workspace id: a token is scoped to one session, and that
 * session belongs to exactly one workspace, so matching both is defence in depth rather than a second
 * rule (DSD-1509 G3 is the rule: leaf session + leaf principal only).</p>
 */
@Repository
public class SessionTemporaryGrantStore {

    private static final String COLUMNS = "id, session_id, workspace_id, principal_id,"
            + " permissions::text AS permissions_text, granted_by_user_id, granted_at, expires_at,"
            + " revoked_at, revoked_by_user_id";
    private static final String LIVE = " AND revoked_at IS NULL AND expires_at > ?";

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final GrantIntersectionEvaluator evaluator;

    public SessionTemporaryGrantStore(JdbcTemplate jdbc, ObjectMapper objectMapper,
                                      GrantIntersectionEvaluator evaluator) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.evaluator = evaluator;
    }

    private final RowMapper<SessionTemporaryGrant> rowMapper = (rs, rowNum) -> new SessionTemporaryGrant(
            rs.getObject("id", UUID.class),
            rs.getObject("session_id", UUID.class),
            rs.getObject("workspace_id", UUID.class),
            rs.getObject("principal_id", UUID.class),
            parseAtoms(rs.getString("permissions_text")),
            rs.getObject("granted_by_user_id", UUID.class),
            toInstant(rs.getObject("granted_at", OffsetDateTime.class)),
            toInstant(rs.getObject("expires_at", OffsetDateTime.class)),
            rs.getObject("revoked_by_user_id", UUID.class),
            toInstant(rs.getObject("revoked_at", OffsetDateTime.class)));

    /**
     * The rows the decision path may honour: this session, this principal, still live. A token is
     * leaf-only (DSD-1509 G3) — the caller passes the request's own session id, never an ancestor's.
     */
    public List<SessionTemporaryGrant> findLive(UUID sessionId, UUID principalId, UUID workspaceId,
                                               Instant now) {
        if (sessionId == null || principalId == null || workspaceId == null || now == null) {
            return List.of();
        }
        return jdbc.query("SELECT " + COLUMNS + " FROM session_temporary_grants"
                        + " WHERE session_id = ? AND principal_id = ? AND workspace_id = ?" + LIVE,
                rowMapper, sessionId, principalId, workspaceId,
                OffsetDateTime.ofInstant(now, java.time.ZoneOffset.UTC));
    }

    /** The read face: one session's live tokens, newest first. */
    public List<SessionTemporaryGrant> listLive(UUID sessionId, Instant now) {
        if (sessionId == null || now == null) {
            return List.of();
        }
        return jdbc.query("SELECT " + COLUMNS + " FROM session_temporary_grants"
                        + " WHERE session_id = ?" + LIVE + " ORDER BY granted_at DESC",
                rowMapper, sessionId, OffsetDateTime.ofInstant(now, java.time.ZoneOffset.UTC));
    }

    /** Row identity lookup, expiry included: a map from the read face never outlives the row's meaning. */
    public Optional<SessionTemporaryGrant> findLiveById(UUID id, Instant now) {
        if (id == null || now == null) {
            return Optional.empty();
        }
        List<SessionTemporaryGrant> rows = jdbc.query("SELECT " + COLUMNS
                        + " FROM session_temporary_grants WHERE id = ?" + LIVE,
                rowMapper, id, OffsetDateTime.ofInstant(now, java.time.ZoneOffset.UTC));
        return rows.stream().findFirst();
    }

    public void insert(SessionTemporaryGrant row) {
        jdbc.update("INSERT INTO session_temporary_grants"
                        + " (id, session_id, workspace_id, principal_id, permissions,"
                        + " granted_by_user_id, granted_at, expires_at)"
                        + " VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?)",
                row.id(), row.sessionId(), row.workspaceId(), row.principalId(),
                permissionsJson(row.atoms()), row.grantedByUserId(),
                OffsetDateTime.ofInstant(row.grantedAt(), java.time.ZoneOffset.UTC),
                OffsetDateTime.ofInstant(row.expiresAt(), java.time.ZoneOffset.UTC));
    }

    /**
     * Revokes one row <b>of this session</b>. The session id is part of the predicate, so a caller who
     * may revoke here can never revoke another session's token by guessing an id. Returns the row
     * count: 0 means "absent, already revoked, expired, or another session's row" and the caller
     * reports all four the same way (404, no existence leak).
     */
    public int revoke(UUID id, UUID sessionId, UUID revokedByUserId, Instant now) {
        return jdbc.update("UPDATE session_temporary_grants"
                        + " SET revoked_at = ?, revoked_by_user_id = ?"
                        + " WHERE id = ? AND session_id = ? AND revoked_at IS NULL",
                OffsetDateTime.ofInstant(now, java.time.ZoneOffset.UTC), revokedByUserId, id, sessionId);
    }

    /**
     * The decision-side projection: live atoms as {@link GrantIntersectionEvaluator.GrantAtom} rows
     * carrying the row id and {@link GrantSources#SESSION_TEMP}, so an explanation can cite which
     * token authorized (DSD-1497 trail, DSD-1509 ④).
     */
    public List<GrantIntersectionEvaluator.GrantAtom> tokenAtoms(UUID sessionId, UUID principalId,
                                                                 UUID workspaceId, Instant now) {
        List<SessionTemporaryGrant> rows = findLive(sessionId, principalId, workspaceId, now);
        if (rows.isEmpty()) {
            return List.of();
        }
        List<GrantIntersectionEvaluator.GrantAtom> atoms = new ArrayList<>();
        for (SessionTemporaryGrant row : rows) {
            String grantId = row.id() == null ? null : row.id().toString();
            for (GrantIntersectionEvaluator.PermissionAtom atom : row.atoms()) {
                atoms.add(new GrantIntersectionEvaluator.GrantAtom(
                        atom.actionClass(), atom.resource(), grantId, GrantSources.SESSION_TEMP));
            }
        }
        return List.copyOf(atoms);
    }

    /** Atom array in the {@code grants.permissions} shape; missing resource means wildcard. */
    String permissionsJson(List<GrantIntersectionEvaluator.PermissionAtom> atoms) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (GrantIntersectionEvaluator.PermissionAtom atom : atoms) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("actionClass", atom.actionClass());
            row.put("resource", atom.resource());
            rows.add(row);
        }
        try {
            return objectMapper.writeValueAsString(rows);
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialize temporary grant atoms", e);
        }
    }

    private List<GrantIntersectionEvaluator.PermissionAtom> parseAtoms(String permissionsText) {
        try {
            JsonNode node = objectMapper.readTree(permissionsText == null ? "[]" : permissionsText);
            return List.copyOf(evaluator.parse(node));
        } catch (Exception e) {
            throw new IllegalStateException("cannot read temporary grant atoms", e);
        }
    }

    private static Instant toInstant(OffsetDateTime value) {
        return value == null ? null : value.toInstant();
    }
}
