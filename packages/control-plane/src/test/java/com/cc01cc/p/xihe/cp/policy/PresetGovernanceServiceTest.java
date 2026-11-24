package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-996: the compare classifier is the read-side projection of the reconciliation kernel.
 *
 * <p>Every case below is stated in the kernel's own vocabulary — {@code (scope, atom,
 * originPresetId)} rows, {@code source='assigned'}, NULL origin = local work — so a regression in
 * the classifier shows up as a wrong bucket instead of a silently "still 200" endpoint.</p>
 */
class PresetGovernanceServiceTest {

    private static final String SUBJECT_TYPE = GrantPrincipalPathResolver.USER;
    private static final UUID SUBJECT_ID = UUID.randomUUID();
    private static final UUID PRESET_A = UUID.randomUUID();
    private static final UUID PRESET_B = UUID.randomUUID();

    private final ObjectMapper mapper = new ObjectMapper();
    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    // ── classifier ──────────────────────────────────────────────────────────

    @Test
    void aLocallyDeletedImportAtomIsMissingAndRealignWouldRestoreIt() {
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> desired =
                desired(Map.of(read(), Set.of(PRESET_A)));

        PresetGovernanceViews.CompareView view = PresetGovernanceService.classifyDiff(
                evaluator, SUBJECT_TYPE, SUBJECT_ID, desired, List.of());

        assertEquals(1, view.scopes().size());
        PresetGovernanceViews.ScopeDiffView scope = view.scopes().get(0);
        assertEquals(1, scope.missing().size(), "the deleted import row is the difference");
        assertEquals(read().actionClass(), scope.missing().get(0).actionClass());
        assertEquals(List.of(PRESET_A), scope.missing().get(0).originPresetIds(),
                "the missing atom names the preset group a realign would re-import from");
        assertTrue(scope.extra().isEmpty());
        assertTrue(scope.localAdded().isEmpty());
        assertFalse(scope.inSync());
        assertTrue(view.summary().changed(), "a realign would create a row");
        assertEquals(1, view.summary().missing());
    }

    @Test
    void aLocallyAddedAtomIsLocalWorkAndNeverAnExtra() {
        // No bindings at all: the only row is a NULL-origin (manual) grant.
        PresetGovernanceViews.CompareView view = PresetGovernanceService.classifyDiff(
                evaluator, SUBJECT_TYPE, SUBJECT_ID, Map.of(),
                List.of(grant(read(), null, AccessScope.instance())));

        PresetGovernanceViews.ScopeDiffView scope = view.scopes().get(0);
        assertEquals(1, scope.localAdded().size(), "a NULL-origin row is local work");
        assertTrue(scope.extra().isEmpty(),
                "no preset group owns the row, so no realign may delete it (R39)");
        assertTrue(scope.missing().isEmpty());
        assertFalse(view.summary().changed(), "a realign would be a no-op");
    }

    @Test
    void anInSyncScopeReportsNothing() {
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> desired =
                desired(Map.of(read(), Set.of(PRESET_A)));

        PresetGovernanceViews.CompareView view = PresetGovernanceService.classifyDiff(
                evaluator, SUBJECT_TYPE, SUBJECT_ID, desired,
                List.of(grant(read(), PRESET_A, AccessScope.instance())));

        PresetGovernanceViews.ScopeDiffView scope = view.scopes().get(0);
        assertTrue(scope.inSync());
        assertTrue(scope.missing().isEmpty());
        assertTrue(scope.extra().isEmpty());
        assertTrue(scope.localAdded().isEmpty());
        assertTrue(scope.overridden().isEmpty());
        assertFalse(view.summary().changed());
    }

