package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
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
 * task-985: the HTTP read face of the org-member candidate picker.
 *
 * <p>What must not regress is the <b>server-side</b> judgement: a subject already placed in any
 * unit never appears (the whole-tree {@code NOT EXISTS}), an unassigned subject does, and {@code q}
 * only narrows the set. A client that filtered a broader directory would pass a UI test and still
 * ship the original bug, so these assertions hit the service that backs the endpoint.</p>
 *
 * <p>The gate order is asserted too: a non-member gets 404 (no existence leak) and a member without
 * {@code MANAGE_ORG_UNIT_MEMBERS} gets 403 — the same order as the write face.</p>
 */
class OrgUnitMemberCandidateHttpTest extends AbstractIntegrationTest {

    @Autowired
    private OrgUnitMemberService memberService;

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
    private UUID unit;

    @BeforeEach
    void cleanOrgTree() {
        jdbc.update("DELETE FROM org_unit_members");
        jdbc.update("DELETE FROM org_units");
        suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        caller = insertUser("candidate-caller");
        unit = insertUnit(null, "candidate-unit-" + suffix, null, 0);
        insertMembership(unit, "human", caller);
        grant(caller, OrgUnitMemberService.MANAGE_MEMBERS_ATOM);
        TenantContext.setUserId(caller.toString());
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void subjectsAlreadyInAnyUnitAreAbsentWhileUnassignedSubjectsAppear() {
        // The assigned subject sits in the very unit being edited; the whole-tree rule also covers
        // descendants/siblings (task-960's repository test), so one assigned row is enough here.
        UUID assigned = insertUser("assigned");
        insertMembership(unit, "human", assigned);
        UUID unassigned = insertUser("unassigned");

        List<OrgUnitWireView.MemberCandidate> candidates =
                memberService.candidates(unit.toString(), "human", null).candidates();

        assertTrue(ids(candidates).contains(unassigned),
                "an unassigned subject must be offered");
        assertFalse(ids(candidates).contains(assigned),
                "a subject already placed in a unit must not be offered again");
        assertFalse(ids(candidates).contains(caller),
                "the caller itself is a member and must not appear as a candidate");
    }

    @Test
    void queryOnlyNarrowsTheCandidateSet() {
        UUID alpha = insertUser("alpha");
        UUID beta = insertUser("beta");

        List<OrgUnitWireView.MemberCandidate> alphaOnly =
                memberService.candidates(unit.toString(), "human", "alpha-" + suffix).candidates();
        assertEquals(1, alphaOnly.size(), "q must narrow the set to the matching display name");
        assertEquals("alpha-" + suffix, alphaOnly.get(0).displayName());

        List<OrgUnitWireView.MemberCandidate> all =
                memberService.candidates(unit.toString(), "human", "  ").candidates();
        assertTrue(ids(all).contains(alpha), "a blank q must not filter the matching subject away");
        assertTrue(ids(all).contains(beta), "a blank q must not filter anything away");
    }

    @Test
    void aNonMemberGets404AndAMemberWithoutTheAtomGets403() {
        UUID outsider = insertUser("outsider");
        TenantContext.setUserId(outsider.toString());
        assertEquals(HttpStatus.NOT_FOUND, assertThrows(CpApiException.class,
                () -> memberService.candidates(unit.toString(), "human", null)).getStatus(),
                "a non-member must not learn whether the unit exists");

        UUID readOnlyMember = insertUser("read-only");
        insertMembership(unit, "human", readOnlyMember);
        TenantContext.setUserId(readOnlyMember.toString());
        CpApiException refused = assertThrows(CpApiException.class,
                () -> memberService.candidates(unit.toString(), "human", null));
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus());
        assertEquals("FORBIDDEN", refused.getCode());
    }

    @Test
    void anUnknownMemberKindIsABadRequest() {
        TenantContext.setUserId(caller.toString());
        CpApiException refused = assertThrows(CpApiException.class,
                () -> memberService.candidates(unit.toString(), "robot", null));
        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatus());
        assertEquals("INVALID_MEMBER_KIND", refused.getCode());
    }

    private static java.util.Set<UUID> ids(List<OrgUnitWireView.MemberCandidate> rows) {
        java.util.Set<UUID> ids = new java.util.HashSet<>();
        rows.forEach(row -> ids.add(row.memberId()));
        return ids;
    }

    // ------------------------------------------------------------------ fixtures

    private UUID insertUnit(UUID parentId, String name, String parentPath, int depth) {
        UUID id = UUID.randomUUID();
        String path = parentPath == null ? label(id) : parentPath + "." + label(id);
        jdbc.update("INSERT INTO org_units (id, parent_id, name, path, depth)"
                + " VALUES (?, ?, ?, ?::ltree, ?)", id, parentId, name, path, depth);
        return id;
    }

    private void insertMembership(UUID unitId, String kind, UUID memberId) {
        jdbc.update("INSERT INTO org_unit_members (org_unit_id, member_kind, member_id)"
                + " VALUES (?, ?, ?)", unitId, kind, memberId);
    }

    private UUID insertUser(String handle) {
        String unique = handle + "-" + suffix;
        return users.save(new User(unique + "@org-candidate-http.test", "x", unique, unique)).getId();
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
