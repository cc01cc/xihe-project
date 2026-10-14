package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0496 M3 (T3.1; contract: 0496 §方案 6): the credential management API over
 * real HTTP — manage gates (wildcard for register, concrete id for operate),
 * sanitized responses, list with reference counts, delete with the reference
 * report, batch bindings all-or-nothing, precheck and 401/403/400 edges.
 */
class CredentialControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private CredentialRepository credentialRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private ObjectMapper objectMapper;

    private UUID userId;
    private String workspaceId;
    private String token;
    private final List<UUID> principalIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        principalIds.forEach(principalId -> {
            workspaceAgentRepository.deleteAll(workspaceAgentRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        });
        if (userId != null) {
            credentialRepository.findAll().stream()
                    .filter(credential -> userId.toString().equals(credential.getOwnerId()))
                    .forEach(credential -> credentialRepository.deleteById(credential.getId()));
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            auditLogRepository.deleteAll(
                    auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId.toString()));
            if (workspaceId != null) {
                UUID workspaceUuid = UUID.fromString(workspaceId);
                workspaceUserRepository.deleteAll(
                        workspaceUserRepository.findByIdWorkspaceId(workspaceUuid));
                workspaceRepository.deleteById(workspaceUuid);
            }
            userRepository.deleteById(userId);
        }
    }

    @Test
    void createRequiresTheManageWildcardAndPersistsSanitizedData() {
        register("read", "write", "delete", "exec", "network");
        String secret = "api-secret-create-0123456789";

        ResponseEntity<String> denied = post("/api/v1/credentials", Map.of(
                "label", "denied-token", "kind", "token", "deliveryTier", "lease", "token", secret));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "registering requires credential_manage@credential:*");

        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        ResponseEntity<String> created = post("/api/v1/credentials", Map.of(
                "label", "api-token", "kind", "token", "deliveryTier", "lease", "token", secret));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        assertTrue(created.getBody().contains("\"fingerprint\""));
        assertTrue(created.getBody().contains("\"ownerType\":\"USER\""));
        assertFalse(created.getBody().contains(secret), "the response must never carry the plaintext");
        assertFalse(created.getBody().contains("6789"), "the response must never carry a suffix");

        String credentialId = field(created.getBody(), "id");
        var row = credentialRepository.findById(UUID.fromString(credentialId)).orElseThrow();
        assertTrue(row.getSecretCiphertext().startsWith("v1:"));
        assertFalse(row.getSecretCiphertext().contains(secret));
    }

    @Test
    void listReturnsOwnerScopedSummariesWithReferenceCounts() {
        register("read", "write", "delete", "exec", "network");
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        post("/api/v1/credentials", Map.of("label", "first", "kind", "token",
                "deliveryTier", "lease", "token", "list-secret-1"));
        post("/api/v1/credentials", Map.of("label", "second", "kind", "token",
                "deliveryTier", "lease", "token", "list-secret-2"));

        ResponseEntity<String> listed = get("/api/v1/credentials");
        assertEquals(HttpStatus.OK, listed.getStatusCode());
        assertTrue(listed.getBody().contains("\"count\":2"));
        assertTrue(listed.getBody().contains("\"referenceCount\":0"));
        assertFalse(listed.getBody().contains("list-secret-1"));
    }

    @Test
    void replaceDeleteAndReferencesFlow() {
        register("read", "write", "delete", "exec", "network");
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        ResponseEntity<String> created = post("/api/v1/credentials", Map.of(
                "label", "flow-token", "kind", "token", "deliveryTier", "lease", "token", "flow-secret-1"));
        String credentialId = field(created.getBody(), "id");
        String resource = "credential:" + credentialId;

        ResponseEntity<String> replaced = post("/api/v1/credentials/" + credentialId + "/replace",
                Map.of("token", "flow-secret-2"));
        assertEquals(HttpStatus.OK, replaced.getStatusCode(), replaced.getBody());
        assertTrue(replaced.getBody().contains("\"revision\":2"));

        // Bind a workspace agent so the reference report has entries.
        grantUser("{\"actionClass\":\"MANAGE_WORKSPACE_AGENTS\"}");
        AgentPrincipal principal = agentPrincipalService.createPrincipal(userId.toString(),
                "ref-agent", null, snapshot("""
                        [{"actionClass":"read"}]
                        """));
        principalIds.add(principal.getId());
        agentPrincipalService.setWorkspaceCap(userId.toString(), UUID.fromString(workspaceId),
                principal.getId(), objectMapper.createArrayNode());
        grantUser("{\"actionClass\":\"credential_use\",\"resource\":\"credential:*\"}");
        ResponseEntity<String> bound = post("/api/v1/credentials/" + credentialId + "/bindings",
                Map.of("workspaceId", workspaceId, "agentPrincipalIds", List.of(principal.getId().toString())));
        assertEquals(HttpStatus.OK, bound.getStatusCode(), bound.getBody());

        ResponseEntity<String> references = get("/api/v1/credentials/" + credentialId + "/references");
        assertEquals(HttpStatus.OK, references.getStatusCode());
        assertTrue(references.getBody().contains("workspace_cap"), references.getBody());
        assertTrue(references.getBody().contains("grant"), references.getBody());
        assertTrue(references.getBody().contains(resource));

        ResponseEntity<String> deleted = exchange(HttpMethod.DELETE, "/api/v1/credentials/" + credentialId, null);
        assertEquals(HttpStatus.OK, deleted.getStatusCode(), deleted.getBody());
        assertTrue(deleted.getBody().contains("\"deleted\":true"));
        assertTrue(deleted.getBody().contains("references"), "delete carries the reference report");
        assertTrue(credentialRepository.findById(UUID.fromString(credentialId)).orElseThrow()
                .getDeletedAt() != null, "delete is a soft delete");
    }

    @Test
    void bindingsBatchIsAllOrNothing() {
        register("read", "write", "delete", "exec", "network");
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"credential_use\",\"resource\":\"credential:*\"}");
        ResponseEntity<String> created = post("/api/v1/credentials", Map.of(
                "label", "batch-token", "kind", "token", "deliveryTier", "lease", "token", "batch-secret"));
        String credentialId = field(created.getBody(), "id");

        grantUser("{\"actionClass\":\"MANAGE_WORKSPACE_AGENTS\"}");
        AgentPrincipal boundPrincipal = agentPrincipalService.createPrincipal(userId.toString(),
                "bound-agent", null, snapshot("[{\"actionClass\":\"read\"}]"));
        principalIds.add(boundPrincipal.getId());
        agentPrincipalService.setWorkspaceCap(userId.toString(), UUID.fromString(workspaceId),
                boundPrincipal.getId(), objectMapper.createArrayNode());
        AgentPrincipal unboundPrincipal = agentPrincipalService.createPrincipal(userId.toString(),
                "unbound-agent", null, snapshot("[{\"actionClass\":\"read\"}]"));
        principalIds.add(unboundPrincipal.getId());

        ResponseEntity<String> failed = post("/api/v1/credentials/" + credentialId + "/bindings",
                Map.of("workspaceId", workspaceId, "agentPrincipalIds",
                        List.of(boundPrincipal.getId().toString(), unboundPrincipal.getId().toString())));
        assertEquals(HttpStatus.NOT_FOUND, failed.getStatusCode(),
                "the unbound principal must fail the batch");

        var boundCap = workspaceAgentRepository.findById(
                        new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(
                                boundPrincipal.getId(), UUID.fromString(workspaceId)))
                .orElseThrow().getPermissionsSnapshot();
        assertFalse(boundCap.toString().contains("credential:" + credentialId),
                "the failed batch must not leave a partial binding (all-or-nothing)");
    }

    @Test
    void precheckListsUncoveredAtomsAndRequiresAuthentication() {
        ResponseEntity<String> anonymous = get("/api/v1/credentials");
        assertEquals(HttpStatus.UNAUTHORIZED, anonymous.getStatusCode());

        register("read", "write", "delete", "exec", "network");
        String resource = "credential:" + UUID.randomUUID();
        ResponseEntity<String> precheck = post("/api/v1/credentials/precheck", Map.of(
                "permissions", List.of(
                        Map.of("actionClass", "read"),
                        Map.of("actionClass", "credential_use", "resource", resource))));
        assertEquals(HttpStatus.OK, precheck.getStatusCode(), precheck.getBody());
        assertTrue(precheck.getBody().contains("credential_use@" + resource),
                "the uncovered credential atom must be listed: " + precheck.getBody());
        assertFalse(precheck.getBody().contains("\"read@"),
                "read is covered by the default USER set");
    }

    @Test
    void missingCredentialReturns404OnReplaceAndDelete() {
        register("read", "write", "delete", "exec", "network");
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        String missing = UUID.randomUUID().toString();

        ResponseEntity<String> replaced = post("/api/v1/credentials/" + missing + "/replace",
                Map.of("token", "any-value"));
        assertEquals(HttpStatus.NOT_FOUND, replaced.getStatusCode(), replaced.getBody());
        assertTrue(replaced.getBody().contains("CREDENTIAL_NOT_FOUND"));

        ResponseEntity<String> deleted = exchange(HttpMethod.DELETE, "/api/v1/credentials/" + missing, null);
        assertEquals(HttpStatus.NOT_FOUND, deleted.getStatusCode(), deleted.getBody());
        assertTrue(deleted.getBody().contains("CREDENTIAL_NOT_FOUND"));
    }

    @Test
    void malformedUuidAndInvalidBodiesReturn400() {
        register("read", "write", "delete", "exec", "network");
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");

        ResponseEntity<String> malformed = exchange(HttpMethod.DELETE, "/api/v1/credentials/not-a-uuid", null);
        assertEquals(HttpStatus.BAD_REQUEST, malformed.getStatusCode());

        ResponseEntity<String> badReferences = get("/api/v1/credentials/not-a-uuid/references");
        assertEquals(HttpStatus.BAD_REQUEST, badReferences.getStatusCode());

        ResponseEntity<String> emptyBatch = post("/api/v1/credentials/" + UUID.randomUUID() + "/bindings",
                Map.of("workspaceId", workspaceId, "agentPrincipalIds", List.of()));
        assertEquals(HttpStatus.BAD_REQUEST, emptyBatch.getStatusCode());

        ResponseEntity<String> noPermissions = post("/api/v1/credentials/precheck", Map.of());
        assertEquals(HttpStatus.BAD_REQUEST, noPermissions.getStatusCode());

        ResponseEntity<String> keyPair = post("/api/v1/credentials", Map.of(
                "label", "pair", "kind", "key_pair", "deliveryTier", "reveal",
                "accessKey", "only-half"));
        assertEquals(HttpStatus.BAD_REQUEST, keyPair.getStatusCode(),
                "key_pair requires both accessKey and secretKey");
    }

    @Test
    void listRejectsForeignOwnerAndResponsesCarryNoStore() {
        register("read", "write", "delete", "exec", "network");
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        post("/api/v1/credentials", Map.of("label", "mine", "kind", "token",
                "deliveryTier", "lease", "token", "mine-secret"));

        HttpHeaders plain = new HttpHeaders();
        plain.setBearerAuth(token);
        ResponseEntity<String> foreign = restTemplate.exchange(
                baseUrl + "/api/v1/credentials?ownerType=USER&ownerId=" + UUID.randomUUID(),
                HttpMethod.GET, new HttpEntity<>(plain), String.class);
        assertEquals(HttpStatus.FORBIDDEN, foreign.getStatusCode());

        ResponseEntity<String> own = get("/api/v1/credentials");
        assertEquals(HttpStatus.OK, own.getStatusCode());
        assertEquals("no-store", own.getHeaders().getFirst("Cache-Control"),
                "0496 design §方案 6: successful responses are non-cacheable");
    }

    @Test
    void unbindHttpFlowRemovesTheBinding() throws Exception {
        register("read", "write", "delete", "exec", "network");
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"credential_use\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"MANAGE_WORKSPACE_AGENTS\"}");
        ResponseEntity<String> created = post("/api/v1/credentials", Map.of(
                "label", "unbound-flow", "kind", "token", "deliveryTier", "lease",
                "token", "unbind-secret"));
        String credentialId = field(created.getBody(), "id");

        AgentPrincipal principal = agentPrincipalService.createPrincipal(userId.toString(),
                "unbind-flow-agent", null, snapshot("[{\"actionClass\":\"read\"}]"));
        principalIds.add(principal.getId());
        agentPrincipalService.setWorkspaceCap(userId.toString(), UUID.fromString(workspaceId),
                principal.getId(), objectMapper.createArrayNode());

        ResponseEntity<String> bound = post("/api/v1/credentials/" + credentialId + "/bindings",
                Map.of("workspaceId", workspaceId,
                        "agentPrincipalIds", List.of(principal.getId().toString())));
        assertEquals(HttpStatus.OK, bound.getStatusCode(), bound.getBody());

        ResponseEntity<String> unbound = exchange(HttpMethod.DELETE,
                "/api/v1/credentials/" + credentialId + "/bindings",
                Map.of("workspaceId", workspaceId,
                        "agentPrincipalIds", List.of(principal.getId().toString())));
        assertEquals(HttpStatus.OK, unbound.getStatusCode(), unbound.getBody());
        assertFalse(objectMapper.readTree(unbound.getBody()).get("bound").asBoolean());

        var cap = workspaceAgentRepository.findById(
                        new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(
                                principal.getId(), UUID.fromString(workspaceId)))
                .orElseThrow().getPermissionsSnapshot();
        assertFalse(cap.toString().contains("credential:" + credentialId),
                "the HTTP unbind must remove the cap atom");
    }

    private void register(String... userActions) {
        String email = "cred-api-" + UUID.randomUUID() + "@test.com";
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Credential API"),
                AuthResponse.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode());
        assertNotNull(response.getBody());
        token = response.getBody().getAccessToken();
        workspaceId = response.getBody().getWorkspaceId();
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId();
    }

    /** V64: a subject owns a single direct grant row — successive grants merge into it. */
    private void grantUser(String atomJson) {
        AuthorizationGrant direct = grantRepository.findBySubjectTypeAndSubjectId("user", userId).stream()
                .filter(grant -> "direct".equals(grant.getSource()))
                .findFirst()
                .orElse(null);
        JsonNode newAtoms = parse("[" + atomJson + "]");
        if (direct == null) {
            direct = new AuthorizationGrant();
            direct.setId(UUID.randomUUID());
            direct.setSubjectType("user");
            direct.setSubjectId(userId);
            direct.setGranterType("user");
            direct.setGranterId(userId);
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

    private JsonNode snapshot(String permissionsJson) {
        var snapshot = objectMapper.createObjectNode();
        snapshot.put("systemPrompt", "cred-api-agent");
        snapshot.set("permissions", parse(permissionsJson));
        return snapshot;
    }

    private JsonNode parse(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }

    private ResponseEntity<String> post(String path, Map<String, Object> body) {
        return exchange(HttpMethod.POST, path, body);
    }

    private ResponseEntity<String> get(String path) {
        return exchange(HttpMethod.GET, path, null);
    }

    private ResponseEntity<String> exchange(HttpMethod method, String path, Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        if (token != null) {
            headers.setBearerAuth(token);
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return restTemplate.exchange(baseUrl + path, method, entity, String.class);
    }

    private static String field(String json, String name) {
        try {
            return new ObjectMapper().readTree(json).get(name).asText();
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }
}
