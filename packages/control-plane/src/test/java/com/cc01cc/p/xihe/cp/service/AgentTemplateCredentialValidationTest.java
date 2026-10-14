package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.credentials.CredentialService;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0496 M3 (T3.2; contract: 0496 §方案 7): agent-template save validation for the
 * credential namespace — canonical resource format (schema + semantics), reference
 * existence via 0495 {@code existsForOwner} (dangling rejected) and the per-role
 * atom cap; explicit error responses.
 */
class AgentTemplateCredentialValidationTest extends AbstractIntegrationTest {

    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private CredentialService credentialService;
    @Autowired private AuthService authService;
    @Autowired private WorkspaceService workspaceService;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private CredentialRepository credentialRepository;
    @Autowired private ConfigJpaRepository configJpaRepository;
    @Autowired private ConfigAuditRepository configAuditRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;

    private UUID writerId;
    private String workspaceId;
    private final List<UUID> credentialIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        credentialIds.forEach(credentialRepository::deleteById);
        if (writerId != null) {
            List<ConfigEntity> rows = configJpaRepository.findByUserIdAndDomain(writerId, "agent-templates");
            rows.forEach(row -> configAuditRepository.deleteAll(
                    configAuditRepository.findByConfigIdOrderByChangedAtDesc(row.getId().toString())));
            configJpaRepository.deleteAll(rows);
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", writerId));
            auditLogRepository.deleteAll(
                    auditLogRepository.findByUserIdOrderByCreatedAtDesc(writerId.toString()));
            if (workspaceId != null) {
                UUID workspaceUuid = UUID.fromString(workspaceId);
                workspaceUserRepository.deleteAll(
                        workspaceUserRepository.findByIdWorkspaceId(workspaceUuid));
                workspaceRepository.deleteById(workspaceUuid);
            }
            userRepository.deleteById(writerId);
        }
    }

    @Test
    void credentialAtomWithExistingReferenceIsAccepted() {
        registerWriter("credential:*");
        Credential credential = createCredential("role-target");

        int changed = putRoles(rolesJson(atom("credential_use", "credential:" + credential.getId())));

        assertTrue(changed > 0, "a canonical credential atom referencing an existing credential is accepted");
    }

    @Test
    void wildcardCredentialAtomIsAcceptedWhenTheWriterHoldsTheWildcard() {
        registerWriter("credential:*");

        int changed = putRoles(rolesJson(atom("credential_use", "credential:*")));

        assertTrue(changed > 0, "credential:* is a canonical form and covered by the writer's wildcard");
    }

    @Test
    void malformedCredentialResourceIsRejectedExplicitly() {
        registerWriter("credential:*");

        CpApiException error = assertThrows(CpApiException.class,
                () -> putRoles(rolesJson(atom("credential_use", "credential:ab*"))));

        assertEquals("AGENT_TEMPLATE_CONFIG_INVALID", error.getCode());
        assertTrue(error.getMessage().contains("invalid"),
                "the rejection must be explicit: " + error.getMessage());
    }

    @Test
    void unknownCredentialReferenceIsRejected() {
        registerWriter("credential:*");

        ConfigService.ConfigAccessException error = assertThrows(ConfigService.ConfigAccessException.class,
                () -> putRoles(rolesJson(atom("credential_use", "credential:" + UUID.randomUUID()))));

        assertTrue(error.getMessage().contains("does not exist"),
                "a dangling credential reference must be rejected explicitly: " + error.getMessage());
    }

    @Test
    void credentialAtomBeyondWriterGrantsIsRejected() {
        registerWriter("credential:" + UUID.randomUUID());
        Credential credential = createCredential("beyond-grants");

        ConfigService.ConfigAccessException error = assertThrows(ConfigService.ConfigAccessException.class,
                () -> putRoles(rolesJson(atom("credential_use", "credential:" + credential.getId()))));

        assertTrue(error.getMessage().contains("within the template writer's current grants"),
                error.getMessage());
    }

    @Test
    void roleCredentialAtomCapIsEnforced() {
        registerWriter("credential:*");
        StringBuilder atoms = new StringBuilder();
        for (int index = 0; index < 65; index++) {
            if (index > 0) {
                atoms.append(',');
            }
            atoms.append(atom("credential_use", "credential:" + UUID.randomUUID()));
        }

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> putRoles(rolesJson(atoms.toString())));

        assertTrue(error.getMessage().contains("at most 64"), error.getMessage());
    }

    private void registerWriter(String useResource) {
        User user = authService.registerUser(new RegisterRequest(
                "template-validation-" + UUID.randomUUID() + "@test.com",
                "template-test-password", "Template Validation"));
        AuthResponse registered = authService.issueTokens(user, workspaceService
                .getOrCreateDefaultWorkspace(user.getId().toString()).getId().toString());
        writerId = user.getId();
        workspaceId = registered.getWorkspaceId();

        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType("user");
        grant.setSubjectId(writerId);
        grant.setGranterType("user");
        grant.setGranterId(writerId);
        grant.setSource("direct");
        grant.setPermissions(parseJson("[{\"actionClass\":\"CREATE_TEMPLATE\"},"
                + "{\"actionClass\":\"credential_use\",\"resource\":\"" + useResource + "\"}]"));
        grantRepository.save(grant);
    }

    private Credential createCredential(String label) {
        Credential credential = credentialService.create(new CredentialService.CreateRequest(
                "USER", writerId.toString(), label, "token", "lease",
                CredentialService.SecretPayload.ofToken("template-secret-" + UUID.randomUUID())),
                writerId.toString());
        credentialIds.add(credential.getId());
        return credential;
    }

    private int putRoles(String rolesJson) {
        return agentTemplateService.putConfigLayer(writerId.toString(), "user", writerId, null,
                Map.of("roles", rolesJson));
    }

    private static String atom(String actionClass, String resource) {
        return "{\"actionClass\":\"" + actionClass + "\",\"resource\":\"" + resource + "\"}";
    }

    private static String rolesJson(String permissions) {
        return "[{\"id\":\"" + UUID.randomUUID() + "\",\"name\":\"role-under-test\","
                + "\"permissions\":[" + permissions + "]}]";
    }

    private com.fasterxml.jackson.databind.JsonNode parseJson(String json) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }
}
