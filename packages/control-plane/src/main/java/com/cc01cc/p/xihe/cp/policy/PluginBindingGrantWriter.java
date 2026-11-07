package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.persistence.EntityManager;
import jakarta.persistence.TypedQuery;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0691 T1.3: the producer of {@code source='plugin_binding'} grant rows — the missing half of
 * {@link PluginBindingAuthorization}.
 *
 * <p>Before this class the gate was installed but nothing ever issued the hold it asks for: every
 * {@code PLUGIN_BIND} row in {@code grants} came from a role ({@code source='role'}), so a
 * binding-scoped authority had no origin and the "who holds the key to this binding" chain ended at
 * the role. Three write paths now share one lifecycle, all inside the caller's transaction:</p>
 * <ul>
 *   <li><b>create</b> → {@link #materialize} issues one row (idempotent: a second call with the same
 *       binding updates that row instead of adding a second one);</li>
 *   <li><b>update</b> → {@link #materialize} again, because the binding row and its atom set are the
 *       source of truth and the grant must follow them;</li>
 *   <li><b>delete</b> → {@link #revoke} drops every row that binding issued, so the authority dies
 *       with the binding it was derived from.</li>
 * </ul>
 *
 * <h2>Where each column comes from, and why</h2>
 * <p>The lead's ruling for T1.3 fixes the split, and each half is load-bearing:</p>
 * <ul>
 *   <li>{@code permissions} carries the atom ({@code PLUGIN_BIND}) and {@code scope_type='workspace'}
 *       + {@code scope_id} carry the <b>authorization surface</b> — that is literally all the gate
 *       reads ({@code AuthorizationGrantRepository#findScopedGrants} filters on subject, source and
 *       scope only: no granter predicate, no resource predicate).</li>
 *   <li>{@code granter_type='plugin_binding'} + {@code granter_id=<bindingId>} carry the
 *       <b>provenance</b>: which binding a row came from. It is never consulted by authorization and
 *       exists so the write-out side can find the rows again (see {@link #revoke}) and so an audit
 *       reader can answer "which binding gave this actor the atom". This is the same slot
 *       {@code GrantRow.bindingId} documents as provenance.</li>
 *   <li>{@code permissions[].resource} is deliberately <b>not</b> used to record the binding:
 *       {@code resource} is the tool-face resource pattern, and writing the binding id there would
 *       be a field no reader looks at — a comment pretending to be data.</li>
 * </ul>
 *
 * <h2>Grantee</h2>
 * <p>The row's subject is the actor who created the binding (passed in by
 * {@code PluginBindingService}). {@code plugin_bindings} stores no creator column, so this is also
 * the only identity available at the write path; the consequence is stated plainly: the binding
 * carries the authority to manage <i>itself</i>, and a creator who later loses the role still holds
 * {@code PLUGIN_BIND} for as long as the binding exists. That is what makes
 * "delete ⇒ the subject's {@code require()} throws 403" a real assertion instead of a vacuous one
 * (a role-held row would keep answering 200 after the delete).</p>
 *
 * <h2>Transaction boundary</h2>
 * <p>Both methods are {@code @Transactional} with the default {@code REQUIRED} propagation, so they
 * join whatever transaction the caller opened and never commit on their own: a binding delete and
 * its revocation are one atomic unit, and a rollback removes both. Nothing here catches an
 * exception, so a failed revoke fails the caller's write.</p>
 */
@Service
public class PluginBindingGrantWriter {

    private static final Logger log = LoggerFactory.getLogger(PluginBindingGrantWriter.class);

    /** Granter type of a binding-issued row; equals the {@code source} token by construction. */
    public static final String GRANTER_TYPE = GrantSources.PLUGIN_BINDING;

    private static final String READ_STATE_READ = "read";

    /** Rows one binding issued, for any subject: the provenance read (never the gate's read). */
    private static final String SELECT_BY_BINDING = "select g from AuthorizationGrant g "
            + "where g.source = :source and g.granterType = :granterType "
            + "and g.granterId = :granterId";

    /** Same, narrowed to one subject: the reconcile read of {@link #materialize}. */
    private static final String SELECT_BY_BINDING_AND_SUBJECT = SELECT_BY_BINDING
            + " and g.subjectType = :subjectType and g.subjectId = :subjectId";

    private final EntityManager entityManager;
    private final AuthzContext authzContext;
    private final ObjectMapper objectMapper;

    public PluginBindingGrantWriter(EntityManager entityManager, AuthzContext authzContext,
            ObjectMapper objectMapper) {
        this.entityManager = entityManager;
        this.authzContext = authzContext;
        this.objectMapper = objectMapper;
    }

    /**
     * Issues (or reconciles) the one {@code plugin_binding} row for {@code bindingId} / subject, in
     * the caller's transaction.
     *
     * <p>Idempotent by design: the desired state is fully described by the arguments (one atom, one
     * workspace scope), so a re-run repairs a drifted row instead of adding a duplicate. A second row
     * for the same binding and subject cannot be legitimate — it would be a copy of the same hold —
     * and is deleted as part of the reconcile.</p>
     *
     * @param subjectType the grantee subject type, a user subject for every binding write path
     * @param subjectId   the grantee (the binding's creator, see the class javadoc)
     * @param workspaceId the workspace the binding is scoped to
     * @param bindingId   the binding whose authority this row carries, as granter provenance
     * @return the number of rows written (0 when the existing row already matched)
     */
    @Transactional
    public int materialize(String subjectType, UUID subjectId, UUID workspaceId, UUID bindingId) {
        if (subjectType == null || subjectId == null || workspaceId == null || bindingId == null) {
            throw new IllegalArgumentException(
                    "subjectType, subjectId, workspaceId and bindingId are required");
        }
        String atom = PluginBindingAuthorization
                .requiredAtom(PluginBindingAuthorization.Op.BIND_TO_WORKSPACE);
        AccessScope scope = AccessScope.workspace(workspaceId);
        List<AuthorizationGrant> existing = rows(SELECT_BY_BINDING_AND_SUBJECT, bindingId,
                subjectType, subjectId);
        int written = 0;
        AuthorizationGrant keep = null;
        for (AuthorizationGrant row : existing) {
            if (keep == null) {
                keep = row;
                if (align(row, scope, atom)) {
                    written++;
                    log.info("plugin binding grant repaired binding={} subject={} workspace={}",
                            bindingId, subjectId, workspaceId);
                }
            } else {
                // Two rows cannot both be "the" hold of one binding; the extra one is dropped so the
                // reconcile keeps its "exactly one row" invariant.
                entityManager.remove(row);
                written++;
            }
        }
        if (keep == null) {
            entityManager.persist(newGrant(subjectType, subjectId, scope, atom, bindingId));
            written++;
            log.info("plugin binding grant issued binding={} subject={} workspace={} atom={}",
                    bindingId, subjectId, workspaceId, atom);
        }
        invalidateNowAndAfterCompletion(subjectType, subjectId);
        return written;
    }

    /**
     * Re-aligns every row the binding already issued, in the caller's transaction.
     *
     * <p>This is the <b>update</b> path: changing the binding's atom set is not supposed to move
     * authority to a different subject, so no new grantee is created here. Only when the binding has
     * no row at all (a binding written before this class existed) does the reconcile fall back to
     * issuing {@code actorSubject}'s row, so an update can never leave a live binding unattributable.
     * The self-call into {@link #materialize} is intentional and safe: it joins the transaction the
     * caller already opened.</p>
     *
     * @param workspaceId  the workspace the binding is scoped to
     * @param bindingId    the binding whose rows are refreshed
     * @param subjectType  subject type used only by the no-row fallback
     * @param subjectId    subject used only by the no-row fallback
     * @return the number of rows written
     */
    @Transactional
    public int refresh(UUID workspaceId, UUID bindingId, String subjectType, UUID subjectId) {
        if (workspaceId == null || bindingId == null) {
            throw new IllegalArgumentException("workspaceId and bindingId are required");
        }
        List<AuthorizationGrant> existing = rows(SELECT_BY_BINDING, bindingId, null, null);
        if (existing.isEmpty()) {
            return materialize(subjectType, subjectId, workspaceId, bindingId);
        }
        String atom = PluginBindingAuthorization
                .requiredAtom(PluginBindingAuthorization.Op.BIND_TO_WORKSPACE);
        AccessScope scope = AccessScope.workspace(workspaceId);
        int written = 0;
        for (AuthorizationGrant row : existing) {
            if (align(row, scope, atom)) {
                written++;
            }
            invalidateNowAndAfterCompletion(row.getSubjectType(), row.getSubjectId());
        }
        if (written > 0) {
            log.info("plugin binding grants refreshed binding={} workspace={} rows={}", bindingId,
                    workspaceId, written);
        }
        return written;
    }

    /**
     * Drops every grant row the binding issued, in the caller's transaction.
     *
     * <p>Located by provenance ({@code source}, {@code granter_type}, {@code granter_id}) because
     * that is the only column set that identifies "rows of this binding" —
     * {@code AuthorizationGrantRepository} exposes no by-granter query and this task may not extend
     * it, so the read goes through JPQL on the injected {@link EntityManager}. The rows are removed
     * one by one rather than through a bulk {@code delete} so the persistence context stays
     * consistent for the caller's remaining statements (the same transaction also deletes the
     * binding row) and so each subject's cached authorization is invalidated.</p>
     *
     * @param bindingId the binding whose rows are revoked
     * @return the number of rows removed (0 when the binding never issued any)
     */
    @Transactional
    public int revoke(UUID bindingId) {
        if (bindingId == null) {
            throw new IllegalArgumentException("bindingId is required");
        }
        List<AuthorizationGrant> rows = rows(SELECT_BY_BINDING, bindingId, null, null);
        for (AuthorizationGrant row : rows) {
            entityManager.remove(row);
            invalidateNowAndAfterCompletion(row.getSubjectType(), row.getSubjectId());
        }
        if (!rows.isEmpty()) {
            log.info("plugin binding grants revoked binding={} rows={}", bindingId, rows.size());
        }
        return rows.size();
    }

    /** Brings one existing row in line with the desired state; {@code true} when it changed. */
    private boolean align(AuthorizationGrant row, AccessScope scope, String atom) {
        boolean changed = false;
        if (!scope.type().equals(row.getScopeType()) || !scope.id().equals(row.getScopeId())) {
            row.setScopeType(scope.type());
            row.setScopeId(scope.id());
            changed = true;
        }
        if (!carriesOnly(row, atom)) {
            row.setPermissions(atomArray(atom));
            changed = true;
        }
        if (changed) {
            row.setReadState(READ_STATE_READ);
        }
        return changed;
    }

    /** Whether the row's {@code permissions} array is exactly one entry with {@code actionClass}. */
    private static boolean carriesOnly(AuthorizationGrant row, String atom) {
        if (row.getPermissions() == null || !row.getPermissions().isArray()
                || row.getPermissions().size() != 1) {
            return false;
        }
        return atom.equals(row.getPermissions().get(0).path("actionClass").asText(null));
    }

    private AuthorizationGrant newGrant(String subjectType, UUID subjectId, AccessScope scope,
            String atom, UUID bindingId) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setGranterType(GRANTER_TYPE);
        grant.setGranterId(bindingId);
        grant.setSubjectType(subjectType);
        grant.setSubjectId(subjectId);
        grant.setSource(GrantSources.PLUGIN_BINDING);
        grant.setScopeType(scope.type());
        grant.setScopeId(scope.id());
        grant.setReadState(READ_STATE_READ);
        grant.setPermissions(atomArray(atom));
        return grant;
    }

    private ArrayNode atomArray(String atom) {
        ArrayNode permissions = objectMapper.createArrayNode();
        ObjectNode node = objectMapper.createObjectNode();
        node.put("actionClass", atom);
        permissions.add(node);
        return permissions;
    }

    /**
     * Reads the rows of one binding, optionally narrowed to one subject. The statement is one of the
     * two {@code SELECT_BY_*} constants above, so no caller input reaches the JPQL text; the
     * optional subject predicate is only ever added together with both of its parameters.
     */
    private List<AuthorizationGrant> rows(String jpql, UUID bindingId, String subjectType,
            UUID subjectId) {
        TypedQuery<AuthorizationGrant> query = entityManager.createQuery(jpql,
                        AuthorizationGrant.class)
                .setParameter("source", GrantSources.PLUGIN_BINDING)
                .setParameter("granterType", GRANTER_TYPE)
                .setParameter("granterId", bindingId);
        if (subjectType != null) {
            query.setParameter("subjectType", subjectType)
                    .setParameter("subjectId", subjectId);
        }
        return new ArrayList<>(query.getResultList());
    }

    /**
     * Invalidates the subject's cached authorization now and again after the transaction ends,
     * mirroring {@link RoleGrantMaterializer}: the grant set changed, so a lazily filled cache must
     * not keep answering with the previous set even when the caller rolls back.
     */
    private void invalidateNowAndAfterCompletion(String subjectType, UUID subjectId) {
        if (!AuthzContext.SUBJECT_USER.equals(subjectType) || subjectId == null) {
            return;
        }
        authzContext.invalidate(subjectId);
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) {
                authzContext.invalidate(subjectId);
            }
        });
    }
}
