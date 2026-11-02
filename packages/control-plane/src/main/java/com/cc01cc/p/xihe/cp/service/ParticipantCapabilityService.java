package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.auth.CapabilityProjectionService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/**
 * PLAN-0623 M1b-②: resolve a run's capability from the <b>participant</b> that answers it.
 *
 * <p>Three rules, in order (Lead ruling 2026-11-02, option B — dual track):</p>
 * <ol>
 *   <li>The default path (no {@code asParticipantId}) keeps the Session's frozen cap snapshot
 *       (PLAN-0622 checklist C3) — no live re-resolution. This class is never called for it.</li>
 *   <li>An explicit {@code asParticipantId} overrides <b>this run's</b> cap with the participant's
 *       live cap: AGENT → {@code AgentPrincipalService.resolveCapFor} (the single entry, same
 *       semantics); HUMAN → {@code CapabilityProjectionService.permissionsFor}, the same projection
 *       {@code GET /api/v1/me/permissions} uses. Never a second rule.</li>
 *   <li>The cap and {@code chat_runs.agent_principal_id} come from the same
 *       {@link SessionParticipantService.Responder} object; neither side re-resolves on its own.</li>
 * </ol>
 *
 * <p>Why HUMAN goes through the projection instead of {@code resolveCapFor}: the agent entry point
 * requires an active {@code workspace_agents} binding and agent grants, and a HUMAN participant's
 * {@code principalId} is a {@code users.id} — calling it would answer 403 for every human.</p>
 */
@Service
public class ParticipantCapabilityService {

    private final AgentPrincipalService agentPrincipalService;
    private final CapabilityProjectionService capabilityProjectionService;

    public ParticipantCapabilityService(AgentPrincipalService agentPrincipalService,
                                        CapabilityProjectionService capabilityProjectionService) {
        this.agentPrincipalService = agentPrincipalService;
        this.capabilityProjectionService = capabilityProjectionService;
    }

    /**
     * @return the participant-scoped cap, or {@code null} when there is no responder (a
     *     principal-null placeholder session) — callers then keep the legacy Session snapshot, so a
     *     placeholder never turns into a 500 (same behaviour as before this change).
     */
    @Transactional(readOnly = true)
    public JsonNode resolveParticipantCap(SessionParticipantService.Responder responder,
                                          UUID workspaceId) {
        if (responder == null || workspaceId == null) {
            return null;
        }
        if ("AGENT".equals(responder.principalKind())) {
            return agentPrincipalService.resolveCapFor(responder.principalId(), workspaceId);
        }
        CapabilityProjectionService.SelfPermissions self =
                capabilityProjectionService.permissionsFor(responder.principalId());
        ArrayNode cap = JsonNodeFactory.instance.arrayNode();
        for (CapabilityProjectionService.WorkspacePermissions workspace : self.workspaces()) {
            if (!workspaceId.toString().equals(workspace.workspaceId())) {
                continue;
            }
            for (CapabilityProjectionService.AtomView atom : workspace.permissions()) {
                ObjectNode node = cap.addObject();
                node.put("actionClass", atom.actionClass());
                if (atom.resource() != null) {
                    node.put("resource", atom.resource());
                }
            }
            break;
        }
        return cap;
    }
}
