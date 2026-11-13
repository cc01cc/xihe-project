package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0668 D1/D1b (Lead 2026-11-05 ruling): the <b>single</b> session visibility resolver.
 *
 * <p>The two historical predicates — {@code SessionService.requireCurrent} (owner-only) and
 * {@code SessionParticipantService.requireVisibleSession} (owner / invited HUMAN / manager) —
 * drifted apart (BL-237). This component owns the primitive exactly once: {@link #resolve}
 * returns the three flags, and every guard consumes that same decision:</p>
 *
 * <ul>
 *   <li>{@link #requireOwned} — the historical {@code requireCurrent} semantics: owner only,
 *       {@code 404 SESSION_NOT_FOUND}. Every existing write/mutation call site keeps this
 *       mode, so "read widens" never widens a write face.</li>
 *   <li>{@link #requireReadable} — read faces: owner or invited, enabled HUMAN participant.
 *       {@code 404 SESSION_NOT_FOUND} for everyone else (not-区分, no existence oracle).</li>
 *   <li>the roster guard keeps its shipped {@code 403 SESSION_ACCESS_DENIED} shape and still
 *       accepts managers (D2: same decision, per-face error shape frozen).</li>
 * </ul>
 *
 * <p>D1b: managers ({@code MANAGE_WORKSPACE_AGENTS} / instance
 * {@code MANAGE_WORKSPACE_MEMBERS}) are deliberately <b>not</b> part of {@link #requireReadable}
 * — that would let an instance administrator read every conversation's content, which is a much
 * larger authorization change than BL-237 needs. Managers keep the existing roster read only.</p>
 */
@Service
public class SessionReadAccess {

    /** Resolved visibility primitive: one source for roster, owner-only and read guards. */
    public record AccessDecision(boolean owner, boolean invitedHuman, boolean manager) {

        /** D1/D1b: what {@link #requireReadable} accepts (manager is intentionally excluded). */
        public boolean readAllowed() {
            return owner || invitedHuman;
        }

        /** What {@code requireVisibleSession} accepts (managers keep their existing roster read). */
        public boolean rosterAllowed() {
            return owner || invitedHuman || manager;
        }
    }

    /** Session + its visibility decision, resolved together against one snapshot. */
    public record Resolved(Session session, AccessDecision access) {
    }

    private final SessionRepository sessionRepository;
    private final SessionParticipantRepository participantRepository;
    private final WorkspaceService workspaceService;
    private final GrantAuthorizationService grantAuthorizationService;

    public SessionReadAccess(SessionRepository sessionRepository,
                             SessionParticipantRepository participantRepository,
                             WorkspaceService workspaceService,
                             GrantAuthorizationService grantAuthorizationService) {
        this.sessionRepository = sessionRepository;
        this.participantRepository = participantRepository;
        this.workspaceService = workspaceService;
        this.grantAuthorizationService = grantAuthorizationService;
    }

    /**
     * Resolve the session and its visibility decision. Workspace accessibility is enforced by the
     * guards that need it (HTTP read faces), so the roster guard keeps its historical semantics.
     *
     * <p>D-1247 (task-399): a workspace-less session ({@code workspace_id IS NULL}, V145) belongs to
     * its user, not to a workspace, so neither the workspace-context blank check nor the workspace
     * equality filter applies to it — otherwise the caller's ambient workspace (which the
     * interceptor resolves server-side from membership) would 404 every independent session.
     * Workspace-bound rows keep both checks verbatim.</p>
     */
    @Transactional(readOnly = true)
    public Resolved resolve(String actorId, String workspaceId, String sessionId) {
        Session session = sessionRepository.findById(parseUuid(sessionId))
                .filter(found -> !found.isArchived())
                .orElseThrow(SessionReadAccess::sessionNotFound);
        boolean workspaceless = session.getWorkspaceId() == null;
        if (!workspaceless) {
            if (workspaceId == null || workspaceId.isBlank()) {
                throw CpApiException.workspaceContextRequired();
            }
            if (!workspaceId.equals(session.getWorkspaceId())) {
                throw sessionNotFound();
            }
        }
        UUID actorUuid = actorUuid(actorId);
        boolean owner = actorUuid != null && session.getUserId() != null
                && actorUuid.toString().equals(session.getUserId());
        boolean invitedHuman = !owner && actorUuid != null && participantRepository
                .existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                        session.getId(), SessionParticipant.KIND_HUMAN, actorUuid);
        // The manager tier needs a workspace: canManage -> WorkspaceService.isWorkspaceMember
        // parses workspaceId as a UUID (WorkspaceService.java:306) and would NPE on null. A
        // workspace-less session has no workspace to manage, so its roster stays owner/invited.
        // Not a regression: these rows were unreachable (404/409) before this change.
        boolean manager = !owner && !invitedHuman && !workspaceless
                && canManage(actorId, workspaceId, session);
        return new Resolved(session, new AccessDecision(owner, invitedHuman, manager));
    }

    /** Historical {@code requireCurrent}: owner-only, 404 otherwise (write/mutation faces). */
    public Session requireOwned(String actorId, String workspaceId, String sessionId) {
        Resolved resolved = resolve(actorId, workspaceId, sessionId);
        requireWorkspaceFor(actorId, workspaceId, resolved.session());
        if (!resolved.access().owner()) {
            throw sessionNotFound();
        }
        return resolved.session();
    }

    /** PLAN-0668 read faces: owner or invited enabled HUMAN; 404 otherwise. */
    public Session requireReadable(String actorId, String workspaceId, String sessionId) {
        Resolved resolved = resolve(actorId, workspaceId, sessionId);
        requireWorkspaceFor(actorId, workspaceId, resolved.session());
        if (!resolved.access().readAllowed()) {
            throw sessionNotFound();
        }
        return resolved.session();
    }

    /**
     * D23-08 / PLAN-0651 A8: the existing manager predicate — one implementation, moved here so
     * the roster guard and any future caller cannot drift. Requires
     * {@code MANAGE_WORKSPACE_AGENTS} at workspace scope or {@code MANAGE_WORKSPACE_MEMBERS} at
     * instance scope (the atom-level replacement for the old administrator-name bypass).
     */
    public boolean canManage(String actorId, String workspaceId, Session session) {
        if (actorId == null) {
            return false;
        }
        if (actorId.equals(session.getUserId())) {
            return true;
        }
        boolean instanceAdministrator = grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                "manage_session_participants_instance",
                List.of(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS), List.of("*"),
                ToolShape.OPAQUE, actorId, null, session.getId().toString()));
        if (instanceAdministrator) {
            return true;
        }
        if (!workspaceService.isWorkspaceMember(workspaceId, actorId)) {
            return false;
        }
        PolicyRequest request = new PolicyRequest("manage_session_participants",
                List.of(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS), List.of("*"),
                ToolShape.OPAQUE, actorId, workspaceId, session.getId().toString());
        return grantAuthorizationService.allowsUserOnly(request);
    }

    /**
     * D-1247 (task-399): membership is enforced for workspace-bound sessions only. A workspace-less
     * session has no workspace to be a member of — its authority is the owner/invited decision, so
     * requiring a workspace here would make the user's own independent sessions unreachable.
     */
    private void requireWorkspaceFor(String actorId, String workspaceId, Session session) {
        if (session.getWorkspaceId() == null) {
            return;
        }
        requireWorkspace(actorId, workspaceId);
    }

    private void requireWorkspace(String actorId, String workspaceId) {
        if (actorId == null || actorId.isBlank() || workspaceId == null || workspaceId.isBlank()) {
            throw CpApiException.workspaceContextRequired();
        }
        workspaceService.requireAccessibleWorkspace(workspaceId, actorId);
    }

    private static UUID actorUuid(String actorId) {
        if (actorId == null || actorId.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(actorId);
        } catch (IllegalArgumentException notUuid) {
            // Not an existence check: a malformed actor id simply cannot match an owner row or a
            // participant row, and the guard that needs identity answers the same 404 as a miss.
            return null;
        }
    }

    /**
     * BL-294 (Lead ruling 2026-11-05): <b>parameter legality precedes resource visibility</b>.
     *
     * <p>"Not-区分" (one 404 for missing vs forbidden) exists to deny an existence oracle to callers
     * who may not see a Session — it says nothing about a value that is <b>not an id at all</b>.
     * Folding the two together made client debugging impossible ("bad uuid" and "not yours" were the
     * same answer). A malformed {@code sessionId} is a request error, so it answers
     * {@code 400 INVALID_REQUEST}; a <b>well-formed</b> id that is missing, archived, in another
     * workspace, or simply not visible to the caller still answers the single
     * {@code 404 SESSION_NOT_FOUND} — the oracle goal is unchanged.</p>
     */
    private static UUID parseUuid(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "sessionId must be a UUID");
        }
        try {
            return UUID.fromString(sessionId);
        } catch (IllegalArgumentException invalidSessionId) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "sessionId must be a UUID");
        }
    }

    private static CpApiException sessionNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
    }
}
