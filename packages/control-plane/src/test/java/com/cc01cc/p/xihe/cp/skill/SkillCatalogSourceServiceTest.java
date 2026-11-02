package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0628 M1 (§6.2): the listing subset.
 *
 * <p>Scope note — this unit test pins the <b>service's</b> behaviour (dedupe, qualification,
 * truncation, diagnostics, fail-soft). The SQL {@code ORDER BY} that implements the frozen priority
 * (AGENT before USER, workspace before instance, then name) is a database contract and is asserted
 * in the DB-level test, not here: this test hands rows over in the order the query promises and
 * asserts the service <b>preserves</b> it.</p>
 */
class SkillCatalogSourceServiceTest {

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_ID = UUID.randomUUID();

    private final SkillBindingRepository bindings = mock(SkillBindingRepository.class);
    private final AgentPrincipalRepository principals = mock(AgentPrincipalRepository.class);
    private final WorkspaceRepository workspaces = mock(WorkspaceRepository.class);
    private final SkillCatalogSourceService service =
            new SkillCatalogSourceService(bindings, principals, workspaces);

    private static Skill skill(String name, String definitionScopeType, UUID definitionScopeId,
                               String description) {
        Skill skill = new Skill();
        skill.setId(UUID.randomUUID());
        skill.setName(name);
        skill.setDefinitionScopeType(definitionScopeType);
        skill.setDefinitionScopeId(definitionScopeId);
        skill.setDescription(description);
        return skill;
    }

    private static SkillBinding binding(Skill skill, String subjectType, UUID subjectId,
                                        String scopeType, UUID scopeId) {
        SkillBinding binding = new SkillBinding();
        binding.setSkillId(skill.getId());
        binding.setSubjectType(subjectType);
        binding.setSubjectId(subjectId);
        binding.setScopeType(scopeType);
        binding.setScopeId(scopeId);
        return binding;
    }

    private static Object[] row(SkillBinding binding, Skill skill) {
        return new Object[]{binding, skill};
    }

    private static SkillCatalogSourceService.Request request(int maxSkills) {
        return new SkillCatalogSourceService.Request(null, USER_ID, WORKSPACE_ID, maxSkills, true,
                SkillCatalogSourceService.SORT_BINDING);
    }

    @Test
    void fortyIsTheDefaultCeilingAndTheOverflowIsReported() {
        List<Object[]> rows = new ArrayList<>();
        for (int index = 0; index < 45; index++) {
            Skill skill = skill("skill-" + index, Skill.DEFINITION_SCOPE_INSTANCE, null, "d" + index);
            rows.add(row(binding(skill, SkillBinding.SUBJECT_USER, USER_ID,
                    SkillBinding.SCOPE_INSTANCE, null), skill));
        }
        when(bindings.findResolvable(any(), any(), any())).thenReturn(rows);

        SkillCatalogSourceService.ComponentView view =
                service.resolve(request(SkillCatalogSourceService.DEFAULT_MAX_SKILLS));

        assertEquals(SkillCatalogSourceService.DEFAULT_MAX_SKILLS, view.items().size());
        assertEquals(SkillCatalogSourceService.STATUS_TRUNCATED, view.status());
        assertTrue(view.truncated());
        assertTrue(view.diagnostics().contains(SkillCatalogSourceService.DIAG_MAX_SKILLS));
    }

    @Test
    void oneSkillBoundTwiceIsListedOnceAtItsFirstTier() {
        Skill skill = skill("writing", Skill.DEFINITION_SCOPE_INSTANCE, null, "d");
        List<Object[]> rows = Arrays.asList(
                row(binding(skill, SkillBinding.SUBJECT_AGENT_PRINCIPAL, UUID.randomUUID(),
                        SkillBinding.SCOPE_INSTANCE, null), skill),
                row(binding(skill, SkillBinding.SUBJECT_USER, USER_ID,
                        SkillBinding.SCOPE_INSTANCE, null), skill));
        when(bindings.findResolvable(any(), any(), any())).thenReturn(rows);

        SkillCatalogSourceService.ComponentView view = service.resolve(request(40));

        assertEquals(List.of("writing — d"), view.items());
        assertEquals(SkillCatalogSourceService.STATUS_READY, view.status());
        assertTrue(view.diagnostics().isEmpty());
    }

