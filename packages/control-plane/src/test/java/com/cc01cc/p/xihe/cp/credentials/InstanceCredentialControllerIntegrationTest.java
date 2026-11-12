package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0771 M3 / task-173 (contract {@code 37e7ddd8}, D-932 contract-first, D-1009): the five
 * instance credential endpoints over real HTTP.
 *
 * <p>Every endpoint carries at least one <b>negative</b> case, and each assertion pins the exact
 * status code <b>and</b> the {@code problem.code} — "a request failed somehow" is not evidence that
 * the contract's rule fired. The three contract rules exercised here are:</p>
 * <ul>
 *   <li>a non-INSTANCE row answers 404 {@code CREDENTIAL_NOT_FOUND}, the same answer a missing row
 *       gives, so the surface cannot be used to probe foreign credential ids (constraint 2);</li>
 *   <li>create refuses {@code ownerType}/{@code ownerId} with 400 {@code INVALID_REQUEST}
 *       (constraint 3);</li>
 *   <li>reveal needs {@code credential_reveal@credential:<id>} in addition to
 *       {@code cap:instance:admin}, and keeps the step-up throttle (constraint 4).</li>
 * </ul>
 */
class InstanceCredentialControllerIntegrationTest extends AbstractReusableIntegrationTest {

    private static final String INSTANCE_CREDENTIALS = "/api/v1/instance/credentials";

    @Autowired private AuthzContext authzContext;
    @Autowired private AccessRoleRepository roleRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private CredentialRepository credentialRepository;
    @Autowired private CredentialService credentialService;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private ObjectMapper objectMapper;

