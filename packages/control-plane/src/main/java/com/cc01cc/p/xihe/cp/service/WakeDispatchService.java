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
                    "participant is gone or disabled", null);
            return new WakeFireResult(false, null, "refused");
        }
        Session session = sessionRepository.findById(sessionId).orElse(null);
        if (session == null) {
            audit(sessionId, participantId, triggerSource, wakeRoundId, "refused",
                    "session is gone", null);
            return new WakeFireResult(false, null, "refused");
        }
        // D23-08: the wake path carries the SAME authorization as the owner's --as.
        try {
            participantService.authorizeAsParticipant(session.getUserId(), session.getWorkspaceId(),
                    sessionId.toString(), participantId.toString());
        } catch (CpApiException denied) {
            audit(sessionId, participantId, triggerSource, wakeRoundId, "refused",
                    "authorization: " + denied.getCode(), null);
            return new WakeFireResult(false, null, "refused");
        }

        if (SessionParticipant.KIND_HUMAN.equals(participant.getPrincipalKind())) {
            notifyHuman(sessionId, participant, triggerSource, wakeRoundId);
            return new WakeFireResult(false, null, "notify");
        }
        String policy = participant.getRespondPolicy() == null
                ? SessionParticipant.RESPOND_WHEN_MENTIONED : participant.getRespondPolicy();
        if (SessionParticipant.RESPOND_MUTED.equals(policy)) {
            audit(sessionId, participantId, triggerSource, wakeRoundId, "skipped_muted",
                    null, null);
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
                logger.warn("[LIFECYCLE] service=cp event=wake_chain_parent_invalid sessionId={} "
                        + "parentRunId={} failureType={}", sessionId, parentRunId,
                        notUuid.getClass().getSimpleName());
                return chainRefused(sessionId, participantId, triggerSource, wakeRoundId,
                        "ancestor_missing");
            }
            WakeFireResult chainRefused = refuseBrokenChain(
                    sessionId, participantId, participant.getPrincipalId(),
                    triggerSource, wakeRoundId, chainParentRunId);
            if (chainRefused != null) {
                return chainRefused;
            }
        }
        if (SessionParticipant.RESPOND_JUDGE.equals(policy)
                && !judgeSaysSpeak(session, participant, triggerSource, wakeRoundId)) {
            audit(sessionId, participantId, triggerSource, wakeRoundId, "judged_no",
                    null, null);
            return new WakeFireResult(false, null, "judged_no");
        }

        String prompt = "[" + triggerSource + " wake " + wakeRoundId + "] respond to the conversation.";
        // The responder stamped on the run is the participant's PRINCIPAL id — chat_runs.agent_principal_id
        // carries an FK to agent_principals (V92 R1); the D23-08 gate above has just verified the row.
        SessionWakeupService.WakeupResult result = sessionWakeupService.wakeupAs(
                sessionId.toString(), session.getUserId(), session.getWorkspaceId(), prompt,
                wakeRoundId, participant.getPrincipalId(), triggerSource, chainParentRunId);
        audit(sessionId, participantId, triggerSource, wakeRoundId,
                result.started() ? "submitted" : "deferred", null, result.runId());
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
     *   <li>this parent run already woke the same responder principal → {@code chain_refused} as a
     *       {@code cycle}: the path-scoped reading, made durable, so a duplicate hop can never
     *       admit a second run.</li>
     * </ul>
     */
    private WakeFireResult refuseBrokenChain(UUID sessionId, UUID participantId, UUID responderPrincipalId,
                                             String triggerSource, String wakeRoundId, UUID parentRunId) {
        dbLockTimeout.apply();
        ChatRun parentRun = chatRunRepository.findByIdForUpdate(parentRunId).orElse(null);
        if (parentRun == null) {
            return chainRefused(sessionId, participantId, triggerSource, wakeRoundId, "ancestor_missing");
        }
        try {
            chainWalker.walkFromRun(parentRun);
        } catch (DelegationChainWalker.AncestorMissingException missing) {
            logger.warn("[LIFECYCLE] service=cp event=wake_chain_ancestor_missing sessionId={} "
                    + "parentRunId={} reason={} detail={}", sessionId, parentRunId,
                    missing.reason(), missing.getMessage());
            return chainRefused(sessionId, participantId, triggerSource, wakeRoundId, "ancestor_missing");
        }
        if (chatRunRepository.existsByParentRunIdAndAgentPrincipalId(
                parentRunId.toString(), responderPrincipalId)) {
            logger.info("[LIFECYCLE] service=cp event=wake_chain_duplicate_refused sessionId={} "
                    + "parentRunId={} responderPrincipalId={}", sessionId, parentRunId, responderPrincipalId);
            return chainRefused(sessionId, participantId, triggerSource, wakeRoundId, "cycle");
        }
        return null;
    }

    private WakeFireResult chainRefused(UUID sessionId, UUID participantId, String triggerSource,
                                        String wakeRoundId, String reason) {
        audit(sessionId, participantId, triggerSource, wakeRoundId, "chain_refused", reason, null);
        return new WakeFireResult(false, null, "chain_refused");
    }

    /** 人=通知：wake_dispatch notify event (SSE = the v1 站内 channel) + mention_count advance. */
    private void notifyHuman(UUID sessionId, SessionParticipant participant,
                             String triggerSource, String wakeRoundId) {
        audit(sessionId, participant.getId(), triggerSource, wakeRoundId, "notify",
                null, null);
        cursorRepository.findById(participant.getId()).ifPresent(cursor -> {
            cursor.setMentionCount((cursor.getMentionCount() == null ? 0 : cursor.getMentionCount()) + 1);
            cursorRepository.save(cursor);
        });
    }

    private void audit(UUID sessionId, UUID participantId, String triggerSource,
                       String wakeRoundId, String outcome, String error, UUID auditRunId) {
        Session session = sessionId == null ? null : sessionRepository.findById(sessionId).orElse(null);
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("wakeRoundId", wakeRoundId == null ? "" : wakeRoundId);
        payload.put("participantId", participantId == null ? "" : participantId.toString());
        payload.put("triggerSource", triggerSource == null ? "" : triggerSource);
        payload.put("outcome", outcome);
        if (error != null) {
            payload.put("error", error);
        }
        if (auditRunId != null) {
            payload.put("runId", auditRunId.toString());
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
