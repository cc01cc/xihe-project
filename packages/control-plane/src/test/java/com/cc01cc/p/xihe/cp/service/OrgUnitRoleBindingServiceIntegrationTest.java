package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M2-11 (task-246): `PUT …/role-bindings` — whole-set replace with the governance
 * whitelist enforced before the first write.
 *
 * <p>The negatives carry the card's two mandatory cases plus the 404/unknown-role path the card
 * asked to keep on one test:</p>
 * <ul>
 *   <li><b>non-governance role ⇒ 409 ORG_SCOPE_ROLE_FORBIDDEN, code asserted</b>, and both the
 *       binding rows and the audit count are unchanged — a status-only assertion could not tell
 *       this 409 from any other conflict;</li>
 *   <li><b>unknown role rides the same path</b> — so a future change that answers unknown roles
 *       differently is forced to touch the test too;</li>
 *   <li><b>member moving outside its subtree ⇒ 403 with code</b> — scope comes only from
 *       {@link OrgUnitAccess}; this test would break the day someone writes a second scope
 *       check with a different answer.</li>
 * </ul>
 */
class OrgUnitRoleBindingServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private OrgUnitRoleBindingService service;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private UserRepository users;

    @Autowired
    private WorkspaceRepository workspaces;

    @Autowired
    private AccessRoleRepository roles;

    @Autowired
    private AccessRoleBindingRepository bindings;

    @Autowired
    private AuthorizationGrantRepository grants;

    @Autowired
    private ObjectMapper objectMapper;

    private String suffix;
    private UUID caller;
    private UUID unitA;
    private UUID unitB;
    private UUID governanceRole;

    @BeforeEach
    void cleanTables() {
        jdbc.update("DELETE FROM org_unit_role_bindings");
        jdbc.update("DELETE FROM org_unit_members");
        jdbc.update("DELETE FROM org_units");
        suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        caller = insertUser("caller");
        unitA = insertUnit(null, "a-" + suffix, null, 0);
        unitB = insertUnit(null, "b-" + suffix, null, 0);
        governanceRole = insertRole("ORG_GOVERNANCE_" + suffix.toUpperCase(),
                "MANAGE_ORG_UNITS", "READ_ORG_UNIT_MEMBERS");
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void aReplaceStoresTheWholeSetOrderedAndWritesTheAuditInTheSameCall() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        UUID secondRole = insertRole("ORG_AUDIT_" + suffix.toUpperCase(), "READ_ORG_UNIT_MEMBERS");

        int auditBefore = auditCount();
        OrgUnitWireView.RoleBindings stored = service.replace(unitA.toString(),
                List.of(secondRole.toString(), governanceRole.toString()));

        assertEquals(2, stored.roleIds().size());
        List<String> asText = stored.roleIds().stream().map(UUID::toString).toList();
        assertEquals(asText.stream().sorted().toList(), asText,
                "the stored set is ordered by role id (uuid byte order = hex-string order), so two"
                        + " reads of unchanged data are byte-identical");
        assertEquals(2, bindingRows(unitA));
        assertEquals(auditBefore + 1, auditCount());

        String detail = latestAuditDetail();
        assertTrue(detail.contains(unitA.toString()), "audit names the unit");
        assertTrue(detail.contains("principalId"), "and the group principal");
        assertTrue(detail.contains(governanceRole.toString()), "and the roles");
        assertTrue(detail.contains("affectedWorkspaceIds"), "and the G1 affected field");

        // A second replace with an empty set clears the rows — a delta could not express this.
        OrgUnitWireView.RoleBindings cleared = service.replace(unitA.toString(), List.of());
        assertEquals(0, cleared.roleIds().size());
        assertEquals(0, bindingRows(unitA));
    }

    @Test
    void aSubtreeMembersOwnedWorkspacesLandInTheAuditAffectedSet() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        UUID member = insertUser("member-" + suffix);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unitA, member);
        UUID owned = insertOwnedWorkspace(member);

        service.replace(unitA.toString(), List.of(governanceRole.toString()));
        assertTrue(latestAuditDetail().contains(owned.toString()),
                "a member's owned workspace is in affectedWorkspaceIds: the binding changed what"
                        + " that owner may do, and the row alone never records it");
    }

    @Test
    void aNonGovernanceRoleIsA409WithItsCodeAndNothingWasWritten() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        // WS_OWNER is a real, well-known role — and exactly what must not be bindable to an org
        // unit: WRITE_WORKSPACE_CONTENT would spread into every workspace a member can reach.
        AccessRole wsOwner = roles.findByName(SystemAccessRoleCatalog.WS_OWNER).orElseThrow();
        int auditBefore = auditCount();

        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.replace(unitA.toString(), List.of(wsOwner.getId().toString())));
        assertEquals(HttpStatus.CONFLICT, refused.getStatus());
        assertEquals("ORG_SCOPE_ROLE_FORBIDDEN", refused.getCode(),
                "the code is the judgement: a bare 409 could be any conflict");
        assertEquals(0, bindingRows(unitA), "a refused replace writes no rows");
        assertEquals(auditBefore, auditCount(), "and no audit row");

        // SUPER_ADMIN fails the whitelist too: mixed atoms (governance + everything else) are the
        // leak, and "it is the admin role" is not an exception.
        AccessRole superAdmin = roles.findByName(SystemAccessRoleCatalog.SUPER_ADMIN).orElseThrow();
        assertEquals("ORG_SCOPE_ROLE_FORBIDDEN", assertThrows(CpApiException.class,
                () -> service.replace(unitA.toString(), List.of(superAdmin.getId().toString())))
                .getCode());
    }

    @Test
    void anUnknownRoleRidesTheSameRefusalPath() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());

        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.replace(unitA.toString(), List.of(UUID.randomUUID().toString())));
        assertEquals("ORG_SCOPE_ROLE_FORBIDDEN", refused.getCode(),
                "unknown is not empty: refusing it here keeps one path for one judgement");
        assertEquals(0, bindingRows(unitA));
    }

    @Test
    void aMemberOutsideItsSubtreeIsA403AndANonMemberIsA404() {
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unitA, caller);
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());

        // unitB is a sibling of the caller's unitA: visible tree stops at unitA's subtree.
        CpApiException outOfScope = assertThrows(CpApiException.class,
                () -> service.replace(unitB.toString(), List.of(governanceRole.toString())));
        assertEquals(HttpStatus.FORBIDDEN, outOfScope.getStatus());
        assertEquals("FORBIDDEN", outOfScope.getCode(),
                "scope violations answer 403/FORBIDDEN — the same code the read face uses");

        // A caller with the atom but no membership row is the instance-level holder (design
        // §4.2), so to reach the 404 path the grant must go too: no membership AND no atom.
        jdbc.update("DELETE FROM org_unit_members WHERE member_id = ?", caller);
        jdbc.update("DELETE FROM grants WHERE subject_id = ?", caller);
        CpApiException notAMember = assertThrows(CpApiException.class,
                () -> service.replace(unitB.toString(), List.of(governanceRole.toString())));
        assertEquals(HttpStatus.NOT_FOUND, notAMember.getStatus());
        assertEquals("ORG_UNIT_NOT_FOUND", notAMember.getCode(),
                "a non-member must not learn whether the unit exists");
    }

    @Test
    void aMissingBodyOrBadUuidIsA400BeforeAnyWrite() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        int auditBefore = auditCount();

        assertEquals("INVALID_ROLE_IDS", assertThrows(CpApiException.class,
                () -> service.replace(unitA.toString(), null)).getCode());
        assertEquals("INVALID_ROLE_ID", assertThrows(CpApiException.class,
                () -> service.replace(unitA.toString(), List.of("not-a-uuid"))).getCode());
        assertEquals(0, bindingRows(unitA));
        assertEquals(auditBefore, auditCount(), "400 paths also write nothing");
    }

    // ------------------------------------------------------------------ fixtures

    private UUID insertUnit(UUID parentId, String name, String parentPath, int depth) {
        UUID id = UUID.randomUUID();
        String path = parentPath == null ? label(id) : parentPath + "." + label(id);
        jdbc.update("INSERT INTO org_units (id, parent_id, name, path, depth)"
                + " VALUES (?, ?, ?, ?::ltree, ?)", id, parentId, name, path, depth);
        return id;
    }

    private UUID insertRole(String name, String... atoms) {
        AccessRole role = new AccessRole();
        role.setName(name);
        role.setDisplayName(name);
        role.setSystem(false);
        role = roles.saveAndFlush(role);
        for (String atom : atoms) {
            jdbc.update("INSERT INTO role_permissions (role_id, action_class, resource_pattern)"
                    + " VALUES (?, ?, '*')", role.getId(), atom);
        }
        return role.getId();
    }

    private UUID insertUser(String handle) {
        String unique = handle + "-" + suffix;
        User user = new User();
        user.setEmail(unique + "@org-unit-role-binding.test");
        user.setUsername(unique);
        user.setPasswordHash("x");
        user.setName(unique);
        return users.save(user).getId();
    }

    private UUID insertOwnedWorkspace(UUID owner) {
        Workspace workspace = new Workspace();
        workspace.setName("ws-" + UUID.randomUUID().toString().substring(0, 8));
        workspace.setStorageMode("direct_attach");
        workspace.setHostPath("/tmp/xihe-org-unit/" + UUID.randomUUID());
        workspace = workspaces.saveAndFlush(workspace);
        AccessRole ownerRole = roles.findByName(SystemAccessRoleCatalog.WS_OWNER).orElseThrow();
        AccessRoleBinding binding = new AccessRoleBinding();
        binding.setRoleId(ownerRole.getId());
        binding.setSubjectType("user");
        binding.setSubjectId(owner);
        binding.setScopeType("workspace");
        binding.setScopeId(workspace.getId());
        binding.setGrantedBy(owner);
        binding.setGrantedAt(Instant.now());
        bindings.saveAndFlush(binding);
        return workspace.getId();
    }

    private int bindingRows(UUID unitId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM org_unit_role_bindings WHERE org_unit_id = ?",
                Integer.class, unitId);
        return count == null ? 0 : count;
    }

    private int auditCount() {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM audit_logs WHERE action = ?",
                Integer.class, OrgUnitRoleBindingService.AUDIT_EVENT);
        return count == null ? 0 : count;
    }

    private String latestAuditDetail() {
        return jdbc.queryForObject("SELECT details FROM audit_logs WHERE action = ?"
                + " ORDER BY created_at DESC, id DESC LIMIT 1", String.class,
                OrgUnitRoleBindingService.AUDIT_EVENT);
    }

    private void grant(UUID subjectId, String atom) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(subjectId);
        grant.setSubjectType("user");
        grant.setSubjectId(subjectId);
        grant.setSource("role");
        grant.setReadState("read");
        ArrayNode permissions = objectMapper.createArrayNode();
        permissions.addObject().put("actionClass", atom).put("resource", "*");
        grant.setPermissions(permissions);
        grants.saveAndFlush(grant);
    }

    private static String label(UUID id) {
        return id.toString().replace("-", "");
    }
}
