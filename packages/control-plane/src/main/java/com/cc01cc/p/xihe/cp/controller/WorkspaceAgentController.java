package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import com.cc01cc.p.xihe.cp.service.AgentMemoryService;
import com.cc01cc.p.xihe.cp.service.AgentMemoryWriteAuthorizer;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.util.JacksonNodeExit;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/agents")
public class WorkspaceAgentController {

    /** `additionalProperties: false` on the wire is enforced here: these are the only legal keys. */
    private static final Set<String> MEMORY_CREATE_KEYS = Set.of("content", "pinned");
    private static final Set<String> MEMORY_UPDATE_KEYS = Set.of("content", "pinned");

    private final AgentPrincipalService agentPrincipalService;
    private final AgentMemoryService agentMemoryService;
    private final AgentMemoryWriteAuthorizer memoryWriteAuthorizer;
    private final ObjectMapper objectMapper;

    public WorkspaceAgentController(AgentPrincipalService agentPrincipalService,
                                    AgentMemoryService agentMemoryService,
                                    AgentMemoryWriteAuthorizer memoryWriteAuthorizer,
                                    ObjectMapper objectMapper) {
        this.agentPrincipalService = agentPrincipalService;
        this.agentMemoryService = agentMemoryService;
        this.memoryWriteAuthorizer = memoryWriteAuthorizer;
        this.objectMapper = objectMapper;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> list(@PathVariable String workspaceId) {
        try {
            List<Map<String, Object>> views = agentPrincipalService.listWorkspaceAgents(
                    requireActor(), parseUuid(workspaceId)).stream()
                    .map(this::toView).toList();
            // PLAN-0622 M1.2 frozen envelope: `{agents:[…]}` (was a bare array before).
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("agents", views);
            return ResponseEntity.ok(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0629 M1-4 (C) + M1-5: the memory tab of the workspace agent dialog (read face).
     *
     * <p>Authorization reuses the list gate: a caller who cannot see the principal in this workspace
     * gets the same 404 as a principal that does not exist (no existence leak), and the read is scoped
     * to exactly this {@code (principal, workspace)} pair.</p>
     *
     * <p>Archive ruling (Lead 2026-11-03): "删除" is an <b>archive</b>. The write delete is the V99 soft
     * delete ({@code deleted_at}, no new status value), and reading it back is an explicit query:
     * {@code status=active} (default) is "what is in effect now", {@code status=retired} is the archived
     * rows, {@code status=all} is both — every row carries {@code archived}/{@code deletedAt} so the UI
     * can label 归档 rather than 删除. An unknown value is a 400, never a silent fallback. Candidates
     * are never listed in any mode.</p>
     *
     * @deprecated V107 (user ruling 2026-11-04): memory is subject-scoped, so the canonical route is
     *     {@code GET /api/v1/agent-principals/{principalId}/memories?workspaceId=…}. This nested route is
     *     kept as a forwarding alias for the in-flight UI; the workspace here authorizes the call and no
     *     longer partitions the data.
     */
    @Deprecated
    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{principalId}/memories")
    public ResponseEntity<?> memories(@PathVariable String workspaceId, @PathVariable String principalId,
                                      @RequestParam(value = "status", defaultValue = "active")
                                      String status) {
        try {
            UUID workspace = parseUuid(workspaceId);
            UUID principal = parseUuid(principalId);
            boolean visible = agentPrincipalService.listWorkspaceAgents(requireActor(), workspace).stream()
                    .anyMatch(view -> view.principalId().equals(principal));
            if (!visible) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found");
            }
            List<Map<String, Object>> rows = agentMemoryService
                    .listMemories(principal, AgentMemoryWire.status(status)).stream()
                    .map(AgentMemoryWire::toView).toList();
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("memories", rows);
            return ResponseEntity.ok(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0629 M1-5: the API write face of agent memory (the read face sits above).
     *
     * <p>Authorization is the {@code MEMORY_WRITE} <b>action atom</b> evaluated in this workspace by
     * {@link RequesterAuthority} — never a role name. V99 seeds it into no default role, so a normal
     * account cannot write memory until an explicit grant; {@code SUPER_ADMIN} holds every atom by
     * definition. The atom is checked <b>before</b> the visibility lookup: a caller without it learns
     * nothing about which principals exist (no existence oracle), while a caller with it still gets
     * the same 404 as the read face for a principal outside this workspace.</p>
     *
     * <p>Channel and provenance are injected here, never taken from the body: {@code origin=ui} and
     * {@code sourceRef=<userId>} are the UI channel's frozen values (D29-19), which is also what makes
     * {@code pinned} legal (only {@code ui}/{@code cli} may pin — V99 CHECK).</p>
     *
     * @deprecated V107 (user ruling 2026-11-04): canonical route is
     *     {@code POST /api/v1/agent-principals/{principalId}/memories?workspaceId=…}; this alias stays for
     *     the in-flight UI and forwards the same semantics (the row is subject-scoped).
     */
    @Deprecated
    @PreAuthorize("isAuthenticated()")
    @PostMapping("/{principalId}/memories")
    public ResponseEntity<?> createMemory(@PathVariable String workspaceId,
                                          @PathVariable String principalId,
                                          @RequestBody(required = false) Map<String, Object> body) {
        try {
            UUID workspace = parseUuid(workspaceId);
            UUID principal = parseUuid(principalId);
            String actor = requireActor();
            requireMemoryWrite(workspace, principal);
            if (body == null || !MEMORY_CREATE_KEYS.containsAll(body.keySet())) {
                return AgentMemoryWire.invalidRequest("Body must contain only content and pinned");
            }
            if (!(body.get("content") instanceof String content)) {
                return AgentMemoryWire.invalidRequest("content is required and must be a string");
            }
            if (body.containsKey("pinned") && !(body.get("pinned") instanceof Boolean)) {
                return AgentMemoryWire.invalidRequest("pinned must be a boolean");
            }
            boolean pinned = Boolean.TRUE.equals(body.get("pinned"));
            AgentMemory saved = agentMemoryService.remember(new AgentMemoryService.MemoryWrite(
                    principal, workspace, content, AgentMemory.ORIGIN_UI, actor, pinned, actor));
            return ResponseEntity.status(HttpStatus.CREATED).body(AgentMemoryWire.envelope(saved));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /** @deprecated V107: canonical route is {@code PATCH /api/v1/agent-principals/{principalId}/memories/{memoryId}?workspaceId=…}. */
    @Deprecated
    @PreAuthorize("isAuthenticated()")
    @PatchMapping("/{principalId}/memories/{memoryId}")
    public ResponseEntity<?> updateMemory(@PathVariable String workspaceId,
                                          @PathVariable String principalId,
                                          @PathVariable String memoryId,
                                          @RequestBody(required = false) Map<String, Object> body) {
        try {
            UUID workspace = parseUuid(workspaceId);
            UUID principal = parseUuid(principalId);
            UUID memory = parseUuid(memoryId);
            String actor = requireActor();
            requireMemoryWrite(workspace, principal);
            if (body == null || body.isEmpty() || !MEMORY_UPDATE_KEYS.containsAll(body.keySet())) {
                return AgentMemoryWire.invalidRequest("Body must contain only content and/or pinned");
            }
            if (body.containsKey("content") && !(body.get("content") instanceof String)) {
                return AgentMemoryWire.invalidRequest("content must be a string");
            }
            if (body.containsKey("pinned") && !(body.get("pinned") instanceof Boolean)) {
                return AgentMemoryWire.invalidRequest("pinned must be a boolean");
            }
            String content = body.get("content") instanceof String value ? value : null;
            Boolean pinned = body.get("pinned") instanceof Boolean value ? value : null;
            AgentMemory saved = agentMemoryService.update(new AgentMemoryService.MemoryUpdate(
                    principal, workspace, memory, content, pinned, actor));
            return ResponseEntity.ok(AgentMemoryWire.envelope(saved));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * Archive one assertion ("归档", Lead ruling 2026-11-03 — <b>not</b> a hard delete).
     *
     * <p>V99 already models this as a soft delete ({@code deleted_at}), which is why no new status
     * value is invented: the row keeps its identity, its audit trail and its dedupe history, while
     * injection and the default listing stop returning it and the dedupe key is freed. Reading it back
     * is an explicit opt-in ({@code GET …?includeArchived=true}), so "归档" stays recoverable and
     * distinguishable from "never existed".</p>
     *
     * @deprecated V107: canonical route is
     *     {@code DELETE /api/v1/agent-principals/{principalId}/memories/{memoryId}?workspaceId=…}.
     */
    @Deprecated
    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{principalId}/memories/{memoryId}")
    public ResponseEntity<?> forgetMemory(@PathVariable String workspaceId,
                                          @PathVariable String principalId,
                                          @PathVariable String memoryId) {
        try {
            UUID workspace = parseUuid(workspaceId);
            UUID principal = parseUuid(principalId);
            UUID memory = parseUuid(memoryId);
            String actor = requireActor();
            requireMemoryWrite(workspace, principal);
            agentMemoryService.forget(principal, workspace, memory, actor);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * {@code MEMORY_WRITE} first (no existence oracle), then the workspace agent visibility gate the
     * read face already uses (404 for a principal outside this workspace).
     */
    private void requireMemoryWrite(UUID workspace, UUID principal) {
        // BL-345: same shared gate as the canonical subject route (MEMORY_WRITE first, then
        // MEMORY_WRITE_SELF + ownership); this deprecated alias must not keep the old semantics.
        memoryWriteAuthorizer.require(workspace, principal);
    }

    @PreAuthorize("isAuthenticated()")
    @PutMapping("/{principalId}")
    public ResponseEntity<?> update(@PathVariable String workspaceId, @PathVariable String principalId,
                                    @RequestBody(required = false) Map<String, Object> body) {
        if (body == null || body.size() != 1 || !(body.get("permissions") instanceof List<?> permissions)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "Body must contain only a permissions array");
        }
        try {
            WorkspaceAgent binding = agentPrincipalService.setWorkspaceCap(
                    requireActor(), parseUuid(workspaceId), parseUuid(principalId),
                    objectMapper.valueToTree(permissions));
            return ResponseEntity.ok(Map.of(
                    "principalId", binding.getId().getPrincipalId(),
                    "workspaceId", binding.getId().getWorkspaceId(),
                    "permissions", toValue(binding.getPermissionsSnapshot())));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{principalId}")
    public ResponseEntity<?> remove(@PathVariable String workspaceId, @PathVariable String principalId) {
        try {
            boolean removed = agentPrincipalService.unbindWorkspace(
                    requireActor(), parseUuid(workspaceId), parseUuid(principalId));
            if (!removed) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND,
                        "WORKSPACE_AGENT_NOT_FOUND", "Workspace Agent binding not found");
            }
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private Map<String, Object> toView(AgentPrincipalService.WorkspaceAgentView view) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("principalId", view.principalId());
        result.put("name", view.name());
        result.put("templateId", view.templateId());
        result.put("templateName", view.templateName());
        result.put("createdAt", view.createdAt().toString());
        // PLAN-0622 M1.2: `permissions` -> `permissionsSnapshot`, plus the mandatory `source`.
        result.put("permissionsSnapshot", toValue(view.permissions()));
        // D26: whether this row is bound to the workspace (visible-without-binding rows are false).
        result.put("bound", view.bound());
        // task-83 Gap D: hook subscriptions — the subscription row must light up on the wire.
        // PLAN-0625 Gap I: hooks are an *object* document ({advisors:[…]}), not the permissions
        // array — the array projection below silently answered `[]` for every row, so the UI could
        // never render the subscription.
        result.put("hooks", JacksonNodeExit.toDocument(objectMapper, view.hooks()));
        // PLAN-0629 M1 (Lead ruling 2026-11-02): the workspace agent list carries the subject's memory
        // policy too, or the UI cannot show/manage it.
        result.put("contextPolicy", JacksonNodeExit.toDocument(objectMapper, view.contextPolicy()));
        // D27: `disabledAt` is projected as a boolean — the UI gates badges/buttons on it.
        result.put("disabled", view.disabled());
        // BL-326 / BL-320 L2 (2026-11-05): `roleIds` is `required` in the published WorkspaceAgentView
        // and the service record computes it (PLAN-0629: "the workspace-scoped roles that authorize
        // this row"), but this hand-written serializer never emitted it — `git log -S'roleIds'` on this
        // file shows no commit, i.e. the field was silently dropped since it was introduced. The UI's
        // AgentRoleBindingsSection is designed against it.
        result.put("roleIds", view.roleIds());
        return result;
    }

    // PLAN-0625 Gap I/J / PLAN-0633 C1: Jackson-2 nodes leave through JacksonNodeExit only — the rule
    // and its rationale live there (single source), and two mechanical gates enforce it.

    private static List<Map<String, String>> toValue(JsonNode permissions) {
        List<Map<String, String>> result = new java.util.ArrayList<>();
        if (permissions != null && permissions.isArray()) {
            for (JsonNode permission : permissions) {
                Map<String, String> atom = new LinkedHashMap<>();
                atom.put("actionClass", permission.path("actionClass").asText());
                if (permission.has("resource")) {
                    atom.put("resource", permission.path("resource").asText());
                }
                result.add(atom);
            }
        }
        return result;
    }

    private String requireActor() {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        return actor;
    }

    private UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "A valid UUID is required", e);
        }
    }
}
