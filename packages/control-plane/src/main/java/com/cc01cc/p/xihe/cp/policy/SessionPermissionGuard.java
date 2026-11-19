package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.service.SessionReadAccess;

import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Who may change a session's permission tier (task-108 / D-1908 rev3). This component answers only
 * the authorization question; the tier vocabulary, its derived approval mode and the strictest-wins
 * evaluation chain belong to task-107 ({@link SessionPermissionTier}).
 *
 * <p>Two faces, one rule each:</p>
 *
 * <ul>
 *   <li><b>Widening</b> (the target tier is looser than the stored one, or no tier is stored yet, so
 *       no tightening can be proven): the actor must hold the action atom
 *       {@code session:permission:configure} <em>and</em> be the session creator
 *       ({@code sessions.user_id}). There is no session OWNER role — {@code V92:66} allows only
 *       PRIMARY/MEMBER/GUARD for {@code session_participants.role} ({@code V92:64-65}: "Never
 *       OWNER"), so the creator column is the only owner predicate.</li>
 *   <li><b>Tightening</b> (the target tier is strictly stricter than the stored one): any session
 *       participant may do it, without the atom. Giving up authority must never need a grant.</li>
 *   <li><b>No-op</b> (the target tier equals the stored one): no participant's authority changes, so
 *       it is not an escalation at all — any participant may submit it, without the atom, and the
 *       audit record carries {@code noop=true} instead of pretending it was a tightening. Rewriting
 *       the same value is what whole-table UI writes, retries and idempotent PATCHes do; refusing
 *       them for lack of an atom would reject callers that never widened anything.</li>
 * </ul>
 *
 * <p>No role-name special cases here: the capability answer comes from the grant table through
 * {@link RequesterAuthority#holdsActionAtom(UUID, String, UUID)}, and the participant answer from
 * {@link SessionReadAccess}, the single session visibility resolver.</p>
 *
 * <p>Every decision — allowed and refused — writes one audit record under
 * {@link #AUDIT_ACTION} carrying the actor, the session, {@code from -> to}, the atom that
 * participated and where it came from ({@code role} / {@code direct} / ...), so a later "who
 * relaxed this session" question is answerable from the audit trail alone.</p>
 */
@Component
public class SessionPermissionGuard {

    private static final Logger log = LoggerFactory.getLogger(SessionPermissionGuard.class);

    /** Durable audit action of one tier-write decision (allowed or refused). */
    public static final String AUDIT_ACTION = "session.permission.escalated";

    /** Tool dimension of the same audit record. */
    public static final String AUDIT_TOOL = "session_permission_configure";

    /** Widening without the action atom at any scope visible to the caller. */
    public static final String REASON_NO_CAPABILITY = "NO_CAPABILITY";
    /** Atom held but the caller is not the session creator / not a participant. */
    public static final String REASON_NOT_SESSION_OWNER = "NOT_SESSION_OWNER";
    /** Reserved: the workspace-layer ceiling of task-107b; this card's tier has no ceiling logic. */
    public static final String REASON_LAYER_CEILING = "LAYER_CEILING";
    /** The stored tier could not be read, so neither widening nor tightening can be proven. */
    public static final String REASON_TIER_UNREADABLE = "TIER_UNREADABLE";

    /**
     * One authorization decision. {@code fromTier} is {@code null} when the session stores no tier
     * (fresh or pre-V176 row), {@code reason} is {@code null} when allowed, {@code noop} marks a
     * write that leaves the stored tier unchanged (no authority change, so it is allowed for any
     * participant), and {@code atomSources} lists the grant sources that carried the atom
     * ({@code role}/{@code direct}/...).
     */
    public record Decision(boolean allowed, String reason, String fromTier, String toTier,
                           boolean tightening, boolean noop, Set<String> atomSources) {
    }

    private final SessionReadAccess sessionReadAccess;
    private final RequesterAuthority requesterAuthority;
    private final SessionApprovalMode sessionApprovalMode;
    private final AuditLogger auditLogger;

    public SessionPermissionGuard(SessionReadAccess sessionReadAccess,
                                  RequesterAuthority requesterAuthority,
                                  SessionApprovalMode sessionApprovalMode,
                                  AuditLogger auditLogger) {
        this.sessionReadAccess = sessionReadAccess;
        this.requesterAuthority = requesterAuthority;
        this.sessionApprovalMode = sessionApprovalMode;
        this.auditLogger = auditLogger;
    }

    /**
     * Authorizes one tier write.
     *
     * @throws IllegalArgumentException when {@code targetTier} is not view/workspace/full
     * @throws com.cc01cc.p.xihe.cp.config.CpApiException when the session is not addressable by this
     *         actor in this workspace (404/409, the historical session-read shapes)
     */
    public Decision authorize(String actorId, String workspaceId, String sessionId, String targetTier) {
        String toTier = SessionPermissionTier.normalize(targetTier)
                .orElseThrow(() -> new IllegalArgumentException("unsupported permission tier: " + targetTier));
        SessionReadAccess.Resolved resolved = sessionReadAccess.resolve(actorId, workspaceId, sessionId);
        String fromTier;
        try {
            fromTier = currentTier(sessionId);
        } catch (RuntimeException e) {
            // Fail closed: with an unreadable current tier we cannot prove the write is a
            // tightening, so it is refused instead of being treated as one.
            log.error("[POLICY] event=session_permission_tier_unreadable actor={} session={}",
                    actorId, sessionId, e);
            return deny(actorId, workspaceId, sessionId, null, toTier, false, false,
                    REASON_TIER_UNREADABLE, Set.of());
        }
        // Three states, not two: the write changes nothing (no-op), it narrows the session
        // (tightening), or it widens it (needs atom + creator). A stored tier equal to the target
        // is an idempotent rewrite, never an escalation — UI whole-table writes and retried PATCHes
        // land here and must not be refused for lacking an atom.
        boolean noop = fromTier != null && fromTier.equals(toTier);
        boolean tightening = !noop && fromTier != null && strictness(toTier) < strictness(fromTier);

        if (noop || tightening) {
            if (!resolved.access().readAllowed()) {
                return deny(actorId, workspaceId, sessionId, fromTier, toTier, tightening, noop,
                        REASON_NOT_SESSION_OWNER, Set.of());
            }
            return allow(actorId, workspaceId, sessionId, fromTier, toTier, tightening, noop, Set.of());
        }

        boolean capability = holdsConfigureAtom(actorId, workspaceId);
        Set<String> sources = capability ? atomSources(actorId, workspaceId) : Set.of();
        if (!capability) {
            return deny(actorId, workspaceId, sessionId, fromTier, toTier, false, false,
                    REASON_NO_CAPABILITY, sources);
        }
        if (!resolved.access().owner()) {
            return deny(actorId, workspaceId, sessionId, fromTier, toTier, false, false,
                    REASON_NOT_SESSION_OWNER, sources);
        }
        return allow(actorId, workspaceId, sessionId, fromTier, toTier, false, false, sources);
    }

    /**
     * Stored tier, falling back to the tier that a pre-V176 {@code approval_mode} row implies. Empty
     * means "no stored override" (the session inherits); a failed read propagates.
     */
    private String currentTier(String sessionId) {
        Optional<String> stored = sessionApprovalMode.tierOf(sessionId);
        if (stored.isPresent()) {
            return stored.get();
        }
        return sessionApprovalMode.modeOf(sessionId).map(SessionPermissionTier::tierForMode).orElse(null);
    }

    private static int strictness(String tier) {
        return SessionPermissionTier.STRICTNESS_ORDER.indexOf(tier);
    }

    private boolean holdsConfigureAtom(String actorId, String workspaceId) {
        UUID subjectId = parseUuid(actorId);
        if (subjectId == null) {
            return false;
        }
        return requesterAuthority.holdsActionAtom(subjectId,
                ToolFaceRegistry.ACTION_SESSION_PERMISSION_CONFIGURE, parseUuid(workspaceId));
    }

    private Set<String> atomSources(String actorId, String workspaceId) {
        UUID subjectId = parseUuid(actorId);
        if (subjectId == null) {
            return Set.of();
        }
        return requesterAuthority.atomSources(subjectId,
                ToolFaceRegistry.ACTION_SESSION_PERMISSION_CONFIGURE, parseUuid(workspaceId));
    }

    private Decision allow(String actorId, String workspaceId, String sessionId, String fromTier,
                           String toTier, boolean tightening, boolean noop, Set<String> sources) {
        audit(actorId, workspaceId, sessionId, "allowed", null, fromTier, toTier, tightening, noop, sources);
        return new Decision(true, null, fromTier, toTier, tightening, noop, sources);
    }

    private Decision deny(String actorId, String workspaceId, String sessionId, String fromTier,
                          String toTier, boolean tightening, boolean noop, String reason,
                          Set<String> sources) {
        log.warn("[POLICY] event=session_permission_denied reason={} actor={} session={} from={} to={}"
                        + " tightening={} noop={}",
                reason, actorId, sessionId, fromTier, toTier, tightening, noop);
        audit(actorId, workspaceId, sessionId, "denied", reason, fromTier, toTier, tightening, noop, sources);
        return new Decision(false, reason, fromTier, toTier, tightening, noop, sources);
    }

    private void audit(String actorId, String workspaceId, String sessionId, String result, String reason,
                       String fromTier, String toTier, boolean tightening, boolean noop,
                       Set<String> sources) {
        String detail = "result=" + result
                + " reason=" + (reason == null ? "-" : reason)
                + " actor=" + actorId
                + " sessionId=" + sessionId
                + " from=" + (fromTier == null ? "-" : fromTier)
                + " to=" + (toTier == null ? "-" : toTier)
                + " tightening=" + tightening
                + " noop=" + noop
                + " atom=" + ToolFaceRegistry.ACTION_SESSION_PERMISSION_CONFIGURE
                + " atomSources=" + (sources.isEmpty() ? "-" : String.join(",", sources));
        auditLogger.record(sessionId, AUDIT_TOOL, AUDIT_ACTION, detail, workspaceId, actorId);
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
