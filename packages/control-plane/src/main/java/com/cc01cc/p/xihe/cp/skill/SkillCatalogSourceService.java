package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0628 M1 (§6.2): resolves the <b>listing subset</b> a run may see — the CP half of D28-16.
 *
 * <p>Division of labour (D28-19): CP decides <i>which</i> skills and renders one line per skill; the
 * Agent decides <i>how many</i> fit the prompt's budget. CP therefore never estimates tokens or
 * window percentages — that arithmetic lives only in the Agent's
 * {@code context/injection_budget.py}. The one number CP does bound is a count ({@code maxSkills}),
 * because "40 skills" is a product decision, not a budget computation.</p>
 *
 * <p>Priority is frozen (D28-14 + README #4) and comes from the SQL order: AGENT bindings before
 * USER, then the narrower workspace scope before the instance tier, then name. Dedupe keeps the
 * first row per {@code skill_id}, so a skill bound at two tiers is listed once, at its best tier.</p>
 *
 * <p><b>Never silent:</b> every reduction carries a diagnostic — truncation, a name collision (which
 * is why qualified names appear), an empty result, or a resolve failure. A short listing without a
 * reason is the failure mode that makes a model conclude "that skill does not exist".</p>
 */
@Service
public class SkillCatalogSourceService {

    /** The wire {@code source} value; also what a UI shows as provenance. */
    public static final String SOURCE = "skill_bindings";

    /** D28-16: 40 × ~24.5 tok ≈ 980 tok, comfortably inside 1 % of a 128k window (1280). */
    public static final int DEFAULT_MAX_SKILLS = 40;

    /** v1 has exactly one ordering; {@code usage} is reserved (rejected explicitly, not ignored). */
    public static final String SORT_BINDING = "binding";
    public static final String SORT_USAGE_RESERVED = "usage";

    public static final String STATUS_READY = "ready";
    public static final String STATUS_TRUNCATED = "truncated";
    public static final String STATUS_EMPTY = "empty";
    public static final String STATUS_FAILED = "failed";

    public static final String DIAG_EMPTY = "skill_catalog_empty";
    public static final String DIAG_MAX_SKILLS = "skill_catalog_max_skills_reached";
    public static final String DIAG_COLLISION = "skill_catalog_name_collision";
    public static final String DIAG_RESOLVE_FAILED = "skill_catalog_resolve_failed";

    private static final String SEPARATOR = " — ";

    private final SkillBindingRepository bindingRepository;
    private final AgentPrincipalRepository principalRepository;
    private final WorkspaceRepository workspaceRepository;

    public SkillCatalogSourceService(SkillBindingRepository bindingRepository,
                                    AgentPrincipalRepository principalRepository,
                                    WorkspaceRepository workspaceRepository) {
        this.bindingRepository = bindingRepository;
        this.principalRepository = principalRepository;
        this.workspaceRepository = workspaceRepository;
    }

    /**
     * One run's listing request. {@code agentPrincipalId} may be null (a run without a bound agent);
     * the AGENT tier is then simply absent instead of failing the run.
     */
    public record Request(UUID agentPrincipalId, UUID userId, UUID workspaceId,
                          int maxSkills, boolean includeDescriptions, String sort) {

        public static Request of(UUID agentPrincipalId, UUID userId, UUID workspaceId) {
            return new Request(agentPrincipalId, userId, workspaceId, DEFAULT_MAX_SKILLS, true,
                    SORT_BINDING);
        }
    }

    /**
     * The component-source view handed to the Agent. Scalars and string lists only — no Jackson-2
     * node can reach the wire through this type (PLAN-0633 C1).
     */
    public record ComponentView(String status, String source, List<String> items, boolean truncated,
                                List<String> diagnostics) {

        public Map<String, Object> toMap() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("status", status);
            view.put("source", source);
            view.put("items", items);
            view.put("truncated", truncated);
            view.put("diagnostics", diagnostics);
            return view;
        }
    }

    /** Resolves one component instance's listing. Never throws for data problems: they become {@code failed}. */
    public ComponentView resolve(Request request) {
        if (request == null) {
            return new ComponentView(STATUS_EMPTY, SOURCE, List.of(), false, List.of(DIAG_EMPTY));
        }
        String sort = request.sort() == null ? SORT_BINDING : request.sort();
        if (SORT_USAGE_RESERVED.equals(sort)) {
            // v1-reserved value: refuse rather than silently fall back to binding order.
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "sort 'usage' is reserved for a later milestone; use 'binding'");
        }
        if (!SORT_BINDING.equals(sort)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "sort must be 'binding'");
        }
        try {
            return resolveRows(request);
        } catch (RuntimeException failure) {
            // D27-22: a missing listing only removes discoverability; it must not fail the run.
            return new ComponentView(STATUS_FAILED, SOURCE, List.of(), false,
                    List.of(DIAG_RESOLVE_FAILED));
        }
    }

    /** A failed view for callers that refuse to resolve at all (bad binding, bad ids). */
    public static ComponentView failed(String diagnostic) {
        return new ComponentView(STATUS_FAILED, SOURCE, List.of(), false, List.of(diagnostic));
    }

    private ComponentView resolveRows(Request request) {
        List<Object[]> rows = bindingRepository.findResolvable(
                request.agentPrincipalId(), request.userId(), request.workspaceId());
        if (rows == null || rows.isEmpty()) {
            return new ComponentView(STATUS_EMPTY, SOURCE, List.of(), false, List.of(DIAG_EMPTY));
        }

        // Dedupe by skill id: the SQL order already put the highest-priority tier first.
        Map<UUID, BindingPlusSkill> unique = new LinkedHashMap<>();
        for (Object[] row : rows) {
            SkillBinding binding = (SkillBinding) row[0];
            Skill skill = (Skill) row[1];
            unique.putIfAbsent(skill.getId(), new BindingPlusSkill(binding, skill));
        }

        List<String> diagnostics = new ArrayList<>();
        boolean collision = hasNameCollision(unique);
        if (collision) {
            diagnostics.add(DIAG_COLLISION);
        }

        Map<UUID, String> principalNames = collision ? principalNames(unique) : Map.of();
        Map<UUID, String> workspaceNames = collision ? workspaceNames(unique, request) : Map.of();

        List<String> items = new ArrayList<>();
        List<BindingPlusSkill> ordered = new ArrayList<>(unique.values());
        boolean truncated = ordered.size() > request.maxSkills();
        int limit = Math.min(ordered.size(), Math.max(0, request.maxSkills()));
        for (int index = 0; index < limit; index++) {
            BindingPlusSkill entry = ordered.get(index);
            String name = collision
                    ? qualifier(entry, principalNames, workspaceNames) + entry.skill().getName()
                    : entry.skill().getName();
            items.add(request.includeDescriptions()
                    ? name + SEPARATOR + entry.skill().getDescription()
                    : name);
        }
        if (truncated) {
            diagnostics.add(DIAG_MAX_SKILLS);
        }
        if (items.isEmpty()) {
            // maxSkills = 0 (or a caller-supplied zero) is legal: say why the listing is bare.
            return new ComponentView(STATUS_EMPTY, SOURCE, List.of(), false,
                    List.of(DIAG_EMPTY));
        }
        return new ComponentView(truncated ? STATUS_TRUNCATED : STATUS_READY, SOURCE, items,
                truncated, List.copyOf(diagnostics));
    }

    private record BindingPlusSkill(SkillBinding binding, Skill skill) {}

    private static boolean hasNameCollision(Map<UUID, BindingPlusSkill> unique) {
        Set<String> seen = new LinkedHashSet<>();
        for (BindingPlusSkill entry : unique.values()) {
            if (!seen.add(entry.skill().getName())) {
                return true;
            }
        }
        return false;
    }

    /**
     * {@code <subjectLabel>:<scopeLabel>:<definitionScopeLabel>:<name>}.
     *
     * <p>README #4 only fixes the <i>shape</i> ("principal:skill-name") and the taskbook simplifies
     * it to {@code <subjectLabel>:<scopeLabel>:}. That formula still collides for two skills with the
     * same name but different <b>definition</b> scopes bound on the same axis (exactly the "双存"
     * case V101 allows), so the definition scope is included as a segment — otherwise two distinct
     * skills would render identically and the model could not address either one.</p>
     */
    private static String qualifier(BindingPlusSkill entry, Map<UUID, String> principalNames,
                                    Map<UUID, String> workspaceNames) {
        String subject = SkillBinding.SUBJECT_AGENT_PRINCIPAL.equals(entry.binding().getSubjectType())
                ? "agent:" + principalNames.getOrDefault(entry.binding().getSubjectId(), "unknown")
                : "user";
        String scope = SkillBinding.SCOPE_WORKSPACE.equals(entry.binding().getScopeType())
                ? "workspace:" + workspaceNames.getOrDefault(entry.binding().getScopeId(), "unknown")
                : "instance";
        String definition = Skill.DEFINITION_SCOPE_WORKSPACE.equals(entry.skill().getDefinitionScopeType())
                ? "ws:" + workspaceNames.getOrDefault(entry.skill().getDefinitionScopeId(), "unknown")
                : "instance";
        return subject + ":" + scope + ":" + definition + ":";
    }

    private Map<UUID, String> principalNames(Map<UUID, BindingPlusSkill> unique) {
        Set<UUID> ids = new LinkedHashSet<>();
        for (BindingPlusSkill entry : unique.values()) {
            if (SkillBinding.SUBJECT_AGENT_PRINCIPAL.equals(entry.binding().getSubjectType())) {
                ids.add(entry.binding().getSubjectId());
            }
        }
        Map<UUID, String> names = new LinkedHashMap<>();
        for (AgentPrincipal principal : principalRepository.findAllById(ids)) {
            names.put(principal.getId(), principal.getName());
        }
        return names;
    }

    private Map<UUID, String> workspaceNames(Map<UUID, BindingPlusSkill> unique, Request request) {
        Set<UUID> ids = new LinkedHashSet<>();
        if (request.workspaceId() != null) {
            ids.add(request.workspaceId());
        }
        for (BindingPlusSkill entry : unique.values()) {
            Optional.ofNullable(entry.binding().getScopeId()).ifPresent(ids::add);
            Optional.ofNullable(entry.skill().getDefinitionScopeId()).ifPresent(ids::add);
        }
        Map<UUID, String> names = new LinkedHashMap<>();
        for (Workspace workspace : workspaceRepository.findAllById(ids)) {
            names.put(workspace.getId(), workspace.getName());
        }
        return names;
    }
}
