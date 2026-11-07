package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * PLAN-0691 T1.2: session attach routes 14–16 of {@code spec/openapi-delta.md} §1.
 *
 * <p>Separate controller instead of hanging these off the session controller: the plugin feature is
 * conditional ({@code cp.plugin.enabled}, D-66), and a conditional bean that owns only its own
 * sub-paths keeps the session surface unaffected when the flag is off (routes answer 404).</p>
 *
 * <p>The workspace scope is the session's own workspace ({@code X-Workspace-Id} must match), and a
 * session or binding from another workspace answers 404/403 respectively — see
 * {@link PluginBindingService#attach}.</p>
 */
@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/plugins")
@ConditionalOnProperty(name = "cp.plugin.enabled", havingValue = "true")
public class SessionPluginBindingController {

    private final PluginBindingService service;

    public SessionPluginBindingController(PluginBindingService service) {
        this.service = service;
    }

    @GetMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> list(@PathVariable String sessionId) {
        try {
            List<PluginBindingService.SessionView> views = service.listSessionViews(
                    TenantContext.getWorkspaceId(), sessionId);
            return ResponseEntity.ok(Map.of("items", views));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PostMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> attach(@PathVariable String sessionId,
            @RequestBody AttachRequest request) {
        try {
            PluginBindingService.AttachResult result = service.attach(
                    TenantContext.getWorkspaceId(), sessionId, request.bindingId(), requireActor());
            return ResponseEntity.status(HttpStatus.CREATED).body(result);
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @DeleteMapping("/{bindingId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> detach(@PathVariable String sessionId,
            @PathVariable String bindingId) {
        try {
            service.detach(TenantContext.getWorkspaceId(), sessionId, bindingId, requireActor());
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private static String requireActor() {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "no authenticated principal in the request context");
        }
        return actor;
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }

    /** Attach body: the binding to mount onto the session (snapshot is taken server-side). */
    public record AttachRequest(String bindingId) {}
}
