package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * D-1585: "an agent principal may never hold a credential atom" is a load-bearing invariant with
 * no runtime voice of its own — {@code CredentialUseCap} would silently become a live gate if the
 * forbidden set or the cap intersection changed. This test makes it speak.
 *
 * <p>Two halves, both asserted positively ({@code D-1574}):</p>
 * <ol>
 *   <li>the atom catalogue refuses {@code credential_use}/{@code credential_reveal}/
 *       {@code credential_manage} for agent principals, and</li>
 *   <li>a {@code credential_use@credential:<uuid>} atom written straight into a Workspace binding
 *       snapshot is gone from the cap {@code AgentPrincipalService#resolveCapFor} resolves, while a
 *       covered {@code read@*} atom from the same snapshot survives.</li>
 * </ol>
 *
 * <p>{@code D-1490} mutation control: deleting {@code credential_use} from
 * {@code PermissionAtomCatalog.AGENT_FORBIDDEN_ATOMS} reddens
 * {@link #agentPrincipalsMayNeverHoldACredentialAtom()}.</p>
 */
class AgentCredentialAtomForbiddenTest extends AbstractReusableIntegrationTest {

    private static final List<String> CREDENTIAL_ATOMS = List.of(
            ToolFaceRegistry.ACTION_CREDENTIAL_USE,
            ToolFaceRegistry.ACTION_CREDENTIAL_REVEAL,
            ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE);

    @Autowired
    private AgentPrincipalService agentPrincipalService;
    @Autowired
    private AgentPrincipalRepository principalRepository;
    @Autowired
    private WorkspaceAgentRepository bindingRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private AuthorizationGrantRepository grantRepository;
    @Autowired
    private ObjectMapper objectMapper;
    @Autowired
    private JdbcTemplate jdbcTemplate;

    private final List<UUID> users = new ArrayList<>();
    private final List<UUID> workspaces = new ArrayList<>();
    private final List<UUID> principals = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        for (UUID principalId : principals) {
            bindingRepository.deleteAll(bindingRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(
                    grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'agent_principal' "
                    + "AND CAST(resource_id AS VARCHAR) = ?", principalId.toString());
            principalRepository.deleteById(principalId);
        }
        principals.clear();
        for (UUID workspaceId : workspaces) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        workspaces.clear();
        for (UUID userId : users) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE user_id = CAST(? AS UUID)",
                    userId.toString());
            userRepository.deleteById(userId);
        }
        users.clear();
    }

    @Test
    void agentPrincipalsMayNeverHoldACredentialAtom() {
        Set<String> forbidden = PermissionAtomCatalog.agentPrincipalForbiddenAtoms();
        for (String atom : CREDENTIAL_ATOMS) {
            assertTrue(forbidden.contains(atom),
                    "the agent-forbidden set must list " + atom);
            assertFalse(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(atom)),
                    "a role carrying " + atom + " must not be bindable to an agent principal");
            assertEquals(atom, PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(List.of(atom)),
                    "the refusal must name " + atom);
        }
    }

    @Test
    void injectedCredentialUseAtomIsDroppedByTheCapIntersection() throws Exception {
        User owner = newUser("credential-atom");
        Workspace workspace = workspace("Credential atom", owner);
        AgentPrincipal principal = principal(owner, "CredentialAtomAgent");
        String credentialId = UUID.randomUUID().toString();
        String credentialResource = ToolFaceRegistry.CREDENTIAL_RESOURCE_PREFIX + credentialId;
        String snapshot = "[{\"actionClass\":\"credential_use\",\"resource\":\""
                + credentialResource + "\"},{\"actionClass\":\"read\",\"resource\":\"*\"}]";
        bind(principal, workspace, snapshot);

        // Control (keeps the test honest): the snapshot on its own does grant credential use.
        JsonNode rawSnapshot = objectMapper.readTree(snapshot);
        assertTrue(CredentialUseCap.grants(rawSnapshot, credentialId),
                "the fixture must grant credential_use before the intersection runs");

        JsonNode cap = agentPrincipalService.resolveCapFor(principal.getId(), workspace.getId());
        assertEquals(Set.of("read@*"), atomSet(cap),
                "the cap must keep exactly the atom the principal's grants cover");
        assertFalse(CredentialUseCap.grants(cap, credentialId),
                "the cap intersection must drop the injected credential_use atom");
    }

    private static Set<String> atomSet(JsonNode cap) {
        Set<String> atoms = new LinkedHashSet<>();
        for (JsonNode atom : cap) {
            String resource = atom.hasNonNull("resource") ? atom.get("resource").asText() : "*";
            atoms.add(atom.path("actionClass").asText() + "@" + resource);
        }
        return atoms;
    }

    private User newUser(String label) {
        User user = userRepository.saveAndFlush(new User(
                "d1585-" + label + "-" + UUID.randomUUID() + "@test.com", "hash", label));
        users.add(user.getId());
        return user;
    }

    private Workspace workspace(String name, User owner) {
        Workspace workspace = workspaceFixture.createOwnedWorkspace(name, owner.getId().toString());
        workspaces.add(workspace.getId());
        return workspace;
    }

    /** Grants read/write/exec/network as the principal's ceiling: the cap is snapshot ∩ grants. */
    private AgentPrincipal principal(User creator, String name) throws Exception {
        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName(name);
        principal.setCreatedByUserId(creator.getId().toString());
        var templateSnapshot = objectMapper.createObjectNode();
        templateSnapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(templateSnapshot);
        AgentPrincipal saved = principalRepository.saveAndFlush(principal);
        principals.add(saved.getId());
        for (String actionClass : List.of("read", "write", "exec", "network")) {
            AuthorizationGrant grant = new AuthorizationGrant();
            grant.setGranterType("user");
            grant.setGranterId(creator.getId());
            grant.setSubjectType("agent_principal");
            grant.setSubjectId(saved.getId());
            grant.setSource("role");
            grant.setReadState("read");
            grant.setPermissions(objectMapper.readTree(
                    "[{\"actionClass\":\"" + actionClass + "\",\"resource\":\"*\"}]"));
            grantRepository.saveAndFlush(grant);
        }
        return saved;
    }

    private WorkspaceAgent bind(AgentPrincipal principal, Workspace workspace, String snapshot)
            throws Exception {
        return bindingRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.readTree(snapshot)));
    }
}