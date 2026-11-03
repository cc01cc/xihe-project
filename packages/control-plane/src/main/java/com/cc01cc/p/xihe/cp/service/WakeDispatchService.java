package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.chat.DelegationChainWalker;
import com.cc01cc.p.xihe.cp.chat.SessionWakeupService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * PLAN-0624 M4 (D24-03/10/15): the filled-in wake dispatch — one entry for every trigger.
 *
 * <p>Rules baked in:</p>
 * <ul>
 *   <li><b>D23-08 (Lead ruling on task-73): system-triggered ≠ authorization-exempt.</b>
 *       Every fire — schedule, mention, chain — passes
 *       {@code SessionParticipantService.authorizeAsParticipant} with the session owner as
 *       actor before any run exists. A wake can never speak as a participant the owner
 *       could not speak as.</li>
 *   <li><b>人=通知，agent=唤醒</b> (SPRINT iron rule): a HUMAN recipient never gets a run —
 *       the fan-out records a {@code wake_dispatch} outcome {@code notify} event (SSE =
 *       the v1 站内 channel) and advances the cursor's {@code mention_count}.</li>
 *   <li><b>respond_policy branches</b>: ALWAYS/WHEN_MENTIONED submit a run via
 *       {@link SessionWakeupService#wakeupAs} (responder attribution + trigger_source inside
 *       one transaction); JUDGE asks {@link JudgeDecisionService} (throttled per
 *       participant+round, D24-02) and only a {@code "speak":true} verdict submits;
 *       MUTED is audited as {@code skipped_muted}.</li>
 * </ul>
 */
@Service
public class WakeDispatchService {

    private static final Logger logger = LoggerFactory.getLogger(WakeDispatchService.class);
    static final String EVENT_WAKE_DISPATCH = "wake_dispatch";

    private final SessionParticipantRepository participantRepository;
    private final SessionRepository sessionRepository;
    private final SessionParticipantService participantService;
    private final SessionWakeupService sessionWakeupService;
    private final JudgeDecisionService judgeDecisionService;
    private final EventStoreService eventStoreService;
    private final SessionParticipantCursorRepository cursorRepository;
    private final ObjectMapper objectMapper;
    private final ChatRunRepository chatRunRepository;
    private final DbLockTimeout dbLockTimeout;
    private final DelegationChainWalker chainWalker;

    public WakeDispatchService(SessionParticipantRepository participantRepository,
                               SessionRepository sessionRepository,
                               SessionParticipantService participantService,
                               SessionWakeupService sessionWakeupService,
                               JudgeDecisionService judgeDecisionService,
                               EventStoreService eventStoreService,
                               SessionParticipantCursorRepository cursorRepository,
                               ObjectMapper objectMapper,
                               ChatRunRepository chatRunRepository,
                               DbLockTimeout dbLockTimeout) {
        this.participantRepository = participantRepository;
        this.sessionRepository = sessionRepository;
        this.participantService = participantService;
        this.sessionWakeupService = sessionWakeupService;
        this.judgeDecisionService = judgeDecisionService;
        this.eventStoreService = eventStoreService;
        this.cursorRepository = cursorRepository;
        this.objectMapper = objectMapper;
        this.chatRunRepository = chatRunRepository;
        this.dbLockTimeout = dbLockTimeout;
        this.chainWalker = new DelegationChainWalker(sessionRepository, chatRunRepository);
    }

    /**
     * Fires one participant wake. Never throws for refuse/skip outcomes — those are audit
     * events; only infrastructure failures propagate.
     *
     * @param parentRunId PLAN-0630 M2: the durable chain parent — non-null only for chain/judge
     *                    hops. Inside the parent run row lock the chain is walked (a missing
     *                    ancestor refuses with {@code ancestor_missing}) and the duplicate-hop
     *                    guard refuses a participant this parent already woke, so two concurrent
     *                    hops from the same parent run can never each admit a run (T2.8/T2.9).
     */
    @Transactional
    public WakeFireResult fire(UUID participantId, String triggerSource, String wakeRoundId,
                               UUID sessionId, String parentRunId) {
        SessionParticipant participant = participantRepository.findById(participantId).orElse(null);
        if (participant == null || participant.getDisabledAt() != null) {
            audit(sessionId, participantId, triggerSource, wakeRoundId, "refused",
                    "participant is gone or disabled", null, parentRunId);
            return new WakeFireResult(false, null, "refused");
        }
        Session session = sessionRepository.findById(sessionId).orElse(null);
        if (session == null) {
            audit(sessionId, participantId, triggerSource, wakeRoundId, "refused",
                    "session is gone", null, parentRunId);
            return new WakeFireResult(false, null, "refused");
        }
        // D23-08: the wake path carries the SAME authorization as the owner's --as.
        try {
            participantService.authorizeAsParticipant(session.getUserId(), session.getWorkspaceId(),
                    sessionId.toString(), participantId.toString());
        } catch (CpApiException denied) {
            audit(sessionId, participantId, triggerSource, wakeRoundId, "refused",
                    "authorization: " + denied.getCode(), null, parentRunId);
            return new WakeFireResult(false, null, "refused");
        }

        if (SessionParticipant.KIND_HUMAN.equals(participant.getPrincipalKind())) {
            notifyHuman(sessionId, participant, triggerSource, wakeRoundId, parentRunId);
            return new WakeFireResult(false, null, "notify");
        }
        String policy = participant.getRespondPolicy() == null
                ? SessionParticipant.RESPOND_WHEN_MENTIONED : participant.getRespondPolicy();
        if (SessionParticipant.RESPOND_MUTED.equals(policy)) {
            audit(sessionId, participantId, triggerSource, wakeRoundId, "skipped_muted",
                    null, null, parentRunId);
            return new WakeFireResult(false, null, "skipped_muted");
        }
        UUID chainParentRunId = null;
        if (parentRunId != null) {
            // T2.8/T2.9: durable chain admission — inside the parent run row lock, same serialization
            // the spawn gate uses. Broken chain (missing ancestor) and duplicate hops refuse here,
            // before any wake run exists.
            try {
                chainParentRunId = UUID.fromString(parentRunId);
            } catch (IllegalArgumentException notUuid) {
                return chainRefused(sessionId, participantId, triggerSource, wakeRoundId,
                        "parent_invalid", parentRunId,
                        "failureType=" + notUuid.getClass().getSimpleName());
            }
            WakeFireResult chainRefused = refuseBrokenChain(
                    sessionId, participantId, participant.getPrincipalId(),
                    triggerSource, wakeRoundId, chainParentRunId, parentRunId);
            if (chainRefused != null) {
                return chainRefused;
            }
        }
        if (SessionParticipant.RESPOND_JUDGE.equals(policy)
                && !judgeSaysSpeak(session, participant, triggerSource, wakeRoundId)) {
            audit(sessionId, participantId, triggerSource, wakeRoundId, "judged_no",
                    null, null, parentRunId);
            return new WakeFireResult(false, null, "judged_no");
        }

        String prompt = "[" + triggerSource + " wake " + wakeRoundId + "] respond to the conversation.";
        // The responder stamped on the run is the participant's PRINCIPAL id — chat_runs.agent_principal_id
        // carries an FK to agent_principals (V92 R1); the D23-08 gate above has just verified the row.
        SessionWakeupService.WakeupResult result = sessionWakeupService.wakeupAs(
                sessionId.toString(), session.getUserId(), session.getWorkspaceId(), prompt,
                wakeRoundId, participant.getPrincipalId(), triggerSource, chainParentRunId);
        audit(sessionId, participantId, triggerSource, wakeRoundId,
                result.started() ? "submitted" : "deferred", null, result.runId(), parentRunId);
        return new WakeFireResult(result.started(), result.runId(),
                result.started() ? "submitted" : "deferred");
    }

    /** JUDGE branch (D24-02 dedupe is inside JudgeDecisionService, keyed by participant+round). */
    private boolean judgeSaysSpeak(Session session, SessionParticipant participant,
                                   String triggerSource, String wakeRoundId) {
        try {
            String inputWindow = "trigger=" + triggerSource + " round=" + wakeRoundId;
            JudgeDecisionService.JudgeOutcome outcome = judgeDecisionService.decide(
                    new JudgeDecisionService.JudgeInput(session.getId(), null, participant.getId(),
                            wakeRoundId, triggerSource, inputWindow,
                            "participant " + participant.getPrincipalId(), "bailian",
                            "decision-model-preview",
                            "Should this participant respond in wake round " + wakeRoundId + "?"));
            if (!outcome.answered() || outcome.verdictJson() == null) {
                return false;
            }
            JsonNode verdict = objectMapper.readTree(outcome.verdictJson());
            return verdict.path("speak").asBoolean(false);
        } catch (Exception judgeFailed) {
            logger.warn("[LIFECYCLE] service=cp event=wake_judge_failed participantId={} round={} "
                    + "failureType={}", participant.getId(), wakeRoundId,
                    judgeFailed.getClass().getSimpleName());
            return false;
        }
    }