    /**
     * README #4 "双存": two distinct skills may share a name when their definitions live in different
     * scopes, so the listing must disambiguate instead of merging them.
     */
    @Test
    void sameNameFromDifferentDefinitionScopesIsQualifiedNotMerged() {
        UUID workspaceId = UUID.randomUUID();
        Skill instanceSkill = skill("writing", Skill.DEFINITION_SCOPE_INSTANCE, null, "shared");
        Skill workspaceSkill = skill("writing", Skill.DEFINITION_SCOPE_WORKSPACE, workspaceId,
                "workspace copy");
        Workspace definitionWorkspace = mock(Workspace.class);
        when(definitionWorkspace.getId()).thenReturn(workspaceId);
        when(definitionWorkspace.getName()).thenReturn("ws-one");
        // The binding's own workspace and the definition's workspace are two different labels, so
        // both must resolve — that is exactly what makes the qualified name unambiguous.
        Workspace bindingWorkspace = mock(Workspace.class);
        when(bindingWorkspace.getId()).thenReturn(WORKSPACE_ID);
        when(bindingWorkspace.getName()).thenReturn("ws-scope");
        when(workspaces.findAllById(any())).thenReturn(List.of(definitionWorkspace, bindingWorkspace));

        List<Object[]> rows = Arrays.asList(
                row(binding(instanceSkill, SkillBinding.SUBJECT_USER, USER_ID,
                        SkillBinding.SCOPE_INSTANCE, null), instanceSkill),
                row(binding(workspaceSkill, SkillBinding.SUBJECT_USER, USER_ID,
                        SkillBinding.SCOPE_WORKSPACE, WORKSPACE_ID), workspaceSkill));
        when(bindings.findResolvable(any(), any(), any())).thenReturn(rows);

        SkillCatalogSourceService.ComponentView view = service.resolve(request(40));

        assertEquals(2, view.items().size());
        assertTrue(view.diagnostics().contains(SkillCatalogSourceService.DIAG_COLLISION));
        assertTrue(view.items().get(0).startsWith("user:instance:instance:writing — "),
                view.items().get(0));
        assertTrue(view.items().get(1).startsWith("user:workspace:ws-scope:ws:ws-one:writing — "),
                view.items().get(1));
    }

    @Test
    void uniqueNamesStayBare() {
        Skill one = skill("alpha", Skill.DEFINITION_SCOPE_INSTANCE, null, "a");
        Skill two = skill("beta", Skill.DEFINITION_SCOPE_INSTANCE, null, "b");
        when(bindings.findResolvable(any(), any(), any())).thenReturn(Arrays.asList(
                row(binding(one, SkillBinding.SUBJECT_USER, USER_ID, SkillBinding.SCOPE_INSTANCE, null), one),
                row(binding(two, SkillBinding.SUBJECT_USER, USER_ID, SkillBinding.SCOPE_INSTANCE, null), two)));

        SkillCatalogSourceService.ComponentView view = service.resolve(request(40));

        assertEquals(List.of("alpha — a", "beta — b"), view.items());
        assertTrue(view.diagnostics().isEmpty());
    }

    @Test
    void descriptionsCanBeOmitted() {
        Skill skill = skill("alpha", Skill.DEFINITION_SCOPE_INSTANCE, null, "a");
        when(bindings.findResolvable(any(), any(), any())).thenReturn(Collections.singletonList(
                row(binding(skill, SkillBinding.SUBJECT_USER, USER_ID, SkillBinding.SCOPE_INSTANCE, null), skill)));

        SkillCatalogSourceService.ComponentView view = service.resolve(
                new SkillCatalogSourceService.Request(null, USER_ID, WORKSPACE_ID, 40, false,
                        SkillCatalogSourceService.SORT_BINDING));

        assertEquals(List.of("alpha"), view.items());
    }

