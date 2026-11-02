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
 */
@RestController
@RequestMapping("/api/v1/skills")
public class SkillController {

    private final SkillLibraryService library;
    private final SkillImportService importService;
    private final SkillAccessGuard guard;

    public SkillController(SkillLibraryService library, SkillImportService importService,
                           SkillAccessGuard guard) {
        this.library = library;
        this.importService = importService;
        this.guard = guard;
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/import")
    public ResponseEntity<?> importSkills(@RequestBody SkillImportRequest request) {
        try {
            UUID actor = UUID.fromString(guard.requireActor());
            SkillImportService.DefinitionScope scope = request.toServiceScope();
            if (scope == null || request.skills() == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "definitionScope and skills are required");
            }
            if (Skill.DEFINITION_SCOPE_WORKSPACE.equals(scope.type()) && scope.id() == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "workspaceId is required for a workspace definition scope");
            }
            boolean instanceAdmin = guard.isInstanceAdmin();
            boolean authorized = guard.canWriteDefinitionScope(scope.type(), scope.id());
            SkillImportService.ImportResult result = importService.importSkills(
                    request.skills(), scope, actor, authorized, instanceAdmin);
            return ResponseEntity.ok(importResponse(result));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
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