    @Test
    void theSameAtomUnderTwoGroupsIsTwoRowsAndOnlyTheMissingGroupIsReported() {
        // V186 keys uq_grants_role_atom on (subject, scope, atom, origin_preset_id): the second
        // group is a DISTINCT row, not a duplicate — so group B is missing while group A is fine.
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> desired =
                desired(Map.of(read(), Set.of(PRESET_A, PRESET_B)));

        PresetGovernanceViews.CompareView view = PresetGovernanceService.classifyDiff(
                evaluator, SUBJECT_TYPE, SUBJECT_ID, desired,
                List.of(grant(read(), PRESET_A, AccessScope.instance())));

        PresetGovernanceViews.ScopeDiffView scope = view.scopes().get(0);
        assertEquals(1, scope.missing().size());
        assertEquals(List.of(PRESET_B), scope.missing().get(0).originPresetIds(),
                "only the group with no row is missing; deleting the atom from A would be wrong");
        assertTrue(scope.extra().isEmpty(), "group A's row is still desired");
        assertTrue(view.summary().changed());
    }

    @Test
    void aLocalRowShadowingAMissingImportAtomIsReportedAsOverridden() {
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> desired =
                desired(Map.of(read(), Set.of(PRESET_A)));

        PresetGovernanceViews.CompareView view = PresetGovernanceService.classifyDiff(
                evaluator, SUBJECT_TYPE, SUBJECT_ID, desired,
                List.of(grant(read(), null, AccessScope.instance())));

        PresetGovernanceViews.ScopeDiffView scope = view.scopes().get(0);
        assertEquals(1, scope.missing().size());
        assertEquals(1, scope.localAdded().size());
        assertEquals(1, scope.overridden().size(),
                "「我删了导入行又手加了一个」 must be visible, not shown as a duplicate atom");
        assertEquals(read().actionClass(), scope.overridden().get(0).actionClass());
        assertEquals(1, view.summary().overridden());
    }

    @Test
    void aMalformedRowIsReportedAsAnExtraBecauseRealignRepairsIt() {
        // Two atoms in one row cannot be matched against the desired set; reconcile deletes it.
        PresetGovernanceViews.CompareView view = PresetGovernanceService.classifyDiff(
                evaluator, SUBJECT_TYPE, SUBJECT_ID, Map.of(),
                List.of(grantMulti()));

        PresetGovernanceViews.ScopeDiffView scope = view.scopes().get(0);
        assertEquals(1, scope.extra().size());
        assertNull(scope.extra().get(0).originPresetId(),
                "a malformed row is not attributed to a group");
        assertTrue(view.summary().changed(), "realign would delete and rewrite it");
    }

    @Test
    void aWorkspaceScopedRowAndItsInstanceRowAreListedInTheirOwnScopes() {
        UUID workspaceId = UUID.randomUUID();
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> desired =
                new LinkedHashMap<>();
        desired.put(AccessScope.instance(), Map.of(read(), Set.of(PRESET_A)));
        desired.put(AccessScope.workspace(workspaceId), Map.of(write(), Set.of(PRESET_A)));

        PresetGovernanceViews.CompareView view = PresetGovernanceService.classifyDiff(
                evaluator, SUBJECT_TYPE, SUBJECT_ID, desired, List.of());

        assertEquals(2, view.scopes().size());
        assertEquals(AccessScope.INSTANCE, view.scopes().get(0).scopeType(),
                "instance scope sorts first");
        assertEquals(workspaceId, view.scopes().get(1).scopeId());
        assertEquals(1, view.scopes().get(0).missing().size());
        assertEquals(1, view.scopes().get(1).missing().size());
    }

    // ── service wiring ──────────────────────────────────────────────────────

