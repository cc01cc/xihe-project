package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0610 W1c (round-3 P1-2): the capability cache must be cleared <b>after</b> the transaction
 * that changed the bindings commits, and a role-permission edit must bump the epoch of every
 * affected user subject.
 *
 * <p>Before this fix {@code RoleGrantMaterializer} invalidated inside the transaction. A concurrent
 * request could then re-fill the cache from the pre-commit state and the stale entry lived for the
 * whole TTL ({@code cp.capability-cache-ttl-ms}, 30s) — the opposite of the 「不超过一次 lookup」
 * contract {@link AuthzContext} documents. Separately, {@code materializeRole} (role permission
 * edit) bumped nothing, so an access token issued before the edit kept authenticating.</p>
 */
class RoleMaterializationEpochTest extends AbstractH2Test {

    @Autowired private UserRepository userRepository;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private AuthzContext authzContext;
    @Autowired private PlatformTransactionManager transactionManager;

    @Test
    void capabilityCacheIsClearedOnlyAfterCommit() {
        User user = user();
        AccessRoleBinding binding = bindingRepository.save(new AccessRoleBinding(
                roleId(SystemAccessRoleCatalog.SUPER_ADMIN), "user", user.getId(),
                AccessScope.INSTANCE, null, user.getId()));
        materializer.materializeSubject("user", user.getId(), user.getId(), null);
        assertTrue(authzContext.isInstanceSuper(user.getId()), "warm the cache with the real state");

        new TransactionTemplate(transactionManager).execute(status -> {
            bindingRepository.delete(binding);
            materializer.materializeSubject("user", user.getId(), user.getId(), null);
            // Inside the transaction the invalidation is registered but not executed: a concurrent
            // reader therefore cannot re-fill from a half-applied state, and this read still sees the
            // pre-commit snapshot.
            assertTrue(authzContext.isInstanceSuper(user.getId()),
                    "invalidation must not run before the commit (round-3 P1-2)");
            return null;
        });

        assertFalse(authzContext.isInstanceSuper(user.getId()),
                "after the commit the next read must resolve the new (empty) state");
        assertTrue(grantRepository.findScopedGrants("user", user.getId(),
                GrantSources.EVALUATION_SOURCES, null).isEmpty());
    }

    @Test
    void rolePermissionEditBumpsTheEpochOfAffectedUserSubjects() {
        User user = user();
        UUID roleId = UUID.randomUUID();
        accessRoleRepository.save(new AccessRole(roleId, "EPOCH_TEST_" + roleId, "Epoch test",
                "test-only role", false));
        AccessRolePermission read = permissionRepository.save(new AccessRolePermission(roleId,
                ToolFaceRegistry.ACTION_READ, PermissionAtomCatalog.WILDCARD));
        bindingRepository.save(new AccessRoleBinding(roleId, "user", user.getId(),
                AccessScope.WORKSPACE, UUID.randomUUID(), user.getId()));
        materializer.materializeSubject("user", user.getId(), user.getId(), null);
        int epoch = tokenVersion(user.getId());
        assertEquals(1, grantRepository.findBySubjectTypeAndSubjectIdAndSource("user", user.getId(),
                GrantSources.ROLE).size());

        // The role loses its only atom: the materialized row disappears and the epoch moves.
        permissionRepository.delete(read);
        materializer.materializeRole(roleId, null, null);

        assertTrue(grantRepository.findBySubjectTypeAndSubjectIdAndSource("user", user.getId(),
                GrantSources.ROLE).isEmpty(), "the revoked atom is no longer materialized");
        assertEquals(epoch + 1, tokenVersion(user.getId()),
                "a change produced by a role edit bumps users.token_version (I4 / V17)");

        // A no-op re-materialization must not log the user out.
        int afterBump = tokenVersion(user.getId());
        materializer.materializeRole(roleId, null, null);
        assertEquals(afterBump, tokenVersion(user.getId()),
                "an unchanged materialization leaves the epoch alone");
    }

    // ---------------------------------------------------------------- helpers

    private User user() {
        return userRepository.save(new User("epoch-" + UUID.randomUUID() + "@test.local", "hash",
                UserRole.USER, "Epoch"));
    }

    private int tokenVersion(UUID userId) {
        return userRepository.findById(userId).orElseThrow().getTokenVersion();
    }

    private UUID roleId(String name) {
        List<AccessRole> roles = List.of(accessRoleRepository.findByName(name).orElseThrow());
        return roles.get(0).getId();
    }
}
