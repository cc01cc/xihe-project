package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.policy.PresetGovernanceService;
import com.cc01cc.p.xihe.cp.policy.PresetGovernanceViews;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.UUID;

/**
 * task-996 / task-948 (R39 治理面): HTTP face of 「与模板对比」 and 「重新对齐」.
 *
 * <pre>
 * GET  /api/v1/presets/governance/compare?subjectType=&amp;subjectId=&amp;presetId=
 * POST /api/v1/presets/governance/realign   { "subjectType": "...", "subjectId": "..." }
 * </pre>
 *
 * <p>Order is deliberate and pinned by tests: authentication, then the action atom
 * ({@code MANAGE_ROLES}, plus {@code MANAGE_WORKSPACE_AGENTS} per touched workspace for the
 * write), <b>then</b> subject-type/UUID parsing and subject resolution. A 403 therefore never
 * says whether the target exists, and an unknown subject is 404 only for an authorized caller.</p>
 *
 * <p>The controller only translates HTTP; comparison and reconciliation live in
 * {@link PresetGovernanceService} on top of {@code PresetGrantMaterializer}.</p>
 */
@RestController
@RequestMapping("/api/v1/presets/governance")
public class PresetGovernanceController {

    private final PresetGovernanceService governanceService;

    public PresetGovernanceController(PresetGovernanceService governanceService) {
        this.governanceService = governanceService;
    }

    /** Read-only difference between the bound templates and the subject's assigned rows. */
    @GetMapping("/compare")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> compare(@RequestParam("subjectType") String subjectType,
                                     @RequestParam("subjectId") String subjectId,
                                     @RequestParam(value = "presetId", required = false)
                                     String presetId) {
        try {
            // Authorize before looking at the target at all.
            governanceService.requireReadAuthority();
            String type = governanceService.normalizeSubjectType(subjectType);
            UUID id = governanceService.parseSubjectId(subjectId);
            UUID preset = presetId == null ? null : governanceService.parseSubjectId(presetId);
            governanceService.requireKnownSubject(type, id);
            return ResponseEntity.ok(governanceService.compare(type, id, preset));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    /** Replay the subject's bound presets into their own import groups; no-op stays a no-op. */
    @PostMapping("/realign")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> realign(@RequestBody(required = false) Map<String, Object> body) {
        String subjectType = body == null ? null : asString(body, "subjectType");
        String subjectId = body == null ? null : asString(body, "subjectId");
        try {
            // Authorization first: MANAGE_ROLES + per-workspace MANAGE_WORKSPACE_AGENTS.
            // The workspace set needs the subject's bindings/rows, so the type/id are parsed
            // (syntax only) before the authority sweep, but no existence probe or name lookup
            // happens until both gates pass.
            governanceService.requireReadAuthority();
            String type = governanceService.normalizeSubjectType(subjectType);
            UUID id = governanceService.parseSubjectId(subjectId);
            governanceService.requireRealignAuthority(type, id);
            governanceService.requireKnownSubject(type, id);
            UUID actorUserId = parseActor(TenantContext.getUserId());
            PresetGovernanceViews.RealignView result = governanceService.realign(
                    type, id, actorUserId, TenantContext.getWorkspaceId());
            return ResponseEntity.ok(result);
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private static UUID parseActor(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }

    private static String asString(Map<String, Object> body, String key) {
        Object value = body == null ? null : body.get(key);
        return value == null ? null : String.valueOf(value);
    }
}
