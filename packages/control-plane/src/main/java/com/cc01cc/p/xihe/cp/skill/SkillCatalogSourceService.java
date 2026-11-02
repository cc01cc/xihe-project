package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
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

    /** Mirrors {@code context-templates.json#skillCatalogConfig.maxSkills}: the config bound wins. */
    public static final int MAX_SKILLS_UPPER = 200;

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

    /**
     * One listing entry plus the provenance a later milestone (M2b's {@code skill_read} comparison)
     * needs. {@code qualifiedName} is the D28-31 three-segment display name — it is always the full
     * {@code <subject>:<scope>:<definitionScope>:<name>} form, even when the rendered line falls back
     * to the bare {@code name} because nothing collides.
     */
    public record Item(UUID skillId, String qualifiedName, String name, String description,
                       int version, String contentHash, boolean oversize,
                       String subjectType, String scopeType, String definitionScopeType) {
    }

    /**
     * A resolved listing <b>before</b> it is flattened into wire lines.
     *
     * <p>PLAN-0628 M2a (D28-35): the run snapshot stores these items, not the lines. The lines are a
     * pure function of the items plus {@code collision}/{@code includeDescriptions}, and both the
     * live path and the snapshot path render through {@link #view(Listing)} — so freezing cannot
     * drift from what a live resolve would have produced.</p>
     */
    public record Listing(String status, List<Item> items, boolean truncated,
                          List<String> diagnostics, int maxSkills, boolean includeDescriptions,
                          boolean collision) {
    }

    /** Resolves one component instance's listing. Never throws for data problems: they become {@code failed}. */
    public ComponentView resolve(Request request) {
        if (request == null) {
            return new ComponentView(STATUS_EMPTY, SOURCE, List.of(), false, List.of(DIAG_EMPTY));
        }
        requireSupportedSort(request);
        try {
            return view(resolveListing(request));
        } catch (RuntimeException failure) {
            // D27-22: a missing listing only removes discoverability; it must not fail the run.
            return new ComponentView(STATUS_FAILED, SOURCE, List.of(), false,
                    List.of(DIAG_RESOLVE_FAILED));
        }
    }

    /**
     * Resolves the structured listing (PLAN-0628 M2a): the same ordering, dedupe, qualification and
     * count bound {@link #resolve(Request)} applies, but without flattening the entries into lines.
     * Data problems are reported as a {@code failed} listing instead of throwing, exactly like the
     * wire path, so callers that freeze a snapshot never fail a Run over the listing.
     */
    public Listing resolveListing(Request request) {
        if (request == null) {
            return new Listing(STATUS_EMPTY, List.of(), false, List.of(DIAG_EMPTY),
                    DEFAULT_MAX_SKILLS, true, false);
        }
        requireSupportedSort(request);
        try {
            return resolveRows(request);
        } catch (RuntimeException failure) {
            return new Listing(STATUS_FAILED, List.of(), false, List.of(DIAG_RESOLVE_FAILED),
                    request.maxSkills(), request.includeDescriptions(), false);
        }
    }

    /**
     * Flattens a listing into the wire view — the single renderer for live and snapshot reads.
     *
     * <p>{@code collision} decides whether the qualified or the bare name leads the line (M1's
     * behaviour, preserved): unique names stay bare so the listing reads naturally, and only a real
     * collision pays the qualified-name tax.</p>
     */
    public static ComponentView view(Listing listing) {
        List<String> lines = new ArrayList<>();
        for (Item item : listing.items()) {
            String display = listing.collision() ? item.qualifiedName() : item.name();
            lines.add(listing.includeDescriptions() && item.description() != null
                    ? display + SEPARATOR + item.description()
                    : display);
        }
        return new ComponentView(listing.status(), SOURCE, List.copyOf(lines), listing.truncated(),
                listing.diagnostics());
    }

    /**
     * PLAN-0628 M2a (D28-39): renders a Run's listing <b>only</b> from its frozen snapshot.
     *
     * <p>This is a pure function of the snapshot and the component's render flags: it never consults
     * {@code skill_bindings}, so a binding added or removed after admission cannot change what this
     * Run's model sees. The collision flag is recovered from the frozen diagnostics instead of being
     * recomputed — recomputing would need the live bindings and reintroduce exactly the drift the
     * snapshot exists to prevent.</p>
     */
    public static ComponentView renderFromSnapshot(JsonNode snapshot, Request request) {
        List<Item> items = new ArrayList<>();
        for (JsonNode item : snapshot.path("items")) {
            items.add(new Item(
                    uuidOrNull(item.path("skillId").asText("")),
                    item.path("qualifiedName").asText(""),
                    item.path("name").asText(""),
                    item.path("description").asText(""),
                    item.path("version").asInt(1),
                    item.path("contentHash").asText(""),
                    item.path("oversize").asBoolean(false),
                    item.path("tier").path("subjectType").asText(""),
                    item.path("tier").path("scopeType").asText(""),
                    item.path("tier").path("definitionScopeType").asText("")));
        }
        List<String> diagnostics = new ArrayList<>();
        for (JsonNode diagnostic : snapshot.path("diagnostics")) {
            if (diagnostic.isTextual()) {
                diagnostics.add(diagnostic.asText());
            }
        }
        boolean includeDescriptions = request == null || request.includeDescriptions();
        return view(new Listing(
                snapshot.path("status").asText(STATUS_EMPTY),
                List.copyOf(items),
                snapshot.path("truncated").asBoolean(false),
                List.copyOf(diagnostics),
                snapshot.path("maxSkills").asInt(DEFAULT_MAX_SKILLS),
                includeDescriptions,
                diagnostics.contains(DIAG_COLLISION)));
    }

    /**
     * Derives the listing request from a component's persisted {@code config}
     * ({@code context-templates.json#skillCatalogConfig}). Shared by the admission-time freeze and
     * the dispatch-time render so both read the same count bound and description flag from the same
     * frozen template.
     */
    public static Request requestFrom(JsonNode config, UUID agentPrincipalId, UUID userId,
                                      UUID workspaceId) {
        JsonNode source = config == null ? JsonNodeFactory.instance.objectNode() : config;
        int requested = source.path("maxSkills").asInt(DEFAULT_MAX_SKILLS);
        int maxSkills = requested < 1 ? DEFAULT_MAX_SKILLS : Math.min(requested, MAX_SKILLS_UPPER);
        boolean includeDescriptions = !source.has("includeDescriptions")
                || source.path("includeDescriptions").asBoolean(true);
        String sort = source.path("sort").asText(SORT_BINDING);
        return new Request(agentPrincipalId, userId, workspaceId, maxSkills, includeDescriptions, sort);
    }

    /** A failed view for callers that refuse to resolve at all (bad binding, bad ids). */
    public static ComponentView failed(String diagnostic) {
        return new ComponentView(STATUS_FAILED, SOURCE, List.of(), false, List.of(diagnostic));
    }

    private static void requireSupportedSort(Request request) {
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
    }

    private static UUID uuidOrNull(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException notAnId) {
            return null;
        }
    }

    private Listing resolveRows(Request request) {
        List<Object[]> rows = bindingRepository.findResolvable(
                request.agentPrincipalId(), request.userId(), request.workspaceId());
        if (rows == null || rows.isEmpty()) {
            return new Listing(STATUS_EMPTY, List.of(), false, List.of(DIAG_EMPTY),
                    request.maxSkills(), request.includeDescriptions(), false);
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

        // The names are resolved unconditionally: the entry's qualifiedName is part of the frozen
        // record even when the rendered line happens to stay bare.
        Map<UUID, String> principalNames = principalNames(unique);
        Map<UUID, String> workspaceNames = workspaceNames(unique, request);

        List<Item> items = new ArrayList<>();
        List<BindingPlusSkill> ordered = new ArrayList<>(unique.values());
        boolean truncated = ordered.size() > request.maxSkills();
        int limit = Math.min(ordered.size(), Math.max(0, request.maxSkills()));
        for (int index = 0; index < limit; index++) {
            BindingPlusSkill entry = ordered.get(index);
            Skill skill = entry.skill();
            items.add(new Item(skill.getId(),
                    qualifier(entry, principalNames, workspaceNames) + skill.getName(),
                    skill.getName(), skill.getDescription(), skill.getVersion(), skill.getContentHash(),
                    skill.isOversize(), entry.binding().getSubjectType(), entry.binding().getScopeType(),
                    skill.getDefinitionScopeType()));
        }
        if (truncated) {
            diagnostics.add(DIAG_MAX_SKILLS);
        }
        if (items.isEmpty()) {
            // maxSkills = 0 (or a caller-supplied zero) is legal: say why the listing is bare.
            return new Listing(STATUS_EMPTY, List.of(), false, List.of(DIAG_EMPTY),
                    request.maxSkills(), request.includeDescriptions(), collision);
        }
        return new Listing(truncated ? STATUS_TRUNCATED : STATUS_READY, List.copyOf(items), truncated,
                List.copyOf(diagnostics), request.maxSkills(), request.includeDescriptions(), collision);
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
