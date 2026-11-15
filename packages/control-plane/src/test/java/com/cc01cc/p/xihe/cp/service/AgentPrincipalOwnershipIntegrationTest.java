package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-173 (V170, user ruling 40C; Lead ruling D-1540) over real HTTP: the stored ownership is written
 * by the correct door, both read faces are exclusive, and the write guard answers 403 for a row the
 * caller does not own.
 *
 * <p>Why a separate class instead of extending the instance-surface suite: the subject is the
 * <b>seam between the two doors</b> (create here, address there), and every assertion names both the
 * status and the {@code problem.code} — "it failed somehow" proves nothing (D-1490).</p>
 *
 * <p>The 403 case is the one the ruling exists for. It was watched red before the guard landed: under
 * 40A the row carried no ownership, so the workspace-binding channel of
 * {@code requireDisableAuthority} let a plain user change a platform agent.</p>
 */
class AgentPrincipalOwnershipIntegrationTest extends AbstractReusableIntegrationTest {

    private static final String USER_PRINCIPALS = "/api/v1/agent-principals";
    private static final String INSTANCE_PRINCIPALS = "/api/v1/instance/agent-principals";

    @Autowired private AuthzContext authzContext;
    @Autowired private RequesterAuthority requesterAuthority;
    @Autowired private AccessRoleRepository roleRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private RoleGrantMaterializer roleMaterializer;
    @Autowired private PlatformTransactionManager transactionManager;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private ObjectMapper objectMapper;

    private final List<UUID> principalIds = new ArrayList<>();
    private final List<UUID> userIds = new ArrayList<>();
    private final Map<UUID, String> tokens = new HashMap<>();

