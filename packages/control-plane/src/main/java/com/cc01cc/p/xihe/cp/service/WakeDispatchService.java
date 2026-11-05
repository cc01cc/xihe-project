package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.chat.DelegationChainWalker;
import com.cc01cc.p.xihe.cp.chat.SessionWakeupService;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

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

    /** PLAN-0648 task-31: how much of the triggering message rides the wake prompt. */
    static final int WAKE_EXCERPT_LIMIT = 600;
    static final String EVENT_WAKE_DISPATCH = "wake_dispatch";

    private final SessionParticipantRepository participantRepository;
    private final SessionRepository sessionRepository;
    private final SessionParticipantService participantService;
    private final SessionWakeupService sessionWakeupService;
    private final JudgeDecisionService judgeDecisionService;
    private final EventStoreService eventStoreService;
    private final ObjectMapper objectMapper;
    private final ChatRunRepository chatRunRepository;
    private final DbLockTimeout dbLockTimeout;
    private final DelegationChainWalker chainWalker;

    /**
     * PLAN-0660 T5.5 (D-102): the user-channel hint port. Optional on purpose — the dispatch path must
     * behave identically when no user channel exists (unit tests, headless contexts).
     */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.cc01cc.p.xihe.cp.event.UserChannelPort userChannel;

    public WakeDispatchService(SessionParticipantRepository participantRepository,
                               SessionRepository sessionRepository,
                               SessionParticipantService participantService,
                               SessionWakeupService sessionWakeupService,
                               JudgeDecisionService judgeDecisionService,
                               EventStoreService eventStoreService,
                               ObjectMapper objectMapper,
                               ChatRunRepository chatRunRepository,
                               DbLockTimeout dbLockTimeout) {
        this.participantRepository = participantRepository;
        this.sessionRepository = sessionRepository;
        this.participantService = participantService;
        this.sessionWakeupService = sessionWakeupService;
        this.judgeDecisionService = judgeDecisionService;
        this.eventStoreService = eventStoreService;
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
    /** Backwards-compatible entry: a caller with no triggering text gets the reference-only prompt. */
    @Transactional
    public WakeFireResult fire(UUID participantId, String triggerSource, String wakeRoundId,
                               UUID sessionId, String parentRunId) {
        return fire(participantId, triggerSource, wakeRoundId, sessionId, parentRunId, null);
    }

    /**
     * PLAN-0648 task-31 (P0): the woken participant needs the message that woke it. A reference-only
     * prompt ("[mention wake …] respond to the conversation.") made every @-woken agent answer
     * "I received a wake signal but there is no content", which is worse than not waking at all —
     * the real-stack reply on session b6d227f3 was exactly that.
     *
     * @param triggeringContent the message body that caused this wake; {@code null} for triggers
     *                          that carry no user text (schedule ticks, chain hops without one)
     */
    @Transactional
    public WakeFireResult fire(UUID participantId, String triggerSource, String wakeRoundId,
                               UUID sessionId, String parentRunId, String triggeringContent) {
        return fire(participantId, triggerSource, triggerSource, wakeRoundId, sessionId, parentRunId,
                triggeringContent);
    }

    /**
     * PLAN-0665 (A, 2026-11-05 real-stack finding): explicit TO wake. Two different facts must not
     * share one string —
     * <ul>
     *   <li>{@code triggerSource} is the <b>run classification</b> written to
     *       {@code chat_runs.trigger_source}, whose CHECK only allows
     *       {@code user/mention/schedule/judge/guard/chain}. A TO-selected target run IS
     *       user-triggered (the user named that target), so TO passes {@code "user"}.</li>
     *   <li>{@code auditTriggerSource} is the <b>diagnostic label</b> of the {@code wake_dispatch}
     *       audit event and the wake prompt ({@code "to"} for TO fan-out).</li>
     * </ul>
     * Writing {@code "to"} into the column raised {@code ConstraintViolationException} on the real
     * stack while mock-based unit tests stayed green: the derived run was dropped and the 202
     * response silently reported one runId less.
     */
    @Transactional
    public WakeFireResult fire(UUID participantId, String triggerSource, String auditTriggerSource,
                               String wakeRoundId, UUID sessionId, String parentRunId,
                               String triggeringContent) {
        String auditLabel = auditTriggerSource == null || auditTriggerSource.isBlank()
                ? triggerSource : auditTriggerSource;
        SessionParticipant participant = participantRepository.findById(participantId).orElse(null);
        if (participant == null || participant.getDisabledAt() != null) {
            audit(sessionId, participantId, auditLabel, wakeRoundId, "refused",
                    "participant is gone or disabled", null, parentRunId);
            return new WakeFireResult(false, null, "refused");
        }
        Session session = sessionRepository.findById(sessionId).orElse(null);
        if (session == null) {
            audit(sessionId, participantId, auditLabel, wakeRoundId, "refused",
                    "session is gone", null, parentRunId);
            return new WakeFireResult(false, null, "refused");
        }
        // PLAN-0660 T1.3 (I4): the delivery target must belong to THIS session. Until now the only
        // place that bound participant↔session was the speak-as gate below (`findByIdAndSessionId`);
        // HUMAN recipients no longer pass through it, so the binding is checked here — a foreign
        // participantId must never be notified, counted, or audited into another session's round.
        if (!sessionId.equals(participant.getSessionId())) {
            audit(sessionId, participantId, auditLabel, wakeRoundId, "refused",
                    "cross_session: participant does not belong to this session", null, parentRunId);
            return new WakeFireResult(false, null, "refused");
        }
        // 人=通知 (0618/0630 frozen): a HUMAN recipient only gets a notification. The criterion is
        // "the delivery target exists, is enabled and lives in this session" (above) — NOT "may this
        // subject speak", which is what D23-08 answers and is always false for another human.
        if (SessionParticipant.KIND_HUMAN.equals(participant.getPrincipalKind())) {
            notifyHuman(sessionId, participant, auditLabel, wakeRoundId, parentRunId);
            return new WakeFireResult(false, null, "notify");
        }

        // D23-08: waking an AGENT writes chat_runs.agent_principal_id, so it carries the SAME
        // authorization as the owner's --as. The judgment comes back as a VALUE (PLAN-0660 T2.1):
        // catching an exception that escaped the inner transactional method is what marked this
        // shared transaction rollback-only, so a plain refusal surfaced as UnexpectedRollbackException
        // at commit time and swallowed the round.
        SessionParticipantService.SpeakDecision speak = participantService.judgeSpeakAs(
                session.getUserId(), session.getWorkspaceId(), sessionId.toString(),
                participantId.toString());
        if (!speak.allowed()) {
            audit(sessionId, participantId, auditLabel, wakeRoundId, "refused",
                    "authorization: " + speak.code(), null, parentRunId);
            return new WakeFireResult(false, null, "refused");
        }

        String policy = participant.getRespondPolicy() == null
                ? SessionParticipant.RESPOND_WHEN_MENTIONED : participant.getRespondPolicy();
        if (SessionParticipant.RESPOND_MUTED.equals(policy)) {
            audit(sessionId, participantId, auditLabel, wakeRoundId, "skipped_muted",
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
                && !judgeSaysSpeak(session, participant, auditLabel, wakeRoundId)) {
            audit(sessionId, participantId, auditLabel, wakeRoundId, "judged_no",
                    null, null, parentRunId);
            return new WakeFireResult(false, null, "judged_no");
        }

        String prompt = buildWakePrompt(auditLabel, wakeRoundId, sessionId, triggeringContent);
        // The responder stamped on the run is the participant's PRINCIPAL id — chat_runs.agent_principal_id
        // carries an FK to agent_principals (V92 R1); the D23-08 gate above has just verified the row.
        SessionWakeupService.WakeupResult result = sessionWakeupService.wakeupAs(
                sessionId.toString(), session.getUserId(), session.getWorkspaceId(), prompt,
                wakeRoundId, participant.getPrincipalId(), triggerSource, chainParentRunId);
        // PLAN-0630 M5b / D2: a dispatch refusal downstream terminalizes the Run with its own
        // error_code (ChatController listener); this wake-level audit keeps "submitted/deferred",
        // so a reviewer can join the two facts instead of guessing from a stuck Run.
        audit(sessionId, participantId, auditLabel, wakeRoundId,
                result.started() ? "submitted" : "deferred", null, result.runId(), parentRunId);
        return new WakeFireResult(result.started(), result.runId(),
                result.started() ? "submitted" : "deferred");
    }

    /**
     * The prompt handed to the woken participant. It must carry what the participant needs to
     * answer: the triggering message body (sanitised, truncated, never empty when there was text)
     * plus the session id for a self-reference. The {@code [<trigger> wake <round>]} prefix stays —
     * operators and the audit stream grep it.
     */
    String buildWakePrompt(String triggerSource, String wakeRoundId, UUID sessionId, String triggeringContent) {
        StringBuilder prompt = new StringBuilder("[")
                .append(triggerSource).append(" wake ").append(wakeRoundId).append("] session=").append(sessionId);
        String excerpt = wakeExcerpt(triggeringContent);
        if (excerpt.isEmpty()) {
            prompt.append(" respond to the conversation.");
            return prompt.toString();
        }
        prompt.append(nl()).append(nl())
                .append("Triggering message").append(truncationNote(triggeringContent)).append(':')
                .append(nl()).append(nl()).append(excerpt).append(nl()).append(nl())
                .append("Answer that message as your own turn. Do not describe the wake signal.");
        return prompt.toString();
    }

    /**
     * Sanitised, whitespace-collapsed excerpt. {@link LogRedactor} owns the "never leak a secret"
     * rule; it only replaces secret-looking spans, so the message keeps its meaning. Truncation
     * keeps the first {@link #WAKE_EXCERPT_LIMIT} characters — the beginning of a message carries
     * the ask far more often than its tail.
     */
    String wakeExcerpt(String triggeringContent) {
        if (triggeringContent == null || triggeringContent.isBlank()) {
            return "";
        }
        String sanitised = LogRedactor.redact(triggeringContent).strip();
        if (sanitised.length() <= WAKE_EXCERPT_LIMIT) {
            return sanitised;
        }
        int cut = sanitised.offsetByCodePoints(0, WAKE_EXCERPT_LIMIT);
        return sanitised.substring(0, cut);
    }

    private String truncationNote(String triggeringContent) {
        if (triggeringContent == null || triggeringContent.isBlank()) {
            return "";
        }
        return wakeExcerpt(triggeringContent).length() < LogRedactor.redact(triggeringContent).strip().length()
                ? " (truncated)" : "";
    }

    private static String nl() {
        return "\n";
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

    /**
     * 人=通知：写 durable {@code wake_dispatch} notify 行 + 推一条最小化 hint（T5.5）。
     *
     * <p>PLAN-0660 T5.3：未读**不再**在这里自增 —— 它是从
     * {@code wake_dispatch ∧ outcome=notify ∧ sequence > last_read_event_seq} 派生的值
     * （`spec/session/user-channel.md` §3，D66-07 / B-4）。</p>
     *
     * <p>PLAN-0660 T5.5：hint 只带 `{sessionId, participantId}`（`spec/session/user-channel.md` §4）
     * —— 不含计数、不含正文；端口可空注入（null ⇒ no-op，既有行为不变）；失败只记
     * `event=user_channel_push_failed` 可计数日志，**不在 dispatch 路径重试**。</p>
     */
    private void notifyHuman(UUID sessionId, SessionParticipant participant,
                             String triggerSource, String wakeRoundId, String parentRunId) {
        audit(sessionId, participant.getId(), triggerSource, wakeRoundId, "notify",
                null, null, parentRunId);
        if (userChannel != null && participant.getPrincipalId() != null) {
            String userId = participant.getPrincipalId().toString();
            String hintSessionId = sessionId.toString();
            String hintParticipantId = participant.getId().toString();
            Runnable push = () -> {
                try {
                    userChannel.participantNotified(userId, hintSessionId, hintParticipantId);
                } catch (RuntimeException failure) {
                    logger.warn("[LIFECYCLE] service=cp event=user_channel_push_failed userId={} "
                                    + "reason={} sessionId={}", userId,
                            failure.getClass().getSimpleName(), sessionId);
                }
            };
            // PLAN-0660 T5.5 (timing gap): the hint is only a hint — it may never precede the
            // durable notify row. Registering afterCommit makes "commit first, push second" the
            // ordering the receiver relies on; on rollback the synchronization never fires, so a
            // rolled-back notify reaches nobody. Without an active synchronization (direct or
            // non-transactional calls) the push stays synchronous — the port is fire-and-forget.
            if (TransactionSynchronizationManager.isSynchronizationActive()) {
                TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                    @Override
                    public void afterCommit() {
                        push.run();
                    }
                });
            } else {
                push.run();
            }
        }
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
