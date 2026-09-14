package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyRule;
import com.cc01cc.p.xihe.cp.policy.PolicyRuleService;
import com.cc01cc.p.xihe.cp.policy.SessionPolicyState;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.Objects;

/**
 * Materializes the grant behind an approval decision (PLAN-0328 M1, spec/approval.md §6.2/§14).
 *
 * <ul>
 *   <li>{@code session} → one ALLOW rule in the in-memory L4 set ("本会话允许", never persisted);</li>
 *   <li>{@code saved} → one ALLOW rule at L3 workspace (default) or L2 user;</li>
 *   <li>{@code reject_always} → the persistent DENY counterpart (decision #25).</li>
 * </ul>
 *
 * <p>The action class is always taken from the tool-face registry: classification authority stays
 * with the classification workflow (owner/admin, decision #56), so a decision may only narrow the
 * {@code resource} and never introduce an action class of its own. An unclassified tool is refused
 * (default ask + no reuse, spec §8) — classify first, then grant.</p>
 */
@Component
public class ApprovalGrantWriter {

    private static final Logger logger = LoggerFactory.getLogger(ApprovalGrantWriter.class);

    /** Validated grant target derived from the decision plus the tool registry. */
    public record RulePlan(String kind, String layer, String tool, String actionClass,
                           String resource, PolicyEffect effect) {}

    private final PolicyEngine policyEngine;
    private final SessionPolicyState sessionState;
    private final PolicyRuleService ruleService;
    private final AuditLogger audit;

    public ApprovalGrantWriter(PolicyEngine policyEngine, SessionPolicyState sessionState,
                               PolicyRuleService ruleService, AuditLogger audit) {
        this.policyEngine = policyEngine;
        this.sessionState = sessionState;
        this.ruleService = ruleService;
        this.audit = audit;
    }

    /**
     * Validates the decision against the registry and returns the grant to commit. Called before
     * the approval row is claimed, so a rejected decision leaves the row pending and retryable.
     */
    public RulePlan prepare(ApprovalDecision decision, String tool, String userId, String workspaceId) {
        if (decision == null || !decision.kind().grantsRule()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "decision does not grant a rule");
        }
        String actionClass = policyEngine.actionClassOf(tool, userId, workspaceId);
        if (PolicyLayer.UNCLASSIFIED_ACTION.equals(actionClass)) {
            throw new CpApiException(HttpStatus.CONFLICT, "TOOL_UNCLASSIFIED",
                    "Tool is not classified; classify it before granting a rule: " + tool);
        }
        if (decision.actionClass() != null && !actionClass.equals(decision.actionClass())) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "actionClass is derived from the tool registry and cannot be overridden");
        }
        // Only session/saved/reject_always reach this point (grantsRule guard above); a switch
        // expression over the 5-constant enum would still need an unreachable default arm.
        String layer = decision.kind() == ApprovalDecision.Kind.SESSION
                ? "session"
                : decision.effectiveLayer();
        PolicyEffect effect = decision.kind() == ApprovalDecision.Kind.REJECT_ALWAYS
                ? PolicyEffect.DENY : PolicyEffect.ALLOW;
        return new RulePlan(decision.kind().wireName(), layer, tool, actionClass,
                decision.effectiveResource(), effect);
    }

    /** Commits the grant; a duplicate persistent rule is an idempotent success (unique scope index). */
    public void commit(RulePlan plan, String sessionId, String userId, String workspaceId) {
        Objects.requireNonNull(plan, "plan");
        if ("session".equals(plan.layer())) {
            sessionState.addRule(sessionId, PolicyRule.of(plan.actionClass(), plan.resource(), plan.effect()));
            audit.record(sessionId, plan.tool(), "policy_rule_granted",
                    "session " + plan.actionClass() + " \"" + plan.resource() + "\" " + plan.effect().name().toLowerCase());
            return;
        }
        try {
            ruleService.create(plan.layer(), userId, workspaceId, false,
                    new PolicyRuleService.RuleInput(plan.actionClass(), plan.resource(),
                            plan.effect().name().toLowerCase(), 0, false));
        } catch (DataIntegrityViolationException e) {
            // The exact rule already exists (uq_policy_rules_scope): the grant is already satisfied.
            logger.info("[LIFECYCLE] service=cp event=approval_rule_already_present layer={} actionClass={}",
                    plan.layer(), plan.actionClass());
        }
        audit.record(sessionId, plan.tool(), "policy_rule_granted",
                plan.layer() + " " + plan.actionClass() + " \"" + plan.resource() + "\" "
                        + plan.effect().name().toLowerCase());
    }

    /**
     * Re-evaluates one pending request against the (already updated) layer context, used for the
     * "新增 allow 后批量重解挂起请求" propagation (decision #23). Only the tool identity participates
     * today — the engine resolves resources from the registry, not from raw arguments.
     */
    public boolean wouldAllow(String tool, String sessionId, String userId, String workspaceId) {
        return policyEngine.evaluateVerdict(tool, "", sessionId, null, userId, workspaceId).effect()
                == PolicyEffect.ALLOW;
    }

    /** Loads the policy context once so a propagation sweep evaluates every row against one snapshot. */
    public PolicyContext loadContext(String userId, String workspaceId, String sessionId) {
        return policyEngine.loadContext(userId, workspaceId, sessionId);
    }

    /** Same re-solve against an already-loaded context: no per-row policy reload. */
    public boolean wouldAllow(String tool, PolicyContext context, String sessionId) {
        return policyEngine.evaluateVerdict(context, tool, "", sessionId, null).effect()
                == PolicyEffect.ALLOW;
    }
}