    /**
     * PLAN-0628 M3-② (裁定 A+B+C): the renderer is the rendering authority, so it normalises the
     * dirty shapes a historical row can still hold — surrounding whitespace, an empty/blank
     * description (no dangling separator), and embedded line breaks (one item stays one line).
     *
     * <p>These rows cannot be imported any more ({@code SkillImportValidator} refuses them), which
     * is exactly why the renderer must handle them <i>without</i> a backfill.</p>
     */
    @Test
    void dirtyDescriptionsAreNormalisedAtRenderTime() {
        Skill padded = skill("alpha", Skill.DEFINITION_SCOPE_INSTANCE, null, "  padded description  ");
        Skill empty = skill("beta", Skill.DEFINITION_SCOPE_INSTANCE, null, "");
        Skill blank = skill("delta", Skill.DEFINITION_SCOPE_INSTANCE, null, "   ");
        Skill multiline = skill("gamma", Skill.DEFINITION_SCOPE_INSTANCE, null,
                "Extract action items\r\n\r\nfrom a meeting transcript");
        Skill nullDescription = skill("epsilon", Skill.DEFINITION_SCOPE_INSTANCE, null, null);
        when(bindings.findResolvable(any(), any(), any())).thenReturn(Arrays.asList(
                row(binding(padded, SkillBinding.SUBJECT_USER, USER_ID, SkillBinding.SCOPE_INSTANCE, null), padded),
                row(binding(empty, SkillBinding.SUBJECT_USER, USER_ID, SkillBinding.SCOPE_INSTANCE, null), empty),
                row(binding(blank, SkillBinding.SUBJECT_USER, USER_ID, SkillBinding.SCOPE_INSTANCE, null), blank),
                row(binding(multiline, SkillBinding.SUBJECT_USER, USER_ID, SkillBinding.SCOPE_INSTANCE, null), multiline),
                row(binding(nullDescription, SkillBinding.SUBJECT_USER, USER_ID, SkillBinding.SCOPE_INSTANCE, null), nullDescription)));

        SkillCatalogSourceService.ComponentView view = service.resolve(request(40));

        assertEquals(List.of(
                "alpha — padded description",
                "beta",
                "delta",
                "gamma — Extract action items from a meeting transcript",
                "epsilon"), view.items());
        // The invariant the Agent relies on: no rendered item spans a line, and none carries edge
        // whitespace (its own `strip()` would then change CP's bytes).
        for (String item : view.items()) {
            assertEquals(item.strip(), item, "an item carries edge whitespace: [" + item + "]");
            assertFalse(item.chars().anyMatch(ch -> ch == '\n' || ch == '\r'),
                    "an item spans a line: [" + item + "]");
            assertFalse(item.endsWith(" — "), "a dangling separator survived: [" + item + "]");
        }
    }

    @Test
    void noBindingsIsEmptyNotAnError() {
        when(bindings.findResolvable(any(), any(), any())).thenReturn(Arrays.asList());

        SkillCatalogSourceService.ComponentView view = service.resolve(request(40));

        assertEquals(SkillCatalogSourceService.STATUS_EMPTY, view.status());
        assertTrue(view.items().isEmpty());
        assertFalse(view.truncated());
        assertEquals(List.of(SkillCatalogSourceService.DIAG_EMPTY), view.diagnostics());
    }

    @Test
    void resolveFailureIsReportedInsteadOfFailingTheRun() {
        when(bindings.findResolvable(any(), any(), any())).thenThrow(new IllegalStateException("db"));

        SkillCatalogSourceService.ComponentView view = service.resolve(request(40));

        assertEquals(SkillCatalogSourceService.STATUS_FAILED, view.status());
        assertEquals(List.of(SkillCatalogSourceService.DIAG_RESOLVE_FAILED), view.diagnostics());
    }

    @Test
    void reservedUsageSortIsRefusedExplicitly() {
        CpApiException refused = assertThrows(CpApiException.class, () -> service.resolve(
                new SkillCatalogSourceService.Request(null, USER_ID, WORKSPACE_ID, 40, true,
                        SkillCatalogSourceService.SORT_USAGE_RESERVED)));
        assertEquals("INVALID_REQUEST", refused.getCode());
        assertThrows(CpApiException.class, () -> service.resolve(
                new SkillCatalogSourceService.Request(null, USER_ID, WORKSPACE_ID, 40, true, "random")));
    }

    @Test
    void theWireViewCarriesOnlyScalarsAndStringLists() {
        Skill skill = skill("alpha", Skill.DEFINITION_SCOPE_INSTANCE, null, "a");
        when(bindings.findResolvable(any(), any(), any())).thenReturn(Collections.singletonList(
                row(binding(skill, SkillBinding.SUBJECT_USER, USER_ID, SkillBinding.SCOPE_INSTANCE, null), skill)));

        Map<String, Object> view = service.resolve(request(40)).toMap();

        assertEquals(List.of("status", "source", "items", "truncated", "diagnostics"),
                List.copyOf(view.keySet()));
        assertEquals(SkillCatalogSourceService.SOURCE, view.get("source"));
        assertTrue(view.get("items") instanceof List<?>);
        // PLAN-0633 C1: nothing Jackson-2 shaped may travel in this map.
        for (Object value : view.values()) {
            assertFalse(value instanceof com.fasterxml.jackson.databind.JsonNode, value.toString());
        }
        assertTrue(!view.containsKey(null));
        assertTrue(view.keySet().stream().noneMatch(java.util.Objects::isNull));
    }

    @Test
    void mapKeysAreStableForTheWireContract() {
        // Guard against a future refactor renaming a key: the Agent validates these exact names.
        SkillCatalogSourceService.ComponentView view = new SkillCatalogSourceService.ComponentView(
                "ready", "skill_bindings", List.of("a — b"), false, List.of());

        assertEquals("status,source,items,truncated,diagnostics",
                String.join(",", view.toMap().keySet()));
    }
}
