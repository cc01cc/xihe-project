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
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * V156 / task-221: the personal skill layer's <b>negative cases</b> against a real Tomcat + PostgreSQL.
 *
 * <p>Every assertion here is a refusal shape, because the feature's risk lives in the refusals:</p>
 *
 * <ul>
 *   <li>another owner's definition is the <b>same 404 SKILL_NOT_FOUND</b> a random UUID gets — a
 *       different code would be an existence oracle;</li>
 *   <li>a {@code type:user} import that carries {@code trusted} (even {@code false}), a
 *       {@code userId} or a {@code workspaceId} is a whole-request {@code 400 INVALID_REQUEST} with
 *       <b>zero rows written</b> — the old code silently mapped every unknown type to the instance
 *       library (I-1), which is exactly what this file would catch;</li>
 *   <li>personal definitions are never bindable: {@code 404 SKILL_NOT_FOUND}, not
 *       {@code 400 SKILL_DEFINITION_OUT_OF_SCOPE} (the 400 wording told the caller the id <i>is</i>
 *       a definition);</li>
 *   <li>the write atom is default-granted, and revoking it turns writes into {@code 403} while
 *       reads stay open (P-189-3: deliberately separate decisions).</li>
 * </ul>
 */
class SkillPersonalLayerContractTest extends AbstractReusableIntegrationTest {

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbc;

    // ------------------------------------------------------------------ happy path (the default grant)

    @Test
    void aPlainUserImportsIntoItsOwnPersonalLibrary() throws Exception {
        AuthResponse alice = register("v156-alice@test.com");

        ResponseEntity<String> imported = post(alice.getAccessToken(), "/api/v1/skills/import",
                personalBody(item("writing", "do the thing")));
        assertEquals(HttpStatus.OK, imported.getStatusCode(), imported.getBody());
        JsonNode body = parse(imported.getBody());
        assertEquals("created", body.path("results").get(0).path("action").asText(), imported.getBody());
        assertEquals(1, body.path("summary").path("created").asInt(), imported.getBody());

        // The row really landed in the personal layer, not in the instance library (I-1 regression).
        ResponseEntity<String> personal = get(alice.getAccessToken(),
                "/api/v1/skills?definitionScope=user");
        JsonNode personalItems = parse(personal.getBody()).path("items");
        assertEquals(1, personalItems.size(), personal.getBody());
        assertEquals("writing", personalItems.get(0).path("name").asText());
        assertEquals("user", personalItems.get(0).path("definitionScope").path("type").asText(),
                "the row must be a user-scope definition: " + personal.getBody());

        ResponseEntity<String> instance = get(alice.getAccessToken(), "/api/v1/skills");
        assertEquals(0, parse(instance.getBody()).path("items").size(),
                "the default listing is the instance library and must contain no personal row: "
                        + instance.getBody());
    }

    // ------------------------------------------------------------------ N1: the owner-only read

    @Test
    void anotherUsersPersonalDefinitionIsTheSame404AsARandomUuid() throws Exception {
        AuthResponse alice = register("v156-owner2@test.com");
        AuthResponse bob = register("v156-stranger2@test.com");
        String skillId = importPersonal(alice, "writing");

        ResponseEntity<String> other = get(bob.getAccessToken(), "/api/v1/skills/" + skillId);
        ResponseEntity<String> random = get(bob.getAccessToken(),
                "/api/v1/skills/" + UUID.randomUUID());
        assertEquals(HttpStatus.NOT_FOUND, other.getStatusCode(), other.getBody());
        assertEquals(HttpStatus.NOT_FOUND, random.getStatusCode(), random.getBody());
        assertEquals("SKILL_NOT_FOUND", problemCode(other.getBody()));
        assertEquals(problemCode(random.getBody()), problemCode(other.getBody()),
                "another owner's definition must be indistinguishable from a random UUID");
        assertEquals(parse(random.getBody()).path("detail").asText(),
                parse(other.getBody()).path("detail").asText(),
                "same code AND same wording — otherwise the wording is an oracle");

        // The owner still sees it: the assertion above is about visibility, not a lost row.
        ResponseEntity<String> owner = get(alice.getAccessToken(), "/api/v1/skills/" + skillId);
        assertEquals(HttpStatus.OK, owner.getStatusCode(), owner.getBody());
    }

