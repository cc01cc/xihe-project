package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

/**
 * PLAN-0630 M1: a spawn refused by the delegation budget, carrying everything the durable audit line
 * needs.
 *
 * <p>It subclasses {@link CpApiException} so both spawn entries keep their normal error mapping: the
 * HTTP face ({@code POST /internal/v1/agents/spawn}) answers {@code 409 DELEGATION_LIMIT_EXCEEDED}
 * through {@code ProblemDetailsHandler}, and the CP-owned MCP tool ({@code spawn_agent}) turns it into
 * a tool error the Agent can see and recover from — a refused spawn must never fail the parent run.</p>
 *
 * <p><b>Why the audit detail rides on the exception:</b> the refusal is thrown inside
 * {@code createSpawnFromParent}'s transaction, so an audit row written there would roll back with it
 * (INV-7). The detail is carried out to {@code AgentSpawnExecutionService.execute}, which writes the
 * single {@code agent_spawn_refused} row <em>outside</em> that transaction.</p>
 *
 * <p>The detail deliberately carries <b>no prompt and no tool arguments</b> — audit rows must not
 * echo untrusted request bodies (`packages/control-plane/AGENTS.md`).</p>
 */
public class DelegationRefusedException extends CpApiException {

    private final String auditDetail;

    private DelegationRefusedException(String code, String message, String auditDetail) {
        this(HttpStatus.CONFLICT, code, message, auditDetail);
    }

    private DelegationRefusedException(HttpStatus status, String code, String message, String auditDetail) {
        super(status, code, message);
        this.auditDetail = auditDetail;
    }

    /** The {@code agent_spawn_refused} detail document (JSON text, no prompt/arguments). */
    public String auditDetail() {
        return auditDetail;
    }

    /**
     * Builds a refusal with an explicit code/status/detail — used for the tree/policy fail-closed
     * branches, which have no full audit context (a missing ancestor may have no principal at all).
     */
    static DelegationRefusedException raw(HttpStatus status, String code, String message, String auditDetail) {
        return new DelegationRefusedException(status, code, message, auditDetail);
    }

    /**
     * @param reason {@code count_exceeded} | {@code depth_exceeded}
     * @param depth the depth the new child would have had
     * @param maxDepth the effective depth limit
     * @param current the effective in-flight count
     * @param maxCount the effective count limit
     */
    public static DelegationRefusedException refused(String reason, DelegationAuditContext context,
                                                    int depth, int maxDepth, int current, int maxCount) {
        String detail = switch (reason) {
            case "depth_exceeded" -> "Delegation depth limit exceeded (depth " + depth + " > maxDepth " + maxDepth + ")";
            case "count_exceeded" -> "Delegation count limit exceeded (in flight " + current
                    + " >= maxCount " + maxCount + ")";
            default -> "Delegation refused: " + reason;
        };
        return new DelegationRefusedException("DELEGATION_LIMIT_EXCEEDED", detail,
                context.toAuditDetail(reason, depth, maxDepth, current, maxCount));
    }

    /** Fail-closed refusal for a broken/absent tree or an unreadable stored policy. */
    public static DelegationRefusedException policyInvalid(String reason, DelegationAuditContext context,
                                                           String detail) {
        return new DelegationRefusedException("DELEGATION_POLICY_INVALID",
                "Delegation policy is invalid (" + reason + "): " + detail,
                context.toAuditDetail(reason, -1, -1, -1, -1));
    }

    /**
     * The spawn coordinates that every refusal audit row carries (same {@code resourceType}/
     * {@code resourceId} as the sibling {@code agent_spawn_created} row, so both can be read back by
     * session).
     */
    public record DelegationAuditContext(String rootSessionId, String parentSessionId, String parentRunId,
                                         String parentToolCallId, String agentPrincipalId) {

        String toAuditDetail(String reason, int depth, int maxDepth, int current, int maxCount) {
            StringBuilder json = new StringBuilder(192);
            json.append("{\"reason\":\"").append(reason).append('"');
            append(json, "rootSessionId", rootSessionId);
            append(json, "parentSessionId", parentSessionId);
            append(json, "parentRunId", parentRunId);
            append(json, "parentToolCallId", parentToolCallId);
            append(json, "agentPrincipalId", agentPrincipalId);
            json.append(",\"depth\":").append(depth)
                    .append(",\"maxDepth\":").append(maxDepth)
                    .append(",\"current\":").append(current)
                    .append(",\"maxCount\":").append(maxCount)
                    .append('}');
            return json.toString();
        }

        private static void append(StringBuilder json, String key, String value) {
            json.append(",\"").append(key).append("\":");
            if (value == null) {
                json.append("null");
            } else {
                json.append('"').append(value).append('"');
            }
        }
    }
}
