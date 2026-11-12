package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * I-6 (task-222): the cross-face criterion — {@code /api/v1/skill-bindings} and
 * {@code /api/v1/agent-principals/{id}/skills} must answer a personal (V156 {@code type=user})
 * definition <b>field-for-field identically</b> ({@code 404 SKILL_NOT_FOUND}), and each of them must
 * be identical to its own missing-id answer (otherwise the wording itself is an existence oracle).
 *
 * <p>Why a whole class instead of one test: {@code task-221} closed the user-facing face (I-4) and
 * left the principal face on the old {@code definitionScopeId != null} test, which a personal row
 * passes (A2/D-1019 keeps {@code definition_scope_id} NULL). Until both faces agree, the same id
 * would be invisible here and bindable there — the fork this class exists to forbid.</p>
 *
 * <p>Comparison excludes {@code requestId} on purpose: it is a per-request correlation id (always
 * distinct by design, and the response header carries it too), so including it would compare nothing
 * but entropy. Every contract-bearing field — {@code type}, {@code title}, {@code status},
 * {@code code}, {@code detail} — is compared.</p>
 */
class SkillBindingFaceParityContractTest extends AbstractReusableIntegrationTest {

    @Autowired
    private ObjectMapper objectMapper;

    /** Registration only echoes a workspaceId when the account already owns one. */
    @Autowired
    private com.cc01cc.p.xihe.cp.integration.WorkspaceFixture workspaceFixture;

    @Test
    void bothBindFacesAnswerAPersonalDefinitionWithTheSameBody() throws Exception {
        AuthResponse alice = register("v222-parity@test.com");
        String workspaceId = workspaceFixture.ensureOwnedWorkspace(
                UUID.fromString(alice.getUser().getId())).getId().toString();
        String personalId = importSkill(alice, Map.of("type", "user"));
        String workspaceDefinitionId = importSkill(alice, Map.of(
                "type", "workspace", "workspaceId", workspaceId));
        String principalId = createPrincipal(alice, "parity001");

        Map<String, Object> principalFace = problem(
                principalBind(alice, principalId, personalId, workspaceId));
        Map<String, Object> userFace = problem(userBind(alice, personalId));
        assertEquals(HttpStatus.NOT_FOUND.value(), principalFace.get("status"), String.valueOf(principalFace));
        assertEquals(HttpStatus.NOT_FOUND.value(), userFace.get("status"), String.valueOf(userFace));
        assertEquals("SKILL_NOT_FOUND", principalFace.get("code"));
        assertEquals("SKILL_NOT_FOUND", userFace.get("code"));
        assertSameProblemBodies(principalFace, userFace,
                "a personal definition must be the same answer on both bind faces");

        // No existence oracle: a random UUID must produce exactly the body the personal definition
        // produced on that face. If only the personal id answered with a different wording, the
        // wording would tell the caller the id exists.
        assertSameProblemBodies(principalFace,
                problem(principalBind(alice, principalId, UUID.randomUUID().toString(), workspaceId)),
                "a missing id must be indistinguishable from a personal definition (principal face)");
        assertSameProblemBodies(userFace,
                problem(userBind(alice, UUID.randomUUID().toString())),
                "a missing id must be indistinguishable from a personal definition (user face)");

        // Positive control: the principal face still works for a definition it may bind — a
        // workspace definition inside its own workspace. Without this, "always 404" would pass.
        ResponseEntity<String> bound = principalBind(alice, principalId, workspaceDefinitionId,
                workspaceId);
        assertEquals(HttpStatus.CREATED, bound.getStatusCode(), bound.getBody());
    }

    // ------------------------------------------------------------------ helpers

    private Map<String, Object> problem(ResponseEntity<String> response) throws Exception {
        Map<String, Object> fields = new LinkedHashMap<>();
        java.util.Iterator<Map.Entry<String, JsonNode>> iterator = parse(response.getBody()).fields();
        while (iterator.hasNext()) {
            Map.Entry<String, JsonNode> entry = iterator.next();
            fields.put(entry.getKey(), objectMapper.convertValue(entry.getValue(), Object.class));
        }
        return fields;
    }

    private static void assertSameProblemBodies(Map<String, Object> first, Map<String, Object> second,
                                                String message) {
        for (String field : List.of("type", "title", "status", "code", "detail")) {
            assertEquals(first.get(field), second.get(field),
                    message + " — field " + field);
        }
        assertEquals(first.size(), second.size(), "the two bodies must carry the same fields");
    }

    private String importSkill(AuthResponse owner, Map<String, Object> scope) throws Exception {
        Map<String, Object> skill = new LinkedHashMap<>();
        String name = "parity-" + UUID.randomUUID().toString().substring(0, 8);
        skill.put("name", name);
        skill.put("description", "parity fixture");
        skill.put("body", "body");
        // The import refuses a name whose source directory does not match, so derive one from the
        // other instead of hardcoding "parity" (that rejection is a rejection, not a 4xx).
        skill.put("sourcePath", ".agents/skills/" + name + "/SKILL.md");
        skill.put("attachments", List.of());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("definitionScope", scope);
        body.put("skills", List.of(skill));
        ResponseEntity<String> imported = post(owner.getAccessToken(), "/api/v1/skills/import", body,
                null);
        assertEquals(HttpStatus.OK, imported.getStatusCode(), imported.getBody());
        return parse(imported.getBody()).path("results").get(0).path("skillId").asText();
    }

    private String createPrincipal(AuthResponse owner, String name) throws Exception {
        ResponseEntity<String> created = post(owner.getAccessToken(), "/api/v1/agent-principals",
                Map.of("name", name), null);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        return parse(created.getBody()).path("principalId").asText();
    }

    private ResponseEntity<String> principalBind(AuthResponse actor, String principalId, String skillId,
                                                 String workspaceId) {
        return post(actor.getAccessToken(),
                "/api/v1/agent-principals/" + principalId + "/skills?workspaceId=" + workspaceId,
                Map.of("skillId", skillId), null);
    }

    private ResponseEntity<String> userBind(AuthResponse actor, String skillId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("skillId", skillId);
        body.put("subjectType", "user");
        body.put("subjectId", actor.getUser().getId());
        body.put("scopeType", "instance");
        return post(actor.getAccessToken(), "/api/v1/skill-bindings", body, null);
    }

    private AuthResponse register(String email) {
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "v222"),
                AuthResponse.class);
        assertTrue(response.getStatusCode().is2xxSuccessful(), String.valueOf(response.getBody()));
        return response.getBody();
    }

    private JsonNode parse(String body) throws Exception {
        return objectMapper.readTree(body);
    }

    private ResponseEntity<String> post(String token, String path, Map<String, Object> body,
                                        Map<String, String> extraHeaders) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        if (extraHeaders != null) {
            extraHeaders.forEach(headers::set);
        }
        return restTemplate.exchange(baseUrl + path, HttpMethod.POST,
                new HttpEntity<>(body, headers), String.class);
    }
}
