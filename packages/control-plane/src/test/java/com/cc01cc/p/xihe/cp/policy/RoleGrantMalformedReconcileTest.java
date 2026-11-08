package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BL-313 / D-182: the materializer's malformed-row repair path must survive its own flush order.
 *
 * <p>A malformed `source='role'` row (multiple atoms in one permissions array — produced by legacy
 * fixture SQL or manual damage, never by the product) violates {@code uq_grants_role_atom}'s
 * one-atom-per-row invariant. {@code reconcile} correctly puts such a row into {@code toDelete} and
 * rewrites the desired atoms, but before the flush fix Hibernate executed the INSERT before the
 * DELETE, so a rewritten atom colliding with the malformed row answered 23505 and the subject's
 * materialization stayed broken (measured on the e2e runner DB, requestId {@code 8891fb74-…}).
 * The malformed row here carries {@code network} (desired) + {@code SPAWN_AGENT} (extra) — exactly
 * the runner-DB shape — so the repair rewrites {@code network} onto its own key.</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RoleGrantMalformedReconcileTest extends AbstractReusableIntegrationTest {

    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private ObjectMapper objectMapper;

    private final java.util.List<UUID> cleanupSubjects = new java.util.ArrayList<>();
    private final java.util.List<UUID> cleanupRoles = new java.util.ArrayList<>();
    private final java.util.List<UUID> cleanupUsers = new java.util.ArrayList<>();

    @AfterEach
    void cleanup() {
        for (UUID subjectId : cleanupSubjects) {
            jdbcTemplate.update("DELETE FROM grants WHERE subject_type='agent_principal'"
                    + " AND subject_id=CAST(? AS UUID)", subjectId.toString());
            bindingRepository.deleteAll(bindingRepository.findBySubjectTypeAndSubjectId(
                    "agent_principal", subjectId));
        }
        cleanupSubjects.clear();
        for (UUID roleId : cleanupRoles) {
            bindingRepository.deleteAll(bindingRepository.findByRoleId(roleId));
            permissionRepository.deleteAll(permissionRepository.findByIdRoleId(roleId));
            accessRoleRepository.deleteById(roleId);
        }
        cleanupRoles.clear();
        for (UUID userId : cleanupUsers) {
            userRepository.deleteById(userId);
        }
        cleanupUsers.clear();
    }

    @Test
    void malformedMultiAtomRowIsRepairedWithoutViolatingTheUniqueKey() {
        UUID subjectId = UUID.randomUUID();
        cleanupSubjects.add(subjectId);
        User granter = userRepository.saveAndFlush(new User(
                "malformed-" + UUID.randomUUID() + "@test.local", "hash", "malformed granter"));
        cleanupUsers.add(granter.getId());

        // Desired: a proper single-atom role the subject is bound to (the rewrite target).
        AccessRole role = accessRoleRepository.saveAndFlush(new AccessRole(
                UUID.randomUUID(), "TMR_" + shortId().substring(0, 6).toUpperCase(),
                "Malformed fixture",
                "test-only", false));
        cleanupRoles.add(role.getId());
        permissionRepository.saveAndFlush(new AccessRolePermission(role.getId(), "network", "*"));
        bindingRepository.saveAndFlush(new AccessRoleBinding(role.getId(), "agent_principal",
                subjectId, AccessScope.INSTANCE, null, granter.getId()));

        // The damage: one malformed multi-atom row — exactly the runner-DB shape
        // ([network, SPAWN_AGENT@*], source='role', instance scope).
        ArrayNode multiAtom = objectMapper.createArrayNode();
        multiAtom.addObject().put("actionClass", "network");
        multiAtom.addObject().put("actionClass", "SPAWN_AGENT").put("resource", "*");
        AuthorizationGrant damaged = new AuthorizationGrant();
        damaged.setId(UUID.randomUUID());
        damaged.setSubjectType("agent_principal");
        damaged.setSubjectId(subjectId);
        damaged.setGranterType("user");
        damaged.setGranterId(granter.getId());
        damaged.setPermissions(multiAtom);
        damaged.setSource(RoleGrantMaterializer.SOURCE_ROLE);
        damaged.setScopeType(AccessScope.INSTANCE);
        grantRepository.saveAndFlush(damaged);

        assertEquals(1, countMultiAtom(subjectId), "fixture: exactly one malformed row");

        // The repair must succeed — pre-fix this answered DataIntegrityViolationException 23505
        // because Hibernate flushed the INSERT (rewritten network) before the DELETE (malformed row).
        RoleGrantMaterializer.Result result = materializer.materializeSubject("agent_principal",
                subjectId, granter.getId(), null);
        assertTrue(result.deleted() >= 1 && result.created() >= 1,
                "the malformed row is deleted and the desired atom rewritten: " + result);

        assertEquals(0, countMultiAtom(subjectId), "the malformed row is gone after the repair");
        assertEquals(1, jdbcTemplate.queryForObject("SELECT count(*) FROM grants"
                        + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)"
                        + " AND source='role' AND permissions @> "
                        + "'[{\"actionClass\":\"network\"}]'::jsonb", Integer.class,
                subjectId.toString()),
                "the desired atom is materialized exactly once (no duplicate key)");
        assertEquals(0, jdbcTemplate.queryForObject("SELECT count(*) FROM grants"
                        + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)"
                        + " AND permissions @> '[{\"actionClass\":\"SPAWN_AGENT\"}]'::jsonb",
                Integer.class, subjectId.toString()),
                "the extra atom of the malformed row is dropped, not preserved");
    }

    private int countMultiAtom(UUID subjectId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM grants"
                + " WHERE subject_type='agent_principal' AND subject_id=CAST(? AS UUID)"
                + " AND jsonb_array_length(permissions) > 1", Integer.class, subjectId.toString());
    }

    private String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }
}
