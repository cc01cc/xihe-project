package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.policy.HookAdvisor;
import com.cc01cc.p.xihe.cp.policy.HookAdvisorRegistry;
import com.cc01cc.p.xihe.cp.policy.HookInvocation;
import com.cc01cc.p.xihe.cp.policy.HookVerdict;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * PLAN-0625 G → M2: the approval-creation hook dispatch (D25-04/08/10/15/16).
 *
 * <p>At pending-approval creation the session's agent participants are scanned; each principal's
 * {@code hooks} row (the runtime single-read surface; templates stay the declaration source)
 * selects the {@link HookAdvisor}s for {@code approval.ask} from the registry. Every verdict
 * lands in the approval's policySummary JSON under the <b>versioned {@code hooks} section</b>
 * (same section G introduced — advisors extend it, they do not fork it).</p>
 *
 * <p>Rules baked in here:</p>
 * <ul>
 *   <li><b>Presented, never auto-applied (D25-16)</b>: even {@code deny} only writes advice; the
 *       human decider and {@code ApprovalService.decide} are the only executors. No auto-deny
 *       configuration exists, by ruling.</li>
 *   <li><b>Uncertainty stays an ask (D25-08)</b>: an {@code ask} verdict (timeout, unwired judge,
 *       unparseable output) is NOT recorded — the pending row already is an ask, so the gate
 *       behavior is unchanged and the human sees exactly the baseline.</li>
 *   <li><b>Deny-priority merge</b>: a stored deny for an advisor kind is never overwritten by a
 *       later allow (same rule G shipped with).</li>
 *   <li><b>G baseline preserved</b>: a GUARD-role participant whose principal row carries no
 *       {@code hooks} (pre-subscription fixtures) still receives the guard advisor — production
 *       preset guards are pre-subscribed by their template data (D25-09).</li>
 *   <li><b>Fail-closed</b>: no registry bean, a disabled participant, a missing principal or any
 *       advisor failure leaves the summary untouched.</li>
 * </ul>
 */
@Service
public class GuardAdviceService {

    private static final Logger logger = LoggerFactory.getLogger(GuardAdviceService.class);
    static final int HOOKS_SECTION_VERSION = 1;

