package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0771 M3 (task-179, contract {@code d533613c}, D-932): the thin orchestration behind
 * {@code /api/v1/instance/agent-principals}.
 *
 * <p>Four things this layer is responsible for, and nothing else:</p>
 * <ol>
 *   <li><b>read face open to every authenticated caller</b> — deliberately different from the
 *       credential surface (which is admin-only because it carries a secret face). The list is not
 *       caller-scoped, so it never goes through {@code listPrincipals};</li>
 *   <li><b>write face = {@code cap:instance:admin} + the {@code MANAGE_AGENT_PRINCIPALS} atom</b> —
 *       the capability atom is enforced on the URL layer
 *       ({@code @PreAuthorize}), the action atom inside {@link AgentPrincipalService} (N1, which is
 *       instance-only by construction). No role-name special case anywhere;</li>
 *   <li><b>{@code DELETE} = retire, never a hard delete</b> — {@code disabledAt} is set, the row is
 *       kept (FK {@code ON DELETE RESTRICT} keeps historical session/delegation references intact),
 *       and repeating it answers 204 again;</li>
 *   <li><b>ownership is a stored fact now</b> (task-173 / V170, user ruling 40C; D-1540): a row
 *       created here is stamped {@code ownership = INSTANCE} by the service, so this prefix is no
 *       longer "the path that makes it an instance platform agent" — the column says it, and both
 *       read faces filter on it. A user/workspace principal still can never be promoted into one
 *       (D-1009 2/3): the column is server-derived, never a request field.</li>
 * </ol>
 *
 * <p>The gap this javadoc used to record is closed by the same ruling. Under 40A the table had no
 * discriminator, so "a row that is NOT INSTANCE-owned answers the identical 404" degenerated to
 * "an unknown id answers 404". Now {@code AgentPrincipalService} rejects a non-INSTANCE row on this
 * prefix with that same 404 ({@code AGENT_PRINCIPAL_NOT_FOUND}), and the failed-retire path answers
 * 403 {@code AGENT_PRINCIPAL_INSTANCE_OWNED} on the user side.</p>
 */
@Service
public class InstanceAgentPrincipalService {

    private final AgentPrincipalService principals;

    public InstanceAgentPrincipalService(AgentPrincipalService principals) {
        this.principals = principals;
    }

    @Transactional(readOnly = true)
    public List<AgentPrincipalService.AgentPrincipalView> list() {
        return principals.listInstancePrincipals();
    }

    @Transactional
    public AgentPrincipal create(String actorUserId, String name, String templateId,
            String defaultModelProvider, String defaultModelName, JsonNode allowedModels, JsonNode hooks,
            List<UUID> roleIds) {
        return principals.createInstancePrincipal(actorUserId, name, templateId, defaultModelProvider,
                defaultModelName, allowedModels, hooks, roleIds);
    }

    @Transactional
    public AgentPrincipalService.PrincipalSettings updateDocuments(String actorUserId, UUID principalId,
            AgentPrincipalService.PrincipalSettingsPatch patch) {
        return principals.applyInstancePrincipalSettings(actorUserId, principalId, patch);
    }

    /** {@code DELETE} = retire; returns {@code false} when it was already retired (still a 204). */
    @Transactional
    public boolean retire(String actorUserId, UUID principalId) {
        return principals.disableInstancePrincipal(actorUserId, principalId);
    }
}
