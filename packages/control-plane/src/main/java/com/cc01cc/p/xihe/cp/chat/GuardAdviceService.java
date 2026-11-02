package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.service.JudgeDecisionService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * PLAN-0625 G (D25-04/06): the guard's verdict as an INPUT to the existing approval gate.
 *
 * <p>At pending-approval creation the session's guard is asked (via the 0624
 * {@link JudgeDecisionService}, governor-metered and deduped per participant+round) for an
 * advisory verdict on the pending action. The verdict lands in the approval's policySummary
 * JSON under a <b>versioned {@code hooks} section</b> — reserved shape for the M2 hook
 * surface (D25-10: more advisors, same section, deny-priority merge).</p>
 *
 * <p>Fail-closed by construction (PLAN-0625 README §范围 #3): no guard, a disabled guard,
 * an unwired judge client or any failure leaves the summary untouched — the human decider
 * and {@code ApprovalService.decide} are the only executors, and the advice is PRESENTED,
 * never auto-applied (no auto-deny configuration exists, by ruling).</p>
 */
@Service
public class GuardAdviceService {

    private static final Logger logger = LoggerFactory.getLogger(GuardAdviceService.class);
    static final int HOOKS_SECTION_VERSION = 1;

    private final ChatApprovalRepository approvalRepository;
    private final SessionParticipantRepository participantRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;
    private final JudgeDecisionService judgeDecisionService;
    private final ObjectMapper objectMapper;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "guard-advice");
        thread.setDaemon(true);
        return thread;
    });

    public GuardAdviceService(ChatApprovalRepository approvalRepository,
                              SessionParticipantRepository participantRepository,
                              AgentPrincipalRepository agentPrincipalRepository,
                              JudgeDecisionService judgeDecisionService,
                              ObjectMapper objectMapper) {
        this.approvalRepository = approvalRepository;
        this.participantRepository = participantRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.judgeDecisionService = judgeDecisionService;
        this.objectMapper = objectMapper;
    }

    /** Fire-and-forget: the pending row already exists; the advice patches its summary when ready. */
    public void adviseAsync(ChatApproval approval) {
        executor.submit(() -> {
            try {
                advise(approval);
            } catch (RuntimeException failure) {
                logger.warn("[LIFECYCLE] service=cp event=guard_advice_failed requestId={} failureType={}",
                        approval.getRequestId(), failure.getClass().getSimpleName());
            }
        });
    }

    /** Synchronous core (the test seam). No-op without an enabled guard participant. */
    void advise(ChatApproval approval) {
        SessionParticipant guard = participantRepository
                .findBySessionIdOrderByOrderIndexAsc(UUID.fromString(approval.getSessionId())).stream()
                .filter(row -> SessionParticipant.ROLE_GUARD.equals(row.getRole())
                        && SessionParticipant.KIND_AGENT.equals(row.getPrincipalKind())
                        && row.getDisabledAt() == null)
                .findFirst()
                .orElse(null);
        if (guard == null) {
            return;
        }
        AgentPrincipal principal = agentPrincipalRepository.findById(guard.getPrincipalId()).orElse(null);
        if (principal == null || principal.getDisabledAt() != null) {
            return;
        }

        JudgeDecisionService.JudgeOutcome outcome = judgeDecisionService.decide(
                new JudgeDecisionService.JudgeInput(
                        UUID.fromString(approval.getSessionId()), null, guard.getId(),
                        approval.getRequestId().toString(), "guard",
                        "approval requestId=" + approval.getRequestId()
                                + " tool=" + approval.getTool() + " action=" + approval.getAction(),
                        "guard participant " + guard.getPrincipalId(),
                        "bailian", "decision-model-preview",
                        "A pending action needs an advisory verdict. Answer with a short JSON object"
                                + " { \"approve\": true|false, \"reason\": \"...\" }."));
        if (!outcome.answered() || outcome.verdictJson() == null) {
            return;
        }
        JsonNode verdict = parseVerdict(outcome.verdictJson());
        if (verdict == null) {
            return;
        }
        patchSummary(approval, verdict);
    }

    private JsonNode parseVerdict(String verdictJson) {
        try {
            return objectMapper.readTree(verdictJson);
        } catch (Exception unparseable) {
            return null;
        }
    }

    /** Merges the advice into the stored summary's versioned hooks section (deny-priority merge). */
    private void patchSummary(ChatApproval approval, JsonNode verdict) {
        try {
            ObjectNode root = approval.getPolicySummary() == null
                    ? objectMapper.createObjectNode()
                    : (ObjectNode) objectMapper.readTree(approval.getPolicySummary());
            ObjectNode hooks = root.with("hooks");
            hooks.put("version", HOOKS_SECTION_VERSION);
            ArrayNode advisors = hooks.withArray("advisors");
            for (JsonNode existing : advisors) {
                // D25/M2 deny-priority: a stored deny is never overwritten by a later allow.
                if ("guard".equals(existing.path("kind").asText())
                        && "deny".equals(existing.path("verdict").asText())) {
                    return;
                }
            }
            ObjectNode advice = advisors.addObject();
            advice.put("kind", "guard");
            advice.put("verdict", verdict.path("approve").asBoolean(false) ? "approve" : "deny");
            advice.put("reason", verdict.path("reason").asText(""));
            advice.put("at", Instant.now().toString());
            approval.setPolicySummary(objectMapper.writeValueAsString(root));
            approvalRepository.save(approval);
            logger.info("[LIFECYCLE] service=cp event=guard_advice_recorded requestId={} verdict={}",
                    approval.getRequestId(), advice.path("verdict").asText());
        } catch (Exception unparseable) {
            logger.warn("[LIFECYCLE] service=cp event=guard_advice_summary_patch_failed requestId={}",
                    approval.getRequestId());
        }
    }
}