    @Test
    void realignDelegatesToTheKernelAndReportsTheAssignedSource() {
        Fixture fixture = new Fixture();
        when(fixture.materializer.materializeSubjectAndBumpIfChanged(SUBJECT_TYPE, SUBJECT_ID,
                null, null)).thenReturn(new PresetGrantMaterializer.Result(2, 1, 3));

        PresetGovernanceViews.RealignView view =
                fixture.service.realign(SUBJECT_TYPE, SUBJECT_ID, null, null);

        assertEquals(2, view.created());
        assertEquals(1, view.deleted());
        assertTrue(view.changed());
        assertEquals(3, view.scopes());
        assertEquals(PresetGrantMaterializer.SOURCE_ASSIGNED, view.source(),
                "a realign writes the same provenance an import does");
        verify(fixture.materializer).materializeSubjectAndBumpIfChanged(SUBJECT_TYPE, SUBJECT_ID,
                null, null);
        verify(fixture.materializer, never())
                .materializeSubjectWithEpochBump(any(), any(), any(), any());
    }

    @Test
    void aNoOpRealignIsReportedAsUnchanged() {
        Fixture fixture = new Fixture();
        when(fixture.materializer.materializeSubjectAndBumpIfChanged(SUBJECT_TYPE, SUBJECT_ID,
                null, null)).thenReturn(new PresetGrantMaterializer.Result(0, 0, 1));

        PresetGovernanceViews.RealignView view =
                fixture.service.realign(SUBJECT_TYPE, SUBJECT_ID, null, null);

        assertFalse(view.changed());
        assertEquals(0, view.created());
        assertEquals(0, view.deleted());
    }

    @Test
    void realignAuthoritySweepsEveryTouchedWorkspaceFromBindingsAndRows() {
        Fixture fixture = new Fixture();
        UUID fromBinding = UUID.randomUUID();
        UUID fromStaleRow = UUID.randomUUID();
        when(fixture.bindings.findBySubjectTypeAndSubjectId(SUBJECT_TYPE, SUBJECT_ID))
                .thenReturn(List.of(binding(fixture.roleId, AccessScope.workspace(fromBinding))));
        when(fixture.grants.findBySubjectTypeAndSubjectIdAndSource(SUBJECT_TYPE, SUBJECT_ID,
                PresetGrantMaterializer.SOURCE_ASSIGNED))
                .thenReturn(List.of(grant(read(), PRESET_A, AccessScope.workspace(fromStaleRow))));

        fixture.service.requireRealignAuthority(SUBJECT_TYPE, SUBJECT_ID);

        verify(fixture.requester).requireManageRoles();
        verify(fixture.requester).requireWorkspaceBindingAuthority(fromBinding);
        verify(fixture.requester).requireWorkspaceBindingAuthority(fromStaleRow);
        verify(fixture.requester, times(2)).requireWorkspaceBindingAuthority(any());
    }

    @Test
    void compareFeedsTheSubjectsBindingsToTheKernelAndReadsAssignedRowsOnly() {
        Fixture fixture = new Fixture();
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> desired =
                desired(Map.of(read(), Set.of(PRESET_A)));
        when(fixture.bindings.findBySubjectTypeAndSubjectId(SUBJECT_TYPE, SUBJECT_ID))
                .thenReturn(List.of(binding(fixture.roleId, AccessScope.instance())));
        when(fixture.materializer.desiredByScopeAndOrigin(any())).thenReturn(desired);
        when(fixture.grants.findBySubjectTypeAndSubjectIdAndSource(SUBJECT_TYPE, SUBJECT_ID,
                PresetGrantMaterializer.SOURCE_ASSIGNED)).thenReturn(List.of());

        PresetGovernanceViews.CompareView view = fixture.service.compare(
                SUBJECT_TYPE, SUBJECT_ID, null);

        assertEquals(SUBJECT_TYPE, view.subjectType());
        assertEquals(SUBJECT_ID, view.subjectId());
        assertEquals(1, view.summary().missing());
        verify(fixture.materializer).desiredByScopeAndOrigin(any());
        verify(fixture.grants).findBySubjectTypeAndSubjectIdAndSource(SUBJECT_TYPE, SUBJECT_ID,
                PresetGrantMaterializer.SOURCE_ASSIGNED);
    }

