package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.Session;

import java.util.LinkedHashMap;
import java.util.Map;

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

    public static Map<String, Object> toView(Session session) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", session.getId());
        view.put("workspaceId", session.getWorkspaceId());
        view.put("agentPrincipalId", session.getAgentPrincipalId());
        view.put("title", session.getTitle());
        view.put("modelProvider", session.getModelProvider());
        view.put("modelName", session.getModelName());
        view.put("providerConnectionId", session.getProviderConnectionId());
        view.put("connectionRevision", session.getConnectionRevision());
        view.put("contextTemplateLayer", session.getContextTemplateLayer());
        view.put("contextTemplateId", session.getContextTemplateId());
        view.put("contextTemplateVersion", session.getContextTemplateVersion());
        view.put("archived", session.isArchived());
        view.put("createdAt", session.getCreatedAt() == null ? null : session.getCreatedAt().toString());
        view.put("updatedAt", session.getUpdatedAt() == null ? null : session.getUpdatedAt().toString());
        return view;
    }
}
