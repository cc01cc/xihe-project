package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.service.SessionReadAccess;
import com.cc01cc.p.xihe.cp.service.SessionReadService;
import com.fasterxml.jackson.databind.JsonNode;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * task-124 / DSD-1509: issues, lists and revokes <b>session-level temporary capability tokens</b>.
 *
 * <p>R2 of DSD-1500 removed {@code exec} from the agent defaults, so a running conversation has no
 * execution path unless a human hands it one for a bounded time. This service is that hand: a row in
 * {@code session_temporary_grants} (V180) names one session, one agent principal, the atoms it
 * covers and an expiry; {@link GrantAuthorizationService} reads the live rows on every decision and
 * lets them replace the per-level holding test for exactly those pairs.</p>
 *
 * <p><b>The gates (DSD-1509 ④)</b>:</p>
 * <ul>
 *   <li><b>G1</b> — issuing needs the session <em>creator</em> and the
 *       {@code session:permission:configure} atom in the addressed workspace: the same pair the tier
 *       face requires to <em>widen</em> a session (D-1908 rev3), because both loosen what the agent
 *       may do inside a conversation.</li>
 *   <li><b>G2</b> — the issued atoms must be a subset of what the caller itself holds in that
 *       workspace, resource prefixes included ({@code fs:<ws>} covers {@code fs:<ws>/src}, nothing
 *       covers a different root), and capability atoms ({@code cap:*}) are refused outright: this
 *       table carries action atoms only. A token can therefore never hand out authority the issuer
 *       did not have.</li>
 *   <li><b>G3</b> — leaf-only: the row is written with the session's own PRIMARY principal and is
 *       read back only for the request's own session id, so it neither inherits from a parent
 *       session nor propagates to a spawned child.</li>
 * </ul>
 *
 * <p><b>Revocation needs no atom</b>: any participant who can read the session may revoke, mirroring
 * the tier rule that tightening is always allowed (D-1908 rev3). Revoking is a conditional UPDATE
 * ({@link SessionTemporaryGrantStore#revoke}); the next decision re-reads the table, so the
 * capability is gone on the next call rather than after {@code cp.capability-cache-ttl-ms}.</p>
 *
 * <p><b>TTL</b> is bounded, not optional: 60s..8h, default 15 minutes. Expiry is a SQL predicate, so
 * an expired row authorizes nothing even if nothing ever deletes it.</p>
 */
@Service
public class SessionTemporaryGrantService {

    /** Bounds and default from DSD-1509 ④; both are user-visible contract values (openapi). */
    public static final int DEFAULT_TTL_SECONDS = 900;
    public static final int MIN_TTL_SECONDS = 60;
    public static final int MAX_TTL_SECONDS = 8 * 60 * 60;

    /** One request may carry at most this many atoms; keeps the token reviewable by a human. */
    public static final int MAX_ATOMS = 20;

    /** Audit action names; task-125 reads the same trail, so they are constants, not literals. */
    public static final String AUDIT_GRANTED = "session.temporary_grant.granted";
    public static final String AUDIT_REVOKED = "session.temporary_grant.revoked";
    /** The tool name both audit rows carry; it is not a tool the agent can call. */
    static final String AUDIT_TOOL = "session_temporary_grant";

    private final SessionTemporaryGrantStore store;
    private final SessionReadAccess sessionReadAccess;
    private final SessionReadService sessionReadService;
    private final RequesterAuthority requesterAuthority;
    private final AuditLogger auditLogger;

    public SessionTemporaryGrantService(SessionTemporaryGrantStore store,
                                        SessionReadAccess sessionReadAccess,
                                        SessionReadService sessionReadService,
                                        RequesterAuthority requesterAuthority,
                                        AuditLogger auditLogger) {
        this.store = store;
        this.sessionReadAccess = sessionReadAccess;
        this.sessionReadService = sessionReadService;
        this.requesterAuthority = requesterAuthority;
        this.auditLogger = auditLogger;
    }

    /**
     * Issues one token.
     *
     * @param rawAtoms the request's {@code atoms} array: {@code [{actionClass, resource?}]}; a missing
     *        resource means the wildcard, exactly as in {@code grants.permissions}
     * @param ttlSeconds requested lifetime; {@code null} means {@link #DEFAULT_TTL_SECONDS}
     * @throws CpApiException 400 for a malformed request/TTL, 403 for a gate, 404 for an unreadable
     *         session, 409 when the session has no PRIMARY principal yet
     */
    @Transactional
    public SessionTemporaryGrant issue(String actorId, String workspaceId, String sessionId,
                                       JsonNode rawAtoms, Integer ttlSeconds) {
        SessionReadAccess.Resolved resolved =
                sessionReadAccess.resolve(actorId, workspaceId, sessionId);
        // An actor who cannot read the session learns 404, the same answer the session surface gives
        // everywhere else. Checking creatorship first would turn this face into an existence oracle:
        // 403 would prove that the session exists to someone who is not allowed to see it.
        if (!resolved.access().readAllowed()) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
        if (!resolved.access().owner()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "only the session creator may issue a temporary grant");
        }
        UUID actorUuid = parseUuid(actorId);
        UUID workspaceUuid = parseUuid(workspaceId);
        if (actorUuid == null || workspaceUuid == null) {
            throw new CpApiException(HttpStatus.CONFLICT, "WORKSPACE_CONTEXT_REQUIRED",
                    "a workspace context is required to issue a temporary grant");
        }
        if (!requesterAuthority.holdsActionAtom(actorUuid,
                ToolFaceRegistry.ACTION_SESSION_PERMISSION_CONFIGURE, workspaceUuid)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    ToolFaceRegistry.ACTION_SESSION_PERMISSION_CONFIGURE
                            + " is required to issue a temporary grant");
        }
        List<GrantIntersectionEvaluator.PermissionAtom> atoms = parseAtoms(rawAtoms);
        int ttl = ttlSeconds == null ? DEFAULT_TTL_SECONDS : ttlSeconds;
        if (ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "ttlSeconds must be between " + MIN_TTL_SECONDS + " and " + MAX_TTL_SECONDS);
        }
        requireWithinCallerAtoms(actorUuid, workspaceUuid, atoms);
        UUID principalId = leafPrincipalId(sessionId);

        Instant now = Instant.now();
        SessionTemporaryGrant row = new SessionTemporaryGrant(
                UUID.randomUUID(), resolved.session().getId(), workspaceUuid, principalId, atoms,
                actorUuid, now, now.plusSeconds(ttl), null, null);
        store.insert(row);
        auditLogger.record(sessionId, AUDIT_TOOL, AUDIT_GRANTED,
                "grantId=" + row.id() + " atoms=" + row.atomLabels()
                        + " expiresAt=" + row.expiresAt(),
                workspaceId, actorId);
        return row;
    }

    /** The read face: live tokens of one session; any participant who can read the session sees them. */
    @Transactional(readOnly = true)
    public List<SessionTemporaryGrant> list(String actorId, String workspaceId, String sessionId) {
        sessionReadAccess.requireReadable(actorId, workspaceId, sessionId);
        return store.listLive(parseUuid(sessionId), Instant.now());
    }

    /**
     * Revokes one token of this session. Returns the row as it was just before revocation (for the
     * response body). Absent, already revoked, expired and another session's id all report the same
     * 404 — a revocation must not become an existence oracle.
     */
    @Transactional
    public SessionTemporaryGrant revoke(String actorId, String workspaceId, String sessionId,
                                        String grantId) {
        sessionReadAccess.requireReadable(actorId, workspaceId, sessionId);
        UUID grantUuid = parseUuid(grantId);
        UUID sessionUuid = parseUuid(sessionId);
        if (grantUuid == null || sessionUuid == null) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "TEMPORARY_GRANT_NOT_FOUND",
                    "temporary grant not found");
        }
        Instant now = Instant.now();
        SessionTemporaryGrant existing = store.findLiveById(grantUuid, now)
                .filter(row -> sessionUuid.equals(row.sessionId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "TEMPORARY_GRANT_NOT_FOUND", "temporary grant not found"));
        int updated = store.revoke(grantUuid, sessionUuid, parseUuid(actorId), now);
        if (updated == 0) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "TEMPORARY_GRANT_NOT_FOUND",
                    "temporary grant not found");
        }
        auditLogger.record(sessionId, AUDIT_TOOL, AUDIT_REVOKED,
                "grantId=" + grantUuid + " atoms=" + existing.atomLabels(), workspaceId, actorId);
        return existing;
    }

    /**
     * G2: every requested atom must be covered by an atom the caller holds in this workspace, with
     * resource-prefix containment. Capability atoms never enter this table (they are decided by the
     * capability kernel, not by a temporary row).
     */
    private void requireWithinCallerAtoms(UUID actorId, UUID workspaceId,
                                          List<GrantIntersectionEvaluator.PermissionAtom> atoms) {
        Set<GrantIntersectionEvaluator.PermissionAtom> held =
                requesterAuthority.actionPermissions(actorId, workspaceId);
        for (GrantIntersectionEvaluator.PermissionAtom atom : atoms) {
            if (PermissionAtomCatalog.isCapabilityAtom(atom.actionClass())) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "a temporary grant cannot carry capability atom " + atom.actionClass());
            }
            boolean covered = false;
            for (GrantIntersectionEvaluator.PermissionAtom mine : held) {
                if (!atom.actionClass().equals(mine.actionClass())) {
                    continue;
                }
                if (coversResource(mine.resource(), atom.resource())) {
                    covered = true;
                    break;
                }
            }
            if (!covered) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "PRIVILEGE_ESCALATION",
                        "Cannot grant an atom the caller does not hold: "
                                + atom.actionClass() + "@" + atom.resource());
            }
        }
    }

    /**
     * Does {@code heldResource} cover {@code requestedResource}?
     *
     * <p>Two {@code fs:} declaration keys are compared as prefixes inside the same root
     * ({@code fs:<ws>} covers {@code fs:<ws>/src}); a declaration key on one side only is never
     * compared as a string (501 §10.4 ⑦, the same refusal {@link ResourceIdentity} makes). Anything
     * else is the wildcard or an exact value — a partial glob is <b>not</b> treated as a prefix, so an
     * unusual pattern cannot silently widen the token.</p>
     */
    static boolean coversResource(String heldResource, String requestedResource) {
        ResourceIdentity.FsKey held = ResourceIdentity.parseDeclaration(heldResource);
        ResourceIdentity.FsKey wanted = ResourceIdentity.parseDeclaration(requestedResource);
        if (held != null && wanted != null) {
            return held.rootScopeId().equals(wanted.rootScopeId())
                    && relativePrefix(held.relativePath(), wanted.relativePath());
        }
        if (held != null || wanted != null) {
            return false;
        }
        if (heldResource == null || requestedResource == null) {
            return false;
        }
        return "*".equals(heldResource) || heldResource.equals(requestedResource);
    }

    /** Path-segment prefix: {@code ""} covers everything in the root, {@code a/b} covers {@code a/b/c}. */
    private static boolean relativePrefix(String prefix, String path) {
        String base = prefix == null ? "" : prefix;
        String target = path == null ? "" : path;
        if (base.isEmpty()) {
            return true;
        }
        return target.equals(base) || target.startsWith(base + "/");
    }

    private List<GrantIntersectionEvaluator.PermissionAtom> parseAtoms(JsonNode rawAtoms) {
        if (rawAtoms == null || !rawAtoms.isArray() || rawAtoms.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "atoms must be a non-empty array of {actionClass, resource?}");
        }
        if (rawAtoms.size() > MAX_ATOMS) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "at most " + MAX_ATOMS + " atoms may be issued at once");
        }
        List<GrantIntersectionEvaluator.PermissionAtom> atoms = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (JsonNode node : rawAtoms) {
            if (node == null || !node.isObject()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "each atom must be an object");
            }
            JsonNode actionClass = node.get("actionClass");
            JsonNode resource = node.get("resource");
            if (actionClass == null || !actionClass.isTextual()
                    || (resource != null && !resource.isTextual())) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "each atom requires a string actionClass and an optional string resource");
            }
            atomFields(node);
            if (PermissionAtomCatalog.isCapabilityAtom(actionClass.asText())) {
                // Capability atoms ("instance:admin" …) are decided by the capability kernel; they are
                // not action classes, so they would otherwise die on the record's vocabulary check and
                // report a misleading "unknown action class".
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "a temporary grant cannot carry capability atom " + actionClass.asText());
            }
            GrantIntersectionEvaluator.PermissionAtom atom;
            try {
                atom = new GrantIntersectionEvaluator.PermissionAtom(actionClass.asText(),
                        resource == null ? "*" : resource.asText());
            } catch (IllegalArgumentException e) {
                // The record's own vocabulary check is the contract; surface it as a 400, never a 500.
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", e.getMessage());
            }
            String key = atom.actionClass() + "|" + atom.resource();
            if (seen.add(key)) {
                atoms.add(atom);
            }
        }
        return List.copyOf(atoms);
    }

    /** Same closed field set as {@code grants.permissions}; an unknown field is a client bug, not a no-op. */
    private static void atomFields(JsonNode node) {
        node.fieldNames().forEachRemaining(field -> {
            if (!"actionClass".equals(field) && !"resource".equals(field)) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "unknown atom field: " + field);
            }
        });
    }

    /** G3: the token belongs to the session's own PRIMARY agent principal, never to a caller-supplied id. */
    private UUID leafPrincipalId(String sessionId) {
        UUID sessionUuid = parseUuid(sessionId);
        String principalId = sessionUuid == null ? null
                : sessionReadService.findById(sessionUuid)
                        .map(SessionReadService.SessionPathView::agentPrincipalId)
                        .orElse(null);
        UUID principalUuid = parseUuid(principalId);
        if (principalUuid == null) {
            throw new CpApiException(HttpStatus.CONFLICT, "SESSION_PRINCIPAL_MISSING",
                    "the session has no agent principal to grant to");
        }
        return principalUuid;
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Response/audit projection: an atom list as plain JSON objects (never a policy input). */
    public static List<Map<String, Object>> atomViews(SessionTemporaryGrant row) {
        List<Map<String, Object>> views = new ArrayList<>();
        for (GrantIntersectionEvaluator.PermissionAtom atom : row.atoms()) {
            Map<String, Object> view = new java.util.LinkedHashMap<>();
            view.put("actionClass", atom.actionClass());
            view.put("resource", atom.resource());
            views.add(view);
        }
        return views;
    }
}
