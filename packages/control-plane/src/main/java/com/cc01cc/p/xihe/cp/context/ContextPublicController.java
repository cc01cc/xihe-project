package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.context.service.ContextAccessService;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * PLAN-0340 U1/U2 public read surface: source summary metadata only (no body).
 */
@RestController
@RequestMapping("/api/v1/context")
public class ContextPublicController {

    private final ContextService contextService;
    private final ContextAccessService contextAccessService;

    public ContextPublicController(ContextService contextService,
                                   ContextAccessService contextAccessService) {
        this.contextService = contextService;
        this.contextAccessService = contextAccessService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/{sessionId}/sources")
    public ResponseEntity<?> sources(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        HttpStatus access = contextAccessService.checkPublicAccess(userId, workspaceId, sessionId);
        if (access == HttpStatus.UNAUTHORIZED) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        if (access == HttpStatus.NOT_FOUND) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
        if (access == HttpStatus.FORBIDDEN) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "Access denied");
        }

        ObjectNode snapshot = contextService.getSnapshot(sessionId, workspaceId, userId, null);
        com.fasterxml.jackson.databind.JsonNode meta = snapshot.path("metadata");
        com.fasterxml.jackson.databind.JsonNode sourcesNode = meta.path("context_sources");
        ObjectNode sources = sourcesNode.isObject() ? (ObjectNode) sourcesNode : null;
        com.fasterxml.jackson.databind.JsonNode epochNode = snapshot.path("epoch");
        ObjectNode epoch = epochNode.isObject() ? (ObjectNode) epochNode : null;

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
