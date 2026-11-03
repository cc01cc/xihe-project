package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.service.AgentMemoryService;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * The <b>subject-level</b> agent memory API (user ruling 2026-11-04, V107): memory follows the agent
 * principal, not the workspace, so the canonical paths hang off {@code /agent-principals/{principalId}}
 * and the workspace travels as a <b>query parameter</b> that only authorizes the call.
 *
 * <p>Why the workspace is still required ({@code ?workspaceId=}): the authority atom
 * ({@code MEMORY_WRITE}) is evaluated <b>in a workspace</b> by {@link RequesterAuthority} — that is the
 * existing, tested authorization surface, and moving it would touch the role-binding lane. So the
 * parameter means "evaluate my grants in this workspace", never "which memory set" — the same agent in
 * two workspaces reads the very same rows, which is the whole point of the ruling.</p>
 *
 * <p>Consequences enforced here:</p>
 * <ul>
 *   <li>{@code MEMORY_WRITE} is checked <b>before</b> the visibility lookup: a caller without it learns
 *       nothing about which principals exist (no existence oracle), and a caller with it still gets the
 *       same 404 as before for a principal that is not bound to the authorizing workspace.</li>
 *   <li>Channel and provenance are injected, never taken from the body: {@code origin=ui} and
 *       {@code sourceRef=<actor>} are the UI channel's frozen values (D29-19), which is also what makes
 *       {@code pinned} legal (only {@code ui}/{@code cli} may pin).</li>
 *   <li>The response view has no workspace field ({@link AgentMemoryWire}): a row is not "owned" by the
 *       workspace that authorized the request.</li>
 * </ul>
 *
 * <p>The old workspace-nested routes stay alive as deprecated forwarders
 * ({@link WorkspaceAgentController}) so an older UI cannot break mid-migration.</p>
 */
@RestController
@RequestMapping("/api/v1/agent-principals/{principalId}/memories")
public class AgentPrincipalMemoryController {

    /** `additionalProperties: false` on the wire is enforced here: these are the only legal keys. */
    private static final Set<String> MEMORY_CREATE_KEYS = Set.of("content", "pinned");
    private static final Set<String> MEMORY_UPDATE_KEYS = Set.of("content", "pinned");

    private final AgentPrincipalService agentPrincipalService;
    private final AgentMemoryService agentMemoryService;
    private final RequesterAuthority requesterAuthority;

    public AgentPrincipalMemoryController(AgentPrincipalService agentPrincipalService,
                                          AgentMemoryService agentMemoryService,
                                          RequesterAuthority requesterAuthority) {
        this.agentPrincipalService = agentPrincipalService;
        this.agentMemoryService = agentMemoryService;
        this.requesterAuthority = requesterAuthority;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> list(@PathVariable String principalId,
                                  @RequestParam("workspaceId") String workspaceId,
                                  @RequestParam(value = "status", defaultValue = "active") String status) {
        try {
            UUID workspace = parseUuid(workspaceId);
            UUID principal = parseUuid(principalId);
            requireVisible(workspace, principal);
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

    @PreAuthorize("isAuthenticated()")
    @PostMapping
    public ResponseEntity<?> create(@PathVariable String principalId,
                                    @RequestParam("workspaceId") String workspaceId,
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

    @PreAuthorize("isAuthenticated()")
    @PatchMapping("/{memoryId}")
    public ResponseEntity<?> update(@PathVariable String principalId,
                                    @PathVariable String memoryId,
                                    @RequestParam("workspaceId") String workspaceId,
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
     * <p>V99 already models this as a soft delete ({@code deleted_at}), which is why no new status value
     * is invented: the row keeps its identity, its audit trail and its dedupe history, while injection
     * and the default listing stop returning it and the dedupe key is freed. Reading it back is an
     * explicit opt-in ({@code GET …?status=retired|all}), so "归档" stays recoverable and
     * distinguishable from "never existed".</p>
     */
    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{memoryId}")
    public ResponseEntity<?> forget(@PathVariable String principalId,
                                    @PathVariable String memoryId,
                                    @RequestParam("workspaceId") String workspaceId) {
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
     * {@code MEMORY_WRITE} first (no existence oracle), then the workspace visibility gate the read
     * face has always used (404 for a principal outside the authorizing workspace).
     */
    private void requireMemoryWrite(UUID workspace, UUID principal) {
        UUID subject = requesterAuthority.currentSubjectId();
        if (subject == null || !requesterAuthority.holdsActionAtom(subject,
                ToolFaceRegistry.ACTION_MEMORY_WRITE, workspace)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MEMORY_WRITE is required to write agent memory in this workspace");
        }
        requireVisible(workspace, principal);
    }

    private void requireVisible(UUID workspace, UUID principal) {
        boolean visible = agentPrincipalService.listWorkspaceAgents(requireActor(), workspace).stream()
                .anyMatch(view -> view.principalId().equals(principal));
        if (!visible) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND",
                    "Agent principal not found");
        }
    }

    private String requireActor() {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
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
