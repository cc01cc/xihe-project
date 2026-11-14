package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.HttpClientErrorException;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * task-52: {@code GET /api/v1/workspaces/{workspaceId}/members/{userId}/effective-permissions}.
 *
 * <p>Three groups, as approved: (1) parity — the self view is equal to the caller's own
 * {@code /me/permissions} workspace entry, asserted on BOTH the atom set and the {@code sources}
 * keys (the hit-source audit, so "same atom, different provenance" cannot slip through); (2) the
 * positive authorization path — an OWNER reads another member; (3) the non-probing refusal — a
 * caller without the atom, and a userId that does not exist, must be answered identically.</p>
 */
class WorkspaceMemberEffectivePermissionsTest extends AbstractIntegrationTest {

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper json;

    private String ownerToken;
    private String ownerId;
    private String workspaceId;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("t52-owner");
        ownerToken = owner.getAccessToken();
        ownerId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("t52 ws", ownerId).getId().toString();
    }

    @Test
    void selfViewEqualsTheCallersOwnMePermissionsEntry() {
        JsonNode me = get(ownerToken, "/api/v1/me/permissions", 200);
        JsonNode member = get(ownerToken,
                "/api/v1/workspaces/" + workspaceId + "/members/" + ownerId + "/effective-permissions", 200);

        assertEquals(atoms(workspaceEntry(me)), atoms(workspaceEntry(member)),
                "same atoms as the caller's own /me/permissions entry");
        assertEquals(sources(workspaceEntry(me)), sources(workspaceEntry(member)),
                "same hit-source audit (task-415 sources), not just the same atom names");
    }

    @Test
    void anOwnerReadsAnotherMembersAtoms() {
        String memberUsername = "t52e" + UUID.randomUUID().toString().substring(0, 8);
        AuthResponse member = register(memberUsername);
        addMember(ownerToken, member.getUser().getUsername(), "EDITOR");

        JsonNode view = get(ownerToken,
                "/api/v1/workspaces/" + workspaceId + "/members/" + member.getUser().getId()
                        + "/effective-permissions", 200);
        assertEquals(member.getUser().getId(), view.path("userId").asText(),
                "the projection is resolved for the TARGET subject, not for the caller");
        assertNotNull(workspaceEntry(view), "the target's workspace entry is present");
    }

    @Test
    void aCallerWithoutTheAtomCannotTellAMemberFromAnUnknownUser() {
        String memberUsername = "t52o" + UUID.randomUUID().toString().substring(0, 8);
        AuthResponse member = register(memberUsername);

        // The outsider is a real account but not a member of this workspace and holds no atom.
        AuthResponse outsider = register("t52x" + UUID.randomUUID().toString().substring(0, 8));

        ResponseEntity<String> knownUser = call(outsider.getAccessToken(), "/api/v1/workspaces/"
                + workspaceId + "/members/" + member.getUser().getId() + "/effective-permissions");
        ResponseEntity<String> unknownUser = call(outsider.getAccessToken(), "/api/v1/workspaces/"
                + workspaceId + "/members/" + UUID.randomUUID() + "/effective-permissions");

        assertEquals(knownUser.getStatusCode(), unknownUser.getStatusCode(),
                "a member and an unknown user must be indistinguishable (D-1437)");
        assertEquals(HttpStatus.NOT_FOUND, knownUser.getStatusCode(),
                "refused, and the same way for both: " + knownUser.getBody());
        JsonNode knownBody = read(knownUser.getBody());
        JsonNode unknownBody = read(unknownUser.getBody());
        assertEquals(knownBody.path("code").asText(), unknownBody.path("code").asText(),
                "same problem code");
        assertEquals(knownBody.path("detail").asText(), unknownBody.path("detail").asText(),
                "same detail text — no existence oracle");
    }

    // ---------------------------------------------------------------- helpers

    private JsonNode workspaceEntry(JsonNode body) {
        for (JsonNode entry : body.path("workspaces")) {
            if (workspaceId.equals(entry.path("workspaceId").asText())) {
                return entry;
            }
        }
        return json.createObjectNode();
    }

    private Set<String> atoms(JsonNode entry) {
        Set<String> keys = new TreeSet<>();
        for (JsonNode atom : entry.path("permissions")) {
            keys.add(atom.path("actionClass").asText() + ":" + atom.path("resource").asText());
        }
        return keys;
    }

    private Set<String> sources(JsonNode entry) {
        Set<String> keys = new TreeSet<>();
        for (JsonNode atom : entry.path("permissions")) {
            String atomKey = atom.path("actionClass").asText() + ":" + atom.path("resource").asText();
            for (JsonNode source : atom.path("sources")) {
                keys.add(atomKey + "|" + source.path("source").asText() + "|"
                        + source.path("roleName").asText() + "|" + source.path("scopeType").asText()
                        + "|" + source.path("scopeId").asText() + "|"
                        + source.path("grantId").asText());
            }
        }
        return keys;
    }

    private void addMember(String token, String username, String role) {
        HttpHeaders headers = headers(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/members"), HttpMethod.POST,
                new HttpEntity<>(Map.of("username", username, "role", role), headers), String.class);
        assertEquals(201, response.getStatusCode().value(), String.valueOf(response.getBody()));
    }

    /** GET that keeps 4xx bodies instead of throwing (the refusal comparison needs both). */
    private ResponseEntity<String> call(String token, String path) {
        try {
            return restTemplate.exchange(url(path), HttpMethod.GET, new HttpEntity<>(headers(token)),
                    String.class);
        } catch (HttpClientErrorException refusal) {
            return ResponseEntity.status(refusal.getStatusCode())
                    .body(refusal.getResponseBodyAsString());
        }
    }

    private JsonNode get(String token, String path, int expectedStatus) {
        ResponseEntity<String> response = restTemplate.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(headers(token)), String.class);
        assertEquals(expectedStatus, response.getStatusCode().value(), response.getBody());
        return read(response.getBody());
    }

    private HttpHeaders headers(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private JsonNode read(String body) {
        try {
            return json.readTree(body == null || body.isBlank() ? "{}" : body);
        } catch (Exception parseFailure) {
            throw new IllegalStateException("unparsable body: " + body, parseFailure);
        }
    }

    private AuthResponse register(String label) {
        // Username is bounded (short, unique per test); the email carries the uniqueness.
        String username = label;
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(label + "-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, username),
                AuthResponse.class);
        assertEquals(201, response.getStatusCode().value());
        assertNotNull(response.getBody());
        return response.getBody();
    }
}
