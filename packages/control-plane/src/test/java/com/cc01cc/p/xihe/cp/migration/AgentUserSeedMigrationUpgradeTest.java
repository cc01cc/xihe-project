package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0651 ⑥ (D-174, V127): AGENT_USER becomes the agent default role.
 * Fresh side: the migrated catalog seeds are exactly right and the sibling seeded agent roles carry
 * no agent-forbidden atom. Upgrade side: the measured 40-row legacy shape (agent seed binding to
 * USER with the materialized CREATE_OWN_AGENT grant) is rebind-in-place by V127 — 40 → 40, seeds
 * preserved, the forbidden atom stripped, five atoms present, and human USER grants untouched.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AgentUserSeedMigrationUpgradeTest extends AbstractIntegrationTest {

    private static final int LEGACY_AGENT_SEEDS = 40;

    @Autowired private UserRepository userRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private JdbcTemplate jdbcTemplate;

    private final List<UUID> principals = new ArrayList<>();
    private final List<UUID> humans = new ArrayList<>();

    @AfterEach
    void cleanup() {
        for (UUID principalId : principals) {
            jdbcTemplate.update("DELETE FROM grants WHERE subject_type='agent_principal'"
                    + " AND subject_id=CAST(? AS UUID)", principalId.toString());
            bindingRepository.deleteAll(bindingRepository.findBySubjectTypeAndSubjectId(
                    "agent_principal", principalId));
            principalRepository.deleteById(principalId);
        }
        principals.clear();
        for (UUID userId : humans) {
            jdbcTemplate.update("DELETE FROM grants WHERE subject_type='user'"
                    + " AND subject_id=CAST(? AS UUID)", userId.toString());
            bindingRepository.deleteAll(bindingRepository.findBySubjectTypeAndSubjectId("user", userId));
            userRepository.deleteById(userId);
        }
        humans.clear();
    }

    // ---------------------------- fresh side (migrations already applied to this schema) --------

    @Test
    void freshCatalogSeedsAreExactAndSiblingAgentRolesAreClean() {
        assertEquals(5, permissionRepository.findByIdRoleId(SystemAccessRoleCatalog.AGENT_USER_ID).size(),
                "AGENT_USER seeds exactly the five base atoms");
        assertEquals(0, permissionRepository.findByIdRoleId(SystemAccessRoleCatalog.AGENT_USER_ID).stream()
                        .filter(row -> "CREATE_OWN_AGENT".equals(row.getId().getActionClass())).count(),
                "the agent-forbidden atom is never part of AGENT_USER");
        assertEquals(6, permissionRepository.findByIdRoleId(SystemAccessRoleCatalog.USER_ID).size(),
                "human USER keeps its six registration atoms (5 base + CREATE_OWN_AGENT)");
        assertTrue(permissionRepository.findByIdRoleId(SystemAccessRoleCatalog.USER_ID).stream()
                        .anyMatch(row -> "CREATE_OWN_AGENT".equals(row.getId().getActionClass())),
                "the human USER seed is untouched");

        // Sibling seeded agent roles: neither may carry an agent-principal-forbidden atom.
        for (String roleName : new String[] {"AGENT_SPAWNER", "AGENT_DELEGATOR"}) {
            AccessRole role = accessRoleRepository.findByName(roleName).orElse(null);
            if (role == null) {
                continue;
            }
            List<String> atoms = permissionRepository.findByIdRoleId(role.getId()).stream()
                    .map(row -> row.getId().getActionClass()).toList();
            assertNull(PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(atoms),
                    roleName + " must not carry a forbidden atom: " + atoms);
        }
    }

    // ---------------------------- upgrade side (V127 executed against a legacy-shaped fixture) --

    @Test
    void v127RebindsFortyLegacyAgentSeedsInPlaceAndStripsTheForbiddenAtom() throws Exception {
        User granter = newHuman("v127-granter");
        int humanGrantsBefore = grantCountForUser(granter.getId());

        UUID userRoleId = SystemAccessRoleCatalog.USER_ID;
        List<UUID> agentIds = new ArrayList<>();
        for (int i = 0; i < LEGACY_AGENT_SEEDS; i++) {
            AgentPrincipal agent = new AgentPrincipal();
            agent.setName("v127-agent-" + i + "-" + UUID.randomUUID().toString().substring(0, 8));
            agent.setTemplateSnapshot(new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode());
            agent.setCreatedByUserId(granter.getId().toString());
            UUID agentId = principalRepository.saveAndFlush(agent).getId();
            principals.add(agentId);
            agentIds.add(agentId);
            AccessRoleBinding legacySeed = new AccessRoleBinding(userRoleId, "agent_principal",
                    agentId, AccessScope.INSTANCE, null, granter.getId());
            legacySeed.setSeed(true);
            bindingRepository.save(legacySeed);
            materializer.materializeSubject("agent_principal", agentId, granter.getId(), null);
        }

        // The legacy shape is in place: seeds point at USER and the forbidden atom is materialized.
        assertEquals(LEGACY_AGENT_SEEDS, seedBindingCount(SystemAccessRoleCatalog.USER_ID),
                "legacy fixture: 40 agent USER seed bindings");
        assertEquals(LEGACY_AGENT_SEEDS, forbiddenGrantCount(agentIds),
                "legacy fixture: CREATE_OWN_AGENT materialized for every agent");

        runV127();

        assertEquals(LEGACY_AGENT_SEEDS, seedBindingCount(SystemAccessRoleCatalog.AGENT_USER_ID),
                "40 → 40: every legacy seed is rebound to AGENT_USER");
        assertEquals(0, seedBindingCount(SystemAccessRoleCatalog.USER_ID),
                "no agent seed keeps pointing at the human USER role");
        assertEquals(0, forbiddenGrantCount(agentIds),
                "the agent-forbidden grant is stripped");
        for (UUID agentId : agentIds) {
            assertEquals(5, jdbcTemplate.queryForObject("SELECT count(*) FROM grants"
                            + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)"
                            + " AND source='role' AND scope_type='instance'", Integer.class,
                    agentId.toString()), "each agent materializes exactly AGENT_USER's five atoms");
        }
        // Seed/granted_by/scope survive the in-place UPDATE (spot check one row).
        AccessRoleBinding sample = bindingRepository.findBySubjectTypeAndSubjectId(
                "agent_principal", agentIds.get(0)).get(0);
        assertEquals("instance", sample.getScopeType());
        assertTrue(sample.isSeed(), "the seed flag survives the rebind");
        assertEquals(granter.getId(), sample.getGrantedBy());

        // human USER: zero change (bindings and grants both).
        assertEquals(humanGrantsBefore, grantCountForUser(granter.getId()),
                "human USER grants are untouched by V127");
    }

    private void runV127() throws Exception {
        String sql = new String(AgentUserSeedMigrationUpgradeTest.class
                .getClassLoader()
                .getResourceAsStream("db/migration/V127__plan0651_agent_user_default_role.sql")
                .readAllBytes(), StandardCharsets.UTF_8);
        StringBuilder statement = new StringBuilder();
        for (String line : sql.split("\n")) {
            String trimmed = line.trim();
            if (trimmed.startsWith("--")) {
                continue;
            }
            statement.append(line).append('\n');
            if (trimmed.endsWith(";")) {
                jdbcTemplate.execute(statement.toString().replace(";", ""));
                statement.setLength(0);
            }
        }
    }

    private int seedBindingCount(UUID roleId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM role_bindings"
                + " WHERE subject_type='agent_principal' AND is_seed AND scope_type='instance'"
                + " AND role_id=CAST(? AS UUID)", Integer.class, roleId.toString());
    }

    private int forbiddenGrantCount(List<UUID> agentIds) {
        int total = 0;
        for (UUID agentId : agentIds) {
            total += jdbcTemplate.queryForObject("SELECT count(*) FROM grants"
                    + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)"
                    + " AND source='role' AND permissions @> "
                    + "'[{\"actionClass\": \"CREATE_OWN_AGENT\"}]'::jsonb", Integer.class,
                    agentId.toString());
        }
        return total;
    }

    private int grantCountForUser(UUID userId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM grants WHERE subject_type='user'"
                + " AND subject_id=CAST(? AS UUID)", Integer.class, userId.toString());
    }

    private User newHuman(String label) {
        User user = userRepository.saveAndFlush(new User(
                label + "-" + UUID.randomUUID() + "@test.local", "hash", label));
        humans.add(user.getId());
        return user;
    }
}