    @Test
    void comparingOnePresetFiltersTheBindingsToThatGroup() {
        Fixture fixture = new Fixture();
        UUID other = UUID.randomUUID();
        when(fixture.bindings.findBySubjectTypeAndSubjectId(SUBJECT_TYPE, SUBJECT_ID))
                .thenReturn(List.of(binding(PRESET_A, AccessScope.instance()),
                        binding(other, AccessScope.instance())));
        when(fixture.materializer.desiredByScopeAndOrigin(any())).thenReturn(Map.of());
        when(fixture.grants.findBySubjectTypeAndSubjectIdAndSource(any(), any(), any()))
                .thenReturn(List.of());

        fixture.service.compare(SUBJECT_TYPE, SUBJECT_ID, PRESET_A);

        org.mockito.ArgumentCaptor<List<GrantPresetBinding>> captor =
                org.mockito.ArgumentCaptor.forClass(List.class);
        verify(fixture.materializer).desiredByScopeAndOrigin(captor.capture());
        assertEquals(1, captor.getValue().size());
        assertEquals(PRESET_A, captor.getValue().get(0).getRoleId());
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    private static final class Fixture {
        final GrantPresetBindingRepository bindings = mock(GrantPresetBindingRepository.class);
        final AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        final UserRepository users = mock(UserRepository.class);
        final AgentPrincipalRepository agents = mock(AgentPrincipalRepository.class);
        final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();
        final PresetGrantMaterializer materializer = mock(PresetGrantMaterializer.class);
        final RequesterAuthority requester = mock(RequesterAuthority.class);
        final PresetGovernanceService service = new PresetGovernanceService(bindings, grants,
                users, agents, evaluator, materializer, requester);
        final UUID roleId = PRESET_A;
    }

    private static GrantIntersectionEvaluator.PermissionAtom read() {
        return new GrantIntersectionEvaluator.PermissionAtom(ToolFaceRegistry.ACTION_READ, null);
    }

    private static GrantIntersectionEvaluator.PermissionAtom write() {
        return new GrantIntersectionEvaluator.PermissionAtom(ToolFaceRegistry.ACTION_WRITE, null);
    }

    private static Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>>
            desired(Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>> instanceAtoms) {
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> map =
                new LinkedHashMap<>();
        map.put(AccessScope.instance(), instanceAtoms);
        return map;
    }

    private static GrantPresetBinding binding(UUID presetId, AccessScope scope) {
        return new GrantPresetBinding(presetId, SUBJECT_TYPE, SUBJECT_ID, scope.type(),
                scope.id(), null);
    }

    private AuthorizationGrant grant(GrantIntersectionEvaluator.PermissionAtom atom, UUID origin,
                                     AccessScope scope) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(SUBJECT_TYPE);
        grant.setSubjectId(SUBJECT_ID);
        grant.setSource(PresetGrantMaterializer.SOURCE_ASSIGNED);
        grant.setOriginPresetId(origin);
        grant.setScopeType(scope.type());
        grant.setScopeId(scope.id());
        grant.setPermissions(atomArray(atom));
        return grant;
    }

    private AuthorizationGrant grantMulti() {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(SUBJECT_TYPE);
        grant.setSubjectId(SUBJECT_ID);
        grant.setSource(PresetGrantMaterializer.SOURCE_ASSIGNED);
        grant.setScopeType(AccessScope.INSTANCE);
        ArrayNode permissions = mapper.createArrayNode();
        permissions.add(atomNode(read()));
        permissions.add(atomNode(write()));
        grant.setPermissions(permissions);
        return grant;
    }

    private ArrayNode atomArray(GrantIntersectionEvaluator.PermissionAtom atom) {
        ArrayNode permissions = mapper.createArrayNode();
        permissions.add(atomNode(atom));
        return permissions;
    }

    private ObjectNode atomNode(GrantIntersectionEvaluator.PermissionAtom atom) {
        ObjectNode node = mapper.createObjectNode();
        node.put("actionClass", atom.actionClass());
        if (!"*".equals(atom.resource())) {
            node.put("resource", atom.resource());
        }
        return node;
    }
}
