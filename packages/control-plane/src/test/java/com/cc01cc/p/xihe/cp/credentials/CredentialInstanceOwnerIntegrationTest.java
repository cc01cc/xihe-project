package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.CredentialAdminService;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-166 / D-1007 + D-1009: the three read paths that must distinguish the INSTANCE owner from
 * USER and WORKSPACE owners, plus the write-side pairing rule.
 *
 * <p>The point of these tests is the <b>negative</b> direction (PLAN-0771/verify.md anti-false-green
 * #2): a list that silently returns nothing, or a list that leaks an instance row into a user's
 * view, both look "green" if the assertion is only "not null / non-empty". Every assertion here
 * names the exact expected id set, so a wrong path fails instead of passing vacuously.
 */
class CredentialInstanceOwnerIntegrationTest extends AbstractReusableIntegrationTest {

    @Autowired private CredentialService credentialService;
    @Autowired private CredentialAdminService credentialAdminService;
    @Autowired private AuthService authService;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AuthzContext authzContext;
    @Autowired private AccessRoleRepository roleRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private CredentialRepository credentialRepository;

    private final List<UUID> credentialIds = new ArrayList<>();
    private final List<UUID> bindingIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        // The list assertions are exact-set assertions, so rows left by an earlier method would
        // break the next one: delete by id, never "delete every credential" (that would also delete
        // migration seeds and hide a real leak).
        credentialIds.forEach(id -> credentialRepository.findById(id)
                .ifPresent(row -> credentialRepository.deleteById(row.getId())));
        bindingIds.forEach(bindingRepository::deleteById);
        credentialIds.clear();
        bindingIds.clear();
    }

    @Test
    void userListNeverReturnsInstanceRowsAndCannotQueryTheInstanceScope() {
        User admin = registerUser("instance-admin");
        User plain = registerUser("plain-user");
        grantInstanceAdmin(admin.getId());

        UUID instanceCredentialId = seedInstanceCredential(admin.getId());
        UUID userCredentialId = seedUserCredential(plain.getId());

        List<String> listedForUser = credentialAdminService
                .list(plain.getId().toString(), "USER", plain.getId().toString())
                .stream().map(CredentialAdminService.CredentialSummary::id).toList();

        assertEquals(List.of(userCredentialId.toString()), listedForUser,
                "a USER-scoped list must return exactly the caller's own credential");
        assertEquals(1, listedForUser.size(),
                "count assertion as well as id assertion: a leaked instance row would make it 2");
        assertFalse(listedForUser.contains(instanceCredentialId.toString()),
                "the INSTANCE row must never appear in a user's own credential list");

        CpApiException refused = assertThrows(CpApiException.class,
                () -> credentialAdminService.list(plain.getId().toString(), "INSTANCE", null));
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus(),
                "a non-admin must not be able to address the INSTANCE scope at all");
    }

    @Test
    void instanceAdminListReturnsTheInstanceRows() {
        User admin = registerUser("instance-admin-list");
        User plain = registerUser("plain-user-list");
        grantInstanceAdmin(admin.getId());

        UUID instanceCredentialId = seedInstanceCredential(admin.getId());
        UUID userCredentialId = seedUserCredential(plain.getId());

        List<String> listedForAdmin = credentialAdminService
                .list(admin.getId().toString(), "INSTANCE", null)
                .stream().map(CredentialAdminService.CredentialSummary::id).toList();

        assertEquals(List.of(instanceCredentialId.toString()), listedForAdmin,
                "the instance admin must see exactly the instance-owned rows");
        assertFalse(listedForAdmin.contains(userCredentialId.toString()),
                "instance scope must not widen into other users' credentials");
    }

    @Test
    void workspaceListDoesNotLeakIntoTheInstanceRows() {
        User admin = registerUser("instance-admin-ws");
        User owner = registerUser("workspace-owner");
        grantInstanceAdmin(admin.getId());
        UUID workspaceId = UUID.fromString(workspaceFixture
                .createOwnedWorkspace("instance-owner-fixture", owner.getId().toString())
                .getId().toString());

        UUID instanceCredentialId = seedInstanceCredential(admin.getId());
        UUID workspaceCredentialId = seedCredential(Credential.OWNER_WORKSPACE,
                workspaceId.toString(), admin.getId(), "workspace-cred");

        List<String> listedForWorkspace = credentialAdminService
                .list(owner.getId().toString(), "WORKSPACE", workspaceId.toString())
                .stream().map(CredentialAdminService.CredentialSummary::id).toList();

        assertEquals(List.of(workspaceCredentialId.toString()), listedForWorkspace,
                "a workspace-scoped list must return exactly that workspace's credentials");
        assertFalse(listedForWorkspace.contains(instanceCredentialId.toString()),
                "the instance row must not be reachable through a workspace scope");
    }

    @Test
    void anInstanceRowCanNeitherCarryAnOwnerIdNorLoseItOnAnotherType() {
        User admin = registerUser("instance-admin-shape");
        grantInstanceAdmin(admin.getId());

        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> credentialService.create(new CredentialService.CreateRequest(
                        Credential.OWNER_INSTANCE, admin.getId().toString(), "bad-instance",
                        Credential.KIND_TOKEN, Credential.TIER_LEASE,
                        new CredentialService.SecretPayload("s3cret", null, null)),
                        admin.getId().toString()));
        assertTrue(refused.getMessage().contains("ownerId"),
                "creating an INSTANCE credential with an ownerId must be refused by name, not dropped");

        UUID instanceCredentialId = seedInstanceCredential(admin.getId());
        Credential row = credentialRepository.findById(instanceCredentialId).orElseThrow();
        assertEquals(null, row.getOwnerId(), "the stored INSTANCE row carries no owner id");

        // The database, not just the service, is the last line of defence: a row written around the
        // service still cannot make INSTANCE and owner_id both non-null.
        row.setOwnerId(UUID.randomUUID().toString());
        assertThrows(DataIntegrityViolationException.class,
                () -> credentialRepository.saveAndFlush(row),
                "ck_credentials_owner_pairing must reject INSTANCE + owner_id");
    }

    // --- fixtures ---------------------------------------------------------------------------

    private User registerUser(String prefix) {
        return authService.registerUser(new RegisterRequest(
                prefix + "-" + UUID.randomUUID() + "@test.com", "instance-owner-password",
                "Instance Owner Test"));
    }

    private void grantInstanceAdmin(UUID userId) {
        AccessRole adminRole = roleRepository.findByName(SystemAccessRoleCatalog.ADMIN).orElseThrow();
        AccessRoleBinding binding = new AccessRoleBinding(adminRole.getId(),
                AuthzContext.SUBJECT_USER, userId, AccessScope.INSTANCE, null, userId);
        bindingRepository.saveAndFlush(binding);
        bindingIds.add(binding.getId());
        authzContext.invalidate(userId);
        assertTrue(authzContext.isInstanceAdmin(userId),
                "fixture must really hold instance:admin, otherwise the positive case proves nothing");
    }

    private UUID seedInstanceCredential(UUID actorId) {
        return seedCredential(Credential.OWNER_INSTANCE, null, actorId, "instance-cred");
    }

    private UUID seedUserCredential(UUID ownerId) {
        return seedCredential(Credential.OWNER_USER, ownerId.toString(), ownerId, "user-cred");
    }

    private UUID seedCredential(String ownerType, String ownerId, UUID actorId, String label) {
        Credential created = credentialService.create(new CredentialService.CreateRequest(
                ownerType, ownerId, label, Credential.KIND_TOKEN, Credential.TIER_LEASE,
                new CredentialService.SecretPayload("s3cret", null, null)), actorId.toString());
        credentialIds.add(created.getId());
        return created.getId();
    }
}
