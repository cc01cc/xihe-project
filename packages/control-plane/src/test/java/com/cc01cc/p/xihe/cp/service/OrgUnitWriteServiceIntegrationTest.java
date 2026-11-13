package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitWriteRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M2-11 batch B (task-237): create / rename / move, and the refusals they must produce.
 *
 * <p>The negatives carry this class, because each one is a refusal that a plausible implementation
 * would answer differently:</p>
 *
 * <ul>
 *   <li><b>ring ⇒ 422</b> and the rows are unchanged — and the refusal is also produced by the V165
 *       trigger when the service's readable pre-check is bypassed, which is what makes the trigger
 *       (not the pre-check) the judgement;</li>
 *   <li><b>duplicate sibling name ⇒ 409</b> and no second row appears (`uq_org_units_sibling_name`
 *       is `NULLS NOT DISTINCT`, so this holds for roots too);</li>
 *   <li><b>non-member write attempt ⇒ 404</b>, not 403 — the same order the read face uses, and the
 *       regression most likely to appear if the atom gate is ever moved to a `@PreAuthorize`;</li>
 *   <li><b>member without `MANAGE_ORG_UNITS` ⇒ 403</b>, so the 404 above cannot be confused with
 *       "refused everything";</li>
 *   <li><b>moving a subtree rewrites every descendant's path and depth</b> — the half-move
 *       (`parent_id` only) leaves a tree whose queries and rows disagree, silently.</li>
 * </ul>
 */
class OrgUnitWriteServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private OrgUnitWriteService writeService;

    @Autowired
    private OrgUnitReadService readService;

    @Autowired
    private OrgUnitWriteRepository writer;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private UserRepository users;

    @Autowired
    private AuthorizationGrantRepository grants;

    @Autowired
    private ObjectMapper objectMapper;

    private String suffix;
    private UUID caller;

    @BeforeEach
    void cleanTables() {
        jdbc.update("DELETE FROM org_unit_members");
        jdbc.update("DELETE FROM org_units");
        suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        caller = insertUser("caller");
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    // ------------------------------------------------------------------ create

    @Test
    void createBuildsThePathAndDepthFromTheParentAndRootsFromNothing() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());

        OrgUnitWireView.Created root = writeService.create("root-" + suffix, null);
        assertTrue(root.path().equals(label(root.id())),
                "a root's path is its own label, not a prefix borrowed from something else");
        OrgUnitWireView.Created child = writeService.create("child-" + suffix, root.id().toString());
        assertEquals(root.path() + "." + label(child.id()), child.path(),
                "a child path is its parent's path plus its own label");
        assertEquals(1, depthOf(child.id()), "a child of a root sits at depth 1");
        assertEquals(0, depthOf(root.id()));
    }

    @Test
    void aDuplicateSiblingNameIsA409AndNotASecondRow() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        OrgUnitWireView.Created root = writeService.create("root-" + suffix, null);

        assertEquals(1, countUnits(), "the first create is the only unit so far");

        CpApiException refused = assertThrows(CpApiException.class,
                () -> writeService.create("root-" + suffix, null));
        assertEquals(HttpStatus.CONFLICT, refused.getStatus());
        assertEquals("ORG_UNIT_NAME_CONFLICT", refused.getCode());
        assertEquals(1, countUnits(), "a refused create writes nothing");

        writeService.create("child-" + suffix, root.id().toString());
        CpApiException sameNameUnderSameParent = assertThrows(CpApiException.class,
                () -> writeService.create("child-" + suffix, root.id().toString()));
        assertEquals("ORG_UNIT_NAME_CONFLICT", sameNameUnderSameParent.getCode());
    }

    // ------------------------------------------------------------------ move

    @Test
    void movingASubtreeRewritesEveryDescendantPathAndDepth() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        OrgUnitWireView.Created rootA = writeService.create("root-a-" + suffix, null);
        OrgUnitWireView.Created rootB = writeService.create("root-b-" + suffix, null);
        OrgUnitWireView.Created moved = writeService.create("moved-" + suffix, rootA.id().toString());
        OrgUnitWireView.Created grandchild =
                writeService.create("grandchild-" + suffix, moved.id().toString());

        int movedDepthBefore = depthOf(moved.id());
        int grandchildDepthBefore = depthOf(grandchild.id());

        OrgUnitWireView.Node after = writeService.move(moved.id().toString(), rootB.id().toString());

        String newPrefix = rootB.path() + "." + label(moved.id());
        assertEquals(newPrefix, pathOf(moved.id()), "the moved unit is re-based onto the new parent");
        assertEquals(newPrefix + "." + label(grandchild.id()), pathOf(grandchild.id()),
                "the descendant is re-based too: a half-move leaves path disagreeing with parent_id");
        assertEquals(movedDepthBefore, depthOf(moved.id()),
                "moving from a root to a root keeps the depth: both parents are depth 0");
        assertEquals(grandchildDepthBefore, depthOf(grandchild.id()));
        assertEquals(rootB.id(), after.parentId());
    }

    @Test
    void movingADeeperSubtreeUnderADeeperParentShiftsTheWholeBranch() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        OrgUnitWireView.Created rootA = writeService.create("root-a-" + suffix, null);
        OrgUnitWireView.Created rootB = writeService.create("root-b-" + suffix, null);
        OrgUnitWireView.Created b1 = writeService.create("b1-" + suffix, rootB.id().toString());
        OrgUnitWireView.Created moved = writeService.create("moved-" + suffix, rootA.id().toString());
        OrgUnitWireView.Created leaf = writeService.create("leaf-" + suffix, moved.id().toString());

        writeService.move(moved.id().toString(), b1.id().toString());

        assertEquals(b1.path() + "." + label(moved.id()), pathOf(moved.id()));
        assertEquals(b1.path() + "." + label(moved.id()) + "." + label(leaf.id()), pathOf(leaf.id()));
        assertEquals(2, depthOf(moved.id()), "root → depth-1 parent means depth 2");
        assertEquals(3, depthOf(leaf.id()), "and the leaf shifts with it");
    }

    @Test
    void aRingIsRefusedWith422AndNothingMoved() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        OrgUnitWireView.Created root = writeService.create("root-" + suffix, null);
        OrgUnitWireView.Created unit = writeService.create("unit-" + suffix, root.id().toString());
        OrgUnitWireView.Created child = writeService.create("child-" + suffix, unit.id().toString());

        Map<String, Object> before = snapshot(unit.id(), child.id());

        CpApiException refused = assertThrows(CpApiException.class,
                () -> writeService.move(unit.id().toString(), child.id().toString()));
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, refused.getStatus());
        assertEquals("ORG_UNIT_CYCLE", refused.getCode());

        assertEquals(before, snapshot(unit.id(), child.id()),
                "a refused move must leave parent_id, path and depth untouched");
        // Moving a unit onto itself is the degenerate ring and must be refused the same way.
        assertEquals("ORG_UNIT_CYCLE", assertThrows(CpApiException.class,
                () -> writeService.move(unit.id().toString(), unit.id().toString())).getCode());
    }

    @Test
    void theTriggerRefusesARingEvenWhenTheReadablePreCheckIsBypassed() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        OrgUnitWireView.Created root = writeService.create("root-" + suffix, null);
        OrgUnitWireView.Created unit = writeService.create("unit-" + suffix, root.id().toString());
        OrgUnitWireView.Created child = writeService.create("child-" + suffix, unit.id().toString());

        // Straight to the repository: no scope, no pre-check, no service. If this succeeded, the
        // service pre-check would be the only judgement and a future bulk path could skip it.
        // `DataAccessException`, not `DataIntegrityViolationException`: SQLSTATE XH001 has the class
        // XH, which Spring does not map to the integrity family — so the *type* the trigger produces
        // is `UncategorizedSQLException`. The service catches the parent type for that reason; a test
        // that expected the subclass would have passed while the service answered 500.
        DataAccessException refused = assertThrows(DataAccessException.class,
                () -> writer.move(unit.id(), child.id(), child.path() + "." + label(unit.id()),
                        depthOf(child.id()) + 1, pathOf(unit.id()), 1));
        Throwable cause = refused.getMostSpecificCause();
        assertEquals("XH001", ((java.sql.SQLException) cause).getSQLState(),
                "the V165 trigger raises XH001, which is what the service translates into 422");
    }

    // ------------------------------------------------------------------ rename

    @Test
    void aRenameChangesTheNameButNotThePath() {
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());
        OrgUnitWireView.Created root = writeService.create("root-" + suffix, null);
        OrgUnitWireView.Created unit = writeService.create("unit-" + suffix, root.id().toString());
        String pathBefore = pathOf(unit.id());

        OrgUnitWireView.Node renamed = writeService.rename(unit.id().toString(), "renamed-" + suffix);
        assertEquals("renamed-" + suffix, renamed.name());
        assertEquals(pathBefore, pathOf(unit.id()),
                "labels are UUIDs, so a rename cannot move a unit: path is untouched by construction");

        // A rename that collides with an existing sibling is the same 409 as a duplicate create.
        writeService.create("other-" + suffix, root.id().toString());
        assertEquals("ORG_UNIT_NAME_CONFLICT", assertThrows(CpApiException.class,
                () -> writeService.rename(unit.id().toString(), "other-" + suffix)).getCode());
    }

    // ------------------------------------------------------------------ authorization

    @Test
    void aNonMemberWriteAttemptIsA404NotA403() {
        // The row is inserted by SQL, not through the service: the caller has no rights yet, which
        // is exactly the case under test.
        UUID unitId = insertUnit(null, "root-" + suffix, null, 0);
        TenantContext.setUserId(caller.toString());

        CpApiException createRefused = assertThrows(CpApiException.class,
                () -> writeService.create("child-" + suffix, unitId.toString()));
        assertEquals(HttpStatus.NOT_FOUND, createRefused.getStatus(),
                "a non-member must not learn whether the unit exists — on the write face too");
        assertEquals("ORG_UNIT_NOT_FOUND", createRefused.getCode());

        assertEquals("ORG_UNIT_NOT_FOUND", assertThrows(CpApiException.class,
                () -> writeService.rename(unitId.toString(), "x-" + suffix)).getCode());
        assertEquals("ORG_UNIT_NOT_FOUND", assertThrows(CpApiException.class,
                () -> writeService.move(unitId.toString(), null)).getCode());
        assertEquals(1, countUnits(), "none of the refusals wrote anything");
    }

    @Test
    void aMemberWithoutTheManageAtomGets403() {
        UUID unitId = insertUnit(null, "root-" + suffix, null, 0);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id) VALUES (?, 'human', ?)",
                unitId, caller);
        grant(caller, OrgUnitReadService.READ_ATOM);
        TenantContext.setUserId(caller.toString());

        CpApiException refused = assertThrows(CpApiException.class,
                () -> writeService.create("child-" + suffix, unitId.toString()));
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus(),
                "a member holds the read atom but not MANAGE_ORG_UNITS");
        assertEquals("FORBIDDEN", refused.getCode());
    }

    @Test
    void aMemberCannotCreateOrPromoteARoot() {
        UUID unitId = insertUnit(null, "root-" + suffix, null, 0);
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id) VALUES (?, 'human', ?)",
                unitId, caller);
        grant(caller, OrgUnitWriteService.MANAGE_ATOM);
        TenantContext.setUserId(caller.toString());

        assertEquals(HttpStatus.FORBIDDEN, assertThrows(CpApiException.class,
                () -> writeService.create("another-root-" + suffix, null)).getStatus(),
                "a member's scope is its own subtree; a root is outside it");
        assertEquals(HttpStatus.FORBIDDEN, assertThrows(CpApiException.class,
                () -> writeService.move(unitId.toString(), null)).getStatus());
    }

    // ------------------------------------------------------------------ fixtures

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
        user.setEmail(unique + "@org-unit-write.test");
        user.setUsername(unique);
        user.setPasswordHash("x");
        user.setName(unique);
        return users.save(user).getId();
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

    private int countUnits() {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM org_units", Integer.class);
        return count == null ? 0 : count;
    }

    private String pathOf(UUID unitId) {
        return jdbc.queryForObject("SELECT path::text FROM org_units WHERE id = ?", String.class, unitId);
    }

    private int depthOf(UUID unitId) {
        Integer depth = jdbc.queryForObject("SELECT depth FROM org_units WHERE id = ?", Integer.class, unitId);
        return depth == null ? -1 : depth;
    }

    private Map<String, Object> snapshot(UUID unitId, UUID childId) {
        return Map.of(
                "unitParent", String.valueOf(parentOf(unitId)),
                "unitPath", pathOf(unitId),
                "unitDepth", depthOf(unitId),
                "childParent", String.valueOf(parentOf(childId)),
                "childPath", pathOf(childId),
                "childDepth", depthOf(childId));
    }

    private UUID parentOf(UUID unitId) {
        return jdbc.queryForObject("SELECT parent_id FROM org_units WHERE id = ?", UUID.class, unitId);
    }

    private static String label(UUID id) {
        return id.toString().replace("-", "");
    }
}