    // ------------------------------------------------------------------ N2: the owner-only delete

    @Test
    void anotherUserCannotDeleteAPersonalDefinition() throws Exception {
        AuthResponse alice = register("v156-owner3@test.com");
        AuthResponse bob = register("v156-stranger3@test.com");
        String skillId = importPersonal(alice, "writing");

        ResponseEntity<String> deleted = delete(bob.getAccessToken(), "/api/v1/skills/" + skillId);
        assertEquals(HttpStatus.NOT_FOUND, deleted.getStatusCode(), deleted.getBody());
        assertEquals("SKILL_NOT_FOUND", problemCode(deleted.getBody()),
                "must not be 403 or 204: existence is not disclosed to a non-owner");

        ResponseEntity<String> stillThere = get(alice.getAccessToken(), "/api/v1/skills/" + skillId);
        assertEquals(HttpStatus.OK, stillThere.getStatusCode(),
                "the refusal must not have deleted the row: " + stillThere.getBody());

        ResponseEntity<String> byOwner = delete(alice.getAccessToken(), "/api/v1/skills/" + skillId);
        assertEquals(HttpStatus.NO_CONTENT, byOwner.getStatusCode(), byOwner.getBody());
    }

    // ------------------------------------------------------------------ N3: the write atom

    @Test
    void revokingTheAtomForbidsPersonalWritesButKeepsPersonalReadsOpen() throws Exception {
        AuthResponse alice = register("v156-revoke@test.com");
        String skillId = importPersonal(alice, "writing");

        jdbc.update("DELETE FROM grants WHERE subject_type = 'user' AND subject_id = ? "
                + "AND permissions->0->>'actionClass' = 'MANAGE_PERSONAL_SKILLS'",
                UUID.fromString(alice.getUser().getId()));

        ResponseEntity<String> refused = post(alice.getAccessToken(), "/api/v1/skills/import",
                personalBody(item("second", "another one")));
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatusCode(), refused.getBody());
        assertEquals("SKILL_IMPORT_FORBIDDEN", problemCode(refused.getBody()),
                "the personal write face refuses through the same code as the instance library");