    private final ChatApprovalRepository approvalRepository;
    private final SessionParticipantRepository participantRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;
    // N13: ObjectProvider (never @Lazy) — breaks any future bean cycle without a half-initialized proxy.
    private final ObjectProvider<HookAdvisorRegistry> registryProvider;
    private final ObjectMapper objectMapper;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "guard-advice");
        thread.setDaemon(true);
        return thread;
    });

    public GuardAdviceService(ChatApprovalRepository approvalRepository,
                              SessionParticipantRepository participantRepository,
                              AgentPrincipalRepository agentPrincipalRepository,
                              ObjectProvider<HookAdvisorRegistry> registryProvider,
                              ObjectMapper objectMapper) {
        this.approvalRepository = approvalRepository;
        this.participantRepository = participantRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.registryProvider = registryProvider;
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

    /** Synchronous core (the test seam). No-op without any subscribed advisor. */
    void advise(ChatApproval approval) {
        HookAdvisorRegistry registry = registryProvider.getIfAvailable();
        if (registry == null) {
            return;
        }
        List<SessionParticipant> participants = participantRepository
                .findBySessionIdOrderByOrderIndexAsc(UUID.fromString(approval.getSessionId()));
        for (SessionParticipant participant : participants) {
            if (!SessionParticipant.KIND_AGENT.equals(participant.getPrincipalKind())
                    || participant.getDisabledAt() != null) {
                continue;
            }
            AgentPrincipal principal =
                    agentPrincipalRepository.findById(participant.getPrincipalId()).orElse(null);
            if (principal == null || principal.getDisabledAt() != null) {
                continue;
            }
            List<HookAdvisor> advisors = advisorsFor(principal, participant, registry);
            if (advisors.isEmpty()) {
                continue;
            }
            HookInvocation invocation = new HookInvocation(
                    HookAdvisorRegistry.ACTION_APPROVAL_ASK,
                    invocationPayload(approval),
                    UUID.fromString(approval.getSessionId()),
                    null,
                    participant.getId(),
                    workspaceIdOrNull(approval));
            for (HookAdvisor advisor : advisors) {
                HookVerdict verdict;
                try {
                    verdict = advisor.advise(invocation);
                } catch (RuntimeException failure) {
                    logger.warn("[LIFECYCLE] service=cp event=hook_advisor_failed requestId={} kind={} failureType={}",
                            approval.getRequestId(), advisor.kind(), failure.getClass().getSimpleName());
                    continue;
                }
                if (verdict == null || HookVerdict.ASK.equals(verdict.decision())) {
                    continue;
                }
                patchSummary(approval, advisor.kind(), verdict);
            }
        }
    }

    /**
     * Subscribed advisors for one participant. With a {@code hooks} row the registry filters by
     * the declared {@code on} whitelist (D25-09: any principal may subscribe). Without one, only
     * a GUARD-role participant keeps the G behavior — the guard advisor fires for
     * {@code approval.ask}.
     */
    private List<HookAdvisor> advisorsFor(AgentPrincipal principal, SessionParticipant participant,
                                          HookAdvisorRegistry registry) {
        JsonNode hooks = principal.getHooks();
        if (hooks != null && !hooks.isNull()) {
            return registry.advisorsFor(hooks, HookAdvisorRegistry.ACTION_APPROVAL_ASK);
        }
        if (SessionParticipant.ROLE_GUARD.equals(participant.getRole())) {
            return registry.byKind(com.cc01cc.p.xihe.cp.service.GuardHookAdvisor.KIND);
        }
        return List.of();
    }

    private ObjectNode invocationPayload(ChatApproval approval) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("requestId", approval.getRequestId().toString());
        payload.put("tool", approval.getTool() == null ? "" : approval.getTool());
        payload.put("action", approval.getAction() == null ? "" : approval.getAction());
        return payload;
    }

    private UUID workspaceIdOrNull(ChatApproval approval) {
        try {
            return approval.getWorkspaceId() == null ? null : UUID.fromString(approval.getWorkspaceId());
        } catch (IllegalArgumentException notUuid) {
            return null;
        }
    }

    /** Merges the advice into the stored summary's versioned hooks section (deny-priority merge). */
    private void patchSummary(ChatApproval approval, String kind, HookVerdict verdict) {
        try {
            ObjectNode root = approval.getPolicySummary() == null
                    ? objectMapper.createObjectNode()
                    : (ObjectNode) objectMapper.readTree(approval.getPolicySummary());
            ObjectNode hooks = root.with("hooks");
            hooks.put("version", HOOKS_SECTION_VERSION);
            ArrayNode advisors = hooks.withArray("advisors");
            for (JsonNode existing : advisors) {
                // D25 deny-priority: a stored deny is never overwritten by a later allow.
                if (kind.equals(existing.path("kind").asText())
                        && "deny".equals(existing.path("verdict").asText())) {
                    return;
                }
            }
            ObjectNode advice = advisors.addObject();
            advice.put("kind", kind);
            // Stored wire values keep G's vocabulary (approve/deny); HookVerdict's internal
            // allow/ask/deny is mapped here and nowhere else.
            advice.put("verdict", HookVerdict.ALLOW.equals(verdict.decision()) ? "approve" : "deny");
            advice.put("reason", verdict.reason() == null ? "" : verdict.reason());
            advice.put("at", Instant.now().toString());
            approval.setPolicySummary(objectMapper.writeValueAsString(root));
            approvalRepository.save(approval);
            logger.info("[LIFECYCLE] service=cp event=hook_advice_recorded requestId={} kind={} verdict={}",
                    approval.getRequestId(), kind, advice.path("verdict").asText());
        } catch (Exception unparseable) {
            logger.warn("[LIFECYCLE] service=cp event=hook_advice_summary_patch_failed requestId={}",
                    approval.getRequestId());
        }
    }
}
