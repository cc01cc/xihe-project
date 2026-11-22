package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.BindingAdminService;
import com.cc01cc.p.xihe.cp.policy.GrantabilityGuard;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.RoleAdminViews;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.service.InstanceOwnershipService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * D-1912 / task-725: the first registration on a fresh instance becomes the instance administrator,
 * the second one does not, and the existing binding surface keeps the "at least one administrator"
 * invariant while allowing a transfer-then-revoke flow.
 *
 * <p>The H2 lane is sufficient for the capability projection: {@code AuthzContext} reads
 * {@code role_bindings} + {@code role_permissions}, both JPA tables. The binding surface is called
 * with {@link RequesterAuthority} and {@link GrantabilityGuard} replaced, because action atoms need
 * the org-unit tables that only the PostgreSQL lane has; the guard under test here is the last-admin
 * invariant in {@link BindingAdminService}, not the MANAGE_ROLES gate.</p>
 */
@TestPropertySource(properties = {
        "XIHE_WORKSPACE_DOCKER_BACKEND=disabled",
        "cp.bootstrap.seed-admin=false"
})
class FirstAccountAdminBootstrapIntegrationTest extends AbstractH2Test {

    private static final String PASSWORD = "first-account-pass";

    @MockitoBean
    private RequesterAuthority requesterAuthority;

    @MockitoBean
    private GrantabilityGuard grantabilityGuard;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private InstanceOwnershipService instanceOwnershipService;

    @Autowired
    private BindingAdminService bindingAdminService;

    @Autowired
    private UserRepository users;

    @Autowired
    private AccessRoleBindingRepository bindings;

    @Autowired
    private AuthorizationGrantRepository grants;

    @Autowired
    private AuditLogRepository audits;

    @Autowired
    private InstanceOwnerRepository owners;

    @AfterEach
    void cleanFixtures() {
        bindings.deleteAll();
        grants.deleteAll();
        audits.deleteAll();
        owners.deleteAll();
        users.deleteAll();
    }

    @Test
    void firstRegisteredAccountBecomesInstanceAdministratorWithAudit() {
        UUID first = register("first-admin@test.com");

        assertTrue(authzContext.capabilitiesFor(first).isInstanceAdmin(),
                "the first account must hold cap:instance:admin");
        assertTrue(authzContext.capabilitiesFor(first).isInstanceSuper(),
                "D-1912 reuses the seed-admin grant core, so the first account is SUPER_ADMIN");
        assertEquals(first, instanceOwnershipService.current().ownerUserId(),
                "provider-connection seeding needs the instance_owner pointer to be set");
        assertTrue(instanceBindings(first).stream()
                        .anyMatch(binding -> SystemAccessRoleCatalog.SUPER_ADMIN_ID
                                .equals(binding.getRoleId())),
                "the capability comes from a role binding, not a users.role column");

        List<AuditLog> auditRows = audits.findByUserIdOrderByCreatedAtDesc(first.toString());
        assertTrue(auditRows.stream().anyMatch(row ->
                        GrantDefaultService.AUDIT_INSTANCE_ADMIN_BOOTSTRAPPED
                                .equals(row.getAction())
                                && row.getDetails() != null
                                && row.getDetails().contains("first_registration")),
                "the bootstrap must leave an instance_admin_bootstrapped row with its source");
    }

    @Test
    void secondRegisteredAccountDoesNotInheritTheAdministratorCapability() {
        UUID first = register("first-admin@test.com");
        UUID second = register("second-user@test.com");

        assertTrue(authzContext.capabilitiesFor(first).isInstanceAdmin());
        assertFalse(authzContext.capabilitiesFor(second).isInstanceAdmin(),
                "only the first account is bootstrapped; later registrations stay USER");
        assertFalse(authzContext.capabilitiesFor(second).isInstanceSuper());
        assertTrue(instanceBindings(second).stream()
                        .anyMatch(binding -> SystemAccessRoleCatalog.USER_ID
                                .equals(binding.getRoleId())),
                "the second account still gets its normal USER tier");
    }

    @Test
    void removingTheLastInstanceAdministratorIsRefused() {
        UUID first = register("first-admin@test.com");

        CpApiException denied = assertThrows(CpApiException.class,
                () -> replaceInstanceBindings(List.of(
                        new RoleAdminViews.BindingInput(null, first,
                                SystemAccessRoleCatalog.USER_ID))));

        assertEquals(HttpStatus.CONFLICT, denied.getStatus());
        assertEquals("LAST_SUPER_ADMIN", denied.getCode());
        assertTrue(instanceBindings(first).stream()
                        .anyMatch(binding -> SystemAccessRoleCatalog.SUPER_ADMIN_ID
                                .equals(binding.getRoleId())),
                "the refused replacement must roll back and keep the administrator binding");
    }

    @Test
    void transferThenRevokeTheOriginalAdministratorSucceeds() {
        UUID first = register("first-admin@test.com");
        UUID second = register("second-user@test.com");

        replaceInstanceBindings(List.of(
                new RoleAdminViews.BindingInput(null, first, SystemAccessRoleCatalog.ADMIN_ID),
                new RoleAdminViews.BindingInput(null, second, SystemAccessRoleCatalog.USER_ID),
                new RoleAdminViews.BindingInput(null, second,
                        SystemAccessRoleCatalog.SUPER_ADMIN_ID)));
        assertTrue(authzContext.capabilitiesFor(first).isInstanceAdmin(),
                "the original administrator is kept on ADMIN during the handover");
        assertTrue(authzContext.capabilitiesFor(second).isInstanceAdmin(),
                "the delegated account now holds cap:instance:admin");

        replaceInstanceBindings(List.of(
                new RoleAdminViews.BindingInput(null, first, SystemAccessRoleCatalog.USER_ID),
                new RoleAdminViews.BindingInput(null, second, SystemAccessRoleCatalog.USER_ID),
                new RoleAdminViews.BindingInput(null, second,
                        SystemAccessRoleCatalog.SUPER_ADMIN_ID)));

        assertFalse(authzContext.capabilitiesFor(first).isInstanceAdmin(),
                "after the transfer the original administrator can be revoked");
        assertTrue(authzContext.capabilitiesFor(second).isInstanceSuper(),
                "the new administrator remains, so the invariant still holds");
    }

    private UUID register(String email) {
        ResponseEntity<Map> response = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", email, "password", PASSWORD, "name", email.split("@")[0]),
                Map.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> body = response.getBody();
        Map<?, ?> user = (Map<?, ?>) body.get("user");
        return UUID.fromString(user.get("id").toString());
    }

    private List<AccessRoleBinding> instanceBindings(UUID userId) {
        return bindings.findBySubjectTypeAndSubjectIdAndScopeType(
                AuthzContext.SUBJECT_USER, userId, "instance");
    }

    private void replaceInstanceBindings(List<RoleAdminViews.BindingInput> desired) {
        bindingAdminService.replace("instance", null, desired);
    }
}