        ResponseEntity<String> personal = get(alice.getAccessToken(),
                "/api/v1/skills?definitionScope=user");
        assertEquals(1, parse(personal.getBody()).path("items").size(),
                "reads stay open: 0 new rows AND the existing one is still listed — "
                        + personal.getBody());
        assertFalse(parse(personal.getBody()).path("items").toString().contains("\"second\""),
                "the refused request wrote nothing: " + personal.getBody());
        ResponseEntity<String> read = get(alice.getAccessToken(), "/api/v1/skills/" + skillId);
        assertEquals(HttpStatus.OK, read.getStatusCode(),
                "P-189-3: revoking the write atom must not close the read surface: " + read.getBody());
    }

    // ------------------------------------------------------------------ N4: trusted is not accepted at all

    @Test
    void personalImportRefusesTheTrustedMemberEvenWhenFalse() throws Exception {
        AuthResponse alice = register("v156-trusted@test.com");

        for (Object trustedValue : List.of(Boolean.TRUE, Boolean.FALSE)) {
            Map<String, Object> item = item("writing", "do the thing");
            item.put("trusted", trustedValue);
            ResponseEntity<String> refused = post(alice.getAccessToken(), "/api/v1/skills/import",
                    personalBody(item));
            assertEquals(HttpStatus.BAD_REQUEST, refused.getStatusCode(),
                    "trusted=" + trustedValue + " must be refused as a whole request: " + refused.getBody());
            assertEquals("INVALID_REQUEST", problemCode(refused.getBody()));
        }
        assertEquals(0, personalCount(alice), "a refused request writes zero rows");
    }

    // ------------------------------------------------------------------ N5/N6: body members that must not exist

    @Test
    void personalImportRefusesAUserIdMember() throws Exception {
        AuthResponse alice = register("v156-userid@test.com");
        AuthResponse bob = register("v156-userid-other@test.com");

        Map<String, Object> scope = new LinkedHashMap<>();
        scope.put("type", "user");
        scope.put("userId", bob.getUser().getId().toString());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("definitionScope", scope);
        body.put("skills", List.of(item("n5-probe", "do the thing")));

        ResponseEntity<String> refused = post(alice.getAccessToken(), "/api/v1/skills/import", body);
        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatusCode(), refused.getBody());
        assertEquals("INVALID_REQUEST", problemCode(refused.getBody()),
                "the schema has no userId member; an attempt to address another owner is a 400");

        // The acceptance asks for a real count, not only a re-read through the API: the refused
        // request must have written zero rows anywhere — neither for the caller, nor for the
        // addressed owner, nor into the instance library (the I-1 leak this card closes).
        assertEquals(0, jdbc.queryForObject(
                "SELECT count(*) FROM skills WHERE name = 'n5-probe'", Integer.class),
                "SELECT count(*) must stay 0 after a refused import");
        assertEquals(0, jdbc.queryForObject(
                "SELECT count(*) FROM skills WHERE definition_scope_type = 'user' "
                        + "AND definition_scope_user_id IN (?, ?)", Integer.class,
                UUID.fromString(alice.getUser().getId()),
                UUID.fromString(bob.getUser().getId())),
                "no personal row may exist for either of the two users");
        assertEquals(0, jdbc.queryForObject(
                "SELECT count(*) FROM skills WHERE definition_scope_type = 'instance' "
                        + "AND name = 'n5-probe'", Integer.class),
                "and nothing may fall back to the instance library (I-1)");

        assertEquals(0, personalCount(alice), "the API listing agrees with the SQL count");
        assertEquals(0, personalCount(bob));
        assertEquals(0, parse(get(alice.getAccessToken(), "/api/v1/skills").getBody())
                .path("items").size());
    }

    @Test
    void personalImportRefusesAWorkspaceIdMember() throws Exception {
        AuthResponse alice = register("v156-wsid@test.com");
        Map<String, Object> scope = new LinkedHashMap<>();
        scope.put("type", "user");
        scope.put("workspaceId", UUID.randomUUID().toString());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("definitionScope", scope);
        body.put("skills", List.of(item("writing", "do the thing")));

        ResponseEntity<String> refused = post(alice.getAccessToken(), "/api/v1/skills/import", body);
        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatusCode(), refused.getBody());
        assertEquals("INVALID_REQUEST", problemCode(refused.getBody()));
        assertEquals(0, personalCount(alice));
    }

    // ------------------------------------------------------------------ N7: always untrusted

    @Test
    void personalDefinitionsAreAlwaysUntrusted() throws Exception {
        AuthResponse alice = register("v156-untrusted@test.com");
        String skillId = importPersonal(alice, "writing");

        JsonNode view = parse(get(alice.getAccessToken(),
                "/api/v1/skills/" + skillId + "?includeBody=true").getBody());
        assertFalse(view.path("trusted").asBoolean(), "a personal definition is always untrusted");
    }

    // ------------------------------------------------------------------ N8: listing isolation

    @Test
    void listingThePersonalLibraryNeverShowsAnotherOwner() throws Exception {
        AuthResponse alice = register("v156-list-a@test.com");
        AuthResponse bob = register("v156-list-b@test.com");
        importPersonal(alice, "alice-only");
        importPersonal(bob, "bob-only");

        String aliceList = get(alice.getAccessToken(), "/api/v1/skills?definitionScope=user").getBody();
        String bobList = get(bob.getAccessToken(), "/api/v1/skills?definitionScope=user").getBody();
        assertEquals(1, parse(aliceList).path("items").size(), aliceList);
        assertEquals(1, parse(bobList).path("items").size(), bobList);
        assertTrue(parse(aliceList).path("items").toString().contains("alice-only"), aliceList);
        assertFalse(parse(aliceList).path("items").toString().contains("bob-only"),
                "another owner's row must never appear: " + aliceList);
        assertFalse(parse(bobList).path("items").toString().contains("alice-only"), bobList);
    }

    // ------------------------------------------------------------------ I-4: never bindable

    @Test
    void bindingAPersonalDefinitionIsA404NotA400() throws Exception {
        AuthResponse alice = register("v156-bind@test.com");
        String skillId = importPersonal(alice, "writing");

        Map<String, Object> bind = new LinkedHashMap<>();
        bind.put("skillId", skillId);
        bind.put("subjectType", "user");
        bind.put("subjectId", alice.getUser().getId().toString());
        bind.put("scopeType", "instance");
        ResponseEntity<String> refused = post(alice.getAccessToken(), "/api/v1/skill-bindings", bind);
        assertEquals(HttpStatus.NOT_FOUND, refused.getStatusCode(), refused.getBody());
        assertEquals("SKILL_NOT_FOUND", problemCode(refused.getBody()),
                "I-4: the personal definition is never bindable, and the refusal is the invisibility"
                        + " code (a 400 with a definition wording would reveal it exists)");
    }

    // ------------------------------------------------------------------ helpers

    private static Map<String, Object> personalBody(Map<String, Object> skill) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("definitionScope", Map.of("type", "user"));
        body.put("skills", List.of(skill));
        return body;
    }

    private static Map<String, Object> item(String name, String body) {
        Map<String, Object> skill = new LinkedHashMap<>();
        skill.put("name", name);
        skill.put("description", "desc of " + name);
        skill.put("body", body);
        skill.put("sourcePath", ".agents/skills/" + name + "/SKILL.md");
        skill.put("attachments", List.of());
        return skill;
    }

    private String importPersonal(AuthResponse owner, String name) throws Exception {
        ResponseEntity<String> imported = post(owner.getAccessToken(), "/api/v1/skills/import",
                personalBody(item(name, "body of " + name)));
        assertEquals(HttpStatus.OK, imported.getStatusCode(), imported.getBody());
        String skillId = parse(imported.getBody()).path("results").get(0).path("skillId").asText();
        assertNotNull(skillId, imported.getBody());
        return skillId;
    }

    private int personalCount(AuthResponse owner) throws Exception {
        String list = get(owner.getAccessToken(), "/api/v1/skills?definitionScope=user").getBody();
        return parse(list).path("items").size();
    }

    private AuthResponse register(String email) {
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "v156"),
                AuthResponse.class);
        assertTrue(response.getStatusCode().is2xxSuccessful(), String.valueOf(response.getBody()));
        return response.getBody();
    }

    private JsonNode parse(String body) throws Exception {
        return objectMapper.readTree(body);
    }

    private String problemCode(String body) throws Exception {
        return parse(body).path("code").asText();
    }

    private ResponseEntity<String> get(String token, String path) {
        return restTemplate.exchange(baseUrl + path, HttpMethod.GET,
                new HttpEntity<>(bearer(token)), String.class);
    }

    private ResponseEntity<String> delete(String token, String path) {
        return restTemplate.exchange(baseUrl + path, HttpMethod.DELETE,
                new HttpEntity<>(bearer(token)), String.class);
    }

    private ResponseEntity<String> post(String token, String path, Map<String, Object> body) {
        return restTemplate.exchange(baseUrl + path, HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), String.class);
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return headers;
    }
}
