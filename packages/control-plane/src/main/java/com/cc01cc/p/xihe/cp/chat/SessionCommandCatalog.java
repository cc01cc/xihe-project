package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * PLAN-0635 M3 (D35-02 ruling A): the session command registry.
 *
 * <p>Availability is decided <b>here</b>, never in the UI: the browser only renders what the
 * registry returns. Each command declares a {@code policyTool} — an <em>existing</em> tool face
 * name borrowed as the availability carrier — so the decision reuses the ordinary
 * {@link PolicyEngine} vocabulary instead of inventing a command permission word
 * ({@code ToolFaceRegistry.builtinActionClasses()} stays the only vocabulary).
 *
 * <p>The carrier name is deliberately <b>not</b> exposed on the wire: it is a mechanical detail
 * ("why is /export a read_file?") and would only confuse readers of the contract. Diagnosability
 * comes from the structured log line below ({@code command → policyTool → verdict}), not from
 * leaking the mechanism into the response.
 *
 * <p>Availability semantics (ruling A, 2026-11-02):
 * <ul>
 *   <li>{@code available=false, reason="approval_required"} — the policy would ask; the UI must
 *       keep showing the command (greyed + reason), never hide it: a hidden command means the
 *       user never learns the capability exists;</li>
 *   <li>{@code available=false, reason="branch_locked"} — mirrors the endpoint precondition
 *       ({@code POST /sessions/{id}/compact} → 409 {@code BRANCH_LOCK} while a run is active), so
 *       the UI never offers a command that is guaranteed to fail;</li>
 *   <li>{@code available=false, reason="denied" | "policy_unavailable"} — policy denial or an
 *       unreadable policy context (fail-closed; the run itself is unaffected).</li>
 * </ul>
 *
 * <p>M3 v1 exposes built-in commands only. Skill-derived commands ({@code /skill:<name>}) are
 * designed but not implemented: their listing must come from the PLAN-0628 run snapshot
 * ({@code skills_snapshot} + {@code skill_read}), which is not in develop yet (D35-07).
 */
@Service
public class SessionCommandCatalog {

    private static final Logger logger = LoggerFactory.getLogger(SessionCommandCatalog.class);

    static final String SOURCE_BUILTIN = "builtin";

    static final String COMMAND_EXPORT = "/export";
    static final String COMMAND_COMPACT = "/compact";

    /**
     * Availability carriers: existing tool faces (never exposed). Export reads session content,
     * so it rides the read face; compaction mirrors its own endpoint preconditions instead of a
     * policy class (it is a context-management action with an explicit lock, not a tool).
     */
    static final String CARRIER_EXPORT = "read_file";

    private static final String REASON_APPROVAL_REQUIRED = "approval_required";
    private static final String REASON_DENIED = "denied";
    private static final String REASON_POLICY_UNAVAILABLE = "policy_unavailable";
    /** Wire reason mirroring the compact endpoint's {@code 409 BRANCH_LOCK} precondition. */
    static final String REASON_BRANCH_LOCKED = "branch_locked";

    private static final String VERDICT_ALLOW = "allow";

    /** Minimal structured body so {@code PolicyResourceExtractor} sees a workspace-relative path. */
    private static final String EXPORT_POLICY_BODY = "{\"params\":{\"arguments\":{\"path\":\".\"}}}";

    private final PolicyEngine policyEngine;
    private final ChatActiveRunRegistry activeRunRegistry;

    public SessionCommandCatalog(PolicyEngine policyEngine, ChatActiveRunRegistry activeRunRegistry) {
        this.policyEngine = policyEngine;
        this.activeRunRegistry = activeRunRegistry;
    }

    /** One registry row; scalars only (the carrier/tool-face name never travels). */
    public record CommandView(String name, String source, boolean available, String reason) { }

    /** Registry response body. */
    public record CommandList(List<CommandView> commands) { }

    public CommandList list(String sessionId, String userId, String workspaceId) {
        List<CommandView> commands = new ArrayList<>();
        commands.add(exportCommand(sessionId, userId, workspaceId));
        commands.add(compactCommand(sessionId));
        return new CommandList(List.copyOf(commands));
    }

    private CommandView exportCommand(String sessionId, String userId, String workspaceId) {
        String verdict;
        String reason;
        try {
            PolicyContext context = policyEngine.loadContext(userId, workspaceId, sessionId);
            PolicyEffect effect = policyEngine
                    .evaluateVerdict(context, CARRIER_EXPORT, EXPORT_POLICY_BODY, sessionId, null, userId, workspaceId)
                    .effect();
            if (effect == PolicyEffect.ALLOW) {
                verdict = VERDICT_ALLOW;
                reason = null;
            } else if (effect == PolicyEffect.ASK) {
                verdict = REASON_APPROVAL_REQUIRED;
                reason = REASON_APPROVAL_REQUIRED;
            } else {
                verdict = REASON_DENIED;
                reason = REASON_DENIED;
            }
        } catch (RuntimeException policyFailure) {
            logger.warn("[LIFECYCLE] service=cp event=command_availability_policy_failed sessionId={} command={} errorType={}",
                    sessionId, COMMAND_EXPORT, policyFailure.getClass().getSimpleName());
            verdict = REASON_POLICY_UNAVAILABLE;
            reason = REASON_POLICY_UNAVAILABLE;
        }
        logAvailability(sessionId, COMMAND_EXPORT, CARRIER_EXPORT, verdict);
        return new CommandView(COMMAND_EXPORT, SOURCE_BUILTIN, VERDICT_ALLOW.equals(verdict), reason);
    }

    private CommandView compactCommand(String sessionId) {
        boolean runActive = activeRunRegistry.hasActive(sessionId);
        String verdict = runActive ? REASON_BRANCH_LOCKED : VERDICT_ALLOW;
        logAvailability(sessionId, COMMAND_COMPACT, "session.compact", verdict);
        return new CommandView(COMMAND_COMPACT, SOURCE_BUILTIN, !runActive,
                runActive ? REASON_BRANCH_LOCKED : null);
    }

    private void logAvailability(String sessionId, String command, String carrier, String verdict) {
        logger.info("[LIFECYCLE] service=cp event=command_availability sessionId={} command={} policyTool={} verdict={}",
                sessionId, command, carrier, verdict);
    }
}
