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
 *   <li><b>no new ownership state</b> — pending decision #40 means "path 即归属" (option 40A), so
 *       a row created here is created exactly like every other principal (owner column null by
 *       design, G2=(b)); the path is what makes it an instance platform agent, and a user/workspace
 *       principal can never be promoted into one (D-1009 2/3).</li>
 * </ol>
 *
 * <p>Known, reported gap (not silently papered over): under 40A the table has no discriminator, so
 * the contract clause "a row that is NOT INSTANCE-owned answers the identical 404" degenerates to
 * "an unknown id answers 404" — a user-created row is addressable through this prefix, by an
 * instance administrator who could already manage it through the ordinary surface. The ruling that
 * would make the clause strict is #40 40B/40C; when it lands, the filter goes in
 * {@code listInstancePrincipals} plus one row check here.</p>
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
