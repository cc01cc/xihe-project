package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
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
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * PLAN-0623 M1a: session participants CRUD.
 *
 * <p>Response shape follows the M1.2 envelope rule (a named object, never a bare array):
 * {@code {participants:[…], capabilities:{view,manage,mention}}}. The capability block exists so the
 * UI can disable actions <i>before</i> the click, instead of surfacing a 403 afterwards.</p>
 */
@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/participants")
public class SessionParticipantController {

    private final SessionParticipantService participantService;

    public SessionParticipantController(SessionParticipantService participantService) {
        this.participantService = participantService;
    }

    @GetMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> list(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank()) {
            return ProblemDetailsHandler.missingPrincipal("Authentication required");
        }
        try {
            SessionParticipantService.ListView view =
                    participantService.list(userId, workspaceId, sessionId);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("participants", view.participants());
            body.put("capabilities", view.capabilities());
            return ResponseEntity.ok(body);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PostMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> add(@PathVariable String sessionId,
                                 @RequestBody(required = false) Map<String, Object> body) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank()) {
            return ProblemDetailsHandler.missingPrincipal("Authentication required");
        }
        if (body == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Body must contain principalKind and principalId");
        }
        try {
            SessionParticipantService.ParticipantView created = participantService.add(userId,
                    workspaceId, sessionId, new SessionParticipantService.AddRequest(
                            text(body.get("principalKind")), text(body.get("principalId")),
                            text(body.get("role")), text(body.get("wakePolicy")),
                            text(body.get("respondPolicy")), configMap(body.get("wakeConfig")),
                            stringList(body.get("deliveryDefaults"))));
            return ResponseEntity.status(HttpStatus.CREATED).body(created);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0660 T5.1: advance the caller's own read cursor for this session.
     *
     * <p>Advance-only + clamped + self-only (`spec/session/user-channel.md` §2). The response is the
     * same {@code readCursor} shape the list endpoint returns, so the UI can render the derived
     * unread count straight from it.</p>
     */
    @PatchMapping("/{participantId}/cursor")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> advanceCursor(@PathVariable String sessionId,
                                           @PathVariable String participantId,
                                           @RequestBody(required = false) Map<String, Object> body) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank()) {
            return ProblemDetailsHandler.missingPrincipal("Authentication required");
        }
        Long lastReadEventSeq = null;
        if (body != null && body.get("lastReadEventSeq") != null) {
            try {
                lastReadEventSeq = Long.parseLong(String.valueOf(body.get("lastReadEventSeq")).trim());
            } catch (NumberFormatException e) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "lastReadEventSeq must be an integer");
            }
        }
        if (lastReadEventSeq == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Body must contain lastReadEventSeq");
        }
        try {
            return ResponseEntity.ok(participantService.advanceCursor(userId, workspaceId, sessionId,
                    participantId, lastReadEventSeq));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PatchMapping("/{participantId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> update(@PathVariable String sessionId,
                                    @PathVariable String participantId,
                                    @RequestBody(required = false) Map<String, Object> body) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank()) {
            return ProblemDetailsHandler.missingPrincipal("Authentication required");
        }
        if (body == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Body must contain at least one of role, wakePolicy, respondPolicy, disabled");
        }
        try {
            SessionParticipantService.ParticipantView updated = participantService.update(userId,
                    workspaceId, sessionId, participantId,
                    new SessionParticipantService.UpdateRequest(text(body.get("role")),
                            text(body.get("wakePolicy")), text(body.get("respondPolicy")),
                            body.get("disabled") instanceof Boolean disabled ? disabled : null,
                            configMap(body.get("wakeConfig")),
                            stringList(body.get("deliveryDefaults"))));
            return ResponseEntity.ok(updated);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @DeleteMapping("/{participantId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> remove(@PathVariable String sessionId,
                                    @PathVariable String participantId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || userId.isBlank()) {
            return ProblemDetailsHandler.missingPrincipal("Authentication required");
        }
        try {
            participantService.remove(userId, workspaceId, sessionId, participantId);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private static java.util.List<String> stringList(Object value) {
        if (value == null) {
            return null;
        }
        if (!(value instanceof java.util.List<?> list)) {
            throw invalidDeliveryDefaults();
        }
        java.util.List<String> strings = new java.util.ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof String string)) {
                throw invalidDeliveryDefaults();
            }
            strings.add(string);
        }
        return strings;
    }

    private static CpApiException invalidDeliveryDefaults() {
        return new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_DELIVERY_DEFAULTS_INVALID",
                "deliveryDefaults must be an array of to/cc/mention_only values");
    }

    @SuppressWarnings("unchecked")
    private static java.util.Map<String, Object> configMap(Object value) {
        return value instanceof java.util.Map<?, ?> map
                ? (java.util.Map<String, Object>) map : null;
    }

    private static String text(Object value) {
        return value instanceof String string && !string.isBlank() ? string : null;
    }
}
