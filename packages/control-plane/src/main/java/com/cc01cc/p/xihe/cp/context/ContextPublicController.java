package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0340 U1/U2 public read surface: source summary metadata only (no body).
 */
@RestController
@RequestMapping("/api/v1/context")
public class ContextPublicController {

    private final ContextService contextService;
    private final SessionRepository sessionRepository;
    private final WorkspaceUserRepository workspaceUserRepository;

    public ContextPublicController(ContextService contextService,
                                   SessionRepository sessionRepository,
                                   WorkspaceUserRepository workspaceUserRepository) {
        this.contextService = contextService;
        this.sessionRepository = sessionRepository;
        this.workspaceUserRepository = workspaceUserRepository;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/{sessionId}/sources")
    public ResponseEntity<?> sources(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        var session = sessionRepository.findById(UUID.fromString(sessionId)).orElse(null);
        if (session == null
                || !userId.equals(session.getUserId())
                || !workspaceId.equals(session.getWorkspaceId())) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
        boolean member = workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), UUID.fromString(userId))
                .isPresent();
        if (!member) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "Access denied");
        }

        ObjectNode snapshot = contextService.getSnapshot(sessionId, workspaceId, userId, null);
        ObjectNode meta = (ObjectNode) snapshot.path("metadata");
        ObjectNode sources = meta != null && meta.get("context_sources").isObject()
                ? (ObjectNode) meta.get("context_sources")
                : null;
        ObjectNode epoch = (ObjectNode) snapshot.path("epoch");

        Map<String, Object> body = new LinkedHashMap<>();
        String status = sources != null ? sources.path("status").asText("") : "";
        String hash = sources != null
                ? sources.path("source_hash").asText("")
                : (epoch != null ? epoch.path("source_hash").asText("") : "");
        body.put("sourceKey", "AGENTS.md");
        body.put("status", status.isBlank() ? "unknown" : status);
        body.put("hashPrefix", hash.length() >= 8 ? hash.substring(0, 8) : hash);
        if (epoch != null) {
            body.put("envBranch", epoch.path("env_branch").asText(""));
            body.put("envHead", epoch.path("env_head").asText(""));
        }
        // Never include rendered body (#55).
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .body(body);
    }
}
