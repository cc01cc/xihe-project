package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.OrgUnitMemberRepository;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M1-6 (task-260): both halves of the org-unit seed, on a real PostgreSQL database.
 *
 * <p>The card was opened because the real {@code /members} page said 「无法查看组织单元」. The root
 * cause was two missing rows, and each is asserted separately here because fixing either one alone
 * leaves the page empty:</p>
 *
 * <ol>
 *   <li><b>V167's root unit</b> — asserted through startup, not through Flyway: this class extends
 *       {@link AbstractIntegrationTest}, whose database is a clone of the migrated template, so
 *       "the migration ran" is not what is being claimed. What is claimed is that a database
 *       that went through the whole chain <i>and then booted the application</i> has a root.</li>
 *   <li><b>DataSeeder's membership row</b> — the migration cannot write it (no {@code users} row
 *       exists at migration time) and the page needs it, so "the admin sits in the root" is a
 *       separate fact with a separate failure mode.</li>
 * </ol>
 *
 * <p>The two halves are pinned to each other: the unit id asserted here is
 * {@link DataSeeder#ROOT_ORG_UNIT_ID}, the constant the seeder queries by, and the unit it finds
 * must be the one V167 wrote. A test that asserted only "some root exists" would pass while the
 * seeder placed the admin somewhere the migration never created.</p>
 *
 * <p><b>Re-runnability is part of the assertion, not a bonus</b>: {@code run()} is what a restart
 * executes again, so it is called a second time here and the row counts must not move. Without
 * that, a restart would either duplicate the membership or move a subject an operator had moved —
 * and both would be invisible until someone read the table.</p>
 */
class OrgUnitRootSeedIntegrationTest extends AbstractIntegrationTest {

    private static final String ROOT_NAME = "默认组织";
    private static final String ORG_UNITS = "/api/v1/org-units";

    @Autowired
    private DataSeeder dataSeeder;

    @Autowired
    private UserRepository users;

    @Autowired
    private OrgUnitReadRepository orgUnits;

    @Autowired
    private OrgUnitMemberRepository orgUnitMembers;

    @Autowired
    private JdbcTemplate jdbc;

    private HttpHeaders adminHeaders() {
        ResponseEntity<Map> login = restTemplate.postForEntity(
                url("/api/v1/auth/login"),
                Map.of("identifier", "admin@xihe.local", "password", DataSeeder.seededAdminPassword()),
                Map.class);
        assertEquals(HttpStatus.OK, login.getStatusCode());
        String token = (String) login.getBody().get("accessToken");
        assertNotNull(token);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private HttpHeaders nonMemberHeaders() {
        ResponseEntity<Map> registered = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", "no-unit-" + UUID.randomUUID() + "@test.com",
                        "password", "non-member-password", "name", "Non member"),
                Map.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode());
        String token = (String) registered.getBody().get("accessToken");
        assertNotNull(token);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    @Test
    void aBootedDatabaseHasTheRootUnitAndTheAdminIsPlacedInIt() {
        User admin = users.findByEmail("admin@xihe.local").orElseThrow();

        assertTrue(orgUnits.findUnit(DataSeeder.ROOT_ORG_UNIT_ID).isPresent(),
                "V167 must have created the root unit: without it the seeder cannot place anyone,"
                        + " because it refuses to guess a unit id");
        assertFalse(orgUnits.findUnit(DataSeeder.ROOT_ORG_UNIT_ID).orElseThrow().parentId() != null,
                "the seeded unit must be a root (parent_id NULL), otherwise the tree hangs off"
                        + " nothing and the member-facing list has no entry point");

        assertEquals(java.util.Optional.of(DataSeeder.ROOT_ORG_UNIT_ID),
                orgUnitMembers.findUnitOf("human", admin.getId()),
                "DataSeeder must place admin@xihe.local in the root unit -- this row is exactly"
                        + " what the org members page was missing (task-260)");
    }

    @Test
    void theAdminSeesTheRootOverHttpInsteadOfAnEmptyTree() {
        ResponseEntity<Map> list = restTemplate.exchange(
                url(ORG_UNITS), HttpMethod.GET, new HttpEntity<>(adminHeaders()), Map.class);
        assertEquals(HttpStatus.OK, list.getStatusCode());

        Object rawNodes = list.getBody().get("nodes");
        assertNotNull(rawNodes, "the list response always carries a nodes array, even when empty");
        List<Map<String, Object>> nodes = (List<Map<String, Object>>) rawNodes;
        assertEquals(1, nodes.size(),
                "a root member sees exactly its own unit here: the list is scoped to the member's"
                        + " subtree and parentId=null was not given");
        assertEquals(DataSeeder.ROOT_ORG_UNIT_ID.toString(), nodes.get(0).get("id"),
                "the one visible node must be the seeded root");
        assertEquals(ROOT_NAME, nodes.get(0).get("name"));
        assertEquals(0, nodes.get(0).get("depth"));
        assertEquals(false, nodes.get(0).get("hasChildren"),
                "V167 seeds the root alone; a child here would mean the seed invented a tree");
    }

    /**
     * The negative that makes the positive mean something: the same endpoint, the same database,
     * a caller without a membership. If this returned nodes too, the page's emptiness would not
     * have been a seeding problem at all.
     */
    @Test
    void aCallerWithoutMembershipGets404RatherThanTheSameTree() {
        ResponseEntity<Map> list = restTemplate.exchange(
                url(ORG_UNITS), HttpMethod.GET, new HttpEntity<>(nonMemberHeaders()), Map.class);
        assertEquals(HttpStatus.NOT_FOUND, list.getStatusCode());
        assertEquals("ORG_UNIT_NOT_FOUND", list.getBody().get("code"));
    }

    @Test
    void runningTheSeederAgainMovesNoRow() {
        User admin = users.findByEmail("admin@xihe.local").orElseThrow();
        int unitsBefore = count("SELECT count(*) FROM org_units");
        int membersBefore = count("SELECT count(*) FROM org_unit_members");

        // The seed is @Transactional, so a direct call takes the same path a restart takes.
        dataSeeder.run();

        assertEquals(unitsBefore, count("SELECT count(*) FROM org_units"),
                "a restart must not create a second root or a child: the seed is a seed, not a migration");
        assertEquals(membersBefore, count("SELECT count(*) FROM org_unit_members"),
                "OrgUnitMemberRepository.place is an upsert on (member_kind, member_id) precisely so a"
                        + " restart rewrites the same row instead of inserting a second one");
        assertEquals(java.util.Optional.of(DataSeeder.ROOT_ORG_UNIT_ID),
                orgUnitMembers.findUnitOf("human", admin.getId()),
                "the re-run must leave the subject where it was, not move it again");
    }

    private int count(String sql) {
        Integer value = jdbc.queryForObject(sql, Integer.class);
        return value == null ? 0 : value;
    }
}
