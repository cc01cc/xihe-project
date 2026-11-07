package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.Session;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0615 (BL-179 A1/A2): the Session → wire view mapping shared by {@link SessionController}
 * and {@link WorkspaceSessionController}.
 *
 * <p>Same reasoning as {@link SessionRequests}: a mapping is not a controller duty, and the
 * path-addressed controller must not depend on another controller to render its own response.
 * Plain class by decision #1.</p>
 */
public final class SessionViews {

    private SessionViews() {
    }

    /**
     * PLAN-0689 A2c: {@code agentPrincipalId} is the Session's PRIMARY participant principal, passed
     * in by the caller from {@code SessionParticipantRepository} — the view must not read the
     * {@code sessions.agent_principal_id} column any more. A missing PRIMARY leaves the field null
     * (display class: never an exception, never a fallback to the column).
     */
    public static Map<String, Object> toView(Session session, UUID agentPrincipalId) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", session.getId());
        view.put("workspaceId", session.getWorkspaceId());
        view.put("agentPrincipalId", agentPrincipalId == null ? null : agentPrincipalId.toString());
        view.put("title", session.getTitle());
        view.put("modelProvider", session.getModelProvider());
        view.put("modelName", session.getModelName());
        view.put("providerConnectionId", session.getProviderConnectionId());
        view.put("connectionRevision", session.getConnectionRevision());
        view.put("contextTemplateLayer", session.getContextTemplateLayer());
        view.put("contextTemplateId", session.getContextTemplateId());
        view.put("contextTemplateVersion", session.getContextTemplateVersion());
        // PLAN-0668 M2: detail symmetry with SessionSummary — list and detail both carry the
        // delegation lineage now that the wire contract declares it on Session as well.
        view.put("kind", session.getKind());
        view.put("spawnedFromSessionId", session.getSpawnedFromSessionId());
        view.put("spawnedFromRunId", session.getSpawnedFromRunId());
        view.put("spawnedAt", session.getSpawnedAt() == null ? null : session.getSpawnedAt().toString());
        view.put("archived", session.isArchived());
        view.put("createdAt", session.getCreatedAt() == null ? null : session.getCreatedAt().toString());
        view.put("updatedAt", session.getUpdatedAt() == null ? null : session.getUpdatedAt().toString());
        return view;
    }
}