    /**
     * PLAN-0630 M2 (T2.8/T2.9): durable chain admission for a wake hop, running inside the parent
     * run row lock (the same {@code findByIdForUpdate} serialization the spawn gate uses, so two
     * concurrent hops from the same parent run serialize and the second one sees the first one's
     * committed child). Returns {@code null} when the hop may proceed.
     *
     * <ul>
     *   <li>missing parent run or a broken ancestor walk (session physically deleted) →
     *       {@code chain_refused} with {@code ancestor_missing} — the same shared
     *       {@link DelegationChainWalker} determination the spawn budget gate consumes;</li>
     *   <li>this parent run already woke the same responder principal → {@code chain_refused} with
     *       {@code reason=duplicate}: the path-scoped reading, made durable, so a duplicate hop can
     *       never admit a second run.</li>
     * </ul>
     */
    private WakeFireResult refuseBrokenChain(UUID sessionId, UUID participantId, UUID responderPrincipalId,
                                             String triggerSource, String wakeRoundId, UUID parentRunId,
                                             String parentRunIdRaw) {
        dbLockTimeout.apply();
        ChatRun parentRun = chatRunRepository.findByIdForUpdate(parentRunId).orElse(null);
        if (parentRun == null) {
            return chainRefused(sessionId, participantId, triggerSource, wakeRoundId,
                    "ancestor_missing", parentRunIdRaw, null);
        }
        try {
            chainWalker.walkFromRun(parentRun);
        } catch (DelegationChainWalker.AncestorMissingException missing) {
            // The walker's own reason rides along as detail: the frozen audit token stays
            // ancestor_missing (design §7.1 / D30-08), the structurally-broken variant is diagnostic.
            return chainRefused(sessionId, participantId, triggerSource, wakeRoundId,
                    "ancestor_missing", parentRunIdRaw,
                    "walkReason=" + missing.reason() + " detail=" + missing.getMessage());
        }
        if (chatRunRepository.existsByParentRunIdAndAgentPrincipalId(
                parentRunId.toString(), responderPrincipalId)) {
            return chainRefused(sessionId, participantId, triggerSource, wakeRoundId,
                    "duplicate", parentRunIdRaw,
                    "responderPrincipalId=" + responderPrincipalId);
        }
        return null;
    }

    /**
     * The one refusal funnel for every chain-admission rejection. Event names are the query/alert
     * contract surface, so this never invents one: the single pre-existing {@code wake_chain_refused}
     * line carries the cause in {@code reason}, and {@link #audit} writes the durable
     * {@code wake_dispatch{outcome=chain_refused, reason=…}} row (design §7.1/§7.2).
     */
    private WakeFireResult chainRefused(UUID sessionId, UUID participantId, String triggerSource,
                                        String wakeRoundId, String reason, String parentRunId,
                                        String detail) {
        logger.warn("[LIFECYCLE] service=cp event=wake_chain_refused sessionId={} participantId={} "
                        + "reason={} parentRunId={} detail={}",
                sessionId, participantId, reason, parentRunId, detail);
        audit(sessionId, participantId, triggerSource, wakeRoundId, "chain_refused", reason, null,
                parentRunId);
        return new WakeFireResult(false, null, "chain_refused");
    }

    /** 人=通知：wake_dispatch notify event (SSE = the v1 站内 channel) + mention_count advance. */
    private void notifyHuman(UUID sessionId, SessionParticipant participant,
                             String triggerSource, String wakeRoundId, String parentRunId) {
        audit(sessionId, participant.getId(), triggerSource, wakeRoundId, "notify",
                null, null, parentRunId);
        cursorRepository.findById(participant.getId()).ifPresent(cursor -> {
            cursor.setMentionCount((cursor.getMentionCount() == null ? 0 : cursor.getMentionCount()) + 1);
            cursorRepository.save(cursor);
        });
    }

    /**
     * The durable {@code wake_dispatch} audit row. The failure cause rides the {@code reason} field —
     * the same key the spawn gate's audit detail and the docs use (design §7.1 froze the vocabulary
     * under ONE event name; {@code error} was the M3 drift).
     */
    private void audit(UUID sessionId, UUID participantId, String triggerSource,
                       String wakeRoundId, String outcome, String reason, UUID auditRunId,
                       String parentRunId) {
        Session session = sessionId == null ? null : sessionRepository.findById(sessionId).orElse(null);
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("wakeRoundId", wakeRoundId == null ? "" : wakeRoundId);
        payload.put("participantId", participantId == null ? "" : participantId.toString());
        payload.put("triggerSource", triggerSource == null ? "" : triggerSource);
        payload.put("outcome", outcome);
        if (reason != null) {
            payload.put("reason", reason);
        }
        if (auditRunId != null) {
            payload.put("runId", auditRunId.toString());
        }
        // PLAN-0630 M3 (T3.5): the durable chain parent on every wake_dispatch row — a field on the
        // existing event, not a new event name (design §7.2). Non-chain triggers stay without it.
        if (parentRunId != null) {
            payload.put("parentRunId", parentRunId);
        }
        String workspaceId = session == null ? null : session.getWorkspaceId();
        String userId = session == null || session.getUserId() == null ? "" : session.getUserId();
        eventStoreService.append(sessionId == null ? "" : sessionId.toString(), workspaceId, userId,
                EVENT_WAKE_DISPATCH, payload);
        logger.info("[LIFECYCLE] service=cp event=wake_dispatch participantId={} outcome={} "
                + "round={}", participantId, outcome, wakeRoundId);
    }

    /** dispatcheResult: did a run start, which run, and the audit outcome. */
    public record WakeFireResult(boolean dispatched, UUID runId, String outcome) {}
}
