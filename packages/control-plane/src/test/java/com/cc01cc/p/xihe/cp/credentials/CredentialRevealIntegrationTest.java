package com.cc01cc.p.xihe.cp.credentials;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.CredentialEvent;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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
 * PLAN-0497 M3 (T3.1/T3.2; contract: 0497 design §方案 3/6, decisions #3/#7/#9/#10,
 * I3/I5/I6): the reveal strong action over real HTTP — user-only
 * credential_reveal intersection, reveal-tier gate, step-up throttling (5
 * failures / 15 minutes), no-store response, value-free audit trail, the
 * owner-visible events read surface and the v1 no-approval guarantee.
 */
class CredentialRevealIntegrationTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AuditLogRepository auditLogRepository;
    @Autowired private CredentialRepository credentialRepository;
    @Autowired private CredentialEventRepository credentialEventRepository;
    @Autowired private ChatApprovalRepository chatApprovalRepository;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private CredentialRotationService credentialRotationService;
    @Autowired
    @org.springframework.beans.factory.annotation.Qualifier("credentialEncryption")
    private com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService credentialEncryption;

    private UUID userId;
    private String workspaceId;
    private String token;
    private final List<String> credentialIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        credentialIds.forEach(credentialId -> {
            credentialEventRepository.deleteAll(
                    credentialEventRepository.findByCredentialIdOrderByCreatedAtDesc(credentialId));
            credentialRepository.deleteById(UUID.fromString(credentialId));
        });
        if (userId != null) {
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
    void revealReturnsTheValueOnceWithNoStoreAndValueFreeTrail() {
        register();
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:*\"}");
        String secret = "reveal-secret-0123456789";
        String credentialId = createCredential("reveal", secret);

        ResponseEntity<String> revealed = reveal(credentialId, TestDataFactory.PASSWORD);

        assertEquals(HttpStatus.OK, revealed.getStatusCode(), revealed.getBody());
        assertTrue(revealed.getBody().contains(secret), "the reveal response carries the value once");
        assertEquals("no-store", revealed.getHeaders().getFirst("Cache-Control"),
                "reveal responses must never be cacheable");
        assertEquals(0, chatApprovalRepository.count(),
                "v1 reveal must not create pending approvals");

        List<CredentialEvent> revealedTrail =
                credentialEventRepository.findByCredentialIdOrderByCreatedAtDesc(credentialId).stream()
                        .filter(event -> CredentialEvent.TYPE_REVEALED.equals(event.getEventType()))
                        .toList();
        assertEquals(1, revealedTrail.size(), "exactly one revealed event for the delivery");
        assertEquals("user:" + userId, revealedTrail.getFirst().getActor());
        assertFalse(revealedTrail.getFirst().toString().contains(secret));
    }

    @Test
    void legacyV1AadRowIsStillRevealable() {
        register();
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:*\"}");
        String secret = "reveal-legacy-v1-0123456789";
        String credentialId = createCredential("reveal", secret);

        Credential row = credentialRepository.findById(UUID.fromString(credentialId)).orElseThrow();
        row.setAadVersion(Credential.AAD_VERSION_LEGACY);
        row.setSecretCiphertext(credentialEncryption.encrypt("{\"token\":\"" + secret + "\"}",
                CredentialAad.formatV1(row.getId().toString(), row.getOwnerType(), row.getOwnerId())));
        credentialRepository.save(row);

        ResponseEntity<String> revealed = reveal(credentialId, TestDataFactory.PASSWORD);

        assertEquals(HttpStatus.OK, revealed.getStatusCode(), revealed.getBody());
        assertTrue(revealed.getBody().contains(secret),
                "pre-V84 rows must stay revealable through the unified entry point (V2)");
    }

    @Test
    void migratedV1RowIsRevealableAfterRotation() {
        register();
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:*\"}");
        String secret = "reveal-migrated-0123456789";
        String credentialId = createCredential("reveal", secret);

        Credential row = credentialRepository.findById(UUID.fromString(credentialId)).orElseThrow();
        row.setAadVersion(Credential.AAD_VERSION_LEGACY);
        row.setFingerprintVersion(Credential.FINGERPRINT_VERSION_SHA256);
        row.setSecretCiphertext(credentialEncryption.encrypt("{\"token\":\"" + secret + "\"}",
                CredentialAad.formatV1(row.getId().toString(), row.getOwnerType(), row.getOwnerId())));
        credentialRepository.save(row);

        assertEquals(1, credentialRotationService.rotateBatch(50).migrated(),
                "the migration run must promote the v1 row to AAD v2 + HMAC");
        Credential migrated = credentialRepository.findById(UUID.fromString(credentialId)).orElseThrow();
        assertEquals(Credential.AAD_VERSION_V2, migrated.getAadVersion());
        assertEquals(Credential.FINGERPRINT_VERSION_HMAC_SHA256_V1, migrated.getFingerprintVersion());

        ResponseEntity<String> revealed = reveal(credentialId, TestDataFactory.PASSWORD);

        assertEquals(HttpStatus.OK, revealed.getStatusCode(), revealed.getBody());
        assertTrue(revealed.getBody().contains(secret),
                "migrated rows must stay revealable through the unified entry point");
    }

    @Test
    void revealWithoutTheGrantFailsClosedBeforeAnyEvent() {
        register();
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        String secret = "reveal-denied-0123456789";
        String credentialId = createCredential("reveal", secret);

        ResponseEntity<String> denied = reveal(credentialId, TestDataFactory.PASSWORD);

        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "reveal requires credential_reveal@credential:<id>");
        assertTrue(revealedEvents(credentialId).isEmpty(),
                "an unauthorized reveal must not write a credential event");
        assertEquals(0, chatApprovalRepository.count());
    }

    @Test
    void revealOnLeaseTierIsRejected() {
        register();
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:*\"}");
        String credentialId = createCredential("lease", "lease-tier-secret-1");

        ResponseEntity<String> rejected = reveal(credentialId, TestDataFactory.PASSWORD);

        assertEquals(422, rejected.getStatusCode().value(), rejected.getBody());
        assertTrue(rejected.getBody().contains("CREDENTIAL_TIER_MISMATCH"),
                "the delivery channels stay disjoint (decision #7)");
    }

    @Test
    void wrongPasswordIsThrottledAfterFiveFailures() {
        register();
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:*\"}");
        String credentialId = createCredential("reveal", "reveal-throttle-0123456789");

        for (int attempt = 0; attempt < 5; attempt++) {
            HttpProbe failed = probeReveal(credentialId, "wrong-password-" + attempt);
            assertEquals(401, failed.status(), failed.body());
            assertTrue(failed.body().contains("CREDENTIAL_REVEAL_STEP_UP_FAILED"));
        }

        HttpProbe throttled = probeReveal(credentialId, TestDataFactory.PASSWORD);
        assertEquals(429, throttled.status(), throttled.body());
        assertTrue(throttled.body().contains("CREDENTIAL_REVEAL_RATE_LIMITED"),
                "the fifth failure must open the 15 minute throttle window");
        assertTrue(revealedEvents(credentialId).isEmpty(),
                "failed step-ups never write a revealed event");
    }

    @Test
    void disabledCredentialIsRejected() {
        register();
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:*\"}");
        String credentialId = createCredential("reveal", "reveal-disabled-0123456789");
        Credential row = credentialRepository.findById(UUID.fromString(credentialId)).orElseThrow();
        row.setStatus(Credential.STATUS_DISABLED);
        credentialRepository.save(row);

        ResponseEntity<String> rejected = reveal(credentialId, TestDataFactory.PASSWORD);

        assertEquals(HttpStatus.FORBIDDEN, rejected.getStatusCode(), rejected.getBody());
        assertTrue(rejected.getBody().contains("CREDENTIAL_DISABLED"));
    }

    @Test
    void eventsReadSurfaceIsOwnerVisibleAndValueFree() {
        register();
        grantUser("{\"actionClass\":\"credential_manage\",\"resource\":\"credential:*\"}");
        grantUser("{\"actionClass\":\"credential_reveal\",\"resource\":\"credential:*\"}");
        String secret = "reveal-events-0123456789";
        String credentialId = createCredential("reveal", secret);
        reveal(credentialId, TestDataFactory.PASSWORD);

        ResponseEntity<String> events = get("/api/v1/credentials/" + credentialId + "/events");

        assertEquals(HttpStatus.OK, events.getStatusCode(), events.getBody());
        assertTrue(events.getBody().contains("\"eventType\":\"revealed\""));
        assertFalse(events.getBody().contains(secret), "the audit trail must never carry the value");
        assertEquals("no-store", events.getHeaders().getFirst("Cache-Control"));
    }

    private String createCredential(String tier, String secret) {
        ResponseEntity<String> created = post("/api/v1/credentials", Map.of(
                "label", "reveal-" + tier, "kind", "token", "deliveryTier", tier, "token", secret));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        String credentialId = field(created.getBody(), "id");
        credentialIds.add(credentialId);
        return credentialId;
    }

    private ResponseEntity<String> reveal(String credentialId, String password) {
        return post("/api/v1/credentials/" + credentialId + "/reveal", Map.of("password", password));
    }

    private List<CredentialEvent> revealedEvents(String credentialId) {
        return credentialEventRepository.findByCredentialIdOrderByCreatedAtDesc(credentialId).stream()
                .filter(event -> CredentialEvent.TYPE_REVEALED.equals(event.getEventType()))
                .toList();
    }

    private record HttpProbe(int status, String body) {}

    /**
     * The JDK HttpClient reads 401 problem bodies that RestTemplate's default
     * HttpURLConnection factory drops (verified with both stacks against the same
     * response); the step-up assertions therefore use this probe.
     */
    private HttpProbe probeReveal(String credentialId, String password) {
        try {
            java.net.http.HttpClient client = java.net.http.HttpClient.newHttpClient();
            java.net.http.HttpRequest request = java.net.http.HttpRequest
                    .newBuilder(java.net.URI.create(baseUrl + "/api/v1/credentials/" + credentialId + "/reveal"))
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json")
                    .POST(java.net.http.HttpRequest.BodyPublishers
                            .ofString("{\"password\":\"" + password + "\"}"))
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

    private void register() {
        String email = "cred-reveal-" + UUID.randomUUID() + "@test.com";
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Credential Reveal"),
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