    private final List<UUID> credentialIds = new ArrayList<>();
    private final List<UUID> bindingIds = new ArrayList<>();
    private final List<UUID> userIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        // Explicit ids only: "delete every credential" would also remove migration seeds and hide a
        // real leak in the exact-id list assertions.
        credentialIds.forEach(id -> credentialRepository.findById(id)
                .ifPresent(row -> credentialRepository.deleteById(row.getId())));
        credentialIds.clear();
        bindingIds.forEach(bindingRepository::deleteById);
        bindingIds.clear();
        userIds.forEach(id -> {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", id));
            auditLogRepository.deleteAll(auditLogRepository.findByUserIdOrderByCreatedAtDesc(id.toString()));
            userRepository.deleteById(id);
        });
        userIds.clear();
    }

    @Test
    void listRequiresInstanceAdminAndReturnsExactlyTheInstanceRows() {
        UUID adminId = registerInstanceAdmin("list");
        String adminToken = tokenOf(adminId);
        UUID instanceCredentialId = seedInstanceCredential(adminId, "instance-list", Credential.TIER_LEASE,
                "list-secret");

        String plainToken = registerPlainUser("list-plain");
        ResponseEntity<String> denied = exchange(plainToken, HttpMethod.GET, INSTANCE_CREDENTIALS, null);
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "without cap:instance:admin the instance list must be refused: " + denied.getBody());
        assertEquals("FORBIDDEN", problemCode(denied));

        ResponseEntity<String> listed = exchange(adminToken, HttpMethod.GET, INSTANCE_CREDENTIALS, null);
        assertEquals(HttpStatus.OK, listed.getStatusCode(), listed.getBody());
        JsonNode body = parse(listed.getBody());
        assertEquals(List.of(instanceCredentialId.toString()), ids(body.path("credentials")),
                "the instance admin must see exactly the instance-owned rows");
        assertEquals(1, body.path("count").asInt(),
                "count assertion as well: a leaked row would make it 2");
        assertEquals("no-store", listed.getHeaders().getFirst("Cache-Control"));
    }

    @Test
    void createRefusesOwnerCoordinatesAndNeedsTheManageWildcard() {
        UUID adminId = registerInstanceAdmin("create");
        String adminToken = tokenOf(adminId);

        ResponseEntity<String> denied = exchange(adminToken, HttpMethod.POST, INSTANCE_CREDENTIALS,
                Map.of("label", "no-atom", "kind", "token", "deliveryTier", "lease", "token", "s1"));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "cap:instance:admin alone must not be enough to register a credential");
        assertEquals("FORBIDDEN", problemCode(denied));

        grantUserAtom(adminId, "{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");

        ResponseEntity<String> ownerType = exchange(adminToken, HttpMethod.POST, INSTANCE_CREDENTIALS,
                Map.of("ownerType", "INSTANCE", "label", "owner-typed", "kind", "token",
                        "deliveryTier", "lease", "token", "s2"));
        assertEquals(HttpStatus.BAD_REQUEST, ownerType.getStatusCode(),
                "constraint 3: an ownerType on the instance side is INVALID_REQUEST");
        assertEquals("INVALID_REQUEST", problemCode(ownerType));

        ResponseEntity<String> ownerId = exchange(adminToken, HttpMethod.POST, INSTANCE_CREDENTIALS,
                Map.of("ownerId", UUID.randomUUID().toString(), "label", "owner-id", "kind", "token",
                        "deliveryTier", "lease", "token", "s3"));
        assertEquals(HttpStatus.BAD_REQUEST, ownerId.getStatusCode(),
                "constraint 3: an ownerId on the instance side is INVALID_REQUEST");
        assertEquals("INVALID_REQUEST", problemCode(ownerId));

        ResponseEntity<String> created = exchange(adminToken, HttpMethod.POST, INSTANCE_CREDENTIALS,
                Map.of("label", "instance-created", "kind", "token", "deliveryTier", "lease",
                        "token", "instance-create-secret"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        JsonNode view = parse(created.getBody());
        assertEquals("INSTANCE", view.path("ownerType").asText());
        assertTrue(view.path("ownerId").isNull(),
                "D-1009: the instance row carries a null ownerId (present-but-null, never omitted)");
        assertFalse(created.getBody().contains("instance-create-secret"),
                "the response must never carry the secret");
        UUID createdId = UUID.fromString(view.path("id").asText());
        credentialIds.add(createdId);
        Credential row = credentialRepository.findById(createdId).orElseThrow();
        assertEquals(Credential.OWNER_INSTANCE, row.getOwnerType());
        assertEquals(null, row.getOwnerId());
    }

    @Test
    void getAnswersTheSameNotFoundForForeignAndMissingRows() {
        UUID adminId = registerInstanceAdmin("one");
        String adminToken = tokenOf(adminId);
        UUID instanceCredentialId = seedInstanceCredential(adminId, "instance-one", Credential.TIER_LEASE,
                "one-secret");
        UUID userCredentialId = seedUserCredential(adminId, "user-one");

        ResponseEntity<String> foreign = exchange(adminToken, HttpMethod.GET,
                INSTANCE_CREDENTIALS + "/" + userCredentialId, null);
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode(),
                "constraint 2: a USER-owned row must answer the same 404 as a missing one");
        assertEquals("CREDENTIAL_NOT_FOUND", problemCode(foreign));

        ResponseEntity<String> missing = exchange(adminToken, HttpMethod.GET,
                INSTANCE_CREDENTIALS + "/" + UUID.randomUUID(), null);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("CREDENTIAL_NOT_FOUND", problemCode(missing),
                "the two answers must be identical, otherwise the 404 becomes an existence oracle");

        ResponseEntity<String> own = exchange(adminToken, HttpMethod.GET,
                INSTANCE_CREDENTIALS + "/" + instanceCredentialId, null);
        assertEquals(HttpStatus.OK, own.getStatusCode(), own.getBody());
        assertEquals(instanceCredentialId.toString(), parse(own.getBody()).path("id").asText());
        assertEquals("INSTANCE", parse(own.getBody()).path("ownerType").asText());
    }

    @Test
    void deleteRequiresTheConcreteAtomAndAnswersNotFoundForForeignRows() {
        UUID adminId = registerInstanceAdmin("delete");
        String adminToken = tokenOf(adminId);
        UUID instanceCredentialId = seedInstanceCredential(adminId, "instance-delete", Credential.TIER_LEASE,
                "delete-secret");
        UUID userCredentialId = seedUserCredential(adminId, "user-delete");

        ResponseEntity<String> foreign = exchange(adminToken, HttpMethod.DELETE,
                INSTANCE_CREDENTIALS + "/" + userCredentialId, null);
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode(),
                "constraint 2 applies to delete as well: foreign row ⇒ 404, not 403");
        assertEquals("CREDENTIAL_NOT_FOUND", problemCode(foreign));
        assertTrue(credentialRepository.findByIdAndDeletedAtIsNull(userCredentialId).isPresent(),
                "a refused delete must leave the foreign row untouched");

        ResponseEntity<String> denied = exchange(adminToken, HttpMethod.DELETE,
                INSTANCE_CREDENTIALS + "/" + instanceCredentialId, null);
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "delete needs credential_manage@credential:<id> on top of cap:instance:admin");
        assertEquals("FORBIDDEN", problemCode(denied));

        grantUserAtom(adminId, "{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        ResponseEntity<String> deleted = exchange(adminToken, HttpMethod.DELETE,
                INSTANCE_CREDENTIALS + "/" + instanceCredentialId, null);
        assertEquals(HttpStatus.OK, deleted.getStatusCode(), deleted.getBody());
        assertTrue(parse(deleted.getBody()).path("deleted").asBoolean());
        assertTrue(credentialRepository.findByIdAndDeletedAtIsNull(instanceCredentialId).isEmpty(),
                "the instance row must really be soft-deleted");
    }

    @Test
    void revealNeedsTheInstanceRevealAtomAndAnswersNotFoundForForeignRows() {
        UUID adminId = registerInstanceAdmin("reveal");
        String adminToken = tokenOf(adminId);
        // A reveal-tier credential created through the instance endpoint itself (the wire path under test).
        ResponseEntity<String> deniedCreate = exchange(adminToken, HttpMethod.POST, INSTANCE_CREDENTIALS,
                Map.of("label", "instance-reveal", "kind", "token", "deliveryTier", "reveal",
                        "token", "instance-reveal-secret"));
        assertEquals(HttpStatus.FORBIDDEN, deniedCreate.getStatusCode(),
                "the fixture must first show the manage-atom gate, so the later create is not vacuous");
        grantUserAtom(adminId, "{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        ResponseEntity<String> created = exchange(adminToken, HttpMethod.POST, INSTANCE_CREDENTIALS,
                Map.of("label", "instance-reveal", "kind", "token", "deliveryTier", "reveal",
                        "token", "instance-reveal-secret"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        UUID instanceCredentialId = UUID.fromString(parse(created.getBody()).path("id").asText());
        credentialIds.add(instanceCredentialId);
        UUID userCredentialId = seedUserCredential(adminId, "user-reveal");
        grantUserAtom(adminId, "{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:"
                + userCredentialId + "\"}");

        // foreign row first: the atom IS granted for it, so a 403 would mean "row exists" leaked.
        ResponseEntity<String> foreign = exchange(adminToken, HttpMethod.POST,
                INSTANCE_CREDENTIALS + "/" + userCredentialId + "/reveal",
                Map.of("password", TestDataFactory.PASSWORD));
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode(),
                "constraint 2 wins over the atom: a foreign row is 404 even when reveal is granted for it");
        assertEquals("CREDENTIAL_NOT_FOUND", problemCode(foreign));

        // no instance-scope credential_reveal atom ⇒ 403 FORBIDDEN
        ResponseEntity<String> denied = exchange(adminToken, HttpMethod.POST,
                INSTANCE_CREDENTIALS + "/" + instanceCredentialId + "/reveal",
                Map.of("password", TestDataFactory.PASSWORD));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode());
        assertEquals("FORBIDDEN", problemCode(denied));

        grantUserAtom(adminId, "{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:"
                + instanceCredentialId + "\"}");

        // step-up: wrong password keeps the unchanged 401 shape. RestTemplate's default
        // HttpURLConnection factory drops 401 problem bodies (CredentialRevealIntegrationTest found
        // this too), so this one assertion goes through the JDK HttpClient probe or it would be
        // indistinguishable from "the body was never produced".
        HttpProbe wrongStepUp = probeReveal(adminToken,
                INSTANCE_CREDENTIALS + "/" + instanceCredentialId + "/reveal", TestDataFactory.INVALID_PASSWORD);
        assertEquals(401, wrongStepUp.status(), wrongStepUp.body());
        assertTrue(wrongStepUp.body().contains("CREDENTIAL_REVEAL_STEP_UP_FAILED"),
                "constraint 4: the step-up verification is unchanged: " + wrongStepUp.body());

        ResponseEntity<String> revealed = exchange(adminToken, HttpMethod.POST,
                INSTANCE_CREDENTIALS + "/" + instanceCredentialId + "/reveal",
                Map.of("password", TestDataFactory.PASSWORD));
        assertEquals(HttpStatus.OK, revealed.getStatusCode(), revealed.getBody());
        // The decrypted payload of a token-kind credential is its stored JSON envelope, so the exact
        // assertion is on the token field: a wrong-key or wrong-AAD decrypt yields other bytes here.
        JsonNode revealedPayload = parse(parse(revealed.getBody()).path("value").asText());
        assertEquals("instance-reveal-secret", revealedPayload.path("token").asText(),
                "the revealed plaintext must be the secret that was registered");
        assertEquals("no-store", revealed.getHeaders().getFirst("Cache-Control"));
    }

    // --- fixtures ---------------------------------------------------------------------------

    /** Registers a user over HTTP (real token) and binds ADMIN at instance scope. */
    private UUID registerInstanceAdmin(String prefix) {
        UUID userId = registerUserViaHttp(prefix);
        AccessRole adminRole = roleRepository.findByName(SystemAccessRoleCatalog.ADMIN).orElseThrow();
        AccessRoleBinding binding = new AccessRoleBinding(adminRole.getId(),
                AuthzContext.SUBJECT_USER, userId, AccessScope.INSTANCE, null, userId);
        bindingRepository.saveAndFlush(binding);
        bindingIds.add(binding.getId());
        authzContext.invalidate(userId);
        assertTrue(authzContext.isInstanceAdmin(userId),
                "fixture must really hold instance:admin, otherwise the positive cases prove nothing");
        return userId;
    }

    private String registerPlainUser(String prefix) {
        return tokens.get(registerUserViaHttp(prefix));
    }

    private final java.util.Map<UUID, String> tokens = new java.util.HashMap<>();

    private String tokenOf(UUID userId) {
        return tokens.get(userId);
    }

    private UUID registerUserViaHttp(String prefix) {
        String email = "instance-cred-" + prefix + "-" + UUID.randomUUID() + "@test.com";
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Instance Credential API"),
                AuthResponse.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        User user = userRepository.findByEmail(email).orElseThrow();
        userIds.add(user.getId());
        tokens.put(user.getId(), response.getBody().getAccessToken());
        return user.getId();
    }

    private UUID seedInstanceCredential(UUID actorId, String label, String tier, String secret) {
        return seedCredential(Credential.OWNER_INSTANCE, null, actorId, label, tier, secret);
    }

    private UUID seedUserCredential(UUID actorId, String label) {
        return seedCredential(Credential.OWNER_USER, actorId.toString(), actorId, label,
                Credential.TIER_REVEAL, "user-secret");
    }

    private UUID seedCredential(String ownerType, String ownerId, UUID actorId, String label, String tier,
            String secret) {
        Credential created = credentialService.create(new CredentialService.CreateRequest(
                ownerType, ownerId, label, Credential.KIND_TOKEN, tier,
                new CredentialService.SecretPayload(secret, null, null)), actorId.toString());
        credentialIds.add(created.getId());
        return created.getId();
    }

    /** A subject holds one direct grant row; successive atoms merge into it (same shape as V64 tests). */
    private void grantUserAtom(UUID userId, String atomJson) {
        AuthorizationGrant row = grantRepository.findBySubjectTypeAndSubjectId("user", userId).stream()
                .findFirst().orElse(null);
        JsonNode newAtoms = parse("[" + atomJson + "]");
        if (row == null) {
            row = new AuthorizationGrant();
            row.setId(UUID.randomUUID());
            row.setSubjectType("user");
            row.setSubjectId(userId);
            row.setGranterType("user");
            row.setGranterId(userId);
            row.setSource("role");
            row.setPermissions(newAtoms);
            grantRepository.save(row);
            return;
        }
        com.fasterxml.jackson.databind.node.ArrayNode merged = objectMapper.createArrayNode();
        row.getPermissions().forEach(merged::add);
        newAtoms.forEach(merged::add);
        row.setPermissions(merged);
        grantRepository.save(row);
    }

    private ResponseEntity<String> exchange(String token, HttpMethod method, String path,
            Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        if (token != null) {
            headers.setBearerAuth(token);
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return restTemplate.exchange(baseUrl + path, method, entity, String.class);
    }

    private JsonNode parse(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }

    private static String problemCode(ResponseEntity<String> response) {
        try {
            return new ObjectMapper().readTree(response.getBody()).path("code").asText("");
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
    }

    private static List<String> ids(JsonNode array) {
        List<String> values = new ArrayList<>();
        array.forEach(item -> values.add(item.path("id").asText()));
        return values;
    }

    private record HttpProbe(int status, String body) {}

    /**
     * The JDK HttpClient reads 401 problem bodies that RestTemplate's default HttpURLConnection
     * factory drops (same finding as {@code CredentialRevealIntegrationTest}); the step-up assertion
     * therefore uses this probe against the same running CP.
     */
    private HttpProbe probeReveal(String token, String path, String password) {
        String payload;
        try {
            payload = objectMapper.writeValueAsString(Map.of("password", password));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new AssertionError(e);
        }
        try {
            java.net.http.HttpClient client = java.net.http.HttpClient.newHttpClient();
            java.net.http.HttpRequest request = java.net.http.HttpRequest
                    .newBuilder(java.net.URI.create(baseUrl + path))
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json")
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(payload))
                    .build();
            java.net.http.HttpResponse<String> response = client.send(request,
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpProbe(response.statusCode(), response.body());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        } catch (java.io.IOException e) {
            throw new AssertionError(e);
        }
    }
}
