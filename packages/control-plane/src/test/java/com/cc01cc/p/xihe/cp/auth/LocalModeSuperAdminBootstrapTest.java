package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserStatus;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.InstanceOwnershipService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0610 W1c: the two bootstrap/seed defects found by the implementation audit.
 *
 * <ul>
 *   <li><b>P0-2</b> — an empty instance bootstrapped through local mode ended with no
 *       {@code SUPER_ADMIN} at all: {@code AuthService.registerUser} maps the legacy tier
 *       {@code ADMIN}/{@code USER} only, and the one {@code ensureInstanceSuperAdmin} call site was
 *       {@code DataSeeder}, which returns early when local mode is on. Invariants I1 ("at least one
 *       usable SUPER_ADMIN") and I5 ("the instance owner MUST hold SUPER_ADMIN") were both false on
 *       the first local instance, and W3's {@code LAST_SUPER_ADMIN} guard had no subject.</li>
 *   <li><b>P1-3</b> — the seeder re-promoted the bootstrap account on every restart: it only asked
 *       "does <em>this</em> account hold SUPER_ADMIN", never "does the instance still have a usable
 *       super administrator" and never "is this account still usable". So an operator's deliberate
 *       downgrade or disable was undone by the next boot, and a transferred owner kept a permanent
 *       second super administrator.</li>
 * </ul>
 *
 * <p>Both tests run on the real HTTP chain (H2) and assert the <em>end state</em> — owner pointer,
 * binding rows, materialized atoms and the resolved {@code cap:instance:super} — because the failing
 * side was "each piece looks right, the combination does not".</p>
 */
class LocalModeSuperAdminBootstrapTest extends AbstractH2Test {

    private static final String LOCAL_MODE_KEY = "XIHE_LOCAL_MODE";

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private InstanceOwnerRepository instanceOwnerRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private InstanceOwnershipService instanceOwnershipService;
    @Autowired private GrantDefaultService grantDefaultService;
    @Autowired private AuthzContext authzContext;

    @AfterEach
    void clearLocalMode() {
        System.clearProperty(LOCAL_MODE_KEY);
    }

    // ------------------------------------------------------------------ P0-2

    @Test
    void localModeFirstRegistrationEndsWithSuperAdminOwner() {
        clearInstance();
        System.setProperty(LOCAL_MODE_KEY, "true");

        ResponseEntity<Map> response = register("first-local@test.local", "pw-12345678");
        assertEquals(HttpStatus.CREATED, response.getStatusCode(),
                "a fresh instance in local mode must still be able to create its first account");

        User user = userRepository.findByEmail("first-local@test.local").orElseThrow();
        assertTrue(instanceOwnershipService.isCurrentOwner(user.getId().toString()),
                "the first local account becomes the instance owner (I5 subject)");
        assertTrue(authzContext.isInstanceSuper(user.getId()),
                "I1/I5: the first local account holds cap:instance:super");
        assertTrue(authzContext.isInstanceAdmin(user.getId()),
                "instance:super implies instance:admin through the capability pipeline");
        assertEquals(SystemAccessRoleCatalog.SUPER_ADMIN, instanceTierRoleName(user.getId()),
                "the instance tier binding is SUPER_ADMIN, not the legacy ADMIN tier");
        assertEquals(PermissionAtomCatalog.actionAtoms().size(),
                grantRepository.findScopedGrants("user", user.getId(),
                        GrantSources.EVALUATION_SOURCES, null).size(),
                "SUPER_ADMIN materializes all 15 action atoms at instance scope");
    }

    // ------------------------------------------------------------------ P1-3

    @Test
    void restartDoesNotResurrectSuperAdminWhileAnotherActiveHolderExists() {
        clearSuperAdminHolders();
        User admin = freshAdmin("downgraded@test.local");
        makeOwner(admin);
        grantDefaultService.ensureInstanceSuperAdmin(admin);
        assertTrue(authzContext.isInstanceSuper(admin.getId()), "precondition: it was SUPER_ADMIN");

        downgradeTo(admin, SystemAccessRoleCatalog.ADMIN);
        User otherHolder = freshAdmin("other-super@test.local");
        bindingRepository.save(new AccessRoleBinding(superAdminRoleId(), "user", otherHolder.getId(),
                AccessScope.INSTANCE, null, otherHolder.getId()));
        authzContext.invalidate(admin.getId());

        // This is exactly what DataSeeder does on every boot.
        grantDefaultService.ensureInstanceSuperAdmin(admin);

        assertEquals(SystemAccessRoleCatalog.ADMIN, instanceTierRoleName(admin.getId()),
                "the operator's downgrade must survive a restart (round-3 P1-3)");
        assertFalse(authzContext.isInstanceSuper(admin.getId()),
                "the downgraded account must not resolve cap:instance:super after the seed pass");
        assertTrue(authzContext.isInstanceSuper(otherHolder.getId()),
                "the instance still has its usable super administrator (I1 unaffected)");
    }

    @Test
    void disabledAccountIsNeverSeededSuperAdmin() {
        clearSuperAdminHolders();
        User admin = freshAdmin("disabled-owner@test.local");
        makeOwner(admin);
        downgradeTo(admin, SystemAccessRoleCatalog.ADMIN);
        admin.setStatus(UserStatus.DISABLED);
        userRepository.save(admin);
        authzContext.invalidate(admin.getId());

        grantDefaultService.ensureInstanceSuperAdmin(admin);

        assertEquals(SystemAccessRoleCatalog.ADMIN, instanceTierRoleName(admin.getId()),
                "a DISABLED account does not receive a fresh SUPER_ADMIN binding (P1-3)");
        assertFalse(authzContext.isInstanceSuper(admin.getId()),
                "a disabled account cannot hold a privilege it could never use");
    }

    @Test
    void idempotentReseedKeepsExistingSuperAdmin() {
        clearSuperAdminHolders();
        User admin = freshAdmin("idempotent@test.local");
        makeOwner(admin);
        grantDefaultService.ensureInstanceSuperAdmin(admin);
        int bindingsAfterFirst = instanceTierBindings(admin.getId()).size();
        assertTrue(authzContext.isInstanceSuper(admin.getId()));

        grantDefaultService.ensureInstanceSuperAdmin(admin);
        grantDefaultService.ensureInstanceSuperAdmin(admin);

        assertEquals(bindingsAfterFirst, instanceTierBindings(admin.getId()).size(),
                "repeated bootstrap passes never accumulate tier bindings");
        assertEquals(SystemAccessRoleCatalog.SUPER_ADMIN, instanceTierRoleName(admin.getId()));
        assertTrue(authzContext.isInstanceSuper(admin.getId()));
    }

    // ---------------------------------------------------------------- helpers

    private ResponseEntity<Map> register(String email, String password) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.postForEntity(url("/api/v1/auth/register"),
                new HttpEntity<>(Map.of("email", email, "password", password, "name", "Local First"),
                        headers), Map.class);
    }

    /** A plain ADMIN account with no instance tier binding yet (the seeder's precondition). */
    private User freshAdmin(String email) {
        return userRepository.save(new User(email, "hash", "Bootstrap " + email));
    }

    /** Points the single-owner row at {@code user} so the bootstrap guard sees a real owner. */
    private void makeOwner(User user) {
        com.cc01cc.p.xihe.cp.entity.InstanceOwner owner = instanceOwnerRepository
                .findById(com.cc01cc.p.xihe.cp.entity.InstanceOwner.SINGLETON_ID)
                .orElseGet(com.cc01cc.p.xihe.cp.entity.InstanceOwner::new);
        owner.assignTo(user.getId(), null);
        instanceOwnerRepository.save(owner);
    }

    /** Removes every SUPER_ADMIN instance binding so a test starts from "no super administrator". */
    private void clearSuperAdminHolders() {
        bindingRepository.deleteAll(bindingRepository.findByRoleId(superAdminRoleId()));
    }

    private List<AccessRoleBinding> instanceTierBindings(UUID userId) {
        return bindingRepository.findBySubjectTypeAndSubjectIdAndScopeType("user", userId,
                AccessScope.INSTANCE);
    }

    /** Replaces every instance tier binding of one user with {@code roleName}. */
    private void downgradeTo(User user, String roleName) {
        bindingRepository.deleteAll(instanceTierBindings(user.getId()));
        bindingRepository.save(new AccessRoleBinding(roleId(roleName), "user", user.getId(),
                AccessScope.INSTANCE, null, user.getId()));
    }

    private String instanceTierRoleName(UUID userId) {
        return instanceTierBindings(userId).stream()
                .map(binding -> accessRoleRepository.findById(binding.getRoleId())
                        .map(AccessRole::getName).orElse("?"))
                .findFirst()
                .orElse("none");
    }

    private UUID superAdminRoleId() {
        return roleId(SystemAccessRoleCatalog.SUPER_ADMIN);
    }

    private UUID roleId(String name) {
        assertNotNull(accessRoleRepository.findByName(name).orElse(null),
                "system role " + name + " must be seeded");
        return accessRoleRepository.findByName(name).orElseThrow().getId();
    }

    /** Simulates a brand-new instance: no accounts, no bindings, no owner pointer. */
    private void clearInstance() {
        bindingRepository.deleteAll();
        grantRepository.deleteAll();
        auditLogRepository.deleteAll();
        instanceOwnerRepository.deleteAll();
        workspaceFixture.unbindAllWorkspaces();
        workspaceRepository.deleteAll();
        userRepository.deleteAll();
        assertTrue(userRepository.count() == 0L, "precondition: an empty instance");
    }
}
