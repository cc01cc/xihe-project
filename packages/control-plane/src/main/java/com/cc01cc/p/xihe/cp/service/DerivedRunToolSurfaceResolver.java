package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.policy.ContextPolicyValidator;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Resolves the tool surface a <b>delegation-derived</b> run gets (task-86, decision = (a)).
 *
 * <p>The measured defect: a run created by the dispatch face landed on {@code tool_mode=none} because
 * <em>nobody decided it</em> — the value fell through to the {@code ChatRun} entity column default,
 * while a human-initiated run in the same session, same principal, same capability ceiling got
 * {@code workspace} and really wrote files. A silent entity default is not a grant decision, so this
 * resolver owns the decision and every branch of it is auditable:
 *
 * <ul>
 *   <li><b>granted</b> — {@code agent_principals.context_policy->>'derivedRunToolMode'} is {@code none}
 *       or {@code workspace}; the value is handed to the submission as-is.</li>
 *   <li><b>not_granted / {@code no_key}</b> — the principal row exists but carries no such key. The
 *       absence of a key IS a grant-set decision whose direction is refusal, so it is audited and the
 *       caller must refuse rather than fall back to a default.</li>
 *   <li><b>unwired</b> — the input cannot be evaluated at all (null principal id, missing row, a
 *       non-object policy, or a value outside the enumerated set). Also a refusal, never a repair.
 *       </li>
 * </ul>
 *
 * <p>Deliberately <b>not</b> the dispatching request's {@code toolMode}: the permission consequences
 * (TOOL_NOT_AUTHORIZED, TOOL_GRANT_DENIED) are borne by the woken principal's own capability set, so the
 * decision belongs to that principal — the same stamp the run's instructions baseline already uses
 * ({@code resolveSystemInstructionsForRun}). Copying the caller's mode would move authority from the
 * party that bears the consequence to the party that does not.</p>
 */
@Component
public class DerivedRunToolSurfaceResolver {

    private static final Logger logger = LoggerFactory.getLogger(DerivedRunToolSurfaceResolver.class);

    /**
     * The {@code context_policy} key holding this principal's default tool surface for derived runs.
     *
     * <p>task-16: the key and its enumeration are owned by {@code ContextPolicyValidator}, which is the
     * single write-side gate — the same two constants are read here so a value the gate accepts can
     * never be one this resolver reports as {@code invalid_value}. Before task-16 the product face
     * could not write this key at all (the gate's top-level whitelist knew only {@code memory}), so the
     * only producer was a direct SQL UPDATE.</p>
     */
    public static final String CONTEXT_POLICY_KEY =
            ContextPolicyValidator.DERIVED_RUN_TOOL_MODE_KEY;

    /** Enumerated values — anything else is a wiring fault, not a value to coerce. */
    private static final Set<String> ALLOWED = ContextPolicyValidator.DERIVED_RUN_TOOL_MODES;

    private final AgentPrincipalRepository agentPrincipalRepository;

    public DerivedRunToolSurfaceResolver(AgentPrincipalRepository agentPrincipalRepository) {
        this.agentPrincipalRepository = agentPrincipalRepository;
    }

    /**
     * @param granted  whether a tool surface could be resolved for this principal
     * @param toolMode the granted value; {@code null} when not granted
     * @param reason   audit token: {@code granted} / {@code no_key} / the unwiring cause
     */
    public record Resolution(boolean granted, String toolMode, String reason) {
    }

    /** Reads the policy for one principal id. Never throws, never guesses a value. */
    public Resolution resolve(UUID principalId) {
        if (principalId == null) {
            return unwired("null_principal", null);
        }
        Optional<AgentPrincipal> found = agentPrincipalRepository.findById(principalId);
        if (found.isEmpty()) {
            return unwired("principal_absent", principalId);
        }
        JsonNode policy = found.get().getContextPolicy();
        if (policy == null || policy.isNull() || !policy.isObject()) {
            return notGranted(principalId);
        }
        JsonNode value = policy.get(CONTEXT_POLICY_KEY);
        if (value == null || value.isNull()) {
            return notGranted(principalId);
        }
        if (!value.isTextual()) {
            return unwired("invalid_value_type", principalId);
        }
        String mode = value.asText().trim();
        if (!ALLOWED.contains(mode)) {
            return unwired("invalid_value", principalId);
        }
        logger.info("[LIFECYCLE] service=cp event=derived_tool_surface outcome=granted principalId={}"
                + " toolMode={} source=context_policy.{}", principalId, mode, CONTEXT_POLICY_KEY);
        return new Resolution(true, mode, "granted");
    }

    private Resolution notGranted(UUID principalId) {
        logger.info("[LIFECYCLE] service=cp event=derived_tool_surface outcome=not_granted"
                + " reason=no_key principalId={} key=context_policy.{}", principalId, CONTEXT_POLICY_KEY);
        return new Resolution(false, null, "no_key");
    }

    private Resolution unwired(String reason, UUID principalId) {
        logger.warn("[LIFECYCLE] service=cp event=derived_tool_surface outcome=unwired reason={}"
                + " principalId={}", reason, principalId);
        return new Resolution(false, null, reason);
    }
}
