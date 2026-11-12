package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0628 M1: the skill definition library.
 *
 * <p>Thin by design: this class resolves HTTP shape and delegates. It holds no repository
 * ({@code CpArchitectureTest.controllersDoNotDependOnRepositories}) and no authorization logic of its
 * own — {@link SkillAccessGuard} answers "who is calling", {@link SkillLibraryService} answers "may
 * they", so <b>a controller can never assert a right it has not resolved</b>.</p>
 *
 * <p>Response types are scalar projections ({@link SkillView}): the entity's Jackson-2
 * {@code attachments} node is converted to typed records and never reaches the wire (PLAN-0633 C1).</p>
 *
 * <p><b>Import binds the body strictly</b> (D-1019 / V156): the request is read as a Jackson-3 tree
 * first and converted with a mapper that has {@code FAIL_ON_UNKNOWN_PROPERTIES} on, so the
 * {@code additionalProperties: false} of {@code SkillImportRequest}, {@code SkillDefinitionScope} and
 * {@code SkillImportItem} is actually enforced. Without it, the schema's promise "no userId member
 * exists, so no request can address another user's library" would be unimplemented: an extra member
 * is not merely ignored, it is {@code 400 INVALID_REQUEST} with zero rows written.</p>
 */
@RestController
@RequestMapping("/api/v1/skills")
public class SkillController {

    private final SkillLibraryService library;
    private final SkillImportService importService;
    private final SkillAccessGuard guard;
    /**
     * A copy of the wire mapper (Jackson 3 — the same one Boot serialises HTTP with) that refuses
     * unknown members. Derived once at construction, never per request.
     */
    private final ObjectMapper strictImportMapper;

    public SkillController(SkillLibraryService library, SkillImportService importService,
                           SkillAccessGuard guard, ObjectMapper wireMapper) {
        this.library = library;
        this.importService = importService;
        this.guard = guard;
        this.strictImportMapper = wireMapper.rebuild()
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .build();
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/import")
    public ResponseEntity<?> importSkills(@RequestBody JsonNode body) {
        try {
            UUID actor = UUID.fromString(guard.requireActor());
            SkillImportRequest request = bindImportRequest(body);
            SkillImportService.DefinitionScope scope = request.toServiceScope(actor);
            if (scope == null || request.skills() == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "definitionScope and skills are required");
            }
            boolean instanceAdmin = guard.canManageInstanceLibrary();
            boolean authorized = guard.canWriteDefinitionScope(scope.type(), scope.id());
            refusePersonalTrusted(request, scope);
            SkillImportService.ImportResult result = importService.importSkills(
                    request.skills(), scope, actor, authorized, instanceAdmin);
            return ResponseEntity.ok(importResponse(result));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * The personal layer accepts no {@code trusted} member at all: the definition is always stored
     * {@code trusted=false}, and a request that carries the member — even {@code false} — is refused
     * as a whole ({@code openapi.yaml} {@code SkillDefinitionScope.type} description, P-189-1).
     * Runs before the service so the refusal writes zero rows.
     */
    private static void refusePersonalTrusted(SkillImportRequest request,
                                              SkillImportService.DefinitionScope scope) {
        if (!Skill.DEFINITION_SCOPE_USER.equals(scope.type())) {
            return;
        }
        for (SkillImportItem item : request.skills()) {
            if (item != null && item.trusted() != null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "the personal layer does not accept trusted: personal definitions are always"
                                + " stored trusted=false");
            }
        }
    }

    private SkillImportRequest bindImportRequest(JsonNode body) {
        try {
            return strictImportMapper.treeToValue(body, SkillImportRequest.class);
        } catch (JacksonException shapeError) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "request body does not match the import shape", shapeError);
        }
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> list(@RequestParam(required = false) String definitionScope,
                                  @RequestParam(required = false) String workspaceId) {
        try {
            String type = definitionScope == null ? Skill.DEFINITION_SCOPE_INSTANCE : definitionScope;
            UUID workspace = workspaceId == null ? null : parseUuid(workspaceId);
            List<SkillView> items = library.list(type, workspace).stream()
                    .map(skill -> SkillView.from(skill, false))
                    .toList();
            return ResponseEntity.ok(Map.of("items", items));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{skillId}")
    public ResponseEntity<?> get(@PathVariable String skillId,
                                 @RequestParam(defaultValue = "false") boolean includeBody) {
        try {
            SkillView view = SkillView.from(library.require(parseUuid(skillId)), includeBody);
            return ResponseEntity.ok(view);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{skillId}")
    public ResponseEntity<?> delete(@PathVariable String skillId) {
        try {
            library.delete(parseUuid(skillId));
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{skillId}/bindings")
    public ResponseEntity<?> listBindings(@PathVariable String skillId) {
        try {
            List<SkillBindingView> items = library.bindingsOf(parseUuid(skillId)).stream()
                    .map(SkillBindingView::from)
                    .toList();
            return ResponseEntity.ok(Map.of("items", items));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private Map<String, Object> importResponse(SkillImportService.ImportResult result) {
        List<Map<String, Object>> results = new ArrayList<>();
        for (SkillImportService.Outcome outcome : result.results()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("skillId", outcome.skillId());
            row.put("name", outcome.name());
            row.put("action", outcome.action());
            row.put("version", outcome.version());
            row.put("bodyTokensEst", outcome.bodyTokensEst());
            row.put("oversize", outcome.oversize());
            results.add(row);
        }
        List<Map<String, Object>> rejected = new ArrayList<>();
        for (SkillImportService.Rejection rejection : result.rejected()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("sourcePath", rejection.sourcePath());
            row.put("code", rejection.code());
            row.put("detail", rejection.detail());
            rejected.add(row);
        }
        SkillImportService.Summary summary = result.summary();
        Map<String, Object> summaryView = new LinkedHashMap<>();
        summaryView.put("created", summary.created());
        summaryView.put("updated", summary.updated());
        summaryView.put("unchanged", summary.unchanged());
        summaryView.put("rejected", summary.rejected());
        summaryView.put("oversize", summary.oversize());

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("results", results);
        response.put("rejected", rejected);
        response.put("summary", summaryView);
        return response;
    }

    private static UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A valid skill id is required", e);
        }
    }
}
