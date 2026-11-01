package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.SessionParticipantCursor;
import com.cc01cc.p.xihe.cp.policy.CapabilityAuthorities;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0623 M1a: session participants — CRUD, invariants and the two authorization paths.
 *
 * <p>The two paths are deliberately different (D23-08):</p>
 * <ul>
 *   <li><b>manage</b> (add / change / remove a member) — the session owner, or whoever holds
 *       {@code MANAGE_WORKSPACE_AGENTS} in the session's workspace. An administrator may therefore
 *       <i>add people</i> to a conversation they do not own.</li>
 *   <li><b>send as</b> ({@code asParticipantId}) — only as a participant the caller is authorized
 *       for: themselves (HUMAN), or an agent principal in a session they own. Holding
 *       {@code MANAGE_WORKSPACE_AGENTS} never grants "speak on someone else's behalf"; that is
 *       speaking for someone else ({@code PARTICIPANT_CAP_DENIED}).</li>
 * </ul>
 *
 * <p>D23-13: the PRIMARY participant is unique (database partial index), cannot be removed and
 * cannot be transferred. Those refusals carry explicit business codes — never a 500 and never a
 * bare {@code DataIntegrityViolationException}.</p>
 */
@Service
public class SessionParticipantService {

    /** Capability keys exposed to the UI (PLAN-0623 UI: 点击前就要禁用/提示). */
    public static final String CAP_VIEW = "view";
    public static final String CAP_MANAGE = "manage";
    public static final String CAP_MENTION = "mention";

    private static final Set<String> KINDS = Set.of(SessionParticipant.KIND_HUMAN,
            SessionParticipant.KIND_AGENT);
    private static final Set<String> ROLES = Set.of(SessionParticipant.ROLE_PRIMARY,
            SessionParticipant.ROLE_MEMBER, SessionParticipant.ROLE_GUARD);
    private static final Set<String> WAKES = Set.of(SessionParticipant.WAKE_ALL_MESSAGES,
            SessionParticipant.WAKE_MENTION);
    private static final Set<String> RESPONDS = Set.of(SessionParticipant.RESPOND_ALWAYS,
            SessionParticipant.RESPOND_WHEN_MENTIONED, SessionParticipant.RESPOND_JUDGE,
            SessionParticipant.RESPOND_MUTED);

    private final SessionParticipantRepository participantRepository;
    private final SessionParticipantCursorRepository cursorRepository;
    private final SessionRepository sessionRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;
    private final UserRepository userRepository;
    private final WorkspaceService workspaceService;
    private final GrantAuthorizationService grantAuthorizationService;

    public SessionParticipantService(SessionParticipantRepository participantRepository,
                                     SessionParticipantCursorRepository cursorRepository,
                                     SessionRepository sessionRepository,
                                     AgentPrincipalRepository agentPrincipalRepository,
                                     UserRepository userRepository,
                                     WorkspaceService workspaceService,
                                     GrantAuthorizationService grantAuthorizationService) {
        this.participantRepository = participantRepository;
        this.cursorRepository = cursorRepository;
        this.sessionRepository = sessionRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.userRepository = userRepository;
        this.workspaceService = workspaceService;
        this.grantAuthorizationService = grantAuthorizationService;
    }

    // ------------------------------------------------------------------ read

    @Transactional(readOnly = true)
    public ListView list(String actorId, String workspaceId, String sessionId) {
        Session session = requireVisibleSession(actorId, workspaceId, sessionId);
        List<SessionParticipant> rows = participantRepository
                .findBySessionIdOrderByOrderIndexAsc(session.getId());
        Map<UUID, SessionParticipantCursor> cursors = new LinkedHashMap<>();
        if (!rows.isEmpty()) {
            cursorRepository.findByParticipantIdIn(rows.stream().map(SessionParticipant::getId).toList())
                    .forEach(cursor -> cursors.put(cursor.getParticipantId(), cursor));
        }
        List<ParticipantView> views = new ArrayList<>(rows.size());
        for (SessionParticipant row : rows) {
            views.add(toView(row, cursors.get(row.getId())));
        }
        // The three capability keys the UI gates its buttons on (never "click then 403").
        Map<String, Boolean> capabilities = new LinkedHashMap<>();
        capabilities.put(CAP_VIEW, true);
        capabilities.put(CAP_MANAGE, canManage(actorId, workspaceId, session));
        capabilities.put(CAP_MENTION, true);
        return new ListView(views, capabilities);
    }

