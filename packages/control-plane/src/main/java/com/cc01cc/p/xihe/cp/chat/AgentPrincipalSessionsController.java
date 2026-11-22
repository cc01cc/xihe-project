package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * task-19: subject-level read face for "every conversation this Agent principal takes part in".
 *
 * <pre>
 * GET /api/v1/agent-principals/{principalId}/sessions?workspaceId=…&amp;includeArchived=…&amp;limit=…
 * </pre>
 *
 * <p>Why a new endpoint instead of a {@code principalId} filter on {@code GET /api/v1/sessions}:
 * that route's workspace-scoped semantics must stay byte-identical (its caller-visible set, its
 * errors, its response shape), and the new semantics (any participant role, honest counts) are a
 * different authorization question. Keeping it on its own path also matches the V107 shape of the
 * sibling subject faces ({@code /agent-principals/{id}/memories}), where the workspace travels as an
 * <b>authorization context</b>, never as "which data set".</p>
 *
 * <p>The counting/content split and the participant-table attribution live in
 * {@link PrincipalSessionReadService}; this class only owns the wire shape.</p>
 */
@RestController
@RequestMapping("/api/v1/agent-principals/{principalId}/sessions")
public class AgentPrincipalSessionsController {

    private final PrincipalSessionReadService readService;

    public AgentPrincipalSessionsController(PrincipalSessionReadService readService) {
        this.readService = readService;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> list(@PathVariable String principalId,
                                  @RequestParam("workspaceId") String workspaceId,
                                  @RequestParam(value = "includeArchived", required = false)
                                  Boolean includeArchived,
                                  @RequestParam(value = "limit", required = false) Integer limit) {
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            PrincipalSessionReadService.Response result = readService.read(
                    actorUserId, parseUuid(workspaceId), parseUuid(principalId),
                    Boolean.TRUE.equals(includeArchived), limit);
            return ResponseEntity.ok(toView(result));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private static Map<String, Object> toView(PrincipalSessionReadService.Response result) {
        Map<String, Object> counts = new LinkedHashMap<>();
        counts.put("all", result.counts().all());
        counts.put("primary", result.counts().primary());
        counts.put("member", result.counts().member());
        counts.put("guard", result.counts().guard());

        List<Map<String, Object>> rows = new ArrayList<>(result.sessions().size());
        for (PrincipalSessionReadService.Row row : result.sessions()) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("id", row.id());
            view.put("title", row.title());
            view.put("readable", row.readable());
            view.put("archived", row.archived());
            view.put("role", row.role());
            view.put("kind", row.kind());
            view.put("spawnedFromSessionId", row.spawnedFromSessionId());
            view.put("spawnedAt", row.spawnedAt() == null ? null : row.spawnedAt().toString());
            view.put("createdAt", row.createdAt() == null ? null : row.createdAt().toString());
            view.put("updatedAt", row.updatedAt() == null ? null : row.updatedAt().toString());
            rows.add(view);
        }

        Map<String, Object> view = new LinkedHashMap<>();
        view.put("workspaceId", result.workspaceId());
        view.put("principalId", result.principalId());
        view.put("includeArchived", result.includeArchived());
        view.put("counts", counts);
        view.put("sessions", rows);
        view.put("truncated", result.truncated());
        view.put("limit", result.limit());
        return view;
    }

    private static UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException invalid) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A valid UUID is required", invalid);
        }
    }
}
