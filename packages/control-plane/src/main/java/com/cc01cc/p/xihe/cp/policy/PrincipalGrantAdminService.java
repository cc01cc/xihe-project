package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthUserLockService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0585: the audited administrator surface that grants or revokes one user's
 * {@code CREATE_ACCOUNT} / {@code MANAGE_WORKSPACE_AGENTS} atoms.
 *
 * <p>Design decisions #4-#9 (2026-10-30): only instance ADMINs reach this service (enforced by the
 * controller), the write is a PATCH difference set, the target is addressed by exact username, and
 * the state lives in the subject's single {@code source='direct'} grant row — the row that V65
 * ({@code uq_grants_direct_subject}) already allows only once per subject. Nothing here touches the
 * {@code source='default'} row, so the default-deny baseline of the three opt-in action classes is
 * unchanged; revoking simply removes the atom again.</p>
 *
 * <p>Concurrency (decision #9): the write path serializes on the <em>target</em> user row
 * ({@link AuthUserLockService}); the actor is taken from the JWT and never locked, which avoids an
 * A&lt;-&gt;B mutual-grant deadlock. A {@code 409 DIRECT_GRANT_CONFLICT} is only the fallback for an
 * insert that raced a writer bypassing this lock (the V65 unique index is the fence). A lock wait
 * beyond {@code cp.lock-timeout-ms} surfaces as 503 {@code OPERATION_LOCK_TIMEOUT} at the API edge
 * through {@link DbLockTimeout}, so it is intentionally not caught here.</p>
 *
 * <p>Atoms outside the manageable pair — including known classes such as {@code read} or
 * {@code CREATE_TEMPLATE} that may share the same direct row — are preserved verbatim; this surface
 * never rewrites another domain's grants. The read view therefore reports only the manageable atoms,
 * so its list matches exactly what the write path can produce while unrelated atoms stay untouched.</p>
 */
@Service
public class PrincipalGrantAdminService {

    private static final Logger logger = LoggerFactory.getLogger(PrincipalGrantAdminService.class);

    private static final String RESOURCE_WILDCARD = "*";
    private static final String AUDIT_RESOURCE_TYPE = "principal_grant";
    private static final String ACTION_ADDED = "principal_grant_added";
    private static final String ACTION_REMOVED = "principal_grant_removed";
    /** V65 partial unique index {@code uq_grants_direct_subject} — the only 409 trigger. */
    private static final String DIRECT_GRANT_CONSTRAINT = "uq_grants_direct_subject";

    private final AuthorizationGrantRepository grantRepository;
    private final UserRepository userRepository;
    private final WorkspaceRepository workspaceRepository;
    private final AuthUserLockService userLock;
    private final GrantIntersectionEvaluator evaluator;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;
    private final DbLockTimeout dbLockTimeout;

    public PrincipalGrantAdminService(AuthorizationGrantRepository grantRepository,
                                      UserRepository userRepository,
                                      WorkspaceRepository workspaceRepository,
                                      AuthUserLockService userLock,
                                      GrantIntersectionEvaluator evaluator,
                                      AuditLogger auditLogger,
                                      ObjectMapper objectMapper,
                                      DbLockTimeout dbLockTimeout) {
        this.grantRepository = grantRepository;
        this.userRepository = userRepository;
        this.workspaceRepository = workspaceRepository;
        this.userLock = userLock;
        this.evaluator = evaluator;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
        this.dbLockTimeout = dbLockTimeout;
    }

    /** One requested {@code {actionClass, resource?}} atom from the PATCH body. */
    public record AtomInput(String actionClass, String resource) {}

    /** One manageable atom as returned by the read view and the PATCH response. */
    public record AtomView(String actionClass, String resource) {}

    /** Read view: the target identity and the atoms this surface manages (no self flag on the wire). */
    public record GrantView(String userId, String username, List<AtomView> grants) {}

    /** Write result: the persisted view plus whether this request actually changed anything. */
    public record GrantMutation(String userId, String username, List<AtomView> grants,
                                boolean changed) {}

    @Transactional(readOnly = true)
    public GrantView read(String username) {
        User target = requireTargetUser(username);
        DirectGrantState state = readDirectGrantState(target.getId());
        return new GrantView(target.getId().toString(), target.getUsername(),
                views(state.managed()));
    }

    @Transactional
    public GrantMutation patch(String actorUserId, String username,
                               List<AtomInput> add, List<AtomInput> remove) {
        if (add == null && remove == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "At least one of add or remove is required");
        }
        Set<GrantIntersectionEvaluator.PermissionAtom> additions = requireAtoms(add, "add");
        Set<GrantIntersectionEvaluator.PermissionAtom> removals = requireAtoms(remove, "remove");
        if (!Collections.disjoint(additions, removals)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "The same atom cannot be added and removed in one request");
        }
        requireExistingWorkspaces(additions);

        User target = requireTargetUser(username);
        String targetUserId = target.getId().toString();
        boolean self = isSelf(actorUserId, target);

        // Decision #9: bound the lock wait, then serialize on the target user row only.
        dbLockTimeout.apply();
        User locked = userLock.lockAndFind(target.getId())
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND",
                        "User not found"));

        AuthorizationGrant row = findDirectRow(locked.getId());
        DirectGrantState state = readDirectGrantState(locked.getId(), row);
        Set<GrantIntersectionEvaluator.PermissionAtom> merged = new LinkedHashSet<>(state.managed());
        merged.addAll(additions);
        merged.removeAll(removals);

        Set<GrantIntersectionEvaluator.PermissionAtom> effectiveAdded = new LinkedHashSet<>(additions);
        effectiveAdded.removeAll(state.managed());
        Set<GrantIntersectionEvaluator.PermissionAtom> effectiveRemoved =
                new LinkedHashSet<>(removals);
        effectiveRemoved.retainAll(state.managed());

        if (merged.equals(state.managed())) {
            // Decision #7: idempotent replay — 200 changed:false, no save, no additional audit.
            return new GrantMutation(targetUserId, locked.getUsername(), views(merged), false);
        }

        persist(row, locked, actorUserId, merged, state.preserved());
        for (GrantIntersectionEvaluator.PermissionAtom atom : effectiveAdded) {
            audit(actorUserId, targetUserId, ACTION_ADDED, atom, self);
        }
        for (GrantIntersectionEvaluator.PermissionAtom atom : effectiveRemoved) {
            audit(actorUserId, targetUserId, ACTION_REMOVED, atom, self);
        }
        return new GrantMutation(targetUserId, locked.getUsername(), views(merged), true);
    }

    // --- read side -------------------------------------------------------------------------

    /** The atoms this surface manages plus the untouched rest of the direct row. */
    private record DirectGrantState(Set<GrantIntersectionEvaluator.PermissionAtom> managed,
                                    List<JsonNode> preserved) {}

    private DirectGrantState readDirectGrantState(UUID userId) {
        return readDirectGrantState(userId, findDirectRow(userId));
    }

    private DirectGrantState readDirectGrantState(UUID userId, AuthorizationGrant row) {
        Set<GrantIntersectionEvaluator.PermissionAtom> managed = new LinkedHashSet<>();
        List<JsonNode> preserved = new ArrayList<>();
        if (row == null || row.getPermissions() == null) {
            return new DirectGrantState(managed, preserved);
        }
        for (JsonNode atom : row.getPermissions()) {
            if (!isManagedAtom(atom)) {
                preserved.add(atom.deepCopy());
                continue;
            }
            try {
                managed.addAll(evaluator.parse(singletonArray(atom)));
            } catch (IllegalArgumentException e) {
                // A stored atom we cannot canonicalize is kept byte-for-byte instead of failing
                // the whole request (this surface never rewrites another domain's atoms).
                logger.warn("[POLICY] event=principal_grant_atom_preserved reason={}",
                        e.getMessage());
                preserved.add(atom.deepCopy());
            }
        }
        return new DirectGrantState(managed, preserved);
    }

    private AuthorizationGrant findDirectRow(UUID userId) {
        return grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.USER, userId).stream()
                .filter(grant -> PrincipalGrantActionCatalog.SOURCE_DIRECT.equals(grant.getSource()))
                .findFirst()
                .orElse(null);
    }

    // --- write side ------------------------------------------------------------------------

    private void persist(AuthorizationGrant row, User target, String actorUserId,
                         Set<GrantIntersectionEvaluator.PermissionAtom> merged,
                         List<JsonNode> preserved) {
        if (merged.isEmpty() && preserved.isEmpty()) {
            if (row != null) {
                grantRepository.delete(row);
            }
            return;
        }
        AuthorizationGrant direct = row;
        if (direct == null) {
            direct = new AuthorizationGrant();
            direct.setId(UUID.randomUUID());
            direct.setSubjectType(GrantPrincipalPathResolver.USER);
            direct.setSubjectId(target.getId());
            direct.setGranterType(GrantPrincipalPathResolver.USER);
            direct.setGranterId(UUID.fromString(actorUserId));
            direct.setSource(PrincipalGrantActionCatalog.SOURCE_DIRECT);
            direct.setReadState(PrincipalGrantActionCatalog.READ_STATE_READ);
        }
        direct.setPermissions(toJson(merged, preserved));
        try {
            grantRepository.saveAndFlush(direct);
        } catch (DataIntegrityViolationException e) {
            // V65 fence: only the direct-row uniqueness race becomes 409. Every other integrity
            // failure (FK, CHECK, serialization) keeps its normal mapping — disguising those as a
            // retryable conflict would hide a real bug behind an idempotent retry.
            if (!mentionsConstraint(e, DIRECT_GRANT_CONSTRAINT)) {
                throw e;
            }
            throw new CpApiException(HttpStatus.CONFLICT, "DIRECT_GRANT_CONFLICT",
                    "The direct grant changed concurrently; retry the request", e);
        }
    }

    /** True when the failure chain names the given database constraint. */
    static boolean mentionsConstraint(Throwable failure, String constraint) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            String message = cause.getMessage();
            if (message != null && message.contains(constraint)) {
                return true;
            }
        }
        return false;
    }

    /**
     * One durable audit row per changed atom (decision #8). {@code resource_id} is the resolved
     * target {@code userId}; {@code workspace_id} is null for the instance-wide
     * {@code CREATE_ACCOUNT} atom and the target workspace id for a workspace-scoped
     * {@code MANAGE_WORKSPACE_AGENTS} atom. The detail stays key=value so it neither needs a schema
     * change nor trips the audit sanitizer.
     */
    private void audit(String actorUserId, String targetUserId, String action,
                       GrantIntersectionEvaluator.PermissionAtom atom, boolean self) {
        auditLogger.recordDurableChange(actorUserId, auditWorkspaceId(atom), action,
                AUDIT_RESOURCE_TYPE, targetUserId, "subjectType=" + GrantPrincipalPathResolver.USER
                        + " subjectId=" + targetUserId
                        + " atom=" + atom.actionClass() + "@" + atom.resource()
                        + " self=" + self);
    }

    /**
     * Decision #4 + the {@code audit_logs.workspace_id} FK ({@code V1__init_schema.sql:382}):
     * an instance-wide {@code CREATE_ACCOUNT} atom audits with no workspace, a workspace-scoped
     * {@code MANAGE_WORKSPACE_AGENTS} atom audits against that workspace. A revoke of an atom whose
     * workspace has since been deleted falls back to no workspace instead of failing the FK.
     */
    private String auditWorkspaceId(GrantIntersectionEvaluator.PermissionAtom atom) {
        if (!ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS.equals(atom.actionClass())) {
            return null;
        }
        UUID workspaceId = UUID.fromString(atom.resource());
        return workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId).isPresent()
                ? atom.resource() : null;
    }

    // --- helpers ---------------------------------------------------------------------------

    private User requireTargetUser(String username) {
        if (username == null || username.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A username is required");
        }
        // Exact match, no case folding: usernames are stored lowercase and the login layer
        // normalizes input; an upper-case spelling is simply an unknown user.
        return userRepository.findByUsername(username)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND",
                        "User not found"));
    }

    private Set<GrantIntersectionEvaluator.PermissionAtom> requireAtoms(List<AtomInput> atoms,
                                                                       String field) {
        Set<GrantIntersectionEvaluator.PermissionAtom> result = new LinkedHashSet<>();
        if (atoms == null) {
            return result;
        }
        for (AtomInput atom : atoms) {
            if (atom == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "Each entry of " + field + " must be an object");
            }
            result.add(PrincipalGrantActionCatalog.requireManageable(
                    atom.actionClass(), atom.resource()));
        }
        return result;
    }

    /**
     * Decision #5 allows granting against any workspace (the effective gate is the target user's
     * membership, evaluated later by the binding path). The existence check below is an
     * <em>implementation fact</em> of the audit FK — {@code audit_logs.workspace_id} references
     * {@code workspaces(id)} ({@code V1__init_schema.sql:382}) — and not a tightening of the product
     * authorization semantics: a grant to a workspace that no longer exists can never take effect
     * and would abort the audit insert. Revokes stay permissive so a stale atom can always be
     * cleaned up (their audit falls back to {@code workspace_id=null}).
     */
    private void requireExistingWorkspaces(
            Set<GrantIntersectionEvaluator.PermissionAtom> additions) {
        for (GrantIntersectionEvaluator.PermissionAtom atom : additions) {
            if (!ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS.equals(atom.actionClass())) {
                continue;
            }
            UUID workspaceId = UUID.fromString(atom.resource());
            if (workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId).isEmpty()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_GRANT_RESOURCE",
                        "MANAGE_WORKSPACE_AGENTS requires an existing workspace");
            }
        }
    }

    /** Audit-only self marker (decision #8): the response carries no self field. */
    private static boolean isSelf(String actorUserId, User target) {
        return actorUserId != null && actorUserId.equals(target.getId().toString());
    }

    private static boolean isManagedAtom(JsonNode atom) {
        if (atom == null || !atom.isObject()) {
            return false;
        }
        JsonNode actionClass = atom.get("actionClass");
        return actionClass != null && actionClass.isTextual()
                && PrincipalGrantActionCatalog.manageable(actionClass.asText());
    }

    private ArrayNode singletonArray(JsonNode atom) {
        ArrayNode array = objectMapper.createArrayNode();
        array.add(atom);
        return array;
    }

    private ArrayNode toJson(Set<GrantIntersectionEvaluator.PermissionAtom> managed,
                             List<JsonNode> preserved) {
        ArrayNode result = objectMapper.createArrayNode();
        managed.stream()
                .sorted(Comparator.comparing(GrantIntersectionEvaluator.PermissionAtom::actionClass)
                        .thenComparing(GrantIntersectionEvaluator.PermissionAtom::resource))
                .forEach(atom -> {
                    ObjectNode node = objectMapper.createObjectNode();
                    node.put("actionClass", atom.actionClass());
                    if (!RESOURCE_WILDCARD.equals(atom.resource())) {
                        node.put("resource", atom.resource());
                    }
                    result.add(node);
                });
        preserved.forEach(result::add);
        return result;
    }

    private static List<AtomView> views(Set<GrantIntersectionEvaluator.PermissionAtom> managed) {
        return managed.stream()
                .sorted(Comparator.comparing(GrantIntersectionEvaluator.PermissionAtom::actionClass)
                        .thenComparing(GrantIntersectionEvaluator.PermissionAtom::resource))
                .map(atom -> new AtomView(atom.actionClass(), atom.resource()))
                .toList();
    }
}
