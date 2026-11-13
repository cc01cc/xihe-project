package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.util.JacksonNodeExit;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0771 M3 (task-179, contract {@code d533613c}): the single wire projection for the principal
 * read/create/document views, shared by {@code /api/v1/agent-principals} and
 * {@code /api/v1/instance/agent-principals}.
 *
 * <p>Same reason the credential surfaces share one projection (task-173): the instance row is the
 * same row type, so a second hand-built map would silently drift — one surface echoing
 * {@code contextPolicy} and the other forgetting it is a contract break nobody notices until a
 * consumer does. Anything added here appears on both surfaces at once, which is the intended
 * coupling (D-932: the instance layer reuses the request/response schemas unchanged).</p>
 *
 * <p>{@code ownerUserId} is projected as {@code null} rather than omitted: the schemas declare it
 * present-and-nullable, and a caller cannot distinguish "no owner" from "field missing" if the key
 * disappears. Note the honest limit (pending decision #40): today <b>every</b> new row has a null
 * owner column, so a view alone cannot tell an instance row from a user row — the path is the
 * discriminator (40A).</p>
 */
public final class AgentPrincipalWireView {

    private AgentPrincipalWireView() {}

    /** {@code AgentPrincipalCreateView}: the create echo plus the roles actually written. */
    public static Map<String, Object> createView(AgentPrincipal principal, List<UUID> roleIds,
            ObjectMapper objectMapper) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("principalId", principal.getId());
        result.put("templateId", principal.getTemplateId());
        result.put("templateName", principal.getTemplateSnapshot().path("templateName").isTextual()
                ? principal.getTemplateSnapshot().path("templateName").asText() : null);
        result.put("createdAt", principal.getCreatedAt().toString());
        result.put("ownerUserId",
                principal.getOwnerUserId() == null ? null : principal.getOwnerUserId().toString());
        result.put("defaultModelProvider", principal.getDefaultModelProvider());
        result.put("defaultModelName", principal.getDefaultModelName());
        result.put("allowedModels", JacksonNodeExit.toDocument(objectMapper, principal.getAllowedModels()));
        result.put("hooks", JacksonNodeExit.toDocument(objectMapper, principal.getHooks()));
        // PLAN-0629 M1 (Lead ruling 2026-11-02): a create always answers with the memory policy too
        // (null = off), so the caller learns immediately whether memory is on for the new subject.
        result.put("contextPolicy",
                JacksonNodeExit.toDocument(objectMapper, principal.getContextPolicy()));
        result.put("roleIds", roleIds);
        return result;
    }

    /** One {@code AgentPrincipalView} row (list member). */
    public static Map<String, Object> principalView(AgentPrincipalService.AgentPrincipalView view,
            ObjectMapper objectMapper) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("principalId", view.principalId());
        result.put("name", view.name());
        result.put("templateId", view.templateId());
        result.put("templateName", view.templateName());
        result.put("createdAt", view.createdAt() == null ? null : view.createdAt().toString());
        result.put("ownerUserId", view.ownerUserId() == null ? null : view.ownerUserId().toString());
        result.put("defaultModelProvider", view.defaultModelProvider());
        result.put("defaultModelName", view.defaultModelName());
        result.put("allowedModels", JacksonNodeExit.toDocument(objectMapper, view.allowedModels()));
        result.put("disabledAt", view.disabledAt() == null ? null : view.disabledAt().toString());
        result.put("hooks", JacksonNodeExit.toDocument(objectMapper, view.hooks()));
        // PLAN-0629 M1 (D29-21): the subject's memory policy is part of the principal view.
        result.put("contextPolicy", JacksonNodeExit.toDocument(objectMapper, view.contextPolicy()));
        return result;
    }

    /** {@code AgentPrincipalUpdateView}: the persisted documents, never the caller's raw input. */
    public static Map<String, Object> documentsView(UUID principalId,
            AgentPrincipalService.PrincipalSettings stored, ObjectMapper objectMapper) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("principalId", principalId);
        result.put("hooks", JacksonNodeExit.toDocument(objectMapper, stored.hooks()));
        result.put("contextPolicy", JacksonNodeExit.toDocument(objectMapper, stored.contextPolicy()));
        result.put("delegationPolicy", JacksonNodeExit.toDocument(objectMapper, stored.delegationPolicy()));
        // task-413: the model-intent triple is echoed from the row too, so the edit face can render
        // persisted state (including a merge that kept one half) without a second read.
        result.put("defaultModelProvider", stored.defaultModelProvider());
        result.put("defaultModelName", stored.defaultModelName());
        result.put("allowedModels", JacksonNodeExit.toDocument(objectMapper, stored.allowedModels()));
        return result;
    }
}
