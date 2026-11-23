package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * DSD-1497 mechanism 1 (task-125): the read-only "why was this allowed / denied?" endpoint.
 *
 * <p>{@code POST /api/v1/authorization/explain} answers one question about <b>the caller themselves</b>:
 * given an action class and a resource, would my grants authorize it, and if not, at which level and
 * against which atom? The subject is never a parameter — it is {@link TenantContext#getUserId()} — so
 * the endpoint cannot be aimed at another principal, and the response can only ever cite grant rows
 * the caller already holds.</p>
 *
 * <p><b>It is not a second decision engine.</b> The verdict comes from
 * {@link RequesterAuthority#explainForUser} which is also what
 * {@link RequesterAuthority#allowsForUser} returns its boolean from, and both run the same
 * {@link GrantIntersectionEvaluator} kernel that authorizes real calls (DSD-1497: one path, one
 * copy of the judgement). Nothing here writes, caches or persists (§6.3 of the task-110 design: no
 * evaluation-side cache), and the response body is not copied into the audit record.</p>
 */
@RestController
@RequestMapping("/api/v1/authorization")
public class AuthorizationExplainController {

    private final RequesterAuthority requesterAuthority;
    private final SessionService sessionService;

    public AuthorizationExplainController(RequesterAuthority requesterAuthority,
                                          SessionService sessionService) {
        this.requesterAuthority = requesterAuthority;
        this.sessionService = sessionService;
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/explain")
    public ResponseEntity<?> explain(@RequestBody Map<String, Object> body) {
        try {
            String userId = TenantContext.getUserId();
            if (userId == null) {
                throw ProblemDetailsHandler.missingPrincipalException("No authenticated principal");
            }
            String actionClass = requireText(body, "actionClass");
            String resource = optionalText(body, "resource");
            String sessionId = optionalText(body, "sessionId");
            String workspaceId = TenantContext.getWorkspaceId();
            if (sessionId != null) {
                // The tenant guard already proved the caller may address this workspace; requiring
                // the session to be readable keeps the scope honest for workspaceless callers too.
                Session session = sessionService.requireReadable(sessionId, userId, workspaceId);
                workspaceId = session.getWorkspaceId();
            }
            PolicyRequest request = new PolicyRequest(
                    "authorization.explain",
                    List.of(actionClass),
                    List.of(resource == null ? "*" : resource),
                    ToolShape.OPAQUE,
                    userId,
                    workspaceId,
                    sessionId);
            UUID scopedWorkspaceId = workspaceId == null ? null : UUID.fromString(workspaceId);
            GrantIntersectionEvaluator.GrantExplanation explanation =
                    requesterAuthority.explainForUser(request, scopedWorkspaceId);
            return ResponseEntity.ok(render(explanation));
        } catch (CpApiException e) {
            return problem(e);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    e.getMessage());
        }
    }

    /**
     * The wire shape. {@code missingAtom} is the deepest miss (null when allowed); {@code missingLevels}
     * keeps every miss so a caller can see that several levels were missing at once. Row identities are
     * the caller's own grants — nothing about another subject can reach this map, because nothing about
     * another subject is read.
     */
    private static Map<String, Object> render(GrantIntersectionEvaluator.GrantExplanation explanation) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("allowed", explanation.allowed());
        body.put("deepestMissingLevel", explanation.deepestMissingLevel());
        body.put("missingAtom", miss(explanation.missingAtom()));
        List<Map<String, Object>> missingLevels = new ArrayList<>(explanation.missingLevels().size());
        for (GrantIntersectionEvaluator.MissingLevel miss : explanation.missingLevels()) {
            missingLevels.add(miss(miss));
        }
        body.put("missingLevels", missingLevels);
        List<Map<String, Object>> matchedGrantRefs = new ArrayList<>(explanation.matchedGrantRefs().size());
        for (GrantIntersectionEvaluator.MatchedGrant match : explanation.matchedGrantRefs()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("level", match.level());
            row.put("levelLabel", match.levelLabel());
            row.put("actionClass", match.actionClass());
            row.put("resource", match.resource());
            row.put("grantId", match.grantId());
            row.put("grantSource", match.grantSource());
            // task-933 / R39: an `assigned` row cites the read-only template its atom was
            // imported from — provenance for display and compare/realign ONLY. The preset did
            // not authorize this atom (the row does); a preset content change never moves this
            // field (the row keeps the origin id), so the explanation cannot claim otherwise.
            // Every other source keeps it null.
            row.put("originPresetId", match.originPresetId());
            matchedGrantRefs.add(row);
        }
        body.put("matchedGrantRefs", matchedGrantRefs);
        List<Map<String, Object>> evaluatedLevels = new ArrayList<>(explanation.evaluatedLevels().size());
        for (GrantIntersectionEvaluator.EvaluatedLevel level : explanation.evaluatedLevels()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("level", level.level());
            row.put("label", level.label());
            row.put("atomCount", level.atomCount());
            row.put("matched", level.matched());
            evaluatedLevels.add(row);
        }
        body.put("evaluatedLevels", evaluatedLevels);
        return body;
    }

    private static Map<String, Object> miss(GrantIntersectionEvaluator.MissingLevel miss) {
        if (miss == null) {
            return null;
        }
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("level", miss.level());
        row.put("levelLabel", miss.levelLabel());
        row.put("actionClass", miss.actionClass());
        row.put("resource", miss.resource());
        row.put("reason", miss.reason());
        return row;
    }

    private static String requireText(Map<String, Object> body, String key) {
        String value = optionalText(body, key);
        if (value == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", key + " is required");
        }
        return value;
    }

    private static String optionalText(Map<String, Object> body, String key) {
        Object value = body == null ? null : body.get(key);
        if (value == null) {
            return null;
        }
        if (!(value instanceof String text)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", key + " must be a string");
        }
        return text.isBlank() ? null : text.trim();
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }
}
