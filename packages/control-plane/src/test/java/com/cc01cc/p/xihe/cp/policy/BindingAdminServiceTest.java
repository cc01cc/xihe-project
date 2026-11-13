package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0773 M2-8c: the org-unit role-binding <b>write gate</b>, and its agreement with the
 * evaluation side.
 *
 * <p><b>Evidence level, stated up front.</b> {@code org_unit_role_bindings} is {@code M1-9}'s table
 * and does not exist yet, so there is no writer to interrupt and no {@code count(*)} to compare.
 * The two proofs available — and the ones this class makes — are:</p>
 *
 * <ol>
 *   <li><b>refused, and no writer was reached</b>: on a {@code 409} the only two things that can
 *       write a binding in this service ({@link AccessRoleBindingRepository} through the
 *       materializer) were <i>never touched</i> ({@code verifyNoInteractions}). "No row was
 *       written" is a structural statement here, not an observation about an empty table;</li>
 *   <li><b>both sides agree on every atom set</b>: the gate refuses exactly the roles that
 *       {@code OrgUnitGrantExpander} drops — same {@code OrgUnitGovernancePolicy}, two entry
 *       points, checked against each other instead of asserted separately.</li>
 * </ol>
 */
@ExtendWith(MockitoExtension.class)
class BindingAdminServiceTest {

    @Mock
    private AccessRoleRepository roles;
    @Mock
    private AccessRolePermissionRepository permissions;
    @Mock
    private AccessRoleBindingRepository bindings;
    @Mock
    private UserRepository users;
    @Mock
    private WorkspaceRepository workspaces;
    @Mock
    private InstanceOwnerRepository owners;
    @Mock
    private RoleGrantMaterializer materializer;
    @Mock
    private RequesterAuthority requester;
    @Mock
    private AuditLogger audit;
    @Mock
    private DbLockTimeout dbLockTimeout;
    @Mock
    private GrantabilityGuard grantability;

    @InjectMocks
    private BindingAdminService service;

    private static final UUID ROLE_ID = UUID.fromString("33333333-3333-4333-8333-333333333331");
    private static final UUID OTHER_ROLE_ID = UUID.fromString("33333333-3333-4333-8333-333333333332");
    private static final UUID USER_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID UNIT_ID = UUID.fromString("44444444-4444-4444-8444-444444444441");

    private static AccessRole role(UUID id, String name) {
        return new AccessRole(id, name, name, "", false);
    }

    private void stubRole(UUID roleId, String roleName, String... atomNames) {
        when(roles.findAllById(any())).thenReturn(List.of(role(roleId, roleName)));
        when(permissions.findByIdRoleIdIn(any())).thenReturn(
                List.of(atomNames).stream()
                        .map(atom -> new AccessRolePermission(roleId, atom, "*"))
                        .toList());
    }

    /**
     * The card's named negative case: a role carrying a workspace-content atom is refused with
     * {@code 409 ORG_SCOPE_ROLE_FORBIDDEN}, the message names the role <b>and</b> the atom, and no
     * writer in this service was reached.
     */
    @Test
    void orgBindingWithContentAtomIs409() {
        stubRole(ROLE_ID, "CONTENT_EDITOR",
                OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS, ToolFaceRegistry.ACTION_EXEC);

        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.requireOrgUnitRoleBindingsAreGovernance(Set.of(ROLE_ID)));

