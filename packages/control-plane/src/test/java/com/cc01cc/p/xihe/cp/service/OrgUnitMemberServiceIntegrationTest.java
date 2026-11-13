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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M2-11 batch C + M2-10b G1 (task-237): add/move/remove a member, and the three clauses
 * of `verify.md` V2-11 that G1 pins.
 *
 * <p>The clauses are asserted as <b>readings</b>, not prose:</p>
 * <ol>
 *   <li>a 200 response carries `affectedWorkspaceIds` — <b>present even when empty</b>;</li>
 *   <li>the audit row (`org_membership_moved`) is written with member/from/to/affected fields;</li>
 *   <li>a missing confirmation is a 409 <b>and</b> the `org_unit_members` row did not change
 *       <b>and</b> the `audit_logs` count did not change — all three, because any two of them can
 *       hold while the third is broken.</li>
 * </ol>
 *
 * <p>The negatives also cover the authorization order this card keeps re-establishing: a non-member
 * is a <b>404</b> on the member face too, and a member without `MANAGE_ORG_UNIT_MEMBERS` is a 403
 * <b>with its code asserted</b> (a status-only assertion cannot tell "the atom gate" from "some
 * other 403").</p>
 */
class OrgUnitMemberServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private OrgUnitMemberService memberService;

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
    private UUID member;

    @BeforeEach
    void cleanTables() {
        jdbc.update("DELETE FROM org_unit_members");
        jdbc.update("DELETE FROM org_units");
        suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        caller = insertUser("caller");
        member = insertUser("member");
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
        jdbc.update("DELETE FROM role_bindings WHERE subject_id IN (?, ?)", caller, member);
    }

    @Test
    void aFirstPlacementAnswersWithAnEmptyAffectedListAndWritesTheAuditRow() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID unit = insertUnit(root, "unit-" + suffix, rootPathOf(root), 1);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unit, caller);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        int auditBefore = auditCount();
        OrgUnitWireView.MemberMoved moved = memberService.move(
                unit.toString(), member.toString(), "human", true);

        assertNull(moved.fromOrgUnitId(), "a first placement has no source unit");
        assertEquals(unit, moved.toOrgUnitId());
        assertNotNull(moved.affectedWorkspaceIds(),
                "G1: the field must be present; an empty list is an answer, absence is a contract break");
        assertTrue(moved.affectedWorkspaceIds().isEmpty());
        assertEquals("org_membership_moved", moved.auditEvent());
        assertEquals(auditBefore + 1, auditCount(), "the G1 audit row is written in the same call");
        assertEquals(unit, unitOf("human", member));
    }

    @Test
    void anOwnerMoveWithoutConfirmationIsA409AndNeitherRowNorAuditCountMoves() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID first = insertUnit(root, "first-" + suffix, rootPathOf(root), 1);
        UUID second = insertUnit(root, "second-" + suffix, rootPathOf(root), 1);
        // The manager is an instance-level holder (the atom without a membership row): the move
        // goes from one unit to a sibling, which a member scoped to its own unit subtree could
        // never reach.
        UUID owned = insertOwnedWorkspace(member);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        int auditBefore = auditCount();
        CpApiException refused = assertThrows(CpApiException.class,
                () -> memberService.move(second.toString(), member.toString(), "human", false));

        assertEquals(HttpStatus.CONFLICT, refused.getStatus());
        assertEquals("ORG_UNIT_MOVE_CONFIRMATION_REQUIRED", refused.getCode(),
                "the code matters: a 409 without this code could be some other conflict");
        assertEquals(auditBefore, auditCount(), "clause 3b: no audit row was written");
        assertNull(unitOf("human", member), "clause 3a: the membership row was not written at all");

        // With the confirmation, the same move succeeds and names the affected workspace.
        OrgUnitWireView.MemberMoved moved = memberService.move(
                second.toString(), member.toString(), "human", true);
        assertEquals(List.of(owned), moved.affectedWorkspaceIds(),
                "the owned workspace is exactly the affected set — not a superset, not empty");
        assertEquals(second, unitOf("human", member));
        assertEquals(auditBefore + 1, auditCount());
    }

    @Test
    void aMoveBetweenUnitsReportsTheSourceAndTargetAndTheAuditNamesBoth() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID first = insertUnit(root, "first-" + suffix, rootPathOf(root), 1);
        UUID second = insertUnit(root, "second-" + suffix, rootPathOf(root), 1);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", first, member);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        OrgUnitWireView.MemberMoved moved = memberService.move(
                second.toString(), member.toString(), "human", true);
        assertEquals(first, moved.fromOrgUnitId());
        assertEquals(second, moved.toOrgUnitId());
        assertEquals(second, unitOf("human", member));

        String detail = latestAuditDetail();
        assertTrue(detail.contains(member.toString()), "the audit detail names the member");
        assertTrue(detail.contains(first.toString()), "and the source unit");
        assertTrue(detail.contains(second.toString()), "and the target unit");
        assertTrue(detail.contains("affectedWorkspaceIds"), "G1 names the field it added");
    }

    @Test
    void removingAMemberDeletesTheRowAndASecondRemoveIsA404() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID unit = insertUnit(root, "unit-" + suffix, rootPathOf(root), 1);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unit, caller);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unit, member);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        memberService.remove(unit.toString(), member.toString(), "human");
        assertNull(unitOf("human", member), "the row is gone");
        CpApiException again = assertThrows(CpApiException.class,
                () -> memberService.remove(unit.toString(), member.toString(), "human"));
        assertEquals(HttpStatus.NOT_FOUND, again.getStatus());
        assertEquals("ORG_UNIT_MEMBER_NOT_FOUND", again.getCode(),
                "removing a non-member of that unit is a 404 with the pair-specific code");
    }

    @Test
    void anAgentPrincipalCanBePlacedAndIsTreatedAsAMember() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID unit = insertUnit(root, "unit-" + suffix, rootPathOf(root), 1);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unit, caller);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        UUID principal = UUID.randomUUID();
        OrgUnitWireView.MemberMoved moved = memberService.move(
                unit.toString(), principal.toString(), "agent_principal", true);
        assertEquals(unit, unitOf("agent_principal", principal));
        assertTrue(moved.affectedWorkspaceIds().isEmpty(),
                "this agent owns no workspace, and that is reported as an empty list");
    }

    @Test
    void anUnknownMemberKindIsA400() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID unit = insertUnit(root, "unit-" + suffix, rootPathOf(root), 1);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unit, caller);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        CpApiException refused = assertThrows(CpApiException.class,
                () -> memberService.move(unit.toString(), member.toString(), "User", true));
        assertEquals("INVALID_MEMBER_KIND", refused.getCode(),
                "a silently accepted spelling would create a member nothing queries for");
    }

    @Test
    void aNonMemberIsA404AndAMemberWithoutTheAtomIsA403WithItsCode() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID unit = insertUnit(root, "unit-" + suffix, rootPathOf(root), 1);
        TenantContext.setUserId(caller.toString());

        CpApiException notAMember = assertThrows(CpApiException.class,
                () -> memberService.move(unit.toString(), member.toString(), "human", true));
        assertEquals(HttpStatus.NOT_FOUND, notAMember.getStatus(),
                "a non-member must not learn whether the unit exists");
        assertEquals("ORG_UNIT_NOT_FOUND", notAMember.getCode());
        assertEquals("ORG_UNIT_NOT_FOUND", assertThrows(CpApiException.class,
                () -> memberService.remove(unit.toString(), member.toString(), "human")).getCode());

        // Now make the caller a member, but grant only the read atom.
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unit, caller);
        grant(caller, OrgUnitReadService.READ_ATOM);
        CpApiException noAtom = assertThrows(CpApiException.class,
                () -> memberService.move(unit.toString(), member.toString(), "human", true));
        assertEquals(HttpStatus.FORBIDDEN, noAtom.getStatus());
        assertEquals("FORBIDDEN", noAtom.getCode(),
                "the code is part of the judgement: status alone cannot tell this 403 from another");
    }

    // ------------------------------------------------------------------ fixtures

    private String rootPathOf(UUID unitId) {
        return jdbc.queryForObject("SELECT path::text FROM org_units WHERE id = ?", String.class, unitId);
    }

    private UUID insertUnit(UUID parentId, String name, String parentPath, int depth) {
        UUID id = UUID.randomUUID();
        String path = parentPath == null ? label(id) : parentPath + "." + label(id);
        jdbc.update("INSERT INTO org_units (id, parent_id, name, path, depth)"
                + " VALUES (?, ?, ?, ?::ltree, ?)", id, parentId, name, path, depth);
        return id;
    }

    private UUID insertUser(String handle) {
        String unique = handle + "-" + suffix;
        User user = new User();
        user.setEmail(unique + "@org-unit-member.test");
        user.setUsername(unique);
        user.setPasswordHash("x");
        user.setName(unique);
        return users.save(user).getId();
    }

    /** A real workspace owned by {@code owner} through a `WS_OWNER` binding at workspace scope. */
    private UUID insertOwnedWorkspace(UUID owner) {
        Workspace workspace = new Workspace();
        workspace.setName("ws-" + UUID.randomUUID().toString().substring(0, 8));
        workspace.setStorageMode("direct_attach");
        workspace.setHostPath("/tmp/xihe-org-unit/" + UUID.randomUUID());
        workspace = workspaces.saveAndFlush(workspace);

        AccessRole ownerRole = roles.findByName(SystemAccessRoleCatalog.WS_OWNER)
                .orElseThrow(() -> new IllegalStateException("WS_OWNER seed role is missing"));
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

    private int auditCount() {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM audit_logs WHERE action = ?",
                Integer.class, OrgUnitMemberService.AUDIT_EVENT);
        return count == null ? 0 : count;
    }

    private String latestAuditDetail() {
        return jdbc.queryForObject("SELECT details FROM audit_logs WHERE action = ?"
                + " ORDER BY created_at DESC, id DESC LIMIT 1", String.class,
                OrgUnitMemberService.AUDIT_EVENT);
    }

    private UUID unitOf(String kind, UUID memberId) {
        List<UUID> rows = jdbc.query("SELECT org_unit_id FROM org_unit_members"
                + " WHERE member_kind = ? AND member_id = ?",
                (rs, i) -> rs.getObject(1, UUID.class), kind, memberId);
        return rows.isEmpty() ? null : rows.get(0);
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
