package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
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
 * USER with a materialized CREATE_OWN_AGENT grant) is rebind-in-place by V127 — 40 → 40, seeds
 * preserved, the forbidden atom stripped, six atoms present (PLAN-0691 T1.3 added
 * PLUGIN_INVOKE to the base set), and human USER grants untouched. BL-312 (V147) removed the atom
 * from the catalog and seeds, so the upgrade fixture re-creates the legacy materialized rows by
 * direct insert — the migration must strip rows the current vocabulary can no longer produce.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class AgentUserSeedMigrationUpgradeTest extends AbstractReusableIntegrationTest {

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
        // Design change, not drift: PLAN-0691 T1.3 (V137) added PLUGIN_INVOKE to
        // SystemAccessRoleCatalog.BASE_ATOMS (spec/authz-plugin-atoms.md B-4: invoking an
        // already-bound BUILTIN plugin is part of the base set of every non-viewer role), so
        // AGENT_USER — whose seed *is* BASE_ATOMS — went from five atoms to six. The expectation
        // moves with the single source; the atom is seed data, not a role special case.
        assertEquals(6, permissionRepository.findByIdRoleId(SystemAccessRoleCatalog.AGENT_USER_ID).size(),
                "AGENT_USER seeds exactly the six base atoms (PLAN-0691 T1.3 added PLUGIN_INVOKE:"
                        + " 5 -> 6)");
        assertEquals(0, permissionRepository.findByIdRoleId(SystemAccessRoleCatalog.AGENT_USER_ID).stream()
                        .filter(row -> "CREATE_OWN_AGENT".equals(row.getId().getActionClass())).count(),
                "the agent-forbidden atom is never part of AGENT_USER");
        // V129/V130 (BL-345/BL-349, 2026-11-06) added MEMORY_WRITE_SELF to the human USER default:
        // base + SELF. The base set is six atoms since PLAN-0691 T1.3 added PLUGIN_INVOKE (V137);
        // BL-312 (V147, 2026-11-09) removed the former CREATE_OWN_AGENT seed row (7 at that point);
        // PLAN-0750 M1 (G1, 2026-11-10) restored it with user-level semantics (8 at that point);
        // V156 (task-221 / D-1019, 2026-11-12) then seeded MANAGE_PERSONAL_SKILLS onto USER
        // (V156:83-85) because every account owns a personal skill library, so the human USER seed
        // is 6 base + SELF + CREATE_OWN_AGENT + MANAGE_PERSONAL_SKILLS = 9. AGENT_USER stays at six:
        // all three extras are agent-principal-forbidden (PermissionAtomCatalog.java:96-139), which
        // is exactly why the two roles differ again.
        assertEquals(9, permissionRepository.findByIdRoleId(SystemAccessRoleCatalog.USER_ID).size(),
                "human USER keeps its registration atoms + the V129 SELF atom + the PLAN-0750 M1"
                        + " own-agent atom + the V156 personal-library atom"
                        + " (6 base + SELF + CREATE_OWN_AGENT + MANAGE_PERSONAL_SKILLS)");
        assertTrue(permissionRepository.findByIdRoleId(SystemAccessRoleCatalog.USER_ID).stream()
                        .anyMatch(row -> "CREATE_OWN_AGENT".equals(row.getId().getActionClass())),
                "PLAN-0750 M1: creating one's own user-level principal is a registration capability"
                        + " again (new semantics: owner = actor, no Workspace binding)");

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
            // The migration under test must strip exactly these rows. Since PLAN-0750 M1 restored
            // the atom, the materializer emits it for a USER-bound agent by itself; the helper only
            // fills the row in when the catalog does not (it is idempotent either way).
            insertLegacyForbiddenGrant(agentId, granter.getId());
        }

        // The legacy shape is in place: seeds point at USER and the forbidden atom is materialized.
        assertEquals(LEGACY_AGENT_SEEDS, seedBindingCount(SystemAccessRoleCatalog.USER_ID),
                "legacy fixture: 40 agent USER seed bindings");
        assertEquals(LEGACY_AGENT_SEEDS, forbiddenGrantCount(agentIds),
                "legacy fixture: CREATE_OWN_AGENT materialized for every USER-bound agent"
                        + " (PLAN-0750 M1 restored it to the human USER seed)");

        runMigration("V127__plan0651_agent_user_default_role.sql");
        // Upgrade path continues past V127: BL-367's forward migration strips the instance-scope SELF
        // row that V129's backfill materialized on legacy agent bindings.
        runMigration("V131__bl367_remove_agent_memory_write_self.sql");
        // V156 (task-221 / D-1019) seeded MANAGE_PERSONAL_SKILLS onto the human USER role, and an
        // agent principal materialized from that legacy USER binding carries it. V159 is the
        // forward strip for exactly that atom — one atom per migration, the same shape as V131
        // (V156 is already applied elsewhere, so it is not edited).
        runMigration("V159__agent_principals_drop_personal_skills_atom.sql");

        assertEquals(LEGACY_AGENT_SEEDS, seedBindingCount(SystemAccessRoleCatalog.AGENT_USER_ID),
                "40 → 40: every legacy seed is rebound to AGENT_USER");
        assertEquals(0, seedBindingCount(SystemAccessRoleCatalog.USER_ID),
                "no agent seed keeps pointing at the human USER role");
        assertEquals(0, forbiddenGrantCount(agentIds),
                "the agent-forbidden grant is stripped");
        for (UUID agentId : agentIds) {
            assertEquals(6, jdbcTemplate.queryForObject("SELECT count(*) FROM grants"
                            + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)"
                            + " AND source='role' AND scope_type='instance'", Integer.class,
                    agentId.toString()), "each agent materializes exactly AGENT_USER's six atoms"
                    + " (PLAN-0691 T1.3 added PLUGIN_INVOKE to the base set: 5 -> 6)");
        }
        // BL-367 处置③: no upgraded agent may hold any AGENT_FORBIDDEN_ATOMS atom. This is the
        // structural guard against a future migration re-materializing SELF (or another forbidden atom).
        for (UUID agentId : agentIds) {
            List<String> atoms = jdbcTemplate.queryForList(
                    "SELECT DISTINCT permissions -> 0 ->> 'actionClass' FROM grants"
                            + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)",
                    String.class, agentId.toString());
            assertNull(PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(atoms),
                    "upgraded agent holds an agent-forbidden atom: " + atoms);
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

    private void runMigration(String resource) throws Exception {
        String sql = new String(AgentUserSeedMigrationUpgradeTest.class
                .getClassLoader()
                .getResourceAsStream("db/migration/" + resource)
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

    /**
     * The V91-era materialized row shape. Idempotent since PLAN-0750 M1 (G1) restored the atom:
     * the fixture's agents are bound to the human USER role, whose seed now carries
     * CREATE_OWN_AGENT, so {@code materializeSubject} already produces this exact row and an
     * unconditional INSERT would violate uq_grants_role_atom.
     */
    private void insertLegacyForbiddenGrant(UUID agentId, UUID granterId) {
        Integer existing = jdbcTemplate.queryForObject("SELECT count(*) FROM grants"
                        + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)"
                        + " AND source='role' AND permissions @> "
                        + "'[{\"actionClass\": \"CREATE_OWN_AGENT\"}]'::jsonb",
                Integer.class, agentId.toString());
        if (existing != null && existing > 0) {
            return;
        }
        jdbcTemplate.update("INSERT INTO grants (id, granter_type, granter_id, subject_type,"
                        + " subject_id, permissions, source, scope_type, scope_id, read_state)"
                        + " VALUES (gen_random_uuid(), 'user', CAST(? AS UUID), 'agent_principal',"
                        + " CAST(? AS UUID), '[{\"actionClass\": \"CREATE_OWN_AGENT\"}]'::jsonb,"
                        + " 'role', 'instance', NULL, 'read')",
                granterId.toString(), agentId.toString());
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