    // ------------------------------------------------------------------ write

    @Transactional
    public ParticipantView add(String actorId, String workspaceId, String sessionId, AddRequest request) {
        Session session = requireVisibleSession(actorId, workspaceId, sessionId);
        requireManage(actorId, workspaceId, session);

        String kind = requireKind(request.principalKind());
        UUID principalId = parseUuid(request.principalId(), "PARTICIPANT_INVALID_PRINCIPAL");
        String role = request.role() == null || request.role().isBlank()
                ? SessionParticipant.ROLE_MEMBER : requireRole(request.role());
        if (SessionParticipant.ROLE_PRIMARY.equals(role)) {
            // D23-13: the PRIMARY is created with the session; a second one is never valid.
            throw new CpApiException(HttpStatus.CONFLICT, "PARTICIPANT_PRIMARY_EXISTS",
                    "The session already has a PRIMARY participant; PRIMARY is never added or transferred");
        }
        requirePrincipalExists(kind, principalId);
        if (participantRepository.existsBySessionIdAndPrincipalKindAndPrincipalId(
                session.getId(), kind, principalId)) {
            throw new CpApiException(HttpStatus.CONFLICT, "PARTICIPANT_ALREADY_EXISTS",
                    "This principal is already a participant of the session");
        }
        String wake = request.wakePolicy() == null || request.wakePolicy().isBlank()
                ? SessionParticipant.WAKE_MENTION : requireWake(request.wakePolicy());
        String respond = request.respondPolicy() == null || request.respondPolicy().isBlank()
                ? SessionParticipant.RESPOND_WHEN_MENTIONED : requireRespond(request.respondPolicy());
        int orderIndex = participantRepository.maxOrderIndex(session.getId()) + 10;

        SessionParticipant saved = participantRepository.save(new SessionParticipant(
                session.getId(), kind, principalId, role, orderIndex, wake, respond));
        // R7: every participant gets a cursor; history counts as read (same rule as the V92 backfill).
        cursorRepository.save(new SessionParticipantCursor(saved.getId(),
                lastEventSequence(session.getId()), 0));
        return toView(saved, null);
    }

    /** D23-13: the PRIMARY row's fixed position — the V92 backfill and every creation path agree. */
    private static final int PRIMARY_ORDER_INDEX = 10;

