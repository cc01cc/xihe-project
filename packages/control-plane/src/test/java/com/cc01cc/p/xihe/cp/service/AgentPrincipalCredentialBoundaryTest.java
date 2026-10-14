package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0496 M1 (T1.2): the credential naming rule at the two write boundaries —
 * principal minting reports uncovered credential atoms explicitly (422 listing the
 * ids) while other atoms keep silent narrowing; the workspace cap uses the same
 * rule ({@code credential:*} ceiling covers any id, exact ids are equal-only, 403).
 */
class AgentPrincipalCredentialBoundaryTest extends AbstractIntegrationTest {

    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AuthService authService;
    @Autowired private WorkspaceService workspaceService;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private ObjectMapper objectMapper;

    private UUID creatorId;
    private String workspaceId;
    private final List<UUID> principalIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        principalIds.forEach(principalId -> {
            workspaceAgentRepository.deleteAll(workspaceAgentRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        });
        if (creatorId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.USER, creatorId));
            auditLogRepository.deleteAll(
                    auditLogRepository.findByUserIdOrderByCreatedAtDesc(creatorId.toString()));
            if (workspaceId != null) {
                UUID workspaceUuid = UUID.fromString(workspaceId);
                workspaceUserRepository.deleteAll(
                        workspaceUserRepository.findByIdWorkspaceId(workspaceUuid));
                workspaceRepository.deleteById(workspaceUuid);
            }
            userRepository.deleteById(creatorId);
        }
    }

    @Test
    void creationRejectsUncoveredCredentialAtomsWith422ListingTheIds() {
        registerCreator();
        String credentialId = "credential:" + UUID.randomUUID();

        CpApiException error = assertThrows(CpApiException.class, () ->
                agentPrincipalService.createPrincipal(creatorId.toString(), "uncovered-agent", null,
                        snapshot("""
                                [{"actionClass":"read"},
                                 {"actionClass":"credential_use","resource":"%s"}]
                                """.formatted(credentialId))));

        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, error.getStatus());
        assertEquals("CREDENTIAL_ATOMS_NOT_COVERED", error.getCode());
        assertTrue(error.getMessage().contains(credentialId),
                "the 422 detail must list the uncovered ids: " + error.getMessage());
    }

    @Test
    void creationKeepsCoveredCredentialAtomsWhenTheCreatorHoldsTheWildcard() {
        registerCreator();
        grantCreator("""
                [{"actionClass":"credential_use","resource":"credential:*"}]
                """);
        String credentialId = "credential:" + UUID.randomUUID();

        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                creatorId.toString(), "covered-agent", null,
                snapshot("""
                        [{"actionClass":"read"},
                         {"actionClass":"credential_use","resource":"%s"}]
                        """.formatted(credentialId)));
        principalIds.add(principal.getId());

        JsonNode permissions = principalGrant(principal.getId());
        assertEquals(2, permissions.size(),
                "the covered credential atom must survive minting (naming rule): " + permissions);
        boolean carriesCredential = false;
        for (JsonNode atom : permissions) {
            if ("credential_use".equals(atom.get("actionClass").asText())) {
                carriesCredential = credentialId.equals(atom.get("resource").asText());
            }
        }
        assertTrue(carriesCredential, "the concrete credential atom is preserved: " + permissions);
    }

    @Test
    void nonCredentialAtomsStillNarrowSilently() {
        registerCreator();

        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                creatorId.toString(), "narrowed-agent", null,
                snapshot("""
                        [{"actionClass":"read"},{"actionClass":"SPAWN_AGENT"}]
                        """));
        principalIds.add(principal.getId());

        JsonNode permissions = principalGrant(principal.getId());
        assertEquals(1, permissions.size(),
                "SPAWN_AGENT is outside the creator's set and is narrowed silently (0496 #9): "
                        + permissions);
        assertEquals("read", permissions.get(0).get("actionClass").asText());
    }

    @Test
    void workspaceCapUsesTheCredentialNamingRule() {
        registerCreator();
        grantCreator("""
                [{"actionClass":"MANAGE_WORKSPACE_AGENTS"}]
                """);
        grantCreator("""
                [{"actionClass":"credential_use","resource":"credential:*"}]
                """);
        String credentialId = "credential:" + UUID.randomUUID();
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                creatorId.toString(), "cap-agent", null,
                snapshot("""
                        [{"actionClass":"credential_use","resource":"%s"}]
                        """.formatted(credentialId)));
        principalIds.add(principal.getId());
        UUID workspaceUuid = UUID.fromString(workspaceId);

        // A concrete cap under a wildcard ceiling is allowed by the naming rule.
        agentPrincipalService.setWorkspaceCap(creatorId.toString(), workspaceUuid, principal.getId(),
                permissions("""
                        [{"actionClass":"credential_use","resource":"%s"}]
                        """.formatted(credentialId)));

        // A wildcard cap over a concrete principal atom exceeds the ceiling (403).
        CpApiException error = assertThrows(CpApiException.class, () ->
                agentPrincipalService.setWorkspaceCap(creatorId.toString(), workspaceUuid,
                        principal.getId(), permissions("""
                                [{"actionClass":"credential_use","resource":"credential:*"}]
                                """)));
        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
        assertEquals("AGENT_PERMISSION_SCOPE_EXCEEDED", error.getCode());
    }

    private void registerCreator() {
        User user = authService.registerUser(new RegisterRequest(
                "cred-boundary-" + UUID.randomUUID() + "@test.com",
                "boundary-test-password", "Boundary Test"));
        AuthResponse registered = authService.issueTokens(user, workspaceService
                .getOrCreateDefaultWorkspace(user.getId().toString()).getId().toString());
        creatorId = user.getId();
        workspaceId = registered.getWorkspaceId();
    }

    /** V64: a subject owns a single direct grant row — successive grants merge into it. */
    private void grantCreator(String permissionsJson) {
        AuthorizationGrant direct = grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.USER, creatorId).stream()
                .filter(grant -> "direct".equals(grant.getSource()))
                .findFirst()
                .orElse(null);
        JsonNode newAtoms = permissions(permissionsJson);
        if (direct == null) {
            direct = new AuthorizationGrant();
            direct.setId(UUID.randomUUID());
            direct.setSubjectType("user");
            direct.setSubjectId(creatorId);
            direct.setGranterType("user");
            direct.setGranterId(creatorId);
            direct.setSource("direct");
            direct.setPermissions(newAtoms);
            grantRepository.save(direct);
            return;
        }
        com.fasterxml.jackson.databind.node.ArrayNode merged = objectMapper.createArrayNode();
        direct.getPermissions().forEach(merged::add);
        newAtoms.forEach(merged::add);
        direct.setPermissions(merged);
        grantRepository.save(direct);
    }

    private JsonNode principalGrant(UUID principalId) {
        return grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId).stream()
                .findFirst()
                .orElseThrow(() -> new AssertionError("no grant for principal " + principalId))
                .getPermissions();
    }

    private JsonNode snapshot(String permissionsJson) {
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("systemPrompt", "boundary-agent-prompt");
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