    @AfterEach
    void cleanFixtures() {
        new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
            for (UUID principalId : principalIds) {
                workspaceAgentRepository.deleteAll(workspaceAgentRepository.findByIdPrincipalId(principalId));
                bindingRepository.deleteBySubject(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId);
                grantRepository.deleteBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId);
                principalRepository.findById(principalId).ifPresent(principalRepository::delete);
            }
            for (UUID userId : userIds) {
                grantRepository.deleteBySubjectTypeAndSubjectId("user", userId);
                bindingRepository.deleteBySubject("user", userId);
                auditLogRepository.deleteAll(
                        auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId.toString()));
                userRepository.deleteById(userId);
            }
        });
        principalIds.clear();
        userIds.clear();
        tokens.clear();
    }

    @Test
    void theInstanceDoorStampsInstanceOwnershipOnTheStoredRowAndEchoesIt() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);

        HttpProbe created = probe(adminToken, "POST", INSTANCE_PRINCIPALS, Map.of("name", uniqueName("owninst")));
        assertEquals(201, created.status(), created.body());
        UUID principalId = remember(parse(created.body()).path("principalId").asText());
        assertEquals(AgentPrincipal.OWNERSHIP_INSTANCE, parse(created.body()).path("ownership").asText(),
                "the create echo names the ownership the server derived from the door");
        assertEquals(AgentPrincipal.OWNERSHIP_INSTANCE, storedOwnership(principalId),
                "the row itself must be stamped, not just the response (D-1540 ②)");

        HttpProbe instanceList = probe(adminToken, "GET", INSTANCE_PRINCIPALS, null);
        assertEquals(200, instanceList.status(), instanceList.body());
        assertNotNull(find(parse(instanceList.body()).path("principals"), principalId.toString()),
                "the instance list is where a platform agent appears");

        HttpProbe userList = probe(adminToken, "GET", USER_PRINCIPALS, null);
        assertEquals(200, userList.status(), userList.body());
        assertEquals(null, find(parse(userList.body()).path("principals"), principalId.toString()),
                "the user prefix must not list an INSTANCE-owned row, not even for an instance admin "
                        + "(D-1540 ①: a row you cannot act on must not be shown)");
    }

    @Test
    void theUserDoorStampsUserOwnershipAndTheInstancePrefixCannotAddressIt() {
        UUID plainId = registerPlainUser();
        String plainToken = tokenOf(plainId);

        HttpProbe created = probe(plainToken, "POST", USER_PRINCIPALS, Map.of("name", uniqueName("ownuser")));
        assertEquals(201, created.status(), created.body());
        UUID principalId = remember(parse(created.body()).path("principalId").asText());
        assertEquals(AgentPrincipal.OWNERSHIP_USER, parse(created.body()).path("ownership").asText());
        assertEquals(AgentPrincipal.OWNERSHIP_USER, storedOwnership(principalId),
                "a user-door row is USER-owned — the two doors must never produce the same row");

        HttpProbe instanceList = probe(plainToken, "GET", INSTANCE_PRINCIPALS, null);
        assertEquals(200, instanceList.status(), instanceList.body());
        assertEquals(null, find(parse(instanceList.body()).path("principals"), principalId.toString()),
                "the instance list answers \"what this deployment installed\", not the user rows");

        Map<String, Object> clearContextPolicy = new LinkedHashMap<>();
        clearContextPolicy.put("contextPolicy", null);
        // The probe caller must be able to REACH the instance prefix (a plain user is stopped one layer
        // earlier by the cap:instance:admin gate, which is a different rule). So the 404 is observed by
        // an instance admin — the caller who would otherwise be allowed to act on anything here.
        String adminToken = tokenOf(registerInstanceAdmin());
        HttpProbe patched = probe(adminToken, "PATCH", INSTANCE_PRINCIPALS + "/" + principalId,
                clearContextPolicy);
        assertEquals(404, patched.status(), patched.body());
        assertEquals("AGENT_PRINCIPAL_NOT_FOUND", problemCode(patched),
                "the instance prefix must answer the identical 404 an unknown id gets");
        HttpProbe deleted = probe(adminToken, "DELETE", INSTANCE_PRINCIPALS + "/" + principalId, null);
        assertEquals(404, deleted.status(), deleted.body());
        assertEquals("AGENT_PRINCIPAL_NOT_FOUND", problemCode(deleted));
    }

    @Test
    void anInstanceOwnedPrincipalAcceptsNoUserPrefixWriter() {
        UUID adminId = registerInstanceAdmin();
        UUID principalId = remember(parse(probe(tokenOf(adminId), "POST", INSTANCE_PRINCIPALS,
                Map.of("name", uniqueName("ownguard"))).body()).path("principalId").asText());
        UUID plainId = registerPlainUser();
        String plainToken = tokenOf(plainId);

        // Lead ruling on this implementation: ONE row has exactly ONE writer. The instance prefix is
        // that writer; the user prefix must not become a second one, so it refuses in both shapes:
        //  (a) context-less: the D-196 gate answers first (409) — unchanged by task-173;
        //  (b) with a workspace context: the gates pass and the ownership guard answers 403 with its
        //      own code — not the generic owner-mismatch a USER-owned row would get.
        HttpProbe retireNoContext = probe(plainToken, "POST",
                USER_PRINCIPALS + "/" + principalId + "/disable", null);
        assertEquals(409, retireNoContext.status(), retireNoContext.body());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", problemCode(retireNoContext));

        Map<String, Object> clearContextPolicy = new LinkedHashMap<>();
        clearContextPolicy.put("contextPolicy", null);
        HttpProbe patchNoContext = probe(plainToken, "PATCH", USER_PRINCIPALS + "/" + principalId,
                clearContextPolicy);
        assertEquals(409, patchNoContext.status(), patchNoContext.body());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", problemCode(patchNoContext));

        // A REAL workspace the caller owns, with the platform agent BOUND to it: under 40A exactly this
        // shape (owner + binding + MANAGE_WORKSPACE_AGENTS) let the caller retire a platform agent. That
        // is the fail-open the ruling closed, so the fixture reproduces it deliberately.
        com.cc01cc.p.xihe.cp.entity.Workspace workspace =
                workspaceFixture.createOwnedWorkspace("Ownership ws", plainId.toString());
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        UUID workspaceContext = workspace.getId();
        HttpProbe retire = probe(plainToken, "POST",
                USER_PRINCIPALS + "/" + principalId + "/disable", null, workspaceContext);
        assertEquals(403, retire.status(), retire.body());
        assertEquals("AGENT_PRINCIPAL_INSTANCE_OWNED", problemCode(retire),
                "the refusal must say WHICH rule fired (a sibling code would send the caller hunting)");

        HttpProbe patch = probe(plainToken, "PATCH", USER_PRINCIPALS + "/" + principalId,
                clearContextPolicy, workspaceContext);
        assertEquals(403, patch.status(), patch.body());
        assertEquals("AGENT_PRINCIPAL_INSTANCE_OWNED", problemCode(patch));

        // A holder of the instance-tier atom gets the SAME answer from the user prefix as a plain user
        // (409, no workspace context): the atom opens the instance surface, not this one. That is the
        // "one row, one writer" rule stated from the strongest caller's side.
        String adminToken = tokenOf(registerInstanceAdmin());
        HttpProbe adminRetire = probe(adminToken, "POST",
                USER_PRINCIPALS + "/" + principalId + "/disable", null);
        assertEquals(409, adminRetire.status(), adminRetire.body());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", problemCode(adminRetire),
                "an N1 holder must use /api/v1/instance/agent-principals, not the user prefix");

        assertTrue(principalRepository.findById(principalId).orElseThrow().getDisabledAt() == null,
                "a refused retire must not have retired anything");
    }

    @Test
    void anInstanceAdminStillRetiresAnInstanceOwnedPrincipalThroughTheInstancePrefix() {
        UUID adminId = registerInstanceAdmin();
        String adminToken = tokenOf(adminId);
        UUID principalId = remember(parse(probe(adminToken, "POST", INSTANCE_PRINCIPALS,
                Map.of("name", uniqueName("ownretire"))).body()).path("principalId").asText());

        HttpProbe retire = probe(adminToken, "DELETE", INSTANCE_PRINCIPALS + "/" + principalId, null);
        assertEquals(204, retire.status(), retire.body());
        assertNotNull(principalRepository.findById(principalId).orElseThrow().getDisabledAt(),
                "DELETE retires; the guard must not turn into a blanket denial");
    }

    // --- fixtures ---------------------------------------------------------------------------

    private String storedOwnership(UUID principalId) {
        return principalRepository.findById(principalId).orElseThrow().getOwnership();
    }

    private static String uniqueName(String prefix) {
        return prefix + UUID.randomUUID().toString().replace("-", "").substring(0, 6);
    }

    private UUID remember(String principalId) {
        UUID id = UUID.fromString(principalId);
        principalIds.add(id);
        return id;
    }

    private String tokenOf(UUID userId) {
        return tokens.get(userId);
    }

    private UUID registerPlainUser() {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        String email = "own-" + suffix + "@test.com";
        HttpProbe response = probe(null, "POST", "/api/v1/auth/register", Map.of(
                "email", email,
                "password", TestDataFactory.PASSWORD,
                "name", "Ownership Fixture",
                "username", "ownuser" + suffix));
        assertEquals(201, response.status(), response.body());
        User user = userRepository.findByEmail(email).orElseThrow();
        userIds.add(user.getId());
        tokens.put(user.getId(), parse(response.body()).path("accessToken").asText());
        return user.getId();
    }

    /** Registers a user over HTTP (real token) and binds ADMIN at instance scope. */
    private UUID registerInstanceAdmin() {
        UUID userId = registerPlainUser();
        AccessRole adminRole = roleRepository.findByName(SystemAccessRoleCatalog.ADMIN).orElseThrow();
        AccessRoleBinding binding = new AccessRoleBinding(adminRole.getId(),
                AuthzContext.SUBJECT_USER, userId, AccessScope.INSTANCE, null, userId);
        bindingRepository.saveAndFlush(binding);
        roleMaterializer.materializeSubject(AuthzContext.SUBJECT_USER, userId, userId, null);
        authzContext.invalidate(userId);
        assertTrue(authzContext.isInstanceAdmin(userId),
                "fixture must really hold cap:instance:admin, otherwise the positive cases prove nothing");
        assertTrue(requesterAuthority.holdsActionAtom(userId,
                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS, null),
                "fixture must really hold the instance-tier atom the write gate names");
        return userId;
    }

    private HttpProbe probe(String token, String method, String path, Map<String, Object> body) {
        return probe(token, method, path, body, null);
    }

    /** Same probe with an explicit workspace context (the only way past the D-196 gate). */
    private HttpProbe probe(String token, String method, String path, Map<String, Object> body,
                            UUID workspaceContext) {
        HttpRequest.Builder builder = HttpRequest
                .newBuilder(URI.create(baseUrl + path))
                .header("Content-Type", "application/json");
        if (workspaceContext != null) {
            builder.header("X-Workspace-Id", workspaceContext.toString());
        }
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        try {
            String payload = body == null ? "" : objectMapper.writeValueAsString(body);
            HttpRequest request = builder.method(method, body == null
                    ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(payload)).build();
            HttpResponse<String> response = HttpClient.newHttpClient()
                    .send(request, HttpResponse.BodyHandlers.ofString());
            return new HttpProbe(response.statusCode(), response.body());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        } catch (java.io.IOException e) {
            throw new AssertionError(e);
        }
    }

    private record HttpProbe(int status, String body) {}

    private JsonNode parse(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }

    private String problemCode(HttpProbe response) {
        return parse(response.body()).path("code").asText("");
    }

    private static JsonNode find(JsonNode array, String principalId) {
        for (JsonNode item : array) {
            if (principalId.equals(item.path("principalId").asText())) {
                return item;
            }
        }
        return null;
    }
}
