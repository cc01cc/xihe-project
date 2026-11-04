package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.SessionParticipantCursor;
import com.cc01cc.p.xihe.cp.entity.User;
import com.fasterxml.jackson.databind.JsonNode;
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
import java.util.Optional;
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
    public static final String CAP_SPEAK_AS = "speakAs";

    private static final Set<String> KINDS = Set.of(SessionParticipant.KIND_HUMAN,
            SessionParticipant.KIND_AGENT);
    private static final Set<String> ROLES = Set.of(SessionParticipant.ROLE_PRIMARY,
            SessionParticipant.ROLE_MEMBER, SessionParticipant.ROLE_GUARD);
    private static final Set<String> WAKES = Set.of(SessionParticipant.WAKE_ALL_MESSAGES,
            SessionParticipant.WAKE_MENTION, SessionParticipant.WAKE_SCHEDULE);
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
    private final com.cc01cc.p.xihe.cp.scheduled.WakeScheduleProjectionService wakeScheduleProjectionService;
    /** PLAN-0660 T5.1/T5.2: session max sequence (clamp) + the derived unread aggregate. */
    private final EventStoreRepository eventStoreRepository;

    private static final org.slf4j.Logger logger =
            org.slf4j.LoggerFactory.getLogger(SessionParticipantService.class);
    private static final String EVENT_WAKE_DISPATCH = "wake_dispatch";
    private static final com.fasterxml.jackson.databind.ObjectReader PAYLOAD_READER =
            new com.fasterxml.jackson.databind.ObjectMapper().reader();

    public SessionParticipantService(SessionParticipantRepository participantRepository,
                                     SessionParticipantCursorRepository cursorRepository,
                                     SessionRepository sessionRepository,
                                     AgentPrincipalRepository agentPrincipalRepository,
                                     UserRepository userRepository,
                                     WorkspaceService workspaceService,
                                     GrantAuthorizationService grantAuthorizationService,
                com.cc01cc.p.xihe.cp.scheduled.WakeScheduleProjectionService wakeScheduleProjectionService,
            EventStoreRepository eventStoreRepository) {
        this.wakeScheduleProjectionService = wakeScheduleProjectionService;
        this.eventStoreRepository = eventStoreRepository;
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
        Map<UUID, String> humanNames = humanDisplayNames(rows);
        Map<UUID, AgentPrincipal> agents = agentPrincipals(rows);
        // PLAN-0660 T5.2: unread is DERIVED once for the whole roster (one query + Java aggregation).
        Map<UUID, Integer> unread = derivedMentionCounts(session.getId(), cursorThresholds(cursors));
        List<ParticipantView> views = new ArrayList<>(rows.size());
        for (SessionParticipant row : rows) {
            views.add(toView(row, cursors.get(row.getId()), humanNames.get(row.getPrincipalId()),
                    isSelfOwned(row, actorId, session, agents),
                    unread.getOrDefault(row.getId(), 0)));
        }
        // The three capability keys the UI gates its buttons on (never "click then 403").
        Map<String, Boolean> capabilities = new LinkedHashMap<>();
        capabilities.put(CAP_VIEW, true);
        capabilities.put(CAP_MANAGE, canManage(actorId, workspaceId, session));
        capabilities.put(CAP_MENTION, true);
        // D23-27 single truth: the block is true exactly when some row is selfOwned.
        capabilities.put(CAP_SPEAK_AS, views.stream().anyMatch(ParticipantView::selfOwned));
        return new ListView(views, capabilities);
    }

    // ------------------------------------------------------------------ write

    /**
     * PLAN-0660 T5.1: advance ONE human participant's read pointer — the only write the pointer
     * ever gets from a client.
     *
     * <p>Semantics frozen in `spec/session/user-channel.md` §2: <b>advance-only</b>
     * ({@code max(现值, 请求值)}), clamped to the session's current max sequence, and
     * <b>self-only</b> (HUMAN row whose {@code principal_id} is the caller). A candidate who is not
     * the row's own human gets {@code 403 CURSOR_SELF_ONLY}; the pointer never regresses and no
     * counter is written (unread is derived, §3).</p>
     */
    @Transactional
    public CursorView advanceCursor(String actorId, String workspaceId, String sessionId,
                                    String participantId, Long requestedSeq) {
        UUID sessionUuid = parseUuid(sessionId, "SESSION_NOT_FOUND");
        UUID participantUuid = parseUuid(participantId, "PARTICIPANT_NOT_FOUND");
        Session session = sessionRepository.findById(sessionUuid)
                .filter(found -> found.getWorkspaceId() != null
                        && found.getWorkspaceId().equals(workspaceId))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND",
                        "Session not found"));
        SessionParticipant row = participantRepository.findByIdAndSessionId(participantUuid, session.getId())
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "PARTICIPANT_NOT_FOUND",
                        "Participant not found"));
        boolean selfHuman = SessionParticipant.KIND_HUMAN.equals(row.getPrincipalKind())
                && actorId != null
                && row.getPrincipalId() != null
                && actorId.equals(row.getPrincipalId().toString());
        if (!selfHuman) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "CURSOR_SELF_ONLY",
                    "The read cursor can only be advanced by its own human participant");
        }
        long requested = requestedSeq == null ? 0L : Math.max(0L, requestedSeq);
        long clamped = Math.min(requested, lastEventSequence(session.getId()));
        SessionParticipantCursor cursor = cursorRepository.findById(participantUuid)
                .orElseGet(() -> new SessionParticipantCursor(participantUuid, 0L));
        long current = cursor.getLastReadEventSeq() == null ? 0L : cursor.getLastReadEventSeq();
        long next = Math.max(current, clamped);
        cursor.setLastReadEventSeq(next);
        SessionParticipantCursor saved = cursorRepository.save(cursor);
        long threshold = saved.getLastReadEventSeq() == null ? 0L : saved.getLastReadEventSeq();
        int unread = derivedMentionCounts(session.getId(), Map.of(participantUuid, threshold))
                .getOrDefault(participantUuid, 0);
        return new CursorView(saved.getLastReadEventSeq(), unread, saved.getUpdatedAt());
    }

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
        requireDisplayNameNotReserved(kind, principalId);
        if (participantRepository.existsBySessionIdAndPrincipalKindAndPrincipalId(
                session.getId(), kind, principalId)) {
            throw new CpApiException(HttpStatus.CONFLICT, "PARTICIPANT_ALREADY_EXISTS",
                    "This principal is already a participant of the session");
        }
        String wake = request.wakePolicy() == null || request.wakePolicy().isBlank()
                ? SessionParticipant.WAKE_MENTION : requireWake(request.wakePolicy());
        com.fasterxml.jackson.databind.JsonNode wakeConfig =
                requireValidWakeConfig(wake, request.wakeConfig());
        String respond = request.respondPolicy() == null || request.respondPolicy().isBlank()
                ? SessionParticipant.RESPOND_WHEN_MENTIONED : requireRespond(request.respondPolicy());
        int orderIndex = participantRepository.maxOrderIndex(session.getId()) + 10;

        SessionParticipant toSave = new SessionParticipant(
                session.getId(), kind, principalId, role, orderIndex, wake, respond);
        toSave.setWakeConfig(wakeConfig);
        SessionParticipant saved = participantRepository.save(toSave);
        // R7: every participant gets a cursor; history counts as read (same rule as the V92 backfill).
        cursorRepository.save(new SessionParticipantCursor(saved.getId(),
                lastEventSequence(session.getId())));
        return toView(saved, null, humanDisplayName(saved),
                isSelfOwned(saved, actorId, session, agentPrincipals(List.of(saved))), 0);
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
        cursorRepository.save(new SessionParticipantCursor(saved.getId(), 0L));
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
        if (request.wakePolicy() != null && !request.wakePolicy().isBlank()) {
            String wake = requireWake(request.wakePolicy());
            // D24/CLI 语义：非 SCHEDULE ⇒ config 显式清空，绝不残留旧调度参数。
            row.setWakePolicy(wake);
            row.setWakeConfig(requireValidWakeConfig(wake, request.wakeConfig()));
        } else if (request.wakeConfig() != null) {
            // 策略未动、只改 config：按现有策略重新校验并落库（M2 投影联动随 syncParticipant 发生）。
            row.setWakeConfig(requireValidWakeConfig(row.getWakePolicy(), request.wakeConfig()));
        }
        if (request.disabled() != null) {
            if (row.isPrimary() && Boolean.TRUE.equals(request.disabled())) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "PARTICIPANT_PRIMARY_IMMUTABLE",
                        "The PRIMARY participant cannot be disabled");
            }
            row.setDisabledAt(Boolean.TRUE.equals(request.disabled()) ? Instant.now() : null);
        }
        SessionParticipant saved = participantRepository.save(row);
        SessionParticipantCursor savedCursor = cursorRepository.findById(saved.getId()).orElse(null);
        long savedThreshold = savedCursor == null || savedCursor.getLastReadEventSeq() == null
                ? 0L : savedCursor.getLastReadEventSeq();
        return toView(saved, savedCursor, humanDisplayName(saved),
                isSelfOwned(saved, actorId, session, agentPrincipals(List.of(saved))),
                derivedMentionCounts(saved.getSessionId(), Map.of(saved.getId(), savedThreshold))
                        .getOrDefault(saved.getId(), 0));
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
        wakeScheduleProjectionService.cancelProjection(row);
        // Idempotent: a second DELETE on an already-disabled row is a no-op 204, never a 500.
    }

    // ------------------------------------------------------------------ D23-08

        /**
     * R1 (PLAN-0623): the principal this run speaks as. {@code asParticipantId} wins (the caller was
     * already authorized by {@code authorizeAsParticipant}); otherwise the PRIMARY participant answers
     * for the conversation. null when the Session has neither — a legacy/placeholder run keeps NULL,
     * exactly like the V92 backfill which never invents a responder.
     */
    @Transactional(readOnly = true)
    public UUID responderPrincipalIdFor(UUID sessionId, String asParticipantId) {
        Responder responder = responderFor(sessionId, asParticipantId);
        return responder == null ? null : responder.principalId();
    }

    /**
     * PLAN-0623 M1b-②: the responder as a <b>single value object</b>.
     *
     * <p>Same resolution as {@link #responderPrincipalIdFor} (explicit {@code asParticipantId} wins,
     * otherwise the PRIMARY; a session without either keeps {@code null}), but it also carries the
     * {@code principalKind}. Callers must derive <b>both</b> the run attribution
     * ({@code chat_runs.agent_principal_id}) and the run's capability from this one object — never
     * re-resolve either side on its own, otherwise "A's cap" can end up driving "B's" message.</p>
     */
    @Transactional(readOnly = true)
    public Responder responderFor(UUID sessionId, String asParticipantId) {
        if (sessionId == null) {
            return null;
        }
        SessionParticipant row;
        if (asParticipantId != null && !asParticipantId.isBlank()) {
            row = participantRepository
                    .findByIdAndSessionId(parseUuid(asParticipantId, "PARTICIPANT_NOT_FOUND"), sessionId)
                    .orElseThrow(SessionParticipantService::participantNotFound);
        } else {
            row = participantRepository.findBySessionIdOrderByOrderIndexAsc(sessionId).stream()
                    .filter(participant -> SessionParticipant.ROLE_PRIMARY.equals(participant.getRole()))
                    .findFirst()
                    .orElse(null);
        }
        return row == null ? null : new Responder(row.getId(), row.getPrincipalKind(),
                row.getPrincipalId());
    }

    /** The responder triple: participant, its kind, and the principal that actually answers. */
    public record Responder(UUID participantId, String principalKind, UUID principalId) {}

    /**
     * PLAN-0669 D2: the participant row for a (session, principal) pair — used by the single
     * assistant-write point to stamp durable message attribution. Empty when the pair has no row, so
     * the caller persists NULL instead of guessing a participant (an attribution that is wrong is
     * worse than an absent one).
     */
    @Transactional(readOnly = true)
    public Optional<UUID> participantIdForPrincipal(UUID sessionId, UUID principalId) {
        if (sessionId == null || principalId == null) {
            return Optional.empty();
        }
        return participantRepository.findFirstBySessionIdAndPrincipalId(sessionId, principalId)
                .map(SessionParticipant::getId);
    }

