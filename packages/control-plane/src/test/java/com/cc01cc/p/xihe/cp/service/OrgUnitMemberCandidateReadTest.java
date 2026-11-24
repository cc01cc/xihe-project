package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-960 (R25/R29/R30): the org-member candidate read face, asserted as invariants rather than
 * specific ids or counts.
 *
 * <p><b>R25/R29</b> — a candidate is a subject that belongs to <b>no unit at all</b>. The assertion
 * {@code candidates ∩ members(whole tree) == ∅} is deliberately not scoped to the unit being edited:
 * the bug this card fixes is a list that offered people already sitting somewhere in the tree, so
 * "not in <i>this</i> unit" would let the same person be added twice. A subject in a descendant unit
 * moves through the existing {@code move} face instead.</p>
 *
 * <p><b>R30</b> — hierarchy is expressed only by the unit tree. The org member read/write faces must
 * not grow a per-row identity such as {@code role: "lead"} / {@code 负责人} to create a level
 * difference inside one unit. {@link #orgMemberFacesCarryNoHierarchyIdentityMarker()} scans the
 * sources; {@link #theHierarchyMarkerScannerFailsOnAPeerLevelLeadField()} proves the scanner itself
 * fails when such a field is injected, so the clean result is not vacuous.</p>
 */
class OrgUnitMemberCandidateReadTest extends AbstractIntegrationTest {

    /**
     * Identity labels that would turn a flat member list into a level (R30/D-1935). The generic word
     * {@code role} is not matched on its own: preset bindings legitimately use "role", and the
     * hierarchy ban is about a member-level lead/leader/owner-label field, not governance presets.
     */
    private static final Pattern HIERARCHY_IDENTITY_MARKER = Pattern.compile(
            "(?i)(?:\\blead\\b|\\bleader\\b|\\bleadership\\b|\\bis_?lead\\b|\\blead_?id\\b"
                    + "|\\bmember_?role\\b|\\brole_?name\\b"
                    + "|\\brole\\s*[=:]\\s*[\\\"']?lead)"
                    + "|负责人|上下级角色");

    private static final List<String> ORG_MEMBER_FACES = List.of(
            "controller/OrgUnitController.java",
            "controller/OrgUnitWireView.java",
            "service/OrgUnitMemberService.java",
            "service/OrgUnitReadService.java",
            "repository/OrgUnitMemberRepository.java",
            "repository/OrgUnitReadRepository.java");

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private OrgUnitMemberRepository members;

    @Autowired
    private UserRepository users;

    @Autowired
    private AgentPrincipalRepository principals;

    private String suffix;
    private UUID agentOwner;

    @BeforeEach
    void cleanOrgTree() {
        jdbc.update("DELETE FROM org_unit_members");
        jdbc.update("DELETE FROM org_units");
        suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        agentOwner = insertUser("agent-owner");
    }

    @Test
    void subjectsAlreadyInAnyUnitNeverAppearAsCandidates() {
        UUID root = insertUnit(null, "candidate-root-" + suffix, null, 0);
        UUID descendant = insertUnit(root, "candidate-deep-" + suffix, pathOf(root), 1);
        UUID assignedHuman = insertUser("assigned-human");
        UUID unassignedHuman = insertUser("unassigned-human");
        UUID assignedAgent = insertAgent("assigned-agent");
        UUID unassignedAgent = insertAgent("unassigned-agent");

        members.place(OrgUnitMemberRepository.KIND_HUMAN, assignedHuman, descendant);
        members.place(OrgUnitMemberRepository.KIND_AGENT_PRINCIPAL, assignedAgent, root);

        List<OrgUnitMemberRepository.CandidateRow> humanCandidates =
                members.findUnassignedCandidates(OrgUnitMemberRepository.KIND_HUMAN, suffix);
        assertTrue(ids(humanCandidates).contains(unassignedHuman),
                "a user that belongs to no unit must be offered");
        assertFalse(ids(humanCandidates).contains(assignedHuman),
                "a user already placed in a descendant unit must not be offered again");

        List<OrgUnitMemberRepository.CandidateRow> agentCandidates =
                members.findUnassignedCandidates(OrgUnitMemberRepository.KIND_AGENT_PRINCIPAL, suffix);
        assertTrue(ids(agentCandidates).contains(unassignedAgent),
                "an agent principal that belongs to no unit must be offered");
        assertFalse(ids(agentCandidates).contains(assignedAgent),
                "an agent principal already placed in a unit must not be offered again");

        assertInvariant(OrgUnitMemberRepository.KIND_HUMAN);
        assertInvariant(OrgUnitMemberRepository.KIND_AGENT_PRINCIPAL);
    }

    /**
     * The cross-unit clause, stated separately: a subject in a grandchild unit is still "in the
     * org", so no unit's candidate list may contain it. Candidate judgement is whole-tree, not
     * "not in this unit".
     */
    @Test
    void aSubjectInADescendantUnitIsNotACandidateForAnyUnit() {
        UUID root = insertUnit(null, "cross-root-" + suffix, null, 0);
        UUID child = insertUnit(root, "cross-child-" + suffix, pathOf(root), 1);
        UUID grandchild = insertUnit(child, "cross-leaf-" + suffix, pathOf(child), 2);
        UUID deepHuman = insertUser("deep-human");
        members.place(OrgUnitMemberRepository.KIND_HUMAN, deepHuman, grandchild);

        List<OrgUnitMemberRepository.CandidateRow> candidates =
                members.findUnassignedCandidates(OrgUnitMemberRepository.KIND_HUMAN, suffix);
        assertFalse(ids(candidates).contains(deepHuman),
                "a member of a grandchild unit must not be offered as a new member");
    }

    @Test
    void aCandidateIsListedOnceAndLeavesTheSetOnFirstPlacement() {
        UUID root = insertUnit(null, "once-root-" + suffix, null, 0);
        UUID unit = insertUnit(root, "once-unit-" + suffix, pathOf(root), 1);
        UUID human = insertUser("once-human");

        List<OrgUnitMemberRepository.CandidateRow> before =
                members.findUnassignedCandidates(OrgUnitMemberRepository.KIND_HUMAN, suffix);
        assertEquals(1, count(before, human), "an unassigned subject must appear exactly once");
        assertEquals(new HashSet<>(ids(before)).size(), before.size(),
                "the candidate face must not repeat a subject");

        members.place(OrgUnitMemberRepository.KIND_HUMAN, human, unit);
        List<OrgUnitMemberRepository.CandidateRow> after =
                members.findUnassignedCandidates(OrgUnitMemberRepository.KIND_HUMAN, suffix);
        assertEquals(0, count(after, human),
                "the same subject must leave the candidate set the moment it is placed");
    }

    @Test
    void disabledSubjectsAreNotOfferedBecauseTheMoveFaceWouldRefuseThem() {
        UUID disabledHuman = insertUser("disabled-human");
        UUID disabledAgent = insertAgent("disabled-agent");
        jdbc.update("UPDATE users SET status = 'DISABLED', deleted_at = now() WHERE id = ?", disabledHuman);
        jdbc.update("UPDATE agent_principals SET disabled_at = now() WHERE id = ?", disabledAgent);

        assertFalse(ids(members.findUnassignedCandidates(
                        OrgUnitMemberRepository.KIND_HUMAN, suffix)).contains(disabledHuman),
                "a deleted/disabled user is not a row the member write face would accept");
        assertFalse(ids(members.findUnassignedCandidates(
                        OrgUnitMemberRepository.KIND_AGENT_PRINCIPAL, suffix)).contains(disabledAgent),
                "a disabled agent principal is not a row the member write face would accept");
    }

    @Test
    void orgMemberFacesCarryNoHierarchyIdentityMarker() throws IOException {
        StringBuilder sources = new StringBuilder();
        for (String relative : ORG_MEMBER_FACES) {
            sources.append(relative).append('\n').append(readSource(relative)).append('\n');
        }
        assertFalse(HIERARCHY_IDENTITY_MARKER.matcher(sources).find(),
                "R30: org member read/write faces must express hierarchy only through the unit tree;"
                        + " a lead/负责人 identity field would create a level inside one unit");
    }

    @Test
    void theHierarchyMarkerScannerFailsOnAPeerLevelLeadField() {
        assertTrue(HIERARCHY_IDENTITY_MARKER.matcher(
                        "public record MemberRow(UUID memberId, String role) { } // role = 'lead'").find(),
                "injecting a lead field into the member view must make the R30 scan fail");
        assertTrue(HIERARCHY_IDENTITY_MARKER.matcher(
                        "public record MemberRow(UUID memberId, String 负责人) { }").find(),
                "a Chinese lead label must make the R30 scan fail as well");
    }

    // ------------------------------------------------------------------ assertions

    private void assertInvariant(String memberKind) {
        Set<UUID> candidates = ids(members.findUnassignedCandidates(memberKind, null));
        Set<UUID> allMembers = new HashSet<>(jdbc.query(
                "SELECT member_id FROM org_unit_members",
                (rs, i) -> rs.getObject(1, UUID.class)));
        assertTrue(candidates.stream().noneMatch(allMembers::contains),
                "invariant candidates ∩ members(whole tree) == ∅ broken for " + memberKind);
    }

    private static Set<UUID> ids(List<OrgUnitMemberRepository.CandidateRow> rows) {
        Set<UUID> ids = new HashSet<>();
        rows.forEach(row -> ids.add(row.memberId()));
        return ids;
    }

    private static int count(List<OrgUnitMemberRepository.CandidateRow> rows, UUID memberId) {
        return (int) rows.stream().filter(row -> row.memberId().equals(memberId)).count();
    }

    private static String readSource(String relative) throws IOException {
        Path file = Path.of("src/main/java/com/cc01cc/p/xihe/cp", relative);
        if (!Files.exists(file)) {
            throw new IllegalStateException("cannot find " + file.toAbsolutePath()
                    + " (cwd=" + Path.of("").toAbsolutePath() + ")");
        }
        return Files.readString(file);
    }

    // ------------------------------------------------------------------ fixtures

    private UUID insertUnit(UUID parentId, String name, String parentPath, int depth) {
        UUID id = UUID.randomUUID();
        String path = parentPath == null ? label(id) : parentPath + "." + label(id);
        jdbc.update("INSERT INTO org_units (id, parent_id, name, path, depth)"
                + " VALUES (?, ?, ?, ?::ltree, ?)", id, parentId, name, path, depth);
        return id;
    }

    private String pathOf(UUID unitId) {
        return jdbc.queryForObject("SELECT path::text FROM org_units WHERE id = ?", String.class, unitId);
    }

    private static String label(UUID id) {
        return "u" + id.toString().replace("-", "");
    }

    private UUID insertUser(String handle) {
        String unique = handle + "-" + suffix;
        return users.save(new User(unique + "@org-candidate.test", "x", unique, unique)).getId();
    }

    private UUID insertAgent(String handle) {
        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName(handle + "-" + suffix);
        principal.setCreatedByUserId(agentOwner.toString());
        return principals.save(principal).getId();
    }
}
