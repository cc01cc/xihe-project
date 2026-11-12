package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0771 M3 (task-179, contract {@code d533613c}): the <b>one</b> wire-body gate for both
 * principal write surfaces — {@code POST/PATCH /api/v1/agent-principals} and
 * {@code POST/PATCH /api/v1/instance/agent-principals}.
 *
 * <p>Why one class and not one parser per controller: the instance surface's body is
 * "AgentPrincipalCreateRequest unchanged" and the document body is
 * "AgentPrincipalUpdateRequest unchanged" (D-932). Two copies of an
 * {@code additionalProperties:false} gate drift in exactly the dangerous direction — one surface
 * starts accepting a key the other refuses, and nothing on the wire says so. The validation
 * messages are kept verbatim from the pre-task-179 controller so existing callers/tests see no
 * change.</p>
 */
public final class AgentPrincipalWireBody {

    /** {@code AgentPrincipalCreateRequest.additionalProperties:false} key set. */
    private static final Set<String> CREATE_KEYS = Set.of(
            "name", "templateId", "defaultModelProvider", "defaultModelName", "allowedModels",
            "hooks", "roleIds");

    /** {@code AgentPrincipalUpdateRequest.additionalProperties:false} key set. */
    private static final Set<String> DOCUMENT_KEYS = Set.of("hooks", "contextPolicy", "delegationPolicy");

    private static final String CREATE_SHAPE_DETAIL = "Body must contain name plus optional templateId, "
            + "defaultModelProvider, defaultModelName, allowedModels, hooks and roleIds only";

    private static final String DOCUMENT_SHAPE_DETAIL =
            "Body must contain hooks, contextPolicy and/or delegationPolicy (object or null)";

    private AgentPrincipalWireBody() {}

    /** The create body after shape validation; {@code name} is the only required member. */
    public record CreateBody(String name, String templateId, String defaultModelProvider,
            String defaultModelName, JsonNode allowedModels, JsonNode hooks, List<UUID> roleIds) {}

    public static CreateBody parseCreate(Map<String, Object> body, ObjectMapper objectMapper) {
        if (body == null || body.isEmpty()
                || !body.containsKey("name")
                || body.keySet().stream().anyMatch(key -> !CREATE_KEYS.contains(key))
                || !(body.get("name") instanceof String name) || name.isBlank()
                || (body.containsKey("templateId") && body.get("templateId") != null
                && (!(body.get("templateId") instanceof String templateId) || templateId.isBlank()))
                || (body.containsKey("defaultModelProvider") && body.get("defaultModelProvider") != null
                && !(body.get("defaultModelProvider") instanceof String))
                || (body.containsKey("defaultModelName") && body.get("defaultModelName") != null
                && !(body.get("defaultModelName") instanceof String))) {
            throw invalidRequest(CREATE_SHAPE_DETAIL);
        }
        String templateId = body.get("templateId") instanceof String value ? value : null;
        List<UUID> roleIds = parseRoleIds(body.get("roleIds"));
        String defaultModelProvider = body.get("defaultModelProvider") instanceof String provider
                ? provider : null;
        String defaultModelName = body.get("defaultModelName") instanceof String model ? model : null;
        JsonNode allowedModels = null;
        if (body.get("allowedModels") != null) {
            try {
                allowedModels = objectMapper.valueToTree(body.get("allowedModels"));
            } catch (IllegalArgumentException e) {
                throw invalidRequest("allowedModels must be an array of {provider, model}");
            }
        }
        // Shape validation of the documents themselves lives in the service (single write-side gate);
        // here we only tree-ify the wire value (same split as the pre-task-179 controller).
        JsonNode hooks = body.get("hooks") == null ? null : objectMapper.valueToTree(body.get("hooks"));
        return new CreateBody(name, templateId, defaultModelProvider, defaultModelName, allowedModels,
                hooks, roleIds);
    }

    public static AgentPrincipalService.PrincipalSettingsPatch parseDocuments(Map<String, Object> body,
            ObjectMapper objectMapper) {
        if (body == null || body.isEmpty()
                || body.keySet().stream().anyMatch(key -> !DOCUMENT_KEYS.contains(key))) {
            throw invalidRequest(DOCUMENT_SHAPE_DETAIL);
        }
        return new AgentPrincipalService.PrincipalSettingsPatch(
                body.get("hooks") == null ? null : objectMapper.valueToTree(body.get("hooks")),
                body.containsKey("hooks"),
                body.get("contextPolicy") == null ? null : objectMapper.valueToTree(body.get("contextPolicy")),
                body.containsKey("contextPolicy"),
                body.get("delegationPolicy") == null
                        ? null : objectMapper.valueToTree(body.get("delegationPolicy")),
                body.containsKey("delegationPolicy"));
    }

    /** {@code roleIds} is a plain array of uuids; anything else is a 400 at the wire edge. */
    private static List<UUID> parseRoleIds(Object raw) {
        List<UUID> roleIds = new ArrayList<>();
        if (raw == null) {
            return roleIds;
        }
        if (!(raw instanceof List<?> rawRoleIds)) {
            throw invalidRequest("roleIds must be an array of role ids");
        }
        for (Object element : rawRoleIds) {
            if (!(element instanceof String roleIdText) || roleIdText.isBlank()) {
                throw invalidRequest("roleIds must be an array of role ids");
            }
            try {
                roleIds.add(UUID.fromString(roleIdText));
            } catch (IllegalArgumentException notAUuid) {
                throw invalidRequest("roleIds must be an array of role ids");
            }
        }
        return roleIds;
    }

    private static CpApiException invalidRequest(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
