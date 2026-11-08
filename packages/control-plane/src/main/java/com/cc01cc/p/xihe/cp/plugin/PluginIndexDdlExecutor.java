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
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
        if (existing != null && existing.matches(declaration)
                && physicalExpressionMatches(name, declaration)) {
            // Same identity, same definition, already applied: a retried install must not rebuild the
            // index (that is the replayable half of "install is idempotent").
            return;
        }
        if (existing != null) {
            // Same identity, different definition: an upgrade changed the fields, the uniqueness, or a
            // field's type. DP-3 keeps field types in the manifest only, so a type change cannot be
            // seen in the ledger — the physical index definition is the evidence. CREATE INDEX IF NOT
            // EXISTS would silently keep the stale cast, so the rebuild is explicit. Only the cast
            // types can differ physically; a string⇄date swap reaches the early return above because
            // its definition is identical (ruling C1: no rebuild, no rename).
            jdbc.execute("DROP INDEX IF EXISTS " + name);
        }
        jdbc.execute(createStatement(bindingId, declaration, name));
    }

    /**
     * Whether the physical index under {@code name} still carries, <b>per field</b>, the cast that
     * field's declared type asks for.
     *
     * <p>The ledger stores field <b>names only</b> (DP-3: the manifest is the single source of field
     * types), so "did an upgrade change a type" cannot be answered from the ledger. The index
     * definition can answer it for the <b>cast</b> types: PostgreSQL prints the cast we emitted
     * ({@code ::numeric}, {@code ::boolean}) right after each {@code (doc ->> 'f'::text)} element.
     * Comparing the <i>set</i> of casts would be too weak: an upgrade that swaps two fields' types
     * leaves the same set behind while each element carries the other field's cast, so the stale
     * ordering would survive silently. Every field is therefore checked on its own — its element must
     * exist, and the first {@code ::} after it (if any) must be exactly its declared cast, absent for
     * {@code string} and {@code date}.</p>
     *
     * <p>Because {@code date} keeps the plain text expression (see {@link #columnExpression}), a
     * {@code string}↔{@code date} swap produces a <b>physically identical</b> index: same element,
     * same order, no cast — measured on PG 17 as byte-identical {@code indexdef}. Ruling C1
     * (2026-11-08) therefore says that swap needs <b>no</b> rebuild and no rename: there is nothing
     * physical to change, the type's only effect is the write-side form check (which re-reads the
     * persisted manifest on every write), and adding a declaration snapshot to detect it would cost a
     * migration while breaking the ledger-only name recomputation that uninstall relies on. What
     * changes across that swap is the set of values the write path accepts: after
     * {@code string→date}, existing un-normalized values no longer satisfy the new invariant, so an
     * upgrade over data that is not already canonical must be refused, never silently re-normalized.</p>
     *
     * <p>A missing index, or an element absent from the definition, counts as "does not match": the
     * ledger says applied but the physical object cannot be the declared one, and rebuilding is
     * idempotent anyway.</p>
     */
    private boolean physicalExpressionMatches(String name, PluginIndexDeclaration declaration) {
        List<String> definitions = jdbc.query("SELECT indexdef FROM pg_indexes WHERE indexname = ?",
                (rs, index) -> rs.getString(1), name);
        return !definitions.isEmpty() && physicalCastsMatch(definitions.get(0), declaration);
    }

    /** The per-field half of {@link #physicalExpressionMatches}; static so the rule is testable. */
    static boolean physicalCastsMatch(String definition, PluginIndexDeclaration declaration) {
        String text = definition == null ? "" : definition;
        for (PluginIndexDeclaration.DeclaredField field : declaration.fields()) {
            Matcher element = Pattern.compile(
                    "\\(\\s*doc\\s*->>\\s*'" + Pattern.quote(field.name()) + "'::text\\s*\\)")
                    .matcher(text);
            if (!element.find()) {
                return false;
            }
            if (!Objects.equals(followingCast(text, element.end()), castMarker(field.type()))) {
                return false;
            }
        }
        return true;
    }

    /**
     * The cast printed immediately after one field element, or {@code null} when the element is not
     * followed by a cast. PostgreSQL deparses our emitted {@code ((doc ->> 'f')::numeric)} as
     * {@code (((doc ->> 'f'::text))::numeric)}, so only whitespace and closing parentheses separate the
     * element from its cast.
     */
    private static String followingCast(String text, int from) {
        int i = from;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (c == ' ' || c == ')') {
                i++;
                continue;
            }
            if (c == ':' && i + 1 < text.length() && text.charAt(i + 1) == ':') {
                int end = i + 2;
                while (end < text.length() && Character.isLetter(text.charAt(end))) {
                    end++;
                }
                String marker = text.substring(i + 2, end);
                return "timestamp".equals(marker) ? "timestamptz" : marker;
            }
            break;
        }
        return null;
    }

    /** The cast suffix a frozen type adds to {@code (doc ->> 'field')}; {@code null} for text. */
    private static String castMarker(String type) {
        return switch (type) {
            case "string", "date" -> null;
            case "number" -> "numeric";
            case "boolean" -> "boolean";
            default -> throw new IllegalArgumentException("undeclared plugin field type: " + type);
        };
    }

    /**
     * The exact {@code CREATE INDEX} text for one declaration. Static and package-private so
     * {@code PluginRecordsIndexCastTest} can assert it <b>character for character</b> against the forms
     * frozen in spec/data-plane.md (including the date lane's uncrasted text form); a database
     * round-trip would only show PostgreSQL's re-printed definition, not the statement the executor
     * sent.
     */
    static String createStatement(UUID bindingId, PluginIndexDeclaration declaration,
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
            sql.append(columnExpression(declaration.fields().get(i)));
        }
        sql.append(") WHERE ").append(predicate(bindingId.toString(), declaration.collection()));
        return sql.toString();
    }

    /**
     * DP-2/§5.3: the declared field is a scalar expression over the document, not a generated
     * column, and the field's frozen type selects the expression — {@code string} and {@code date} ⇒
     * {@code (doc ->> 'f')}, {@code number} ⇒ {@code ((doc ->> 'f')::numeric)}, {@code boolean} ⇒
     * {@code ((doc ->> 'f')::boolean)}. The forms in {@code data-plane.md} are the <b>elements</b> of
     * the column list: the executor wraps them in the list parentheses, so a single string field
     * becomes {@code ON plugin_records ((doc ->> 'email'))} — verbatim the §6.3 unique sample. The
     * extra parenthesis around a cast is load-bearing: PostgreSQL's {@code index_elem} grammar is
     * {@code '(' a_expr ')'}, so {@code (doc ->> 'f')::numeric} is a syntax error ("at or near ::"),
     * while {@code ((doc ->> 'f')::numeric)} is accepted.
     *
     * <p>{@code date} is <b>not</b> cast: casting a document text to {@code timestamptz} needs
     * {@code timestamptz_in}, which is {@code STABLE}, so PostgreSQL refuses it outright
     * ({@code functions in index expression must be marked IMMUTABLE}, measured on PG 17) — the type
     * therefore stores a normalized fixed-width UTC instant ({@code 2026-11-08T13:40:00Z}, 20 chars)
     * and is ordered by plain text, where lexicographic order equals chronological order. The write
     * path enforces that normalization ({@code PluginRecordsService}), so an un-normalized value can
     * never reach this index. Without a cast {@code ->>} yields text and compares
     * lexicographically ({@code "10" < "9"}), which is the ordering the contract forbids for
     * {@code number}/{@code boolean} — that is why those two keep their cast.</p>
     *
     * <p>The field name was validated against the manifest grammar and the type against the frozen
     * vocabulary before this point, so no manifest-supplied value reaches the statement unvalidated.</p>
     */
    static String columnExpression(PluginIndexDeclaration.DeclaredField field) {
        String doc = "(doc ->> '" + field.name() + "')";
        return switch (field.type()) {
            case "string", "date" -> doc;
            case "number" -> "(" + doc + "::numeric)";
            case "boolean" -> "(" + doc + "::boolean)";
            default -> throw new IllegalArgumentException(
                    "undeclared plugin field type: " + field.type());
        };
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
                declaration.fieldNames().toArray(new String[0])));
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

    /**
     * One ledger row, read back to decide between "already applied" and "rebuild".
     *
     * <p>{@code fields} is the ledger's own name list; the <b>types</b> are not stored there (DP-3),
     * which is why the definition comparison in {@link #physicalExpressionMatches} is needed before
     * an install may skip the rebuild.</p>
     */
    private record Existing(List<String> fields, boolean unique, String state) {

        boolean matches(PluginIndexDeclaration declaration) {
            return "applied".equals(state) && unique == declaration.unique()
                    && fields.equals(declaration.fieldNames());
        }
    }
}
