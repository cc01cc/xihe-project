package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0496 V1 (round-4): credential evaluation across the three snapshot layers —
 * {@code {credential_use, credential:<id>}} must be rejected when any one of the
 * principal grant, the Workspace binding cap or the Session snapshot lacks the atom,
 * and pass when all three carry it. Spawn child caps come from the D-49 active-binding
 * gate ({@code resolveCapFor}), never from a now-dropped Session identity column.
 */
class CredentialThreeLayerAuthorizationTest extends AbstractReusableIntegrationTest {

    @Autowired private GrantAuthorizationService grantAuthorizationService;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private SessionService sessionService;
    @Autowired private AuthService authService;
    @Autowired private WorkspaceService workspaceService;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper objectMapper;

    private String userId;
    private UUID workspaceId;
    private UUID principalId;
    private final List<UUID> sessionIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        sessionIds.forEach(sessionRepository::deleteById);
        if (userId != null) {
            UUID userUuid = UUID.fromString(userId);
            for (AgentPrincipal principal : agentPrincipalRepository.findAll()) {
                boolean mine = userId.equals(principal.getCreatedByUserId())
                        || userUuid.equals(principal.getOwnerUserId());
                if (!mine) {
                    continue;
                }
                workspaceAgentRepository.deleteAll(
                        workspaceAgentRepository.findByIdPrincipalId(principal.getId()));
                grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principal.getId()));
                agentPrincipalRepository.deleteById(principal.getId());
            }
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.USER, userUuid));
            if (workspaceId != null) {
                workspaceAgentRepository.deleteAll(
                        workspaceAgentRepository.findByIdWorkspaceId(workspaceId));
                workspaceFixture.unbindWorkspace(workspaceId);
                workspaceRepository.deleteById(workspaceId);
            }
            userRepository.deleteById(userUuid);
        }
    }

    @Test
    void credentialRequestsRejectWhenAnyLayerLacksTheAtomAndPassWhenAllCarryIt() {
        String resource = "credential:" + UUID.randomUUID();
        ArrayNode credentialAtom = credentialAtom("credential_use", resource);
        Session session = registerWorkspacePrincipalAndSession(credentialAtom);
        PolicyRequest request = new PolicyRequest("probe", List.of("credential_use"),
                List.of(resource), ToolShape.STRUCTURED, userId, workspaceId.toString(),
                session.getId().toString());

        assertFalse(grantAuthorizationService.allows(request),
                "the Workspace binding cap layer must reject while the cap lacks the atom");

        agentPrincipalService.setWorkspaceCap(userId, workspaceId, principalId, credentialAtom);
        assertTrue(grantAuthorizationService.allows(request),
                "principal grant ∩ binding cap ∩ Session snapshot all carry the atom");

        session.setAgentPermissionsSnapshot(atomsOf("read"));
        sessionRepository.saveAndFlush(session);
        assertFalse(grantAuthorizationService.allows(request),
                "the Session snapshot layer must reject while it lacks the atom");

        session.setAgentPermissionsSnapshot(credentialAtom);
        sessionRepository.saveAndFlush(session);
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
        assertFalse(grantAuthorizationService.allows(request),
                "the principal grant layer must reject while it lacks the atom");
    }

    @Test
    void spawnChildCapGateRejectsPrincipalWithoutAnActiveWorkspaceBinding() {
        String resource = "credential:" + UUID.randomUUID();
        ArrayNode credentialAtom = credentialAtom("credential_use", resource);
        registerWorkspacePrincipalAndSession(credentialAtom);

        AgentPrincipal unbound = agentPrincipalService.createPrincipal(userId, "unboundAgent",
                null, snapshotOf("[{\"actionClass\":\"read\"}]"));
        CpApiException refused = assertThrows(CpApiException.class,
                () -> agentPrincipalService.resolveCapFor(
                        unbound.getId().toString(), workspaceId.toString()));

        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, refused.getStatus(),
                "spawn child cap must come from the D-49 active-binding gate, never a Session column");
    }

    private Session registerWorkspacePrincipalAndSession(ArrayNode sessionSnapshot) {
        String email = "cred-layer-" + UUID.randomUUID() + "@test.com";
        User user = authService.registerUser(
                new RegisterRequest(email, "layer-test-password", "Layer Test"));
        AuthResponse registered = authService.issueTokens(user, workspaceFixture.createOwnedWorkspace("Fixture Workspace", user.getId().toString()).getId().toString());
        userId = user.getId().toString();
        workspaceId = UUID.fromString(registered.getWorkspaceId());

        AuthorizationGrant manageGrant = new AuthorizationGrant();
        manageGrant.setId(UUID.randomUUID());
        manageGrant.setSubjectType("user");
        manageGrant.setSubjectId(user.getId());
        manageGrant.setGranterType("user");
        manageGrant.setGranterId(user.getId());
        manageGrant.setSource("role");
        // MANAGE_WORKSPACE_AGENTS for the cap write, plus credential_use@* so the
        // operator ceiling of setWorkspaceCap covers the concrete test id.
        manageGrant.setPermissions(snapshotOf("""
                [{"actionClass":"MANAGE_WORKSPACE_AGENTS"},
                 {"actionClass":"credential_use","resource":"credential:*"}]
                """).get("permissions"));
        grantRepository.save(manageGrant);

        AgentPrincipal principal = agentPrincipalService.createPrincipal(userId, "credLayerAgent",
                null, snapshotOf("[{\"actionClass\":\"read\"}]"));
        principalId = principal.getId();
        agentPrincipalService.setWorkspaceCap(userId, workspaceId, principalId,
                objectMapper.createArrayNode());

        // 2026-11-04 裁定（PLAN-0629「role 行是唯一权威源」）：求值只看 source='role' 的行；
        // creation 物化的 role 行（默认实例角色，一原子一行）才是权威源，所以把 credential 原子
        // 合进 role 行，而不是已降级为 legacy-only 的 agent_default 行。
        // 2026-11-04 裁定：creation 不再写 legacy 快照行；把 credential 原子作为一条**新的**
        // source='role' 行写入（role 行一原子一行，避免把两个原子塞进同一行触发 uq 约束）。
        AuthorizationGrant credentialRoleRow = new AuthorizationGrant();
        credentialRoleRow.setGranterType(GrantPrincipalPathResolver.USER);
        credentialRoleRow.setGranterId(UUID.fromString(userId));
        credentialRoleRow.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        credentialRoleRow.setSubjectId(principalId);
        credentialRoleRow.setSource(GrantSources.ROLE);
        credentialRoleRow.setReadState("read");
        credentialRoleRow.setPermissions(sessionSnapshot);
        grantRepository.saveAndFlush(credentialRoleRow);

        Session session = new Session(workspaceId.toString(), userId, "cred-layer-session");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(sessionSnapshot);
        sessionRepository.saveAndFlush(session);
        // PLAN-0689 A7: grant evaluation resolves the Session's agent path through the
        // PRIMARY participant row; the dropped sessions.agent_principal_id column cannot
        // stand in for it.
        bindPrimaryParticipant(session.getId().toString(), principalId.toString());
        sessionIds.add(session.getId());
        return session;
    }

    private ArrayNode credentialAtom(String actionClass, String resource) {
        ArrayNode atoms = objectMapper.createArrayNode();
        ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", actionClass);
        atom.put("resource", resource);
        atoms.add(atom);
        return atoms;
    }

    private ArrayNode atomsOf(String... actionClasses) {
        ArrayNode atoms = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            atoms.add(atom);
        }
        return atoms;
    }

    private JsonNode snapshotOf(String permissionsJson) {
        try {
            ObjectNode snapshot = objectMapper.createObjectNode();
            snapshot.put("systemPrompt", "cred-layer");
            snapshot.set("permissions", objectMapper.readTree(permissionsJson));
            return snapshot;
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }
}
