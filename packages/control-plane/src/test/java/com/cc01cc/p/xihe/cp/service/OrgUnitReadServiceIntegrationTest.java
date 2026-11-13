package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M2-11 batch A (task-237): the judgement of the two read endpoints, on a real database.
 *
 * <p>What is under test is <b>who may see what</b>, not that a SELECT returns rows. The negatives
 * are the substance, and each exists because a plausible alternative would have been wrong:</p>
 *
 * <ul>
 *   <li>a <b>non-member</b> gets 404 for every unit id — existing or not — because a 403 would
 *       confirm existence (design §4.3);</li>
 *   <li>a <b>member without the atom</b> gets 403: the atom gate runs after scope, so it cannot
 *       collapse into the 404 above;</li>
 *   <li>a <b>member</b> reading a sibling or an ancestor gets 403 — the rule is
 *       "descendant-or-self", and an ancestor is not inside its own subtree;</li>
 *   <li>an <b>instance-level reader</b> (atom, no membership) sees the whole tree: design §4.2's
 *       default grant, and the only way to hold the atom without a membership row today.</li>
 * </ul>
 *
 * <p>Fixtures are SQL rows, not API calls: this batch adds no write endpoint, so a membership row
 * can only be produced by a fixture until batch C lands (same reasoning as M2-10a's negative).</p>
 */
class OrgUnitReadServiceIntegrationTest extends AbstractIntegrationTest {

    /** Per-test unique token: the database is cloned per class, so a fixed email would collide
     * on the second test method (`uq_users_email`) — the same trap `SkillCatalogIsolationTest` hit. */
    private String suffix;

    @Autowired
    private OrgUnitReadService readService;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private UserRepository users;

    @Autowired
    private AgentPrincipalRepository principals;

    @Autowired
    private AuthorizationGrantRepository grants;

    @Autowired
    private ObjectMapper objectMapper;

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

    @Test
    void aMemberWithoutTheAtomIsRefusedWith403() {
        NodeRef root = root("root");
        NodeRef mine = child(root, "mine");
        insertMembership(mine, "human", caller);
        TenantContext.setUserId(caller.toString());

        CpApiException refused = assertThrows(CpApiException.class, () -> readService.list(null, null));
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus());
        assertEquals("FORBIDDEN", refused.getCode());
        assertEquals(HttpStatus.FORBIDDEN, assertThrows(CpApiException.class,
                () -> readService.members(mine.id.toString(), false)).getStatus());
    }

    @Test
    void aNonMemberGets404ForEveryUnitIdExistingOrNot() {
        NodeRef root = root("root");
        NodeRef existing = child(root, "existing");
        TenantContext.setUserId(caller.toString());

        CpApiException listRefused = assertThrows(CpApiException.class,
                () -> readService.list(null, null));
        assertEquals(HttpStatus.NOT_FOUND, listRefused.getStatus());
        assertEquals("ORG_UNIT_NOT_FOUND", listRefused.getCode());

        // The same answer for an id that exists and for one that does not: if they differed, the
        // error itself would be the existence oracle the ruling refuses.
        assertEquals("ORG_UNIT_NOT_FOUND", assertThrows(CpApiException.class,
                () -> readService.members(existing.id.toString(), false)).getCode());
        assertEquals("ORG_UNIT_NOT_FOUND", assertThrows(CpApiException.class,
                () -> readService.members(UUID.randomUUID().toString(), false)).getCode());
        assertEquals("ORG_UNIT_NOT_FOUND", assertThrows(CpApiException.class,
                () -> readService.list(existing.id.toString(), null)).getCode());
    }

    @Test
    void aMemberSeesOnlyItsOwnSubtreeAndSiblingsAndAncestorsAre403() {
        NodeRef root = root("root");
        NodeRef mine = child(root, "mine");
        NodeRef sibling = child(root, "sibling");
        NodeRef grandchild = child(mine, "grandchild");
        insertMembership(mine, "human", caller);
        grant(caller, OrgUnitReadService.READ_ATOM);
        TenantContext.setUserId(caller.toString());

        OrgUnitWireView.NodeList top = readService.list(null, null);
        assertEquals(1, top.nodes().size(), "the visible top is the caller's own unit");
        assertEquals("mine-" + suffix, top.nodes().get(0).name());
        assertTrue(top.nodes().get(0).hasChildren());

        OrgUnitWireView.NodeList below = readService.list(mine.id.toString(), null);
        assertEquals(1, below.nodes().size());
        assertEquals("grandchild-" + suffix, below.nodes().get(0).name());
        assertFalse(below.nodes().get(0).hasChildren());

        assertEquals(HttpStatus.FORBIDDEN, assertThrows(CpApiException.class,
                () -> readService.list(sibling.id.toString(), null)).getStatus(),
                "a sibling subtree is outside the governance scope");
        assertEquals(HttpStatus.FORBIDDEN, assertThrows(CpApiException.class,
                () -> readService.list(root.id.toString(), null)).getStatus(),
                "an ancestor is outside it too: <@ is descendant-or-self");
        assertEquals(HttpStatus.FORBIDDEN, assertThrows(CpApiException.class,
                () -> readService.members(sibling.id.toString(), false)).getStatus());
        assertEquals(1, readService.members(mine.id.toString(), false).members().size(),
                "the caller's own row is the only member of mine");
    }

    @Test
    void anInstanceLevelReaderSeesTheWholeTree() {
        NodeRef first = root("tree-one");
        NodeRef second = root("tree-two");
        NodeRef nested = child(second, "nested");
        grant(caller, OrgUnitReadService.READ_ATOM);
        TenantContext.setUserId(caller.toString());

        OrgUnitWireView.NodeList roots = readService.list(null, null);
        assertEquals(2, roots.nodes().size(),
                "an instance-scope holder with no membership row sees every root (design §4.2)");
        assertEquals(0, readService.members(nested.id.toString(), false).members().size(),
                "and it can read a unit in a tree it is not part of");
        assertEquals(0, readService.members(first.id.toString(), true).members().size());
    }

    @Test
    void membersCarryTheirSubjectLabelAndDescendantsAreOptional() {
        NodeRef root = root("root");
        NodeRef mine = child(root, "mine");
        NodeRef below = child(mine, "below");
        UUID human = insertUser("human");
        UUID principal = insertPrincipal("agent-" + suffix);
        insertMembership(mine, "human", human);
        insertMembership(below, "agent_principal", principal);
        insertMembership(mine, "human", caller);
        grant(caller, OrgUnitReadService.READ_ATOM);
        TenantContext.setUserId(caller.toString());

        List<OrgUnitWireView.Member> direct = readService.members(mine.id.toString(), false).members();
        assertEquals(2, direct.size(),
                "two humans: the fixture member and the caller (whose visibility requires that row)");
        java.util.Map<UUID, String> labels = new java.util.HashMap<>();
        for (OrgUnitWireView.Member member : direct) {
            assertEquals("human", member.memberKind());
            assertEquals(mine.id, member.orgUnitId());
            labels.put(member.memberId(), member.displayName());
        }
        assertEquals("human-" + suffix, labels.get(human), "the label is users.username");
        assertEquals("caller-" + suffix, labels.get(caller));

        List<OrgUnitWireView.Member> subtree = readService.members(mine.id.toString(), true).members();
        assertEquals(3, subtree.size(),
                "includeDescendants=true adds the agent one level down to the two humans");
        OrgUnitWireView.Member agentRow = subtree.stream()
                .filter(member -> "agent_principal".equals(member.memberKind()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("the agent in the child unit is missing"));
        assertEquals("agent-" + suffix, agentRow.displayName(),
                "the agent label is agent_principals.name, from the same query");
        assertEquals(below.id, agentRow.orgUnitId());

        assertEquals(1, readService.members(below.id.toString(), false).members().size(),
                "the child unit itself holds only the agent");
    }

    @Test
    void aNameSearchStaysInsideTheCallersSubtree() {
        NodeRef root = root("root");
        NodeRef mine = child(root, "mine");
        child(root, "hidden-hit");
        child(mine, "visible-hit");
        insertMembership(mine, "human", caller);
        grant(caller, OrgUnitReadService.READ_ATOM);
        TenantContext.setUserId(caller.toString());

        OrgUnitWireView.NodeList hits = readService.list(null, "hit");
        assertEquals(1, hits.nodes().size(), "one hit inside the subtree, none from the sibling");
        assertEquals("visible-hit-" + suffix, hits.nodes().get(0).name());
        assertEquals(0, readService.list(null, "hidden-hit").nodes().size(),
                "a sibling subtree's name is not searchable from here");
    }

    // ------------------------------------------------------------------ fixtures

    private record NodeRef(UUID id, String path, int depth) {}

    private NodeRef root(String name) {
        UUID id = UUID.randomUUID();
        String path = label(id);
        insertUnit(id, null, name + "-" + suffix, path, 0);
        return new NodeRef(id, path, 0);
    }

    private NodeRef child(NodeRef parent, String name) {
        UUID id = UUID.randomUUID();
        String path = parent.path + "." + label(id);
        insertUnit(id, parent.id, name + "-" + suffix, path, parent.depth + 1);
        return new NodeRef(id, path, parent.depth + 1);
    }

    private void insertUnit(UUID id, UUID parentId, String name, String path, int depth) {
        jdbc.update("INSERT INTO org_units (id, parent_id, name, path, depth)"
                + " VALUES (?, ?, ?, ?::ltree, ?)", id, parentId, name, path, depth);
    }

    private void insertMembership(NodeRef unit, String kind, UUID memberId) {
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id) VALUES (?, ?, ?)",
                unit.id, kind, memberId);
    }

    private UUID insertUser(String handle) {
        String unique = handle + "-" + suffix;
        User user = new User();
        user.setEmail(unique + "@org-unit.test");
        user.setUsername(unique);
        user.setPasswordHash("x");
        user.setName(unique);
        return users.save(user).getId();
    }

    private UUID insertPrincipal(String name) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name);
        principal.setCreatedByUserId(caller.toString());
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        return principals.saveAndFlush(principal).getId();
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
