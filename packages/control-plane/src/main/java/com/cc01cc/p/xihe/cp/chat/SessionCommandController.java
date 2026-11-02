package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * PLAN-0635 M3 (D35-02 ruling A): the {@code /} command registry, decided on the server.
 *
 * <p>{@code GET /api/v1/sessions/{sessionId}/commands} returns the commands this session can use
 * <b>now</b>. The browser renders exactly this list (plus its own local-only commands {@code /clear}
 * and {@code /help}); it never decides availability itself, and it never hides a command that the
 * server marked unavailable — it shows it greyed with the reason.
 *
 * <p>Compaction is deliberately not re-implemented: {@code /compact} reuses the existing
 * {@code POST /api/v1/sessions/{sessionId}/compact} (PLAN-294 decision #15). The registry only
 * mirrors that endpoint's preconditions (D35-10). The {@code /export} artifact lives in
 * {@link SessionExportController} so the registry and the export stay independently reviewable.
 */
@RestController
@RequestMapping("/api/v1/sessions")
public class SessionCommandController {

    private final SessionService sessionService;
    private final SessionCommandCatalog commandCatalog;

    public SessionCommandController(SessionService sessionService, SessionCommandCatalog commandCatalog) {
        this.sessionService = sessionService;
        this.commandCatalog = commandCatalog;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{sessionId}/commands")
    public ResponseEntity<?> commands(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        if (!isUuid(sessionId)) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sessionId must be a UUID");
        }
        try {
            sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        return ResponseEntity.ok(commandCatalog.list(sessionId, userId, workspaceId));
    }

    private static boolean isUuid(String value) {
        try {
            UUID.fromString(value);
            return true;
        } catch (IllegalArgumentException invalidUuid) {
            return false;
        }
    }
}
