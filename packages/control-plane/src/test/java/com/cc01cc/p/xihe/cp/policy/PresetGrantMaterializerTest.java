package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.GrantPresetAtom;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetAtomRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0610 W1a T1.5: the preset materializer.
 *
 * <p>task-933 / R39 pins the shape the evaluation query relies on: importing a preset writes one
 * {@code source='assigned'} row per atom, carrying the {@code origin_preset_id} of the import group
 * that produced it, with the binding scope copied onto the row; capability atoms are filtered out
 * (design #23) and an atom that cannot live in the binding scope is rejected rather than dropped
 * (decision #12).</p>
 *
 * <p>Because a preset is now a READ-ONLY TEMPLATE, the identity of a reconciled row is
 * {@code (scope, atom, importGroup)}: a rewrite never removes a row another still-bound group
 * carries, and a NULL-origin row (manual work, or a legacy row V186 could not attribute) survives
 * every group rewrite. {@code GrantSources.PRESET} is neither written nor evaluated any more — the
 * retired axis must not be able to come back through a write.</p>
 */
class PresetGrantMaterializerTest {

    private static final UUID USER_PRESET = UUID.randomUUID();
    private static final UUID WS_EDITOR_PRESET = UUID.randomUUID();
    private static final UUID ADMIN_PRESET = UUID.randomUUID();
    private static final UUID ACCOUNT_PRESET = UUID.randomUUID();
    private static final UUID EXTRA_PRESET = UUID.randomUUID();

    private static final UUID SUBJECT = UUID.randomUUID();
    private static final UUID ACTOR = UUID.randomUUID();
    private static final UUID WORKSPACE_A = UUID.randomUUID();

    /** Per-preset atom sets; mutable so a case can model "the template's own set changed". */
    private final Map<UUID, List<String>> presetAtoms = new HashMap<>();

    private GrantPresetBindingRepository bindingRepository;
    private GrantPresetAtomRepository permissionRepository;
    private AuthorizationGrantRepository grantRepository;
    private UserRepository userRepository;
    private AuthzContext authzContext;
    private AuditLogger auditLogger;
    private PresetGrantMaterializer materializer;

    @BeforeEach
    void setUp() {
        bindingRepository = mock(GrantPresetBindingRepository.class);
        permissionRepository = mock(GrantPresetAtomRepository.class);
        grantRepository = mock(AuthorizationGrantRepository.class);
        userRepository = mock(UserRepository.class);
        authzContext = mock(AuthzContext.class);
        auditLogger = mock(AuditLogger.class);
        materializer = new PresetGrantMaterializer(bindingRepository, permissionRepository,
                grantRepository, userRepository, new GrantIntersectionEvaluator(), authzContext,
                auditLogger, new ObjectMapper());
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource(anyString(), any(), anyString()))
                .thenReturn(List.of());
        // The epoch bump reads the row FOR UPDATE; unstubbed it answers null and the bump NPEs.
        when(userRepository.findByIdForUpdate(any())).thenAnswer(invocation ->
                Optional.of(userWith(invocation.getArgument(0))));
        presetAtoms.put(USER_PRESET, new ArrayList<>(List.of("read", "write", "delete", "exec", "network")));
        presetAtoms.put(WS_EDITOR_PRESET, new ArrayList<>(List.of("read", "write", "delete", "exec")));
        presetAtoms.put(EXTRA_PRESET, new ArrayList<>(List.of("read", "CREATE_TEMPLATE")));
        stubPresetAtoms();
    }

    // ------------------------------------------------------------------ import

    @Test
    void importsOneAssignedRowPerAtomCarryingItsImportGroup() {
        GrantPresetBinding instance = instanceBinding(USER_PRESET);
        GrantPresetBinding workspace = workspaceBinding(WS_EDITOR_PRESET, WORKSPACE_A);
        bindingsOf(instance, workspace);

        PresetGrantMaterializer.Result result =
                materializer.materializeSubject(SUBJECT_USER, SUBJECT, ACTOR, null);

        List<AuthorizationGrant> saved = savedRows();
        assertEquals(5 + 4, saved.size(),
                "five USER atoms at instance scope plus four editor atoms at workspace scope");
        assertEquals(5 + 4, result.created());
        assertEquals(0, result.deleted());
        for (AuthorizationGrant row : saved) {
            // task-933 / R39: an imported atom is an `assigned` row — never the retired `preset`.
            assertEquals(GrantSources.ASSIGNED, row.getSource());
            assertNotNull(row.getOriginPresetId(), "an import always cites the preset it came from");
            assertEquals("read", row.getReadState());
            assertEquals(1, row.getPermissions().size(), "one atom per row (round-2 P1-2)");
            assertEquals(row.getScopeId() == null ? AccessScope.INSTANCE : AccessScope.WORKSPACE,
                    row.getScopeType());
            // The origin id is the import group = the PRESET id (the column's own name, and what a
            // display face can resolve). Two presets imported into one scope stay two rows because
            // the V186 unique key carries the origin.
            assertEquals(row.getScopeId() == null ? USER_PRESET : WS_EDITOR_PRESET,
                    row.getOriginPresetId(),
                    "each row cites the template its import group came from: "
                            + "instance rows -> USER, workspace rows -> WS_EDITOR");
            assertNotEquals(instance.getId(), row.getOriginPresetId(),
                    "origin_preset_id is the preset, never the grant_preset_bindings row id");
        }
        assertEquals(5, saved.stream().filter(row -> row.getScopeId() == null).count());
        assertEquals(4, saved.stream().filter(row -> WORKSPACE_A.equals(row.getScopeId())).count());
        verify(authzContext).invalidate(SUBJECT);
    }

    @Test
    void anAdminShapedPresetMaterializesEveryActionAtomAndNoCapabilityAtom() {
        List<String> atoms = new ArrayList<>(PermissionAtomCatalog.actionAtoms());
        atoms.addAll(PermissionAtomCatalog.capabilityAtoms());
        presetAtoms.put(ADMIN_PRESET, atoms);
        stubPresetAtoms();
        bindingsOf(instanceBinding(ADMIN_PRESET));

        materializer.materializeSubject(SUBJECT_USER, SUBJECT, ACTOR, null);

        List<AuthorizationGrant> saved = savedRows();
        assertEquals(PermissionAtomCatalog.actionAtoms().size(), saved.size(),
                "every action atom materializes; the three capability atoms are resolved at "
                        + "authentication time and never reach grants (design #23)");
        List<String> written = new ArrayList<>();
        saved.forEach(row -> written.add(row.getPermissions().get(0).get("actionClass").asText()));
        assertEquals(new LinkedHashSet<>(PermissionAtomCatalog.actionAtoms()),
                new LinkedHashSet<>(written), "exactly the action atoms, in preset order");
        for (String capability : PermissionAtomCatalog.capabilityAtoms()) {
            assertFalse(written.contains(capability), "capability atom must not reach grants: " + capability);
        }
        assertTrue(ToolFaceRegistry.builtinActionClasses().stream()
                        .map(AtomNames::action).toList().containsAll(written),
                "written atoms are canonical action atoms of the built-in vocabulary");
    }

    // ------------------------------------------------------------------ reconcile

    @Test
    void anUnchangedImportWritesNothingAndAuditsNothing() {
        GrantPresetBinding binding = instanceBinding(USER_PRESET);
        bindingsOf(binding);
        List<AuthorizationGrant> existing = new ArrayList<>();
        for (String atom : List.of("read", "write", "delete", "exec", "network")) {
            // Rows exactly as an import of USER_PRESET would have written them: origin = preset id.
            existing.add(existingRow(AccessScope.instance(), atom, USER_PRESET));
        }
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource(SUBJECT_USER, SUBJECT, "assigned"))
                .thenReturn(existing);

        PresetGrantMaterializer.Result result =
                materializer.materializeSubject(SUBJECT_USER, SUBJECT, ACTOR, null);

        assertEquals(0, result.created());
        assertEquals(0, result.deleted());
        assertFalse(result.changed(), "an idempotent re-import is not an authorization change");
        verify(grantRepository, never()).saveAll(anyList());
        verify(grantRepository, never()).deleteAll(anyList());
        verifyNoInteractions(auditLogger);
    }

    /**
     * task-933 / R39 per-group identity: the SAME atom under two import groups is two rows, and a
     * rewrite only removes a row whose OWN group no longer carries it. {@code CREATE_TEMPLATE} is
     * desired by EXTRA_PRESET (B2) and not by USER_PRESET (B1): B1's row goes, B2's row stays.
     */
    @Test
    void aGroupRewriteRemovesOnlyItsOwnStaleRowAndNeverAnotherGroupsHolding() {
        GrantPresetBinding b1 = instanceBinding(USER_PRESET);
        GrantPresetBinding b2 = instanceBinding(EXTRA_PRESET);
        bindingsOf(b1, b2);
        AuthorizationGrant unchanged = existingRow(AccessScope.instance(), "read", USER_PRESET);
        AuthorizationGrant staleInOwnGroup = existingRow(AccessScope.instance(), "CREATE_TEMPLATE", USER_PRESET);
        AuthorizationGrant heldByOtherGroup = existingRow(AccessScope.instance(), "CREATE_TEMPLATE", EXTRA_PRESET);
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource(SUBJECT_USER, SUBJECT, "assigned"))
                .thenReturn(List.of(unchanged, staleInOwnGroup, heldByOtherGroup));

        PresetGrantMaterializer.Result result =
                materializer.materializeSubject(SUBJECT_USER, SUBJECT, ACTOR, null);

        List<AuthorizationGrant> deleted = deletedRows();
        assertEquals(List.of(staleInOwnGroup), deleted,
                "only the row whose own import group dropped the atom is removed");
        assertEquals(1, result.deleted());
        assertFalse(deleted.contains(unchanged), "an unchanged atom keeps its existing row");
        assertFalse(deleted.contains(heldByOtherGroup),
                "another still-bound group's row is not this group's stale row to delete");
        // B1 re-creates write/delete/exec/network; B2 needs read + CREATE_TEMPLATE and holds neither.
        List<AuthorizationGrant> created = savedRows();
        assertEquals(5, created.size(), "read under the second group, plus the four USER atoms it alone carries");
        assertEquals(5, result.created());
        assertTrue(created.stream().allMatch(row -> GrantSources.ASSIGNED.equals(row.getSource())));
    }

    /**
     * task-933 / R39: an unattributed (NULL-origin) row is LOCAL work — a manual grant, or a legacy
     * row V186 could not attribute to exactly one preset. No import group owns it, so no group
     * rewrite may delete it; the subject keeps 「导入后每个主体可独立微调」.
     */
    @Test
    void anUnattributedRowIsLocalWorkAndSurvivesEveryGroupRewrite() {
        bindingsOf(instanceBinding(USER_PRESET));
        AuthorizationGrant sameAtomLocally = existingRow(AccessScope.instance(), "read", null);
        AuthorizationGrant extraAtomLocally = existingRow(AccessScope.instance(), "CREATE_TEMPLATE", null);
        assertNull(sameAtomLocally.getOriginPresetId(), "the fixture is an unattributed row");
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource(SUBJECT_USER, SUBJECT, "assigned"))
                .thenReturn(List.of(sameAtomLocally, extraAtomLocally));

        PresetGrantMaterializer.Result result =
                materializer.materializeSubject(SUBJECT_USER, SUBJECT, ACTOR, null);

        assertEquals(0, result.deleted(),
                "deleting an unattributed row here would wipe manual work the moment a preset is re-imported");
        verify(grantRepository, never()).deleteAll(anyList());
        // The five imported atoms are still written as their OWN rows: a NULL-origin row does not
        // satisfy a group's desired atom (the V186 key carries origin_preset_id for exactly this).
        assertEquals(5, result.created());
        for (AuthorizationGrant row : savedRows()) {
            assertNotNull(row.getOriginPresetId(), "an import always attributes its own group");
        }
    }

    @Test
    void losingEveryBindingRemovesTheImportedRows() {
        bindingsOf();
        AuthorizationGrant orphanGroup = existingRow(AccessScope.workspace(WORKSPACE_A), "read",
                UUID.randomUUID());
        AuthorizationGrant localWork = existingRow(AccessScope.workspace(WORKSPACE_A), "read", null);
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource(SUBJECT_USER, SUBJECT, "assigned"))
                .thenReturn(List.of(orphanGroup, localWork));

        PresetGrantMaterializer.Result result =
                materializer.materializeSubject(SUBJECT_USER, SUBJECT, ACTOR, null);

        assertEquals(0, result.created());
        assertEquals(1, result.deleted(), "unbinding revokes the template's rows, not the subject's own");
        verify(grantRepository).deleteAll(List.of(orphanGroup));
    }

    @Test
    void onlyTheAssignedSourceIsRead() {
        bindingsOf(instanceBinding(USER_PRESET));

        materializer.materializeSubject(SUBJECT_USER, SUBJECT, ACTOR, null);

        verify(grantRepository).findBySubjectTypeAndSubjectIdAndSource(SUBJECT_USER, SUBJECT, "assigned");
        verify(grantRepository, never()).findBySubjectTypeAndSubjectIdAndSource(anyString(), any(),
                eq(GrantSources.PRESET));
        verify(grantRepository, never()).findBySubjectTypeAndSubjectIdAndSource(anyString(), any(),
                eq(GrantSources.AGENT_DEFAULT));
    }

    // ------------------------------------------------------------------ replay (重新对齐)

    /**
     * task-933 反证③: an explicit governance replay restores the preset set WITHIN the holder's own
     * import group — an atom the holder deleted comes back, a locally added atom inside that group
     * is removed by the realign — and every row still says {@code assigned}, never {@code preset}.
     */
    @Test
    void aGovernanceReplayRealignsTheImportGroupAndStaysAssigned() {
        GrantPresetBinding binding = instanceBinding(USER_PRESET);
        when(bindingRepository.findByRoleId(USER_PRESET)).thenReturn(List.of(binding));
        bindingsOf(binding);
        AuthorizationGrant keptRead = existingRow(AccessScope.instance(), "read", USER_PRESET);
        AuthorizationGrant keptWrite = existingRow(AccessScope.instance(), "write", USER_PRESET);
        AuthorizationGrant keptDelete = existingRow(AccessScope.instance(), "delete", USER_PRESET);
        AuthorizationGrant keptExec = existingRow(AccessScope.instance(), "exec", USER_PRESET);
        AuthorizationGrant localAddition = existingRow(AccessScope.instance(), "CREATE_TEMPLATE", USER_PRESET);
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource(SUBJECT_USER, SUBJECT, "assigned"))
                .thenReturn(List.of(keptRead, keptWrite, keptDelete, keptExec,
                        localAddition));

        int holders = materializer.replayPresetToAll(USER_PRESET, ACTOR, null);

        assertEquals(1, holders);
        assertEquals(1, deletedRows().size(), "the realign drops the atom the holder added locally");
        assertTrue(deletedRows().contains(localAddition));
        List<AuthorizationGrant> created = savedRows();
        assertEquals(1, created.size(), "`network` was deleted locally and the replay restores it");
        assertEquals(AtomNames.action("network"),
                created.get(0).getPermissions().get(0).get("actionClass").asText());
        for (AuthorizationGrant row : created) {
            assertEquals(GrantSources.ASSIGNED, row.getSource(),
                    "a realigned row still says `assigned` — the retired axis cannot come back "
                            + "through a write");
            assertEquals(USER_PRESET, row.getOriginPresetId(), "the replay re-cites the template, not a binding row");
        }
    }

    /**
     * task-933 治理面「与预设对比」: the compare face reads the preset through exactly the
     * projection a replay writes, so a comparison can never display a set the replay would not
     * produce. Without this parity the 「看见本地改了哪些」 answer would be a second, drifting truth.
     */
    @Test
    void theCompareProjectionMatchesWhatAReplayWouldWrite() {
        GrantPresetBinding binding = instanceBinding(USER_PRESET);
        bindingsOf(binding);
        when(bindingRepository.findByRoleId(USER_PRESET)).thenReturn(List.of(binding));

        assertEquals(materializer.desiredByScopeAndOrigin(List.of(binding)),
                materializer.desiredPresetSet(USER_PRESET),
                "subject view and preset view are the same projection");
        Map<GrantIntersectionEvaluator.PermissionAtom, java.util.Set<UUID>> instanceAtoms =
                materializer.desiredPresetSet(USER_PRESET).get(AccessScope.instance());
        assertEquals(5, instanceAtoms.size(), "the five USER atoms, capability atoms filtered out");
        assertTrue(instanceAtoms.values().stream().allMatch(groups -> groups.equals(java.util.Set.of(USER_PRESET))),
                "every atom is attributed to the one import group that carried it");
    }

    // ------------------------------------------------------------------ scope guard

    /**
     * Decision #12: an instance-only atom bound at workspace scope is rejected, not silently
     * dropped — a partial materialization would look like a successful import.
     */
    @Test
    void rejectsAnAtomThatCannotLiveInTheBindingScope() {
        presetAtoms.put(ACCOUNT_PRESET, new ArrayList<>(List.of(ToolFaceRegistry.ACTION_CREATE_ACCOUNT)));
        stubPresetAtoms();
        bindingsOf(workspaceBinding(ACCOUNT_PRESET, WORKSPACE_A));

        CpApiException failure = assertThrows(CpApiException.class,
                () -> materializer.materializeSubject(SUBJECT_USER, SUBJECT, ACTOR, null));

        assertEquals("ROLE_SCOPE_MISMATCH", failure.getCode());
        verify(grantRepository, never()).saveAll(anyList());
    }

    @Test
    void requiresASubject() {
        assertThrows(IllegalArgumentException.class,
                () -> materializer.materializeSubject(null, SUBJECT, ACTOR, null));
        assertThrows(IllegalArgumentException.class,
                () -> materializer.materializeSubject(SUBJECT_USER, null, ACTOR, null));
        assertThrows(IllegalArgumentException.class, () -> materializer.replayPresetToAll(null, ACTOR, null));
        assertThrows(IllegalArgumentException.class, () -> materializer.desiredPresetSet(null));
    }

    // ------------------------------------------------------------------ epoch / cache

    /**
     * PLAN-0610 W1c-2 (round-4 P1-1): the per-subject epoch bumps take {@code SELECT … FOR UPDATE}
     * locks in <b>sorted subject-id order</b>, not the order {@code findByRoleId} returned. Without
     * the sort two concurrent preset edits over intersecting holder sets could form an ABBA cycle
     * and PostgreSQL would abort one with {@code 40P01}.
     */
    @Test
    void bumpsEpochsInSortedSubjectOrder() {
        UUID lowSubject = UUID.fromString("00000000-0000-4000-8000-000000000001");
        UUID highSubject = UUID.fromString("00000000-0000-4000-8000-000000000002");
        GrantPresetBinding lowBinding = binding(USER_PRESET, lowSubject, AccessScope.instance(), null);
        GrantPresetBinding highBinding = binding(USER_PRESET, highSubject, AccessScope.instance(), null);
        // Deliberately "wrong" order: the higher id comes back from the role query first.
        when(bindingRepository.findByRoleId(USER_PRESET)).thenReturn(List.of(highBinding, lowBinding));
        when(bindingRepository.findBySubjectTypeAndSubjectId(SUBJECT_USER, lowSubject))
                .thenReturn(List.of(lowBinding));
        when(bindingRepository.findBySubjectTypeAndSubjectId(SUBJECT_USER, highSubject))
                .thenReturn(List.of(highBinding));
        when(userRepository.findByIdForUpdate(any())).thenAnswer(invocation ->
                Optional.of(userWith(invocation.getArgument(0))));

        materializer.materializePreset(USER_PRESET, ACTOR, null);

        InOrder ordered = inOrder(userRepository);
        ordered.verify(userRepository).findByIdForUpdate(lowSubject);
        ordered.verify(userRepository).findByIdForUpdate(highSubject);
    }

    /**
     * PLAN-0610 W1c-2 (round-4 P1-2): invalidation happens <b>twice</b> — once inside the writing
     * transaction (same-request readers such as {@code /me/permissions}) and once after the
     * transaction completes (a concurrent reader may have re-filled the cache from the pre-commit
     * state in between).
     */
    @Test
    void invalidatesImmediatelyAndAgainAfterTheTransactionCompletes() {
        bindingsOf(instanceBinding(USER_PRESET));

        TransactionSynchronizationManager.initSynchronization();
        try {
            materializer.materializeSubject(SUBJECT_USER, SUBJECT, ACTOR, null);
            verify(authzContext, times(1)).invalidate(SUBJECT);

            TransactionSynchronizationManager.getSynchronizations()
                    .forEach(sync -> sync.afterCompletion(TransactionSynchronization.STATUS_COMMITTED));
            verify(authzContext, times(2)).invalidate(SUBJECT);
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    // ---------------------------------------------------------------- helpers

    private static final String SUBJECT_USER = AuthzContext.SUBJECT_USER;

    /** Re-stubs the whole preset atom vocabulary from {@link #presetAtoms}. */
    private void stubPresetAtoms() {
        List<GrantPresetAtom> rows = new ArrayList<>();
        for (Map.Entry<UUID, List<String>> preset : presetAtoms.entrySet()) {
            for (String atom : preset.getValue()) {
                rows.add(new GrantPresetAtom(preset.getKey(), canonicalAtom(atom), resourceOf(atom)));
            }
        }
        when(permissionRepository.findByIdRoleIdIn(anyCollection())).thenReturn(rows);
    }

    /** Presets store the canonical spelling (task-835); capability atoms already carry `cap:`. */
    private static String canonicalAtom(String atom) {
        return AtomNames.isCapabilityFamily(atom) ? atom : AtomNames.action(atom);
    }

    private static String resourceOf(String atom) {
        return ToolFaceRegistry.isCredentialActionClass(atom)
                ? ToolFaceRegistry.CREDENTIAL_RESOURCE_WILDCARD
                : PermissionAtomCatalog.WILDCARD;
    }

    private static GrantPresetBinding binding(UUID presetId, UUID subjectId, AccessScope scope,
                                              UUID granter) {
        GrantPresetBinding row = new GrantPresetBinding(presetId, SUBJECT_USER, subjectId,
                scope.type(), scope.isInstance() ? null : scope.id(), granter);
        row.setId(UUID.randomUUID());
        return row;
    }

    private static GrantPresetBinding instanceBinding(UUID presetId) {
        return binding(presetId, SUBJECT, AccessScope.instance(), ACTOR);
    }

    private static GrantPresetBinding workspaceBinding(UUID presetId, UUID workspaceId) {
        return binding(presetId, SUBJECT, AccessScope.workspace(workspaceId), ACTOR);
    }

    private void bindingsOf(GrantPresetBinding... rows) {
        when(bindingRepository.findBySubjectTypeAndSubjectId(SUBJECT_USER, SUBJECT))
                .thenReturn(List.of(rows));
    }

    /** A persisted {@code assigned} row of this subject, with (or without) an import-group origin. */
    private static AuthorizationGrant existingRow(AccessScope scope, String atom, UUID originPresetId) {
        ObjectMapper mapper = new ObjectMapper();
        AuthorizationGrant row = new AuthorizationGrant();
        row.setId(UUID.randomUUID());
        row.setSubjectType(SUBJECT_USER);
        row.setSubjectId(SUBJECT);
        row.setSource(GrantSources.ASSIGNED);
        row.setOriginPresetId(originPresetId);
        row.setScopeType(scope.type());
        row.setScopeId(scope.isInstance() ? null : scope.id());
        row.setReadState("read");
        var permissions = mapper.createArrayNode();
        var node = permissions.addObject();
        node.put("actionClass", canonicalAtom(atom));
        if (ToolFaceRegistry.isCredentialActionClass(atom)) {
            node.put("resource", ToolFaceRegistry.CREDENTIAL_RESOURCE_WILDCARD);
        }
        row.setPermissions(permissions);
        assertNull(row.getRoleName(), "role_name is reserved for config role display names");
        return row;
    }

    private static User userWith(UUID userId) {
        User user = new User("epoch-" + userId + "@test.local", "hash", "Epoch");
        user.setId(userId);
        return user;
    }

    @SuppressWarnings("unchecked")
    private List<AuthorizationGrant> savedRows() {
        ArgumentCaptor<Iterable<AuthorizationGrant>> captor = ArgumentCaptor.forClass(Iterable.class);
        verify(grantRepository, org.mockito.Mockito.atLeastOnce()).saveAll(captor.capture());
        List<AuthorizationGrant> rows = new ArrayList<>();
        captor.getAllValues().forEach(values -> values.forEach(rows::add));
        return rows;
    }

    @SuppressWarnings("unchecked")
    private List<AuthorizationGrant> deletedRows() {
        ArgumentCaptor<Iterable<AuthorizationGrant>> captor = ArgumentCaptor.forClass(Iterable.class);
        verify(grantRepository, org.mockito.Mockito.atLeastOnce()).deleteAll(captor.capture());
        List<AuthorizationGrant> rows = new ArrayList<>();
        captor.getAllValues().forEach(values -> values.forEach(rows::add));
        return rows;
    }
}
