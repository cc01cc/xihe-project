package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.interceptor.TransactionAspectSupport;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0691 T2.2: creates and drops the physical indexes a plugin manifest declares, and keeps
 * {@code plugin_index_declarations} (spec/data-plane.md DP-3) as the ledger of what exists.
 *
 * <h2>Why the ledger row is written after the DDL, not before</h2>
 *
 * <p>LC-8 requires a failed install to roll back with no half index while still leaving a
 * {@code failed} ledger row. Those two demands pull in opposite directions on one row, and the naive
 * shape — insert {@code pending} in the install transaction, then rewrite the same row to
 * {@code failed} from a {@code REQUIRES_NEW} transaction — <b>self-deadlocks</b>: the install
 * transaction still holds the uncommitted row lock when the nested transaction tries to update the
 * same primary key.</p>
 *
 * <p>So the ordering is: run every {@code CREATE INDEX} first (PostgreSQL DDL is transactional, so a
 * later failure undoes them), then write the ledger rows as {@code applied} inside the install
 * transaction. On failure the install transaction has written <b>nothing</b> to this table, which is
 * what lets {@link #recordFailure} insert the {@code failed} rows from its own transaction without
 * contending for a lock — and the test asserts exactly that, including the absence of any
 * lock-timeout or deadlock error.</p>
 *
 * <h2>Refused declarations get an audit row, not a ledger row</h2>
 *
 * <p>A declaration the manifest grammar refuses (illegal segment, zero fields, more than four) is
 * rejected <b>before</b> any DDL, so it never acquires a physical identity: the ledger's primary key is
 * {@code (binding_id, collection, index_name)} and its {@code fields} CHECK admits 1..4 entries, which
 * cannot even express a zero-field declaration. Writing an unapplied row for it would therefore either
 * fail the constraint or invent a second meaning for "row exists". The durable evidence of the refusal
 * is the audit row ({@code result=rejected}), which survives the caller's rollback exactly like the
 * {@code failed} path does.</p>
 *
 * <h2>Transaction and timeout contract</h2>
 *
 * <ul>
 *   <li>{@link #applyForBinding} and {@link #dropForBinding} are {@code MANDATORY}: index DDL and the
 *       binding row must commit or roll back together (LC-8).</li>
 *   <li>{@code lock_timeout} 3 s / {@code statement_timeout} 5 s (QUOTA-13) are set with
 *       {@code SET LOCAL}, so they last exactly as long as the surrounding transaction and never
 *       leak into the pool connection. The ledger transaction does not inherit them (a fresh
 *       transaction re-defaults) and additionally resets {@code lock_timeout} explicitly, so a
 *       recovery write can never inherit a 3 s budget from a previous transaction on the same
 *       connection.</li>
 * </ul>
 */
@Service
public class PluginIndexDdlExecutor {

    private static final Logger log = LoggerFactory.getLogger(PluginIndexDdlExecutor.class);

    /**
     * LC-1/LC-8: index DDL belongs to the install face, so the audit rows use that same action. The
     * action word list is a contract — no {@code plugin.index.*} verb is introduced here.
     */
    static final String ACTION = "plugin.install";

    static final String RESOURCE_TYPE = "plugin_index_declaration";

    private static final String LOCK_TIMEOUT = "3s";
    private static final String STATEMENT_TIMEOUT = "5s";
    private static final int MAX_ERROR_LENGTH = 1000;

    private final JdbcTemplate jdbc;
    private final AuditLogger auditLogger;
    private final TransactionTemplate ledgerTx;

    public PluginIndexDdlExecutor(JdbcTemplate jdbc, AuditLogger auditLogger,
            PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.auditLogger = auditLogger;
        this.ledgerTx = new TransactionTemplate(transactionManager);
        this.ledgerTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    /**
     * Creates (or rebuilds) every declared index for one binding and records it as {@code applied}.
     *
     * <p>Must run inside the install transaction: the caller's rollback is what removes the DDL, and
     * the {@code failed} ledger rows are written from a separate transaction so they survive it.</p>
     *
     * @return the physical index names that now exist, in declaration order
     * @throws CpApiException 422 {@code PLUGIN_MANIFEST_INVALID} when a declaration is not
     *     manifest-legal — rejected before any DDL, audited as {@code result=rejected}, no ledger row
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public List<String> applyForBinding(UUID bindingId, List<PluginIndexDeclaration> declarations,
            String actorUserId, String workspaceId) {
        if (bindingId == null) {
            throw new IllegalArgumentException("bindingId is required");
        }
        if (declarations == null || declarations.isEmpty()) {
            return List.of();
        }
        List<PluginIndexDeclaration> rejected = new ArrayList<>();
        for (PluginIndexDeclaration declaration : declarations) {
            if (!PluginIndexNaming.isDeclarable(declaration)) {
                rejected.add(declaration);
            }
        }
        if (!rejected.isEmpty()) {
            CpApiException rejection = new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY,
                    PluginManifestValidator.ERROR_CODE,
                    "declared index is not installable: " + describe(rejected.get(0)));
            recordRejection(bindingId, rejected, actorUserId, workspaceId,
                    rejection.getMessage());
            throw rejection;
        }
        try {
            jdbc.execute("SET LOCAL lock_timeout = '" + LOCK_TIMEOUT + "'");
            jdbc.execute("SET LOCAL statement_timeout = '" + STATEMENT_TIMEOUT + "'");
            List<String> names = new ArrayList<>(declarations.size());
            for (PluginIndexDeclaration declaration : declarations) {
                String name = PluginIndexNaming.physicalName(bindingId, declaration.collection(),
                        declaration.name());
                createIndex(bindingId, declaration, name);
                names.add(name);
            }
            for (PluginIndexDeclaration declaration : declarations) {
                markApplied(bindingId, declaration);
            }
            auditLogger.recordDurableChange(actorUserId, workspaceId, ACTION, RESOURCE_TYPE,
                    bindingId.toString(), "result=applied indexes=" + String.join(",", names));
            log.info("plugin index declarations applied binding={} indexes={}", bindingId, names);
            return names;
        } catch (RuntimeException failure) {
            // The install transaction must not commit a half install (LC-8). The outer service already
            // treats this exception as fatal; this makes the rollback explicit even if it does not.
            TransactionAspectSupport.currentTransactionStatus().setRollbackOnly();
            recordFailure(bindingId, declarations, actorUserId, workspaceId, failure.getMessage());
            throw failure;
        }
    }

    /**
     * Drops the physical indexes of one binding and keeps its ledger rows (LC-6: the ledger survives
     * uninstall and purge).
     *
     * <p>Names are recomputed from ledger rows only, so calling this twice — or after a crash between
     * the DDL and the commit — is a no-op rather than an error ({@code DROP INDEX IF EXISTS}).</p>
     *
     * @return how many ledger rows were swept (not how many indexes existed)
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public int dropForBinding(UUID bindingId) {
        List<String[]> rows = jdbc.query("SELECT collection, index_name"
                        + " FROM plugin_index_declarations WHERE binding_id = ?"
                        + " ORDER BY collection, index_name",
                (rs, index) -> new String[] {rs.getString(1), rs.getString(2)}, bindingId);
        int swept = 0;
        for (String[] row : rows) {
            String name;
            try {
                name = PluginIndexNaming.physicalName(bindingId, row[0], row[1]);
            } catch (IllegalArgumentException e) {
                // Only reachable if a ledger row was written outside this executor (the refuse path
                // writes no rows): nothing can name that index, so the sweep cannot drop it. Keep the
                // row — LC-6 — and surface the anomaly instead of silently reporting a clean sweep.
                log.warn("skipping unrecomputable plugin index name binding={} collection={}"
                        + " index={}", bindingId, row[0], row[1], e);
                continue;
            }
            jdbc.execute("DROP INDEX IF EXISTS " + name);
            swept++;
        }
        if (swept > 0) {
            log.info("plugin indexes dropped binding={} swept={}", bindingId, swept);
        }
        return swept;
    }

    private void createIndex(UUID bindingId, PluginIndexDeclaration declaration, String name) {
        Existing existing = findExisting(bindingId, declaration);
        if (existing != null && existing.matches(declaration)) {
            // Same identity, same definition, already applied: a retried install must not rebuild the
            // index (that is the replayable half of "install is idempotent").
            return;
        }
        if (existing != null) {
            // Same identity, different definition (an upgrade changed fields/unique). CREATE INDEX IF
            // NOT EXISTS would silently keep the stale index, so the rebuild is explicit.
            jdbc.execute("DROP INDEX IF EXISTS " + name);
        }
        jdbc.execute(createStatement(bindingId, declaration, name));
    }

    private String createStatement(UUID bindingId, PluginIndexDeclaration declaration,
            String name) {
        StringBuilder sql = new StringBuilder("CREATE ");
        if (declaration.unique()) {
            // DP-2: a declared unique index becomes a partial unique index, scoped to one binding and
            // collection, so two workspaces binding the same plugin cannot collide with each other.
            sql.append("UNIQUE ");
        }
        sql.append("INDEX IF NOT EXISTS ").append(name).append(" ON plugin_records (");
        for (int i = 0; i < declaration.fields().size(); i++) {
            if (i > 0) {
                sql.append(", ");
            }
            // DP-2: the declared field is a scalar expression over the document, not a generated
            // column; the field name was validated against the manifest grammar above.
            sql.append("((doc->>'").append(declaration.fields().get(i)).append("'))");
        }
        sql.append(") WHERE ").append(predicate(bindingId.toString(), declaration.collection()));
        return sql.toString();
    }

    private void markApplied(UUID bindingId, PluginIndexDeclaration declaration) {
        jdbc.update("INSERT INTO plugin_index_declarations (binding_id, collection, index_name,"
                        + " fields, unique_flag, state, applied_at, error)"
                        + " VALUES (?, ?, ?, ?, ?, 'applied', NOW(), NULL)"
                        + " ON CONFLICT (binding_id, collection, index_name) DO UPDATE SET"
                        + " fields = EXCLUDED.fields, unique_flag = EXCLUDED.unique_flag,"
                        + " state = 'applied', applied_at = NOW(), error = NULL",
                (PreparedStatement statement) -> bindDeclaration(statement, bindingId, declaration));
    }

    private void markFailed(UUID bindingId, PluginIndexDeclaration declaration, String error) {
        jdbc.update("INSERT INTO plugin_index_declarations (binding_id, collection, index_name,"
                        + " fields, unique_flag, state, applied_at, error)"
                        + " VALUES (?, ?, ?, ?, ?, 'failed', NULL, ?)"
                        + " ON CONFLICT (binding_id, collection, index_name) DO UPDATE SET"
                        + " fields = EXCLUDED.fields, unique_flag = EXCLUDED.unique_flag,"
                        + " state = 'failed', applied_at = NULL, error = EXCLUDED.error",
                (PreparedStatement statement) -> {
                    bindDeclaration(statement, bindingId, declaration);
                    statement.setString(6, truncate(error));
                });
    }

    private void bindDeclaration(PreparedStatement statement, UUID bindingId,
            PluginIndexDeclaration declaration) throws SQLException {
        statement.setObject(1, bindingId);
        statement.setString(2, declaration.collection());
        statement.setString(3, declaration.name());
        statement.setArray(4, statement.getConnection().createArrayOf("text",
                declaration.fields().toArray(new String[0])));
        statement.setBoolean(5, declaration.unique());
    }

    private Existing findExisting(UUID bindingId, PluginIndexDeclaration declaration) {
        List<Existing> found = jdbc.query("SELECT fields, unique_flag, state"
                        + " FROM plugin_index_declarations"
                        + " WHERE binding_id = ? AND collection = ? AND index_name = ?",
                (rs, index) -> new Existing(
                        List.of((String[]) rs.getArray(1).getArray()),
                        rs.getBoolean(2), rs.getString(3)),
                bindingId, declaration.collection(), declaration.name());
        return found.isEmpty() ? null : found.get(0);
    }

    private static String predicate(String bindingId, String collection) {
        return "binding_id = '" + bindingId + "' AND collection = '" + collection + "'";
    }

    /**
     * Records the failure in its own transaction, so the row and the audit survive the install
     * rollback. Never throws: the caller rethrows the original DDL failure, and a bookkeeping failure
     * must not mask it.
     */
    private void recordFailure(UUID bindingId, List<PluginIndexDeclaration> declarations,
            String actorUserId, String workspaceId, String failure) {
        String error = truncate(failure);
        try {
            ledgerTx.executeWithoutResult(status -> {
                jdbc.execute("SET LOCAL lock_timeout TO DEFAULT");
                for (PluginIndexDeclaration declaration : declarations) {
                    try {
                        markFailed(bindingId, declaration, error);
                    } catch (RuntimeException e) {
                        log.warn("could not record failed plugin index binding={} declaration={}",
                                bindingId, describe(declaration), e);
                    }
                }
                auditLogger.recordDurableChange(actorUserId, workspaceId, ACTION, RESOURCE_TYPE,
                        bindingId.toString(), "result=failed error=" + error);
            });
        } catch (RuntimeException e) {
            log.error("could not record plugin index failure binding={}", bindingId, e);
        }
    }

    /**
     * Records a refusal in its own transaction. No ledger row: see the class comment — a declaration
     * that never reached DDL has no physical identity, and the ledger's {@code fields} CHECK could not
     * store a zero-field declaration anyway. Never throws, so the 422 reaches the caller unmasked.
     */
    private void recordRejection(UUID bindingId, List<PluginIndexDeclaration> rejected,
            String actorUserId, String workspaceId, String reason) {
        try {
            ledgerTx.executeWithoutResult(status -> {
                jdbc.execute("SET LOCAL lock_timeout TO DEFAULT");
                auditLogger.recordDurableChange(actorUserId, workspaceId, ACTION, RESOURCE_TYPE,
                        bindingId.toString(), "result=rejected error=" + truncate(reason)
                                + " declarations=" + describeAll(rejected));
            });
        } catch (RuntimeException e) {
            log.error("could not record plugin index rejection binding={}", bindingId, e);
        }
    }

    private static String describe(PluginIndexDeclaration declaration) {
        return declaration.collection() + "/" + declaration.name() + " fields="
                + declaration.fields();
    }

    private static String describeAll(List<PluginIndexDeclaration> declarations) {
        List<String> described = new ArrayList<>(declarations.size());
        for (PluginIndexDeclaration declaration : declarations) {
            described.add(describe(declaration));
        }
        return String.join("; ", described);
    }

    private static String truncate(String value) {
        if (value == null) {
            return "index DDL failed";
        }
        return value.length() > MAX_ERROR_LENGTH ? value.substring(0, MAX_ERROR_LENGTH) : value;
    }

    /** One ledger row, read back to decide between "already applied" and "rebuild". */
    private record Existing(List<String> fields, boolean unique, String state) {

        boolean matches(PluginIndexDeclaration declaration) {
            return "applied".equals(state) && unique == declaration.unique()
                    && fields.equals(declaration.fields());
        }
    }
}
