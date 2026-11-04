package com.cc01cc.p.xihe.cp.policy;
import com.cc01cc.p.xihe.cp.chat.ChatBindingTestSupport;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.credentials.CredentialService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0496 M2 (T2.1/T2.2; contract: 0494 #12/#13 + 0496 §方案 5):
 * the credential-binding path — use atoms land on the principal credential_binding row and
 * the Workspace cap in one transaction under the credential_manage gate, the
 * operator ceiling and the existence check; unbind removes them; bindings apply to
 * new sessions only (existing snapshots stay frozen).
 */
class CredentialBindingServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired private CredentialBindingService credentialBindingService;
    @Autowired private CredentialService credentialService;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private SessionService sessionService;
    @Autowired private com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository providerConnections;
    @Autowired private AuthService authService;
    @Autowired private WorkspaceService workspaceService;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private CredentialRepository credentialRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private ObjectMapper objectMapper;

    private UUID creatorId;
    private String workspaceId;
    private final List<UUID> principalIds = new ArrayList<>();
    private final List<UUID> credentialIds = new ArrayList<>();
    private final List<UUID> sessionIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        sessionIds.forEach(sessionRepository::deleteById);
        principalIds.forEach(principalId -> {
            workspaceAgentRepository.deleteAll(workspaceAgentRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        });
        credentialIds.forEach(credentialRepository::deleteById);
        if (creatorId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.USER, creatorId));
            auditLogRepository.deleteAll(
                    auditLogRepository.findByUserIdOrderByCreatedAtDesc(creatorId.toString()));
            if (workspaceId != null) {
                UUID workspaceUuid = UUID.fromString(workspaceId);
                workspaceFixture.unbindWorkspace(workspaceUuid);
                workspaceRepository.deleteById(workspaceUuid);
            }
            userRepository.deleteById(creatorId);
        }
    }

    @Test
    void bindAddsUseAtomToPrincipalGrantAndCapWithAudit() {
        Fixture fixture = fixture("credential:*", "credential:*", true);

        credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                fixture.principalId, List.of(fixture.credentialResource));

        assertTrue(principalCredentialBindingContains(fixture.principalId, fixture.credentialResource),
                "the principal credential_binding row must carry credential_use@<id>");
        assertTrue(capContains(fixture.workspaceId, fixture.principalId, fixture.credentialResource),
                "the Workspace cap must be synchronized in the same transaction");
        assertTrue(auditContains("credential_binding_added"),
                "the binding must be audited as credential_binding_added");
    }

    @Test
    void bindRejectsWhenOperatorLacksManageForTheCredential() {
        // REFACTOR-GUARD(null-workspace): this denial comes from
        // CredentialBindingService#requireCredentialManage, which evaluates a PolicyRequest with a
        // null workspace through evaluator.allows(...) directly (no UUID parsing) and throws 403
        // FORBIDDEN. ASSERT THE EXACT STATUS — if that method is ever refactored onto
        // GrantAuthorizationService#allowsUserOnly, the null workspace reaches UUID.fromString and
        // the call becomes a 500. (rg 'REFACTOR-GUARD' finds every such guard.)
        Fixture fixture = fixture("credential:" + UUID.randomUUID(), "credential:*", true);
        Credential second = createCredential("second");
        String secondResource = "credential:" + second.getId();

        CpApiException error = assertThrows(CpApiException.class, () ->
                credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                        fixture.principalId, List.of(secondResource)));
        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
    }

    @Test
    void bindRejectsWhenOperatorDoesNotHoldTheNewUseAtom() {
        Fixture fixture = fixture("credential:*", "credential:" + UUID.randomUUID(), true);
        Credential second = createCredential("second");
        String secondResource = "credential:" + second.getId();

        CpApiException error = assertThrows(CpApiException.class, () ->
                credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                        fixture.principalId, List.of(secondResource)));
        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
        assertEquals("CREDENTIAL_ATOMS_NOT_OWNED_BY_OPERATOR", error.getCode());
    }

    @Test
    void bindRejectsMissingCredentialAndMissingBinding() {
        Fixture fixture = fixture("credential:*", "credential:*", true);

        CpApiException missingCredential = assertThrows(CpApiException.class, () ->
                credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                        fixture.principalId, List.of("credential:" + UUID.randomUUID())));
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, missingCredential.getStatus());
        assertEquals("CREDENTIAL_NOT_FOUND", missingCredential.getCode());

        AgentPrincipal unbound = agentPrincipalService.createPrincipal(
                creatorId.toString(), "unboundAgent", null, snapshot("[{\"actionClass\":\"read\"}]"));
        principalIds.add(unbound.getId());
        CpApiException missingBinding = assertThrows(CpApiException.class, () ->
                credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                        unbound.getId(), List.of(fixture.credentialResource)));
        assertEquals(HttpStatus.NOT_FOUND, missingBinding.getStatus());
        assertEquals("AGENT_BINDING_NOT_FOUND", missingBinding.getCode());
    }

    @Test
    void bindIsAllOrNothingWhenOneResourceFailsValidation() {
        Fixture fixture = fixture("credential:*", "credential:*", true);
        Credential second = createCredential("second");
        String secondResource = "credential:" + second.getId();

        // second credential has no manage grant for a different operator scope:
        // revoke by replacing the creator's manage grant with an exact one
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.USER, creatorId));
        grantCreator("[{\"actionClass\":\"MANAGE_WORKSPACE_AGENTS\"},"
                + "{\"actionClass\":\"credential_manage\",\"resource\":\"" + fixture.credentialResource + "\"},"
                + "{\"actionClass\":\"credential_use\",\"resource\":\"credential:*\"}]");

        assertThrows(CpApiException.class, () -> credentialBindingService.bindCredentialAtoms(
                creatorId.toString(), fixture.workspaceId, fixture.principalId,
                List.of(fixture.credentialResource, secondResource)));

        assertFalse(principalCredentialBindingContains(fixture.principalId, fixture.credentialResource),
                "a failed batch must not write any atom (all-or-nothing)");
        assertFalse(capContains(fixture.workspaceId, fixture.principalId, fixture.credentialResource));
    }

    @Test
    void unbindRemovesUseAtomFromPrincipalGrantAndCapWithAudit() {
        Fixture fixture = fixture("credential:*", "credential:*", true);
        credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                fixture.principalId, List.of(fixture.credentialResource));

        credentialBindingService.unbindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                fixture.principalId, List.of(fixture.credentialResource));

        assertFalse(principalCredentialBindingContains(fixture.principalId, fixture.credentialResource),
                "unbind removes the atom from the principal credential_binding row");
        assertFalse(capContains(fixture.workspaceId, fixture.principalId, fixture.credentialResource),
                "unbind removes the atom from the cap");
        assertTrue(auditContains("credential_binding_removed"));
    }

    @Test
    void bindingAppliesToNewSessionsOnly() {
        Fixture fixture = fixture("credential:*", "credential:*", true);
        // 2026-11-04 P0（task-24）：裸会话被禁止 —— 这两个 createAgentSession 必须带显式 provider 绑定。
        var chatConnection = ChatBindingTestSupport.ensureChatConnection(providerConnections, "USER",
                creatorId.toString(), "cb-int-" + UUID.randomUUID().toString().substring(0, 8));
        Session before = sessionService.createAgentSession(creatorId.toString(), workspaceId,
                "before-binding", chatConnection.getProviderId(), "gpt-test",
                chatConnection.getId().toString(), fixture.principalId.toString());
        sessionIds.add(before.getId());
        assertFalse(snapshotContains(before.getAgentPermissionsSnapshot(), fixture.credentialResource),
                "a session created before the binding must not carry the atom");

        credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                fixture.principalId, List.of(fixture.credentialResource));

        Session after = sessionService.createAgentSession(creatorId.toString(), workspaceId,
                "after-binding", chatConnection.getProviderId(), "gpt-test",
                chatConnection.getId().toString(), fixture.principalId.toString());
        sessionIds.add(after.getId());
        assertTrue(snapshotContains(after.getAgentPermissionsSnapshot(), fixture.credentialResource),
                "a new session picks up the binding (0494 #13)");

        Session reloaded = sessionRepository.findById(before.getId()).orElseThrow();
        assertFalse(snapshotContains(reloaded.getAgentPermissionsSnapshot(), fixture.credentialResource),
                "an existing session snapshot stays frozen");
    }

    @Test
    void unbindRemovesDanglingAtomsAfterTheCredentialIsDeleted() {
        Fixture fixture = fixture("credential:*", "credential:*", true);
        credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                fixture.principalId, List.of(fixture.credentialResource));
        UUID credentialId = UUID.fromString(
                fixture.credentialResource.substring("credential:".length()));
        credentialService.delete(credentialId, creatorId.toString());

        // Round-4: I4 fences the creation of new references only — removal must stay
        // possible so the delete report's dangling atoms can be cleaned through the API.
        credentialBindingService.unbindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                fixture.principalId, List.of(fixture.credentialResource));

        assertFalse(principalCredentialBindingContains(fixture.principalId, fixture.credentialResource),
                "unbind must clean a dangling atom after the credential is soft-deleted");
        assertFalse(capContains(fixture.workspaceId, fixture.principalId, fixture.credentialResource));
    }

    @Test
    void duplicateCredentialBindingRowIsRejectedByThePartialUniqueIndex() {
        Fixture fixture = fixture("credential:*", "credential:*", true);
        credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                fixture.principalId, List.of(fixture.credentialResource));

        AuthorizationGrant duplicate = new AuthorizationGrant();
        duplicate.setId(UUID.randomUUID());
        duplicate.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        duplicate.setSubjectId(fixture.principalId);
        duplicate.setGranterType("user");
        duplicate.setGranterId(creatorId);
        duplicate.setSource("credential_binding");
        duplicate.setPermissions(permissions(
                "[{\"actionClass\":\"credential_use\",\"resource\":\"" + fixture.credentialResource + "\"}]"));

        assertThrows(org.springframework.dao.DataIntegrityViolationException.class,
                () -> grantRepository.saveAndFlush(duplicate),
                "V87 successor of V65: a second credential_binding row per subject must be rejected");
    }

    @Test
    void batchUnbindIsAllOrNothing() {
        Fixture fixture = fixture("credential:*", "credential:*", true);
        credentialBindingService.bindCredentialAtoms(creatorId.toString(), fixture.workspaceId,
                fixture.principalId, List.of(fixture.credentialResource));
        AgentPrincipal unboundPeer = agentPrincipalService.createPrincipal(creatorId.toString(),
                "unboundPeer", null, snapshot("[{\"actionClass\":\"read\"}]"));
        principalIds.add(unboundPeer.getId());

        assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> credentialBindingService.unbindFromPrincipals(creatorId.toString(),
                        fixture.workspaceId,
                        List.of(fixture.principalId, unboundPeer.getId()),
                        List.of(fixture.credentialResource)),
                "the unbound peer must fail the batch");

        assertTrue(principalCredentialBindingContains(fixture.principalId, fixture.credentialResource),
                "the failed batch must roll back the first unbind (all-or-nothing)");
        assertTrue(capContains(fixture.workspaceId, fixture.principalId, fixture.credentialResource));
    }

    @Test
    void bindingRequiresWorkspaceMembership() {
        Fixture fixture = fixture("credential:*", "credential:*", true);
        // Temporarily remove the operator from the target workspace (B1 裁定 2026-10-13:
        // bindings align with setWorkspaceCap's membership precondition).
        workspaceFixture.unbindWorkspace(fixture.workspaceId);

        com.cc01cc.p.xihe.cp.config.CpApiException error = assertThrows(
                com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> credentialBindingService.bindCredentialAtoms(creatorId.toString(),
                        fixture.workspaceId, fixture.principalId,
                        List.of(fixture.credentialResource)));

        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, error.getStatus());
        assertTrue(error.getMessage().contains("membership"));
        assertFalse(principalCredentialBindingContains(fixture.principalId, fixture.credentialResource),
                "the rejected bind must not write anything");
    }

    private record Fixture(UUID workspaceId, UUID principalId, String credentialResource) {}

    private Fixture fixture(String manageResource, String useResource, boolean withCapBinding) {
        registerCreator();
        grantCreator("[{\"actionClass\":\"MANAGE_WORKSPACE_AGENTS\"},"
                + "{\"actionClass\":\"credential_manage\",\"resource\":\"" + manageResource + "\"},"
                + "{\"actionClass\":\"credential_use\",\"resource\":\"" + useResource + "\"}]");
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                creatorId.toString(), "bindingAgent", null, snapshot("[{\"actionClass\":\"read\"}]"));
        principalIds.add(principal.getId());
        UUID workspaceUuid = UUID.fromString(workspaceId);
        if (withCapBinding) {
            agentPrincipalService.setWorkspaceCap(creatorId.toString(), workspaceUuid, principal.getId(),
                    permissions("[]"));
        }
        Credential credential = createCredential("primary");
        return new Fixture(workspaceUuid, principal.getId(), "credential:" + credential.getId());
    }

    private Credential createCredential(String label) {
        Credential credential = credentialService.create(new CredentialService.CreateRequest(
                "USER", creatorId.toString(), label, "token", "lease",
                CredentialService.SecretPayload.ofToken("binding-secret-" + UUID.randomUUID())),
                creatorId.toString());
        credentialIds.add(credential.getId());
        return credential;
    }

    private void registerCreator() {
        User user = authService.registerUser(new RegisterRequest(
                "cred-binding-" + UUID.randomUUID() + "@test.com",
                "binding-test-password", "Binding Test"));
        AuthResponse registered = authService.issueTokens(user, workspaceFixture.createOwnedWorkspace("Fixture Workspace", user.getId().toString()).getId().toString());
        creatorId = user.getId();
        workspaceId = registered.getWorkspaceId();
    }

    /**
     * PLAN-0610: user grants are materialized {@code source='role'} rows and a materialized row
     * carries exactly one atom. The fixture therefore seeds one row per atom (idempotently) — a
     * multi-atom row would be treated as malformed and rewritten by the materializer, which collides
     * with {@code uq_grants_role_atom} when the delete and the insert land in one flush.
     */
    private void grantCreator(String permissionsJson) {
        JsonNode newAtoms = permissions(permissionsJson);
        for (JsonNode atom : newAtoms) {
            String actionClass = atom.path("actionClass").asText();
            String resource = atom.path("resource").asText("*");
            boolean exists = grantRepository.findBySubjectTypeAndSubjectId(
                            GrantPrincipalPathResolver.USER, creatorId).stream()
                    .filter(grant -> GrantSources.ROLE.equals(grant.getSource()))
                    .anyMatch(grant -> grant.getPermissions().size() == 1
                            && actionClass.equals(grant.getPermissions().get(0)
                                    .path("actionClass").asText())
                            && resource.equals(grant.getPermissions().get(0)
                                    .path("resource").asText("*")));
            if (exists) {
                continue;
            }
            AuthorizationGrant roleGrant = new AuthorizationGrant();
            roleGrant.setId(UUID.randomUUID());
            roleGrant.setSubjectType("user");
            roleGrant.setSubjectId(creatorId);
            roleGrant.setGranterType("user");
            roleGrant.setGranterId(creatorId);
            roleGrant.setSource(GrantSources.ROLE);
            roleGrant.setPermissions(objectMapper.createArrayNode().add(atom));
            grantRepository.save(roleGrant);
        }
    }

    private boolean principalCredentialBindingContains(UUID principalId, String resource) {
        return grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId).stream()
                .filter(grant -> GrantSources.CREDENTIAL_BINDING.equals(grant.getSource()))
                .anyMatch(grant -> snapshotContains(grant.getPermissions(), resource));
    }

    private boolean capContains(UUID workspaceUuid, UUID principalId, String resource) {
        return workspaceAgentRepository.findById(
                        new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(principalId, workspaceUuid))
                .map(binding -> snapshotContains(binding.getPermissionsSnapshot(), resource))
                .orElse(false);
    }

    private boolean auditContains(String action) {
        return auditLogRepository.findByUserIdOrderByCreatedAtDesc(creatorId.toString()).stream()
                .anyMatch(row -> action.equals(row.getAction()));
    }

    private static boolean snapshotContains(JsonNode permissions, String resource) {
        for (JsonNode atom : permissions) {
            if ("credential_use".equals(atom.get("actionClass").asText())
                    && resource.equals(atom.get("resource").asText())) {
                return true;
            }
        }
        return false;
    }

    private JsonNode snapshot(String permissionsJson) {
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("systemPrompt", "binding-agent-prompt");
        snapshot.set("permissions", permissions(permissionsJson));
        return snapshot;
    }

    private JsonNode permissions(String permissionsJson) {
        try {
            return objectMapper.readTree(permissionsJson);
        } catch (JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }
}
