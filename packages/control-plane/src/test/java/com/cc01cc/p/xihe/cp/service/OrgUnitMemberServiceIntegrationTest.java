package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.entity.GrantPreset;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.SystemGrantPresetCatalog;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
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
    private GrantPresetRepository roles;

    @Autowired
    private GrantPresetBindingRepository bindings;

    @Autowired
    private AuthorizationGrantRepository grants;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AgentPrincipalRepository principals;

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
        jdbc.update("DELETE FROM grant_preset_bindings WHERE subject_id IN (?, ?)", caller, member);
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

    /**
     * R31 (task-956): the old assertion "the membership row is gone" is no longer enough. The
     * invariant is the MVP one: <b>no path may leave an active subject outside the org</b>. So after
     * a remove the subject must be (a) absent from every unit <b>and</b> (b) deactivated — an
     * account row that survives for traceability, but one that cannot authenticate. A second
     * remove of the same pair is a 404 because the pair no longer exists.
     */
    @Test
    void removingAMemberDeactivatesTheSubjectAndASecondRemoveIsA404() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID unit = insertUnit(root, "unit-" + suffix, rootPathOf(root), 1);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unit, caller);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unit, member);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        int auditBefore = auditCount(OrgUnitMemberService.REMOVED_AUDIT_EVENT);
        memberService.remove(unit.toString(), member.toString(), "human");
        assertNull(unitOf("human", member), "the membership row is gone");
        assertEquals(0, membershipRows("human", member),
                "the subject is in no unit at all — not just no longer in this one");
        assertEquals(0, activeMemberships("human", member),
                "MVP invariant: an active subject can never be unit-less");
        assertEquals(1, disabledUsers(member),
                "the account row survives, soft-deleted and disabled — traceable, not erased");
        assertTrue(jdbc.queryForObject("SELECT token_version FROM users WHERE id = ?",
                        Integer.class, member) > 0,
                "both credential epochs are bumped, so access/refresh tokens die now");
        assertEquals(auditBefore + 1, auditCount(OrgUnitMemberService.REMOVED_AUDIT_EVENT),
                "the deactivation is audited durably, not only logged");
        CpApiException again = assertThrows(CpApiException.class,
                () -> memberService.remove(unit.toString(), member.toString(), "human"));
        assertEquals(HttpStatus.NOT_FOUND, again.getStatus());
        assertEquals("ORG_UNIT_MEMBER_NOT_FOUND", again.getCode(),
                "removing a non-member of that unit is a 404 with the pair-specific code");
        assertEquals(1, disabledUsers(member),
                "the refused second call did not touch the account state again");
    }

    /**
     * Security negative: the pair is checked <b>before</b> deactivation. Targeting a unit the
     * subject is not in must not disable the account.
     */
    @Test
    void removingFromTheWrongUnitIsA404AndDoesNotDeactivateTheSubject() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID first = insertUnit(root, "first-" + suffix, rootPathOf(root), 1);
        UUID second = insertUnit(root, "second-" + suffix, rootPathOf(root), 1);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", first, member);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        int auditBefore = auditCount(OrgUnitMemberService.REMOVED_AUDIT_EVENT);
        CpApiException refused = assertThrows(CpApiException.class,
                () -> memberService.remove(second.toString(), member.toString(), "human"));
        assertEquals(HttpStatus.NOT_FOUND, refused.getStatus());
        assertEquals("ORG_UNIT_MEMBER_NOT_FOUND", refused.getCode());
        assertEquals(first, unitOf("human", member), "the subject is still in its real unit");
        assertEquals(0, disabledUsers(member), "the account was NOT disabled by the wrong-unit call");
        assertEquals(auditBefore, auditCount(OrgUnitMemberService.REMOVED_AUDIT_EVENT),
                "a refused remove writes no deactivation audit row");
    }

    @Test
    void removingAnAgentPrincipalDisablesThePrincipalInsteadOfFreeingIt() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID unit = insertUnit(root, "unit-" + suffix, rootPathOf(root), 1);
        UUID agentId = insertAgentPrincipal();
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'agent_principal', ?)", unit, agentId);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", unit, caller);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        memberService.remove(unit.toString(), agentId.toString(), "agent_principal");

        assertNull(unitOf("agent_principal", agentId), "the membership row is gone");
        assertEquals(0, membershipRows("agent_principal", agentId));
        assertEquals(1, jdbc.queryForObject(
                "SELECT count(*) FROM agent_principals WHERE id = ? AND disabled_at IS NOT NULL",
                Integer.class, agentId), "disabled_at is the traceable deactivation marker");
    }

    /**
     * The invariant that matters, stated as a disjunction so it holds for both legal exits:
     * after either exit a subject is either still in exactly one unit, or deactivated. Nothing can
     * produce "active and in no unit".
     */
    @Test
    void moveAndRemoveAreTheOnlyExitsAndNeitherLeavesAnActiveSubjectOutsideTheOrg() {
        UUID root = insertUnit(null, "root-" + suffix, null, 0);
        UUID first = insertUnit(root, "first-" + suffix, rootPathOf(root), 1);
        UUID second = insertUnit(root, "second-" + suffix, rootPathOf(root), 1);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, 'human', ?)", first, member);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());

        memberService.move(second.toString(), member.toString(), "human", true);
        assertEquals(second, unitOf("human", member), "after a move the subject is in exactly one unit");
        assertEquals(0, disabledUsers(member), "and the account is still active");

        memberService.remove(second.toString(), member.toString(), "human");
        assertEquals(0, membershipRows("human", member), "after a remove the subject is in no unit");
        assertEquals(1, disabledUsers(member), "because it is deactivated instead");
        assertEquals(0, activeMemberships("human", member),
                "the invariant: active membership exists for every active subject");
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

        GrantPreset ownerRole = roles.findByName(SystemGrantPresetCatalog.WS_OWNER)
                .orElseThrow(() -> new IllegalStateException("WS_OWNER seed role is missing"));
        GrantPresetBinding binding = new GrantPresetBinding();
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
        return auditCount(OrgUnitMemberService.AUDIT_EVENT);
    }

    private int auditCount(String action) {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM audit_logs WHERE action = ?",
                Integer.class, action);
        return count == null ? 0 : count;
    }

    private int membershipRows(String kind, UUID memberId) {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM org_unit_members"
                + " WHERE member_kind = ? AND member_id = ?", Integer.class, kind, memberId);
        return count == null ? 0 : count;
    }

    private int activeMemberships(String kind, UUID memberId) {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM org_unit_members m"
                + " WHERE m.member_kind = ? AND m.member_id = ?"
                + " AND (m.member_kind <> 'human' OR EXISTS (SELECT 1 FROM users u"
                + " WHERE u.id = m.member_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL))"
                + " AND (m.member_kind <> 'agent_principal' OR EXISTS (SELECT 1 FROM agent_principals p"
                + " WHERE p.id = m.member_id AND p.disabled_at IS NULL))",
                Integer.class, kind, memberId);
        return count == null ? 0 : count;
    }

    private int disabledUsers(UUID userId) {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM users"
                + " WHERE id = ? AND status = 'DISABLED' AND deleted_at IS NOT NULL",
                Integer.class, userId);
        return count == null ? 0 : count;
    }

    private UUID insertAgentPrincipal() {
        var principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName("agent-" + suffix);
        principal.setCreatedByUserId(caller.toString());
        return principals.save(principal).getId();
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
        grant.setSource("assigned");
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
