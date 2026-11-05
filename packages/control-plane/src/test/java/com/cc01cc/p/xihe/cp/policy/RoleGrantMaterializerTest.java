package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0610 W1a T1.5: the role materializer.
 *
 * <p>Pins the contract the evaluation query relies on: one {@code source='role'} row per atom,
 * the binding scope copied onto the row, capability atoms filtered out (negative case, design
 * #23) and scope incompatibility rejected instead of dropped (decision #12).</p>
 */
class RoleGrantMaterializerTest {

    private static final UUID USER_ROLE = UUID.randomUUID();
    private static final UUID WS_EDITOR_ROLE = UUID.randomUUID();
    private static final UUID INSTANCE_ADMIN_ROLE = UUID.randomUUID();
    private static final UUID ACCOUNT_ROLE = UUID.randomUUID();

    private static final UUID SUBJECT = UUID.randomUUID();
    private static final UUID ACTOR = UUID.randomUUID();
    private static final UUID WORKSPACE_A = UUID.randomUUID();

    private AccessRoleBindingRepository bindingRepository;
    private AccessRolePermissionRepository permissionRepository;
    private AuthorizationGrantRepository grantRepository;
    private com.cc01cc.p.xihe.cp.repository.UserRepository userRepository;
    private AuthzContext authzContext;
    private AuditLogger auditLogger;
    private RoleGrantMaterializer materializer;

    @BeforeEach
    void setUp() {
        bindingRepository = mock(AccessRoleBindingRepository.class);
        permissionRepository = mock(AccessRolePermissionRepository.class);
        grantRepository = mock(AuthorizationGrantRepository.class);
        userRepository = mock(com.cc01cc.p.xihe.cp.repository.UserRepository.class);
        authzContext = mock(AuthzContext.class);
        auditLogger = mock(AuditLogger.class);
        materializer = new RoleGrantMaterializer(bindingRepository, permissionRepository,
                grantRepository, userRepository, new GrantIntersectionEvaluator(), authzContext,
                auditLogger, new ObjectMapper());
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource(anyString(), any(), anyString()))
                .thenReturn(List.of());
    }

    // ------------------------------------------------------------------ cases

    @Test
    void materializesOneRowPerAtomPerScopeWithTheBindingScope() {
        stubRoles(USER_ROLE, WS_EDITOR_ROLE);
        bindings(new AccessRoleBinding(USER_ROLE, "user", SUBJECT, AccessScope.INSTANCE, null, ACTOR),
                new AccessRoleBinding(WS_EDITOR_ROLE, "user", SUBJECT, AccessScope.WORKSPACE,
                        WORKSPACE_A, ACTOR));

        RoleGrantMaterializer.Result result = materializer.materializeSubject("user", SUBJECT, ACTOR, null);

        List<AuthorizationGrant> saved = savedRows();
        assertEquals(5 + 4, saved.size(), "five USER atoms at instance scope plus four editor atoms");
        assertEquals(5 + 4, result.created());
        assertEquals(0, result.deleted());
        for (AuthorizationGrant row : saved) {
            assertEquals(GrantSources.ROLE, row.getSource());
            assertEquals("read", row.getReadState());
            assertEquals(1, row.getPermissions().size(), "one atom per row (round-2 P1-2)");
            AccessScope scope = row.getScopeId() == null
                    ? AccessScope.instance()
                    : AccessScope.workspace(row.getScopeId());
            assertEquals(scope.isInstance() ? "instance" : "workspace", row.getScopeType());
        }
        assertEquals(5, saved.stream().filter(row -> row.getScopeId() == null).count());
        assertEquals(4, saved.stream().filter(row -> WORKSPACE_A.equals(row.getScopeId())).count());
        verify(authzContext).invalidate(SUBJECT);
    }

    @Test
    void superAdminInstanceBindingMaterializesEveryActionAtomAndNoCapabilityAtom() {
        stubRoles(INSTANCE_ADMIN_ROLE);
        bindings(new AccessRoleBinding(INSTANCE_ADMIN_ROLE, "user", SUBJECT, AccessScope.INSTANCE,
                null, ACTOR));

        materializer.materializeSubject("user", SUBJECT, ACTOR, null);

        List<AuthorizationGrant> saved = savedRows();
        assertEquals(PermissionAtomCatalog.actionAtoms().size(), saved.size(),
                "all action atoms are instance-bindable (decision #27; count frozen in SkillReadFaceTest); the 3 capability atoms "
                        + "are resolved at authentication time");
        List<String> writtenAtoms = new ArrayList<>();
        saved.forEach(row -> writtenAtoms.add(row.getPermissions().get(0).get("actionClass").asText()));
        assertEquals(new java.util.LinkedHashSet<>(PermissionAtomCatalog.actionAtoms()),
                new java.util.LinkedHashSet<>(writtenAtoms),
                "exactly the action atoms, no capability atom");
        for (String capability : PermissionAtomCatalog.capabilityAtoms()) {
            assertFalse(writtenAtoms.contains(capability),
                    "capability atom must not reach grants: " + capability);
        }
        // The negative case in the other direction: every written atom is a builtin action class,
        // so GrantIntersectionEvaluator.PermissionAtom can never throw on these rows.
        assertTrue(ToolFaceRegistry.builtinActionClasses().containsAll(writtenAtoms));
    }

    @Test
    void reconcilesStaleAtomsAndKeepsUnchangedRows() {
        stubRoles(USER_ROLE);
        bindings(new AccessRoleBinding(USER_ROLE, "user", SUBJECT, AccessScope.INSTANCE, null, ACTOR));
        AuthorizationGrant kept = existingRow("role", AccessScope.instance(), "read");
        AuthorizationGrant stale = existingRow("role", AccessScope.instance(), "CREATE_TEMPLATE");
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource("user", SUBJECT, "role"))
                .thenReturn(List.of(kept, stale));

        RoleGrantMaterializer.Result result = materializer.materializeSubject("user", SUBJECT, ACTOR, null);

        List<AuthorizationGrant> deleted = deletedRows();
        assertEquals(1, deleted.size());
        assertEquals("CREATE_TEMPLATE", deleted.get(0).getPermissions().get(0)
                .get("actionClass").asText(), "atoms no longer granted must be removed");
        List<AuthorizationGrant> saved = savedRows();
        assertEquals(4, saved.size(), "write/delete/exec/network are created; read is kept as-is");
        assertEquals(4, result.created());
        assertEquals(1, result.deleted());
        assertFalse(saved.contains(kept), "an unchanged atom keeps its existing row");
    }

    @Test
    void rejectsAtomsThatCannotLiveInTheBindingScopeRound2P12() {
        stubRoles(ACCOUNT_ROLE);
        bindings(new AccessRoleBinding(ACCOUNT_ROLE, "user", SUBJECT, AccessScope.WORKSPACE,
                WORKSPACE_A, ACTOR));

        CpApiException failure = assertThrows(CpApiException.class,
                () -> materializer.materializeSubject("user", SUBJECT, ACTOR, null));
        assertEquals("ROLE_SCOPE_MISMATCH", failure.getCode());
        verify(grantRepository, never()).saveAll(anyList());
    }

    @Test
    void writesNoAuditAndNoRowsWhenTheMaterializedSetIsUnchanged() {
        stubRoles(USER_ROLE);
        bindings(new AccessRoleBinding(USER_ROLE, "user", SUBJECT, AccessScope.INSTANCE, null, ACTOR));
        List<AuthorizationGrant> existing = new ArrayList<>();
        for (String atom : List.of("read", "write", "delete", "exec", "network")) {
            existing.add(existingRow("role", AccessScope.instance(), atom));
        }
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource("user", SUBJECT, "role"))
                .thenReturn(existing);

        RoleGrantMaterializer.Result result = materializer.materializeSubject("user", SUBJECT, ACTOR, null);

        assertEquals(0, result.created());
        assertEquals(0, result.deleted());
        verify(grantRepository, never()).saveAll(anyList());
        verify(grantRepository, never()).deleteAll(anyList());
        verifyNoInteractions(auditLogger);
    }

    @Test
    void removesRowsWhenTheSubjectLosesEveryBinding() {
        stubRoles(USER_ROLE);
        bindings();
        AuthorizationGrant stale = existingRow("role", AccessScope.workspace(WORKSPACE_A), "read");
        when(grantRepository.findBySubjectTypeAndSubjectIdAndSource("user", SUBJECT, "role"))
                .thenReturn(List.of(stale));

        RoleGrantMaterializer.Result result = materializer.materializeSubject("user", SUBJECT, ACTOR, null);

        assertEquals(0, result.created());
        assertEquals(1, result.deleted());
        verify(grantRepository).deleteAll(List.of(stale));
    }

    @Test
    void neverTouchesTheFrozenAgentDefaultSource() {
        stubRoles(USER_ROLE);
        bindings(new AccessRoleBinding(USER_ROLE, "user", SUBJECT, AccessScope.INSTANCE, null, ACTOR));

        materializer.materializeSubject("user", SUBJECT, ACTOR, null);

        verify(grantRepository).findBySubjectTypeAndSubjectIdAndSource("user", SUBJECT, "role");
        verify(grantRepository, never()).findBySubjectTypeAndSubjectIdAndSource(anyString(), any(),
                eq(GrantSources.AGENT_DEFAULT));
    }

    // ---------------------------------------------------------------- helpers

    private void stubRoles(UUID... roleIds) {
        List<AccessRolePermission> permissions = new ArrayList<>();
        for (UUID roleId : roleIds) {
            for (String atom : atomsOf(roleId)) {
                permissions.add(new AccessRolePermission(roleId, atom, resourceOf(atom)));
            }
        }
        when(permissionRepository.findByIdRoleIdIn(anyCollection())).thenReturn(permissions);
    }

    private static List<String> atomsOf(UUID roleId) {
        if (roleId.equals(USER_ROLE)) {
            return List.of("read", "write", "delete", "exec", "network");
        }
        if (roleId.equals(WS_EDITOR_ROLE)) {
            return List.of("read", "write", "delete", "exec");
        }
        if (roleId.equals(INSTANCE_ADMIN_ROLE)) {
            // SUPER_ADMIN-shaped role: the full action atom set plus the three capability atoms.
            List<String> atoms = new ArrayList<>(PermissionAtomCatalog.actionAtoms());
            atoms.addAll(PermissionAtomCatalog.capabilityAtoms());
            return List.copyOf(atoms);
        }
        if (roleId.equals(ACCOUNT_ROLE)) {
            return List.of(ToolFaceRegistry.ACTION_CREATE_ACCOUNT);
        }
        return List.of();
    }

    private static String resourceOf(String atom) {
        return ToolFaceRegistry.isCredentialActionClass(atom)
                ? ToolFaceRegistry.CREDENTIAL_RESOURCE_WILDCARD
                : "*";
    }

    /**
     * PLAN-0610 W1c-2 (round-4 P1-1): the per-subject epoch bumps take {@code SELECT … FOR UPDATE}
     * locks in <b>sorted subject-id order</b>, not in the order {@code findByRoleId} happened to
     * return. Without the sort two concurrent role edits over intersecting holder sets could form an
     * ABBA cycle and one of them would die with PostgreSQL {@code 40P01}.
     */
    @Test
    void bumpsEpochsInSortedSubjectOrder() {
        UUID lowSubject = UUID.fromString("00000000-0000-4000-8000-000000000001");
        UUID highSubject = UUID.fromString("00000000-0000-4000-8000-000000000002");
        stubRoles(USER_ROLE);
        AccessRoleBinding lowBinding = new AccessRoleBinding(USER_ROLE, "user", lowSubject,
                AccessScope.INSTANCE, null, ACTOR);
        AccessRoleBinding highBinding = new AccessRoleBinding(USER_ROLE, "user", highSubject,
                AccessScope.INSTANCE, null, ACTOR);
        // Deliberately "wrong" order: the higher id comes back from the role query first.
        when(bindingRepository.findByRoleId(USER_ROLE)).thenReturn(List.of(highBinding, lowBinding));
        when(bindingRepository.findBySubjectTypeAndSubjectId("user", lowSubject))
                .thenReturn(List.of(lowBinding));
        when(bindingRepository.findBySubjectTypeAndSubjectId("user", highSubject))
                .thenReturn(List.of(highBinding));
        when(userRepository.findByIdForUpdate(any())).thenAnswer(invocation ->
                java.util.Optional.of(userWith(invocation.getArgument(0))));

        materializer.materializeRole(USER_ROLE, ACTOR, null);

        org.mockito.InOrder inOrder = org.mockito.Mockito.inOrder(userRepository);
        inOrder.verify(userRepository).findByIdForUpdate(lowSubject);
        inOrder.verify(userRepository).findByIdForUpdate(highSubject);
    }

    /**
     * PLAN-0610 W1c-2 (round-4 P1-2): invalidation happens <b>twice</b> — once inside the writing
     * transaction (same-request readers such as W3's {@code /me/permissions}) and once after the
     * transaction completes (a concurrent reader may have re-filled the cache from the pre-commit
     * state in between).
     */
    @Test
    void invalidatesImmediatelyAndAgainAfterTheTransactionCompletes() {
        stubRoles(USER_ROLE);
        bindings(new AccessRoleBinding(USER_ROLE, "user", SUBJECT, AccessScope.INSTANCE, null, ACTOR));

        org.springframework.transaction.support.TransactionSynchronizationManager.initSynchronization();
        try {
            materializer.materializeSubject("user", SUBJECT, ACTOR, null);
            verify(authzContext, org.mockito.Mockito.times(1)).invalidate(SUBJECT);

            org.springframework.transaction.support.TransactionSynchronizationManager
                    .getSynchronizations()
                    .forEach(sync -> sync.afterCompletion(
                            org.springframework.transaction.support.TransactionSynchronization
                                    .STATUS_COMMITTED));
            verify(authzContext, org.mockito.Mockito.times(2)).invalidate(SUBJECT);
        } finally {
            org.springframework.transaction.support.TransactionSynchronizationManager
                    .clearSynchronization();
        }
    }

    private static com.cc01cc.p.xihe.cp.entity.User userWith(UUID userId) {
        com.cc01cc.p.xihe.cp.entity.User user = new com.cc01cc.p.xihe.cp.entity.User("epoch-" + userId + "@test.local", "hash", "Epoch");
        user.setId(userId);
        return user;
    }

    private void bindings(AccessRoleBinding... rows) {
        when(bindingRepository.findBySubjectTypeAndSubjectId("user", SUBJECT)).thenReturn(List.of(rows));
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

    private AuthorizationGrant existingRow(String source, AccessScope scope, String atom) {
        AuthorizationGrant row = new AuthorizationGrant();
        row.setId(UUID.randomUUID());
        row.setSubjectType("user");
        row.setSubjectId(SUBJECT);
        row.setSource(source);
        row.setScopeType(scope.type());
        row.setScopeId(scope.isInstance() ? null : scope.id());
        row.setReadState("read");
        row.setPermissions(new ObjectMapper().createArrayNode().add(
                new ObjectMapper().createObjectNode().put("actionClass", atom)));
        assertNull(row.getRoleName(), "role_name is reserved for config role display names");
        return row;
    }
}


