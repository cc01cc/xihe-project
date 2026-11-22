package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-125 / DSD-1497 mechanism ①: {@code POST /api/v1/authorization/explain} against a real
 * Tomcat, a real tenant guard and a real grant table.
 *
 * <p>The six faces that this class pins:</p>
 *
 * <ol>
 *   <li>anonymous callers are refused (the route is not tenant-exempt, so it is never open);</li>
 *   <li>a holder of the atom gets {@code allowed=true} plus <b>its own</b> grant row cited -- the
 *       positive half, without which the denials below could not distinguish "correctly
 *       refused" from "always refused";</li>
 *   <li>a missing atom is answered with {@code allowed=false}, a level index and a reason token;</li>
 *   <li>another subject's grant never appears in the body -- the subject is the authenticated
 *       principal, not a request field, so there is nothing to point at another user;</li>
 *   <li>{@code sessionId} resolves through the same read face the session APIs use, so an
 *       unreadable/unknown session is {@code 404 SESSION_NOT_FOUND} (one code, no oracle);</li>
 *   <li>a caller with no role in the addressed workspace is stopped by the tenant guard with
 *       {@code 403 WORKSPACE_FORBIDDEN} before the controller runs.</li>
 * </ol>
 *
 * <p>Shape errors stay {@code 400 INVALID_REQUEST}, and a blank {@code resource} is normalised to
 * {@code *} by the controller (so it never reaches the kernel's {@code blank-resource} branch).</p>
 */
class AuthorizationExplainContractTest extends AbstractReusableIntegrationTest {

    private static final String EXPLAIN = "/api/v1/authorization/explain";

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Test
    void anAnonymousCallerIsRefused() {
        ResponseEntity<String> response = restTemplate.exchange(baseUrl + EXPLAIN, HttpMethod.POST,
                new HttpEntity<>(Map.of("actionClass", "read"), jsonHeaders(null, null)), String.class);
        assertTrue(response.getStatusCode() == HttpStatus.UNAUTHORIZED
                        || response.getStatusCode() == HttpStatus.FORBIDDEN,
                "explain must not be anonymous-accessible, got " + response.getStatusCode());
    }

    /** The positive half: an atom the caller really holds is reported as allowed and cited. */
    @Test
    void theHolderOfAnAtomIsAllowedAndSeesTheRowThatAuthorizedIt() {
        AuthResponse caller = registerAuth("t125-holder@test.com");
        UUID userId = UUID.fromString(caller.getUser().getId());
        UUID grantId = grantInstanceAtom(userId, ToolFaceRegistry.ACTION_MANAGE_SCHEDULED_TASK);

        ResponseEntity<String> response = post(caller.getAccessToken(), EXPLAIN,
                Map.of("actionClass", ToolFaceRegistry.ACTION_MANAGE_SCHEDULED_TASK), null);

        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        JsonNode body = parse(response.getBody());
        assertTrue(body.path("allowed").asBoolean(), response.getBody());
        assertEquals(-1, body.path("deepestMissingLevel").asInt(),
                "an allowed decision has no missing level: " + response.getBody());
        assertTrue(body.path("missingAtom").isNull(), response.getBody());
        assertEquals(0, body.path("missingLevels").size(), response.getBody());
        assertEquals(1, body.path("evaluatedLevels").size(), response.getBody());
        assertEquals("user-grants", body.path("evaluatedLevels").get(0).path("label").asText(),
                response.getBody());
        assertTrue(body.path("evaluatedLevels").get(0).path("matched").asBoolean(),
                response.getBody());
        JsonNode matched = body.path("matchedGrantRefs");
        assertEquals(1, matched.size(), response.getBody());
        assertEquals(grantId.toString(), matched.get(0).path("grantId").asText(),
                "the referenced row must be the caller's own grant: " + response.getBody());
        assertEquals(GrantSources.PRESET, matched.get(0).path("grantSource").asText(),
                response.getBody());
        assertEquals(com.cc01cc.p.xihe.cp.policy.AtomNames.action(
                        ToolFaceRegistry.ACTION_MANAGE_SCHEDULED_TASK),
                matched.get(0).path("actionClass").asText(), response.getBody());
    }

    /** The negative half: nothing granted, and the answer still names the level and a reason. */
    @Test
    void aMissingAtomIsReportedWithItsLevelAndReason() {
        AuthResponse caller = registerAuth("t125-denied@test.com");

        // The USER role that every registration materializes carries read/write/delete/exec/network at
        // "*" (V87__dynamic_access_roles.sql:170-176); MANAGE_ROLES is SUPER_ADMIN/ADMIN only
        // (V87:150-151), so this caller has levels and still nothing that matches.
        ResponseEntity<String> response = post(caller.getAccessToken(), EXPLAIN,
                Map.of("actionClass", ToolFaceRegistry.ACTION_MANAGE_ROLES), null);

        assertEquals(HttpStatus.OK, response.getStatusCode(),
                "a refusal is a successful explanation, not an HTTP error: " + response.getBody());
        JsonNode body = parse(response.getBody());
        assertFalse(body.path("allowed").asBoolean(), response.getBody());
        assertEquals(0, body.path("deepestMissingLevel").asInt(), response.getBody());
        JsonNode miss = body.path("missingAtom");
        assertFalse(miss.isNull(), response.getBody());
        assertEquals(0, miss.path("level").asInt(), response.getBody());
        assertEquals("user-grants", miss.path("levelLabel").asText(), response.getBody());
        assertEquals(com.cc01cc.p.xihe.cp.policy.AtomNames.action(ToolFaceRegistry.ACTION_MANAGE_ROLES),
                miss.path("actionClass").asText(),
                response.getBody());
        assertEquals("no-matching-atom", miss.path("reason").asText(),
                "the level has rows, none of them matches: " + response.getBody());
        assertEquals(0, body.path("matchedGrantRefs").size(), response.getBody());
        assertFalse(body.path("evaluatedLevels").get(0).path("matched").asBoolean(),
                response.getBody());
    }

    /** Two subjects, two rows: the explanation of one never cites the other. */
    @Test
    void anotherSubjectsGrantNeverAppearsInTheBody() {
        AuthResponse alice = registerAuth("t125-alice@test.com");
        AuthResponse bob = registerAuth("t125-bob@test.com");
        UUID aliceId = UUID.fromString(alice.getUser().getId());
        UUID bobId = UUID.fromString(bob.getUser().getId());
        UUID aliceGrant = grantInstanceAtom(aliceId, ToolFaceRegistry.ACTION_MANAGE_SCHEDULED_TASK);
        UUID bobGrant = grantInstanceAtom(bobId, ToolFaceRegistry.ACTION_MANAGE_SCHEDULED_TASK);
        assertNotEquals(aliceGrant, bobGrant);

        ResponseEntity<String> response = post(alice.getAccessToken(), EXPLAIN,
                Map.of("actionClass", ToolFaceRegistry.ACTION_MANAGE_SCHEDULED_TASK), null);

        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        assertTrue(parse(response.getBody()).path("allowed").asBoolean(), response.getBody());
        assertTrue(response.getBody().contains(aliceGrant.toString()),
                "the caller's own row must be cited: " + response.getBody());
        assertFalse(response.getBody().contains(bobGrant.toString()),
                "another subject's grant must never be echoed: " + response.getBody());
        assertFalse(response.getBody().contains(bobId.toString()),
                "another subject's id must never be echoed: " + response.getBody());
    }

    /** sessionId goes through requireReadable: unknown -> 404, readable -> 200 and same scope. */
    @Test
    void aSessionIdResolvesThroughTheSessionReadFace() {
        AuthResponse owner = registerAuth("t125-session@test.com");
        String ownerId = owner.getUser().getId();
        UUID workspaceId = workspaceFixture.createOwnedWorkspace("t125 explain ws", ownerId).getId();
        Session session = new Session(workspaceId.toString(), ownerId, "t125 explain session");
        session.setId(UUID.randomUUID());
        session = sessionRepository.save(session);

        ResponseEntity<String> unknown = post(owner.getAccessToken(), EXPLAIN,
                Map.of("actionClass", ToolFaceRegistry.ACTION_READ,
                        "sessionId", UUID.randomUUID().toString()), workspaceId.toString());
        assertEquals(HttpStatus.NOT_FOUND, unknown.getStatusCode(), unknown.getBody());
        assertEquals("SESSION_NOT_FOUND", problemCode(unknown.getBody()));

        ResponseEntity<String> readable = post(owner.getAccessToken(), EXPLAIN,
                Map.of("actionClass", ToolFaceRegistry.ACTION_READ,
                        "sessionId", session.getId().toString()), workspaceId.toString());
        assertEquals(HttpStatus.OK, readable.getStatusCode(), readable.getBody());
        JsonNode body = parse(readable.getBody());
        assertEquals(1, body.path("evaluatedLevels").size(), readable.getBody());

        ResponseEntity<String> malformed = post(owner.getAccessToken(), EXPLAIN,
                Map.of("actionClass", ToolFaceRegistry.ACTION_READ, "sessionId", "not-a-uuid"),
                workspaceId.toString());
        assertEquals(HttpStatus.BAD_REQUEST, malformed.getStatusCode(), malformed.getBody());
        assertEquals("INVALID_REQUEST", problemCode(malformed.getBody()));
    }

    /** A stranger addressing someone else's workspace is stopped before the controller. */
    @Test
    void aCallerWithoutARoleInTheAddressedWorkspaceIsRefusedByTheTenantGuard() {
        AuthResponse owner = registerAuth("t125-owner@test.com");
        AuthResponse stranger = registerAuth("t125-stranger@test.com");
        UUID workspaceId = workspaceFixture
                .createOwnedWorkspace("t125 stranger ws", owner.getUser().getId()).getId();

        ResponseEntity<String> response = post(stranger.getAccessToken(), EXPLAIN,
                Map.of("actionClass", ToolFaceRegistry.ACTION_READ), workspaceId.toString());

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), response.getBody());
        assertEquals("WORKSPACE_FORBIDDEN", problemCode(response.getBody()));
    }

    /** Request-shape errors are 400 with the offending key named; a blank resource is normalised. */
    @Test
    void requestShapeErrorsStayInvalidRequest() {
        AuthResponse caller = registerAuth("t125-shape@test.com");

        ResponseEntity<String> missing = post(caller.getAccessToken(), EXPLAIN,
                Map.of("resource", "a.md"), null);
        assertEquals(HttpStatus.BAD_REQUEST, missing.getStatusCode(), missing.getBody());
        assertEquals("INVALID_REQUEST", problemCode(missing.getBody()));
        assertTrue(missing.getBody().contains("actionClass is required"), missing.getBody());

        Map<String, Object> nonString = new LinkedHashMap<>();
        nonString.put("actionClass", ToolFaceRegistry.ACTION_READ);
        nonString.put("resource", 5);
        ResponseEntity<String> badResource = post(caller.getAccessToken(), EXPLAIN, nonString, null);
        assertEquals(HttpStatus.BAD_REQUEST, badResource.getStatusCode(), badResource.getBody());
        assertEquals("INVALID_REQUEST", problemCode(badResource.getBody()));

        ResponseEntity<String> blank = post(caller.getAccessToken(), EXPLAIN,
                Map.of("actionClass", ToolFaceRegistry.ACTION_READ, "resource", "   "), null);
        assertEquals(HttpStatus.OK, blank.getStatusCode(), blank.getBody());
        JsonNode miss = parse(blank.getBody()).path("missingAtom");
        assertTrue(miss.isNull() || !"blank-resource".equals(miss.path("reason").asText()),
                "a blank resource is normalised to * before the kernel: " + blank.getBody());
    }

    // ------------------------------------------------------------------ helpers

    private UUID grantInstanceAtom(UUID subjectId, String actionClass) {
        ArrayNode permissions = objectMapper.createArrayNode();
        ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", com.cc01cc.p.xihe.cp.policy.AtomNames.action(actionClass));
        permissions.add(atom);
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(GrantPrincipalPathResolver.USER);
        grant.setSubjectId(subjectId);
        grant.setSource(GrantSources.PRESET);
        grant.setPermissions(permissions);
        return grantRepository.save(grant).getId();
    }

    private AuthResponse registerAuth(String email) {
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "t125"), AuthResponse.class);
        assertTrue(response.getStatusCode().is2xxSuccessful(), String.valueOf(response.getBody()));
        assertNotNull(response.getBody());
        return response.getBody();
    }

    private JsonNode parse(String body) {
        try {
            return objectMapper.readTree(body);
        } catch (Exception unparseable) {
            throw new AssertionError("unparseable body: " + body, unparseable);
        }
    }

    private ResponseEntity<String> post(String token, String path, Map<String, Object> body,
                                        String workspaceId) {
        return restTemplate.exchange(baseUrl + path, HttpMethod.POST,
                new HttpEntity<>(body, jsonHeaders(token, workspaceId)), String.class);
    }

    private static HttpHeaders jsonHeaders(String token, String workspaceId) {
        HttpHeaders headers = new HttpHeaders();
        if (token != null) {
            headers.setBearerAuth(token);
        }
        if (workspaceId != null) {
            headers.set("X-Workspace-Id", workspaceId);
        }
        return headers;
    }

    private static String problemCode(String body) {
        if (body == null) {
            return null;
        }
        try {
            JsonNode node = new ObjectMapper().readTree(body);
            return node.path("code").asText(null);
        } catch (Exception unparseable) {
            throw new AssertionError("unparseable problem body: " + body, unparseable);
        }
    }
}