        assertEquals(HttpStatus.CONFLICT, refused.getStatus(),
                "the write side answers 409, the same status the card requires");
        assertEquals(OrgUnitGovernancePolicy.CODE_FORBIDDEN, refused.getCode());
        assertTrue(refused.getMessage().contains("CONTENT_EDITOR"),
                "the refusal must name the role: " + refused.getMessage());
        assertTrue(refused.getMessage().contains(ToolFaceRegistry.ACTION_EXEC),
                "the refusal must name the offending atom: " + refused.getMessage());
        // Structural: nothing that can write a binding row was reached at all. There is no
        // org_unit_role_bindings writer in this repository yet (M1-9), and the gate precedes every
        // writer there will be — asserted here so the ordering cannot silently invert later.
        verifyNoInteractions(bindings, materializer, audit);
    }

    /** A pure governance role passes the gate — and still nothing is written by the gate itself. */
    @Test
    void governanceRolePassesTheGate() {
        stubRole(ROLE_ID, "ORG_LEADER",
                OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS,
                OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNIT_MEMBERS,
                OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS);

        service.requireOrgUnitRoleBindingsAreGovernance(Set.of(ROLE_ID));

        verifyNoInteractions(bindings, materializer, audit);
    }

    /** A role the database cannot resolve is refused as {@code 404}, not treated as "no atoms". */
    @Test
    void unknownRoleFailsClosed() {
        when(roles.findAllById(any())).thenReturn(List.of());
        when(permissions.findByIdRoleIdIn(any())).thenReturn(List.of());

        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.requireOrgUnitRoleBindingsAreGovernance(Set.of(OTHER_ROLE_ID)));

        assertEquals(HttpStatus.NOT_FOUND, refused.getStatus());
        assertEquals("ROLE_NOT_FOUND", refused.getCode());
    }

    /**
     * Both entry points, checked against each other: for every atom set, the write gate refuses
     * exactly what the evaluation side drops. Two implementations that drifted apart would fail
     * here even if each one still "worked" on its own.
     */
    @Test
    void writeSideAndEvaluationSideAgreeOnEveryAtomSet() {
        OrgUnitGrantExpander expander = new OrgUnitGrantExpander();
        List<List<String>> cases = List.of(
                List.of(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS),
                List.of(OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS,
                        ToolFaceRegistry.ACTION_WRITE_WORKSPACE_CONTENT),
                List.of(ToolFaceRegistry.ACTION_EXEC),
                List.of());

        for (List<String> atoms : cases) {
            // Fresh mocks per case: the judgement under test is the policy's, not Mockito's state.
            AccessRoleRepository caseRoles = mock(AccessRoleRepository.class);
            AccessRolePermissionRepository casePermissions = mock(AccessRolePermissionRepository.class);
            when(caseRoles.findAllById(any())).thenReturn(List.of(role(ROLE_ID, "ROLE_UNDER_TEST")));
            when(casePermissions.findByIdRoleIdIn(any())).thenReturn(atoms.stream()
                    .map(atom -> new AccessRolePermission(ROLE_ID, atom, "*"))
                    .toList());
            BindingAdminService caseService = new BindingAdminService(caseRoles, casePermissions,
                    mock(AccessRoleBindingRepository.class), mock(UserRepository.class),
                    mock(WorkspaceRepository.class), mock(InstanceOwnerRepository.class),
                    mock(RoleGrantMaterializer.class), mock(RequesterAuthority.class),
                    mock(AuditLogger.class), mock(DbLockTimeout.class), mock(GrantabilityGuard.class));

            boolean writeAccepted;
            try {
                caseService.requireOrgUnitRoleBindingsAreGovernance(Set.of(ROLE_ID));
                writeAccepted = true;
            } catch (CpApiException refused) {
                writeAccepted = false;
            }

            List<AuthorizationGrant> expanded = expander.expand(
                    new OrgUnitGrantExpander.MemberRef(OrgUnitGrantExpander.MEMBER_HUMAN, USER_ID),
                    new OrgUnitGrantExpander.Rows(
                            List.of(new OrgUnitGrantExpander.UnitRow(UNIT_ID, "root")),
                            List.of(new OrgUnitGrantExpander.MembershipRow(
                                    OrgUnitGrantExpander.MEMBER_HUMAN, USER_ID, UNIT_ID)),
                            List.of(new OrgUnitGrantExpander.RoleBindingRow(
                                    UNIT_ID, ROLE_ID, "ROLE_UNDER_TEST", atoms, null))));

            assertEquals(writeAccepted, expanded.size() == 1,
                    "write gate and evaluation side must agree on the atom set " + atoms);
        }
    }
}