    /**
     * D23-13: keeps "a Session that has an Agent principal has exactly one PRIMARY participant" true
     * on every path that establishes the principal — Session creation and the later bind of a
     * principal-null placeholder.
     *
     * <p>Runs inside the caller's transaction on purpose: a Session without its PRIMARY (or a PRIMARY
     * without its cursor row) is the inconsistency this method exists to prevent. Idempotent: an
     * existing PRIMARY is left untouched, so create-then-bind cannot produce two.</p>
     *
     * <p>A principal-null Session (the 0614 placeholder) returns early — there is no conversation
     * principal yet, so inventing a PRIMARY would fake one. That emptiness is deliberate.</p>
     */
    @Transactional
    public void ensurePrimaryParticipant(UUID sessionId, String agentPrincipalId) {
        if (sessionId == null || agentPrincipalId == null || agentPrincipalId.isBlank()) {
            return;
        }
        if (participantRepository.existsBySessionIdAndRole(sessionId, SessionParticipant.ROLE_PRIMARY)) {
            return;
        }
        SessionParticipant saved = participantRepository.save(new SessionParticipant(
                sessionId, SessionParticipant.KIND_AGENT,
                parseUuid(agentPrincipalId, "INVALID_AGENT_PRINCIPAL"),
                SessionParticipant.ROLE_PRIMARY, PRIMARY_ORDER_INDEX,
                SessionParticipant.WAKE_ALL_MESSAGES, SessionParticipant.RESPOND_ALWAYS));
        // R7: the PRIMARY reads from the beginning — the same rule the V92 backfill applies.
        cursorRepository.save(new SessionParticipantCursor(saved.getId(), 0L, 0));
    }
    @Transactional
    public ParticipantView update(String actorId, String workspaceId, String sessionId,
                                  String participantId, UpdateRequest request) {
        Session session = requireVisibleSession(actorId, workspaceId, sessionId);
        requireManage(actorId, workspaceId, session);
        SessionParticipant row = participantRepository
                .findByIdAndSessionId(parseUuid(participantId, "PARTICIPANT_NOT_FOUND"), session.getId())
                .orElseThrow(SessionParticipantService::participantNotFound);

        if (request.role() != null && !request.role().isBlank()) {
            String role = requireRole(request.role());
            if (row.isPrimary()) {
                // D23-13: PRIMARY is not transferable — a new conversation is the way to hand over.
                throw new CpApiException(HttpStatus.FORBIDDEN, "PARTICIPANT_PRIMARY_IMMUTABLE",
                        "The PRIMARY participant cannot be changed or transferred");
            }
            if (SessionParticipant.ROLE_PRIMARY.equals(role)) {
                throw new CpApiException(HttpStatus.CONFLICT, "PARTICIPANT_PRIMARY_EXISTS",
                        "The session already has a PRIMARY participant");
            }
            row.setRole(role);
        }
        if (request.wakePolicy() != null && !request.wakePolicy().isBlank()) {
            row.setWakePolicy(requireWake(request.wakePolicy()));
        }
        if (request.respondPolicy() != null && !request.respondPolicy().isBlank()) {
            row.setRespondPolicy(requireRespond(request.respondPolicy()));
        }
        if (request.disabled() != null) {
            if (row.isPrimary() && Boolean.TRUE.equals(request.disabled())) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "PARTICIPANT_PRIMARY_IMMUTABLE",
                        "The PRIMARY participant cannot be disabled");
            }
            row.setDisabledAt(Boolean.TRUE.equals(request.disabled()) ? Instant.now() : null);
        }
        SessionParticipant saved = participantRepository.save(row);
        return toView(saved, cursorRepository.findById(saved.getId()).orElse(null));
    }

    @Transactional
    public void remove(String actorId, String workspaceId, String sessionId, String participantId) {
        Session session = requireVisibleSession(actorId, workspaceId, sessionId);
        requireManage(actorId, workspaceId, session);
        SessionParticipant row = participantRepository
                .findByIdAndSessionId(parseUuid(participantId, "PARTICIPANT_NOT_FOUND"), session.getId())
                .orElseThrow(SessionParticipantService::participantNotFound);
        if (row.isPrimary()) {
            // D23-13: PRIMARY is unique and irreducible; removal needs a new session.
            throw new CpApiException(HttpStatus.FORBIDDEN, "PARTICIPANT_PRIMARY_IMMUTABLE",
                    "The PRIMARY participant cannot be removed");
        }
        // D23-26: "remove" is a soft disable. The row (and its cursor) stay so the UI can keep the
        // line with a "disabled" badge and the audit trail keeps "this person was in the
        // conversation". Hard deletion would silently drop the cursor history.
        if (row.getDisabledAt() == null) {
            row.setDisabledAt(Instant.now());
            participantRepository.save(row);
        }
        // Idempotent: a second DELETE on an already-disabled row is a no-op 204, never a 500.
    }

    // ------------------------------------------------------------------ D23-08

    /**
     * Authorization for {@code POST /api/v1/chat} with {@code asParticipantId}.
     *
     * <p>Adds nothing to the run yet — writing {@code chat_runs.agent_principal_id} is M1b; this
     * method is the gate that must stay in front of it.</p>
     */
    @Transactional(readOnly = true)
    public SessionParticipant authorizeAsParticipant(String actorId, String workspaceId,
                                                     String sessionId, String asParticipantId) {
        Session session = requireVisibleSession(actorId, workspaceId, sessionId);
        SessionParticipant row = participantRepository
                .findByIdAndSessionId(parseUuid(asParticipantId, "PARTICIPANT_NOT_FOUND"), session.getId())
                .orElseThrow(SessionParticipantService::participantNotFound);
        if (row.getDisabledAt() != null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "PARTICIPANT_DISABLED",
                    "This participant is disabled and cannot send messages");
        }
        UUID actorUuid = parseUuid(actorId, "PARTICIPANT_CAP_DENIED");
        if (SessionParticipant.KIND_HUMAN.equals(row.getPrincipalKind())) {
            if (!actorUuid.equals(row.getPrincipalId())) {
                // D23-08: speaking as another human is impersonation, not delegation.
                throw capDenied();
            }
            return row;
        }
        // AGENT: the caller must own the conversation; a workspace administrator who merely added
        // the member may not speak for it.
        if (!actorId.equals(session.getUserId())) {
            throw capDenied();
        }
        AgentPrincipal principal = agentPrincipalRepository.findById(row.getPrincipalId())
                .orElseThrow(SessionParticipantService::principalNotFound);
        if ("PERSONAL".equals(principal.getScope())
                && !actorUuid.equals(principal.getOwnerUserId())) {
            throw capDenied();
        }
        if (principal.getDisabledAt() != null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "PARTICIPANT_DISABLED",
                    "The agent principal of this participant is disabled");
        }
        return row;
    }

    // ------------------------------------------------------------------ helpers

    private Session requireVisibleSession(String actorId, String workspaceId, String sessionId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            throw new CpApiException(HttpStatus.CONFLICT, "WORKSPACE_CONTEXT_REQUIRED",
                    "A workspace context is required to read session participants");
        }
        Session session = sessionRepository.findById(parseUuid(sessionId, "SESSION_NOT_FOUND"))
                .filter(found -> !found.isArchived() && workspaceId.equals(found.getWorkspaceId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                        "Session not found"));
        boolean owner = actorId != null && actorId.equals(session.getUserId());
        boolean invited = actorId != null && participantRepository
                .existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                        session.getId(), SessionParticipant.KIND_HUMAN,
                        parseUuid(actorId, "SESSION_ACCESS_DENIED"));
        // D23-08: an administrator who may manage this workspace's agents must also be able to add
        // people to a conversation they do not own, so "manage authority" counts as visibility here;
        // it never implies "speak as" (see authorizeAsParticipant).
        boolean manager = !owner && !invited && canManage(actorId, workspaceId, session);
        if (!owner && !invited && !manager) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "SESSION_ACCESS_DENIED",
                    "Only the session owner or an invited participant may read the participant list");
        }
        return session;
    }

    private void requireManage(String actorId, String workspaceId, Session session) {
        if (!canManage(actorId, workspaceId, session)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "PARTICIPANT_MANAGE_FORBIDDEN",
                    "Managing participants requires the session owner or MANAGE_WORKSPACE_AGENTS");
        }
    }

    private boolean canManage(String actorId, String workspaceId, Session session) {
        if (actorId == null) {
            return false;
        }
        if (actorId.equals(session.getUserId()) || CapabilityAuthorities.isInstanceAdmin()) {
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

    private void requirePrincipalExists(String kind, UUID principalId) {
        if (SessionParticipant.KIND_HUMAN.equals(kind)) {
            if (!userRepository.existsById(principalId)) {
                throw principalNotFound();
            }
            return;
        }
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(SessionParticipantService::principalNotFound);
        if (principal.getDisabledAt() != null) {
            throw new CpApiException(HttpStatus.CONFLICT, "PARTICIPANT_PRINCIPAL_DISABLED",
                    "A disabled agent principal cannot join a session");
        }
    }

    private long lastEventSequence(UUID sessionId) {
        // V92 backfills from MAX(context_events.sequence); participants created later start there too
        // so "unread" means "events after the moment you joined", never the whole history.
        return 0L;
    }

    private ParticipantView toView(SessionParticipant row, SessionParticipantCursor cursor) {
        AgentPrincipal principal = SessionParticipant.KIND_AGENT.equals(row.getPrincipalKind())
                ? agentPrincipalRepository.findById(row.getPrincipalId()).orElse(null)
                : null;
        CursorView cursorView = cursor == null
                ? null
                : new CursorView(cursor.getLastReadEventSeq(), cursor.getMentionCount(),
                        cursor.getUpdatedAt());
        return new ParticipantView(row.getId(), row.getPrincipalKind(), row.getPrincipalId(),
                row.getRole(), row.getOrderIndex(), row.getWakePolicy(), row.getRespondPolicy(),
                row.getCreatedAt(), row.getDisabledAt(),
                // AGENT-only projection: displayName/model intent/source (UI row). HUMAN rows stay null — no fakes.
                principal == null ? null : principal.getName(),
                principal == null ? null : principal.getDefaultModelProvider(),
                principal == null ? null : principal.getDefaultModelName(),
                principal == null ? null : sourceOf(principal),
                cursorView);
    }

    private static String sourceOf(AgentPrincipal principal) {
        String scope = principal.getScope();
        return scope == null ? null : scope.toLowerCase(Locale.ROOT);
    }

    private static String requireKind(String value) {
        if (value == null || !KINDS.contains(value)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_INVALID_KIND",
                    "principalKind must be HUMAN or AGENT");
        }
        return value;
    }

    private static String requireRole(String value) {
        if (!ROLES.contains(value)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_INVALID_ROLE",
                    "role must be PRIMARY, MEMBER or GUARD");
        }
        return value;
    }

    private static String requireWake(String value) {
        if (!WAKES.contains(value)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_INVALID_WAKE_POLICY",
                    "wakePolicy must be ALL_MESSAGES or MENTION");
        }
        return value;
    }

    private static String requireRespond(String value) {
        if (!RESPONDS.contains(value)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_INVALID_RESPOND_POLICY",
                    "respondPolicy must be ALWAYS, WHEN_MENTIONED, JUDGE or MUTED");
        }
        return value;
    }

    private static UUID parseUuid(String value, String code) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, code, "A valid UUID is required");
        }
    }

    private static CpApiException participantNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "PARTICIPANT_NOT_FOUND",
                "Session participant not found");
    }

    private static CpApiException principalNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "PARTICIPANT_PRINCIPAL_NOT_FOUND",
                "The referenced principal does not exist");
    }

    private static CpApiException capDenied() {
        return new CpApiException(HttpStatus.FORBIDDEN, "PARTICIPANT_CAP_DENIED",
                "You may only send as a participant you are authorized for");
    }

    // ------------------------------------------------------------------ views

    public record AddRequest(String principalKind, String principalId, String role,
                             String wakePolicy, String respondPolicy) {}

    public record UpdateRequest(String role, String wakePolicy, String respondPolicy,
                                Boolean disabled) {}

    public record CursorView(Long lastReadEventSeq, Integer mentionCount, Instant updatedAt) {}

    public record ParticipantView(UUID participantId, String principalKind, UUID principalId,
                                  String role, Integer orderIndex, String wakePolicy,
                                  String respondPolicy, Instant createdAt, Instant disabledAt,
                                  String displayName, String defaultModelProvider,
                                  String defaultModelName, String source, CursorView readCursor) {}

    public record ListView(List<ParticipantView> participants, Map<String, Boolean> capabilities) {}
}