/**
     * Authorization for {@code POST /api/v1/chat} with {@code asParticipantId}.
     *
     * <p>Adds nothing to the run yet — writing {@code chat_runs.agent_principal_id} is M1b; this
     * method is the gate that must stay in front of it.</p>
     */
    @Transactional(readOnly = true)
    public SessionParticipant authorizeAsParticipant(String actorId, String workspaceId,
                                                     String sessionId, String asParticipantId) {
        return authorizeAsParticipantInTransaction(actorId, workspaceId, sessionId, asParticipantId);
    }

    /**
     * PLAN-0660 T2.1 (BL-238): the wake path needs the same D23-08 judgment as a <b>value</b>, not as
     * an exception. The catch sits INSIDE this transactional method, so a refusal can never mark the
     * caller's shared transaction rollback-only — that propagation is exactly what made
     * {@code WakeDispatchService.fire()} fail at commit time with
     * {@code UnexpectedRollbackException} and silently swallow the whole wake round.
     *
     * <p>One implementation: every check lives in {@link #authorizeAsParticipantInTransaction} and is
     * shared with {@link #authorizeAsParticipant}; only the failure shape differs (value vs throw).</p>
     */
    @Transactional(readOnly = true)
    public SpeakDecision judgeSpeakAs(String actorId, String workspaceId, String sessionId,
                                      String asParticipantId) {
        try {
            authorizeAsParticipantInTransaction(actorId, workspaceId, sessionId, asParticipantId);
            return SpeakDecision.permit();
        } catch (CpApiException denied) {
            return SpeakDecision.refused(denied.getCode());
        }
    }

    /** The wake path's refusal as a value; {@code code} is the same code the throwing path carries. */
    public record SpeakDecision(boolean allowed, String code) {
        static SpeakDecision permit() {
            return new SpeakDecision(true, null);
        }

        static SpeakDecision refused(String code) {
            return new SpeakDecision(false, code);
        }
    }

    /**
     * PLAN-0665 Q3: gate every explicit TO target ({@code toParticipantIds}) through the <b>same</b>
     * D23-08 judgment as {@code asParticipantId} — a fan-out selector must not become an
     * authorization bypass.
     *
     * <p>M1 accepts <b>AGENT participants only</b>: a human target is refused with
     * {@code 400 INVALID_REQUEST} (not 403 — the caller may legitimately speak as themselves; this
     * is a selector that is not supported yet). Human TO is blocked on BL-238 (the wake path refuses
     * every human participant) and is a separate plan.</p>
     *
     * @return authorized rows in the caller's selection order (first-seen, already de-duplicated)
     */
    @Transactional(readOnly = true)
    public List<SessionParticipant> authorizeToTargets(String actorId, String workspaceId,
                                                       String sessionId, List<UUID> targetParticipantIds) {
        if (targetParticipantIds == null || targetParticipantIds.isEmpty()) {
            return List.of();
        }
        List<SessionParticipant> authorized = new ArrayList<>(targetParticipantIds.size());
        for (UUID target : targetParticipantIds) {
            SessionParticipant row = authorizeAsParticipantInTransaction(actorId, workspaceId,
                    sessionId, target.toString());
            if (!SessionParticipant.KIND_AGENT.equals(row.getPrincipalKind())) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "toParticipantIds currently accepts AGENT participants only; "
                                + "human targets are a later plan");
            }
            authorized.add(row);
        }
        return authorized;
    }

    private SessionParticipant authorizeAsParticipantInTransaction(String actorId, String workspaceId,
                                                                   String sessionId,
                                                                   String asParticipantId) {
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

    /** D24-12: "all" is the reserved @all token; no participant may claim it as a display name. */
    private void requireDisplayNameNotReserved(String kind, UUID principalId) {
        String displayName = null;
        if (SessionParticipant.KIND_AGENT.equals(kind)) {
            displayName = agentPrincipalRepository.findById(principalId)
                    .map(com.cc01cc.p.xihe.cp.entity.AgentPrincipal::getName).orElse(null);
        } else {
            displayName = userRepository.findById(principalId)
                    .map(com.cc01cc.p.xihe.cp.entity.User::getName).orElse(null);
        }
        if (com.cc01cc.p.xihe.cp.chat.MentionParser.isReservedDisplayName(displayName)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_RESERVED_DISPLAY_NAME",
                    "The display name 'all' is reserved for @all");
        }
    }

    private void requireManage(String actorId, String workspaceId, Session session) {
        if (!canManage(actorId, workspaceId, session)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "PARTICIPANT_MANAGE_FORBIDDEN",
                    "Managing participants requires the session owner or MANAGE_WORKSPACE_AGENTS");
        }
    }

    /** AGENT participants of a page, fetched once — displayName, source and selfOwned all read it. */
    private Map<UUID, AgentPrincipal> agentPrincipals(List<SessionParticipant> rows) {
        List<UUID> agentIds = rows.stream()
                .filter(row -> SessionParticipant.KIND_AGENT.equals(row.getPrincipalKind()))
                .map(SessionParticipant::getPrincipalId)
                .filter(java.util.Objects::nonNull)
                .distinct()
                .toList();
        if (agentIds.isEmpty()) {
            return Map.of();
        }
        Map<UUID, AgentPrincipal> byId = new LinkedHashMap<>();
        for (AgentPrincipal agent : agentPrincipalRepository.findAllById(agentIds)) {
            byId.put(agent.getId(), agent);
        }
        return byId;
    }

    /**
     * D23-27: can the caller send <b>as this row</b>? One predicate, two projections — the per-row
     * {@code selfOwned} flag and the block-level {@code speakAs} (true when any row is selfOwned), so
     * the two can never disagree.
     *
     * <p>Mirrors {@link #authorizeAsParticipant} exactly; that method stays the authority and this one
     * only predicts it: speaking is the conversation owner's right (a workspace administrator is
     * never allowed), a HUMAN may speak as themselves, a PERSONAL agent only by its owner, and a
     * WORKSPACE/INSTANCE agent by the conversation owner (it has no single human owner).</p>
     */
    private boolean isSelfOwned(SessionParticipant row, String actorId, Session session,
                                Map<UUID, AgentPrincipal> agents) {
        if (actorId == null || session == null || !actorId.equals(session.getUserId())
                || row.getDisabledAt() != null) {
            return false;
        }
        UUID actor = UUID.fromString(actorId);
        if (SessionParticipant.KIND_HUMAN.equals(row.getPrincipalKind())) {
            return actor.equals(row.getPrincipalId());
        }
        AgentPrincipal agent = agents.get(row.getPrincipalId());
        if (agent == null || agent.getDisabledAt() != null) {
            return false;
        }
        return !"PERSONAL".equals(agent.getScope()) || actor.equals(agent.getOwnerUserId());
    }

    private boolean canManage(String actorId, String workspaceId, Session session) {
        if (actorId == null) {
            return false;
        }
        if (actorId.equals(session.getUserId())) {
            return true;
        }
        // PLAN-0651 T1.3 (D51-29): the instance-administrator bypass is an action atom now —
        // MANAGE_WORKSPACE_MEMBERS at instance scope (ADMIN holds it through the seeded role).
        // A8 deliberately keeps MANAGE_WORKSPACE_AGENTS for the workspace-scope branch so WS_OWNER
        // keeps managing participants exactly as today.
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

    /**
     * The session's current max {@code context_events.sequence} — 0 for a session with no events.
     *
     * <p>PLAN-0660 T5.1: this is the clamp ceiling for the read cursor. It also keeps the V92 rule
     * ("a participant reads from the moment it joined") true on the runtime creation path, not just
     * in the migration backfill.</p>
     */
    private long lastEventSequence(UUID sessionId) {
        return eventStoreRepository.findTopBySessionIdOrderBySequenceDesc(sessionId.toString())
                .map(event -> event.getSequence() == null ? 0L : event.getSequence())
                .orElse(0L);
    }

    /**
     * PLAN-0660 T5.2 (BL-273): {@code participantId → unread mention count} for one session.
     *
     * <p>Unread is a <b>derived</b> value: notify rows whose {@code sequence} is past that
     * participant's pointer. It is deliberately not a stored counter (D66-07 / B-4,
     * `spec/session/user-channel.md` §3).</p>
     *
     * <p><b>Dialect-neutral on purpose (BL-273):</b> the events are fetched with a plain derived
     * query and the {@code payload} JSON is interpreted in Java. The first implementation pushed
     * {@code payload->>'outcome'} into native SQL — PostgreSQL-only syntax that H2
     * ({@code MODE=PostgreSQL}) rejects with {@code SQL 42000}, which broke the roster on the H2 lane
     * while the unit tests stayed green because the repository was mocked. The rule that came out of
     * it: <em>any new native SQL needs a test that really executes it on the test database's dialect</em>.</p>
     */
    private Map<UUID, Integer> derivedMentionCounts(UUID sessionId,
                                                    Map<UUID, Long> cursorSeqByParticipant) {
        if (cursorSeqByParticipant == null || cursorSeqByParticipant.isEmpty()) {
            return Map.of();
        }
        List<ContextEvent> events = eventStoreRepository
                .findBySessionIdAndEventTypeOrderBySequenceAsc(sessionId.toString(), EVENT_WAKE_DISPATCH);
        Map<UUID, Integer> counts = new LinkedHashMap<>();
        for (ContextEvent event : events) {
            String participantId = notifyTargetParticipant(event.getPayload());
            if (participantId == null || event.getSequence() == null) {
                continue;
            }
            UUID participant;
            try {
                participant = UUID.fromString(participantId);
            } catch (IllegalArgumentException malformed) {
                continue;
            }
            Long threshold = cursorSeqByParticipant.get(participant);
            if (threshold == null || event.getSequence() <= threshold) {
                continue;
            }
            counts.merge(participant, 1, Integer::sum);
        }
        return counts;
    }

    /**
     * The {@code participantId} of a {@code wake_dispatch} row whose outcome is {@code notify}, or
     * {@code null} for every other row (other outcomes are not unread mentions).
     */
    private static String notifyTargetParticipant(String payloadJson) {
        if (payloadJson == null || payloadJson.isBlank()) {
            return null;
        }
        try {
            JsonNode payload = PAYLOAD_READER.readTree(payloadJson);
            if (!"notify".equals(payload.path("outcome").asText())) {
                return null;
            }
            String participantId = payload.path("participantId").asText(null);
            return participantId == null || participantId.isBlank() ? null : participantId;
        } catch (java.io.IOException malformed) {
            // A payload we cannot parse cannot be attributed to a participant — log it, never guess.
            logger.warn("[LIFECYCLE] service=cp event=wake_dispatch_payload_unparsable reason={}",
                    malformed.getClass().getSimpleName());
            return null;
        }
    }

    private static Map<UUID, Long> cursorThresholds(Map<UUID, SessionParticipantCursor> cursors) {
        Map<UUID, Long> thresholds = new LinkedHashMap<>();
        cursors.forEach((participantId, cursor) -> thresholds.put(participantId,
                cursor.getLastReadEventSeq() == null ? 0L : cursor.getLastReadEventSeq()));
        return thresholds;
    }

    private ParticipantView toView(SessionParticipant row, SessionParticipantCursor cursor,
                                     String humanDisplayName, boolean selfOwned, int unreadMentions) {
        AgentPrincipal principal = SessionParticipant.KIND_AGENT.equals(row.getPrincipalKind())
                ? agentPrincipalRepository.findById(row.getPrincipalId()).orElse(null)
                : null;
        CursorView cursorView = cursor == null
                ? null
                : new CursorView(cursor.getLastReadEventSeq(), unreadMentions,
                        cursor.getUpdatedAt());
        return new ParticipantView(row.getId(), row.getPrincipalKind(), row.getPrincipalId(),
                row.getRole(), row.getOrderIndex(), row.getWakePolicy(), row.getRespondPolicy(),
                row.getCreatedAt(), row.getDisabledAt(),
                // displayName: AGENT → agent_principals.name; HUMAN → the user display name (a group chat
                // must never show a raw UUID as "who said this"). null only when it cannot be resolved.
                principal == null ? humanDisplayName : principal.getName(),
                principal == null ? null : principal.getDefaultModelProvider(),
                principal == null ? null : principal.getDefaultModelName(),
                principal == null ? null : sourceOf(principal),
                selfOwned, row.getWakeConfig(), cursorView);
    }

    /**
     * HUMAN rows: resolve the name in one batch so a long participant list does not do N+1 lookups.
     * Only HUMAN rows are looked up; AGENT display names come from agent_principals.
     */
    private Map<UUID, String> humanDisplayNames(List<SessionParticipant> rows) {
        List<UUID> humanIds = rows.stream()
                .filter(row -> SessionParticipant.KIND_HUMAN.equals(row.getPrincipalKind()))
                .map(SessionParticipant::getPrincipalId)
                .filter(java.util.Objects::nonNull)
                .distinct()
                .toList();
        if (humanIds.isEmpty()) {
            return Map.of();
        }
        Map<UUID, String> names = new LinkedHashMap<>();
        for (User user : userRepository.findAllById(humanIds)) {
            String name = displayNameOf(user);
            if (name != null) {
                names.put(user.getId(), name);
            }
        }
        return names;
    }

    private String humanDisplayName(SessionParticipant row) {
        if (!SessionParticipant.KIND_HUMAN.equals(row.getPrincipalKind()) || row.getPrincipalId() == null) {
            return null;
        }
        return userRepository.findById(row.getPrincipalId())
                .map(SessionParticipantService::displayNameOf)
                .orElse(null);
    }

    /**
     * PLAN-0623: a human participant is shown by name — {@code name} → {@code username} → the email
     * local part. Returning null here means "the user record is gone", which the UI renders as an
     * unknown-user placeholder rather than a UUID.
     */
    static String displayNameOf(User user) {
        if (user == null) {
            return null;
        }
        if (user.getName() != null && !user.getName().isBlank()) {
            return user.getName();
        }
        if (user.getUsername() != null && !user.getUsername().isBlank()) {
            return user.getUsername();
        }
        String email = user.getEmail();
        if (email == null || email.isBlank()) {
            return null;
        }
        int at = email.indexOf('@');
        String localPart = at > 0 ? email.substring(0, at) : email;
        return localPart.isBlank() ? null : localPart;
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

    /**
     * PLAN-0624 task-74 (wire 补丁): SCHEDULE 必须带合法 wake_config——intervalSeconds 必填
     * 且 ≥60（对齐 M2 的 30s tick 与 V94 CHECK）；jitterSeconds/maxConcurrent 可选。
     * 非 SCHEDULE ⇒ config 必须为 null（显式清除语义，与 CLI 一致）；传了就是 400。
     */
    static com.fasterxml.jackson.databind.JsonNode requireValidWakeConfig(
            String wakePolicy, java.util.Map<String, Object> wakeConfig) {
        boolean schedule = SessionParticipant.WAKE_SCHEDULE.equals(wakePolicy);
        if (!schedule) {
            if (wakeConfig != null && !wakeConfig.isEmpty()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_INVALID_WAKE_CONFIG",
                        "wakeConfig is only valid when wakePolicy is SCHEDULE; it must be omitted otherwise");
            }
            return null;
        }
        if (wakeConfig == null || wakeConfig.isEmpty()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_INVALID_WAKE_CONFIG",
                    "wakeConfig with intervalSeconds is required when wakePolicy is SCHEDULE");
        }
        Object rawInterval = wakeConfig.get("intervalSeconds");
        if (!(rawInterval instanceof Number interval) || interval.intValue() < 60) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_INVALID_WAKE_CONFIG",
                    "wakeConfig.intervalSeconds is required and must be >= 60");
        }
        Object jitter = wakeConfig.get("jitterSeconds");
        if (jitter != null && (!(jitter instanceof Number) || ((Number) jitter).intValue() < 0)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_INVALID_WAKE_CONFIG",
                    "wakeConfig.jitterSeconds must be a non-negative integer");
        }
        Object maxConcurrent = wakeConfig.get("maxConcurrent");
        if (maxConcurrent != null && (!(maxConcurrent instanceof Number)
                || ((Number) maxConcurrent).intValue() < 1)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_INVALID_WAKE_CONFIG",
                    "wakeConfig.maxConcurrent must be a positive integer");
        }
        return new com.fasterxml.jackson.databind.ObjectMapper().valueToTree(wakeConfig);
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
                             String wakePolicy, String respondPolicy,
                             java.util.Map<String, Object> wakeConfig) {}

    public record UpdateRequest(String role, String wakePolicy, String respondPolicy,
                                Boolean disabled,
                                java.util.Map<String, Object> wakeConfig) {}

    public record CursorView(Long lastReadEventSeq, Integer mentionCount, Instant updatedAt) {}

    public record ParticipantView(UUID participantId, String principalKind, UUID principalId,
                                  String role, Integer orderIndex, String wakePolicy,
                                  String respondPolicy, Instant createdAt, Instant disabledAt,
                                  String displayName, String defaultModelProvider,
                                  String defaultModelName, String source, boolean selfOwned,
                                  com.fasterxml.jackson.databind.JsonNode wakeConfig,
                                  CursorView readCursor) {}

    public record ListView(List<ParticipantView> participants, Map<String, Boolean> capabilities) {}
}
