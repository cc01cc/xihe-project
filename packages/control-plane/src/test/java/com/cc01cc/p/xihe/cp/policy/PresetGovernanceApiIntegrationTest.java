package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.RestTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-996: the compare / realign HTTP face against a real PostgreSQL + Spring context.
 *
 * <p>These cases are deliberately end-to-end: the point of the card is that the difference a user
 * sees is exactly what the replay writes, so the assertions read the {@code grants} table
 * ({@code source}, {@code origin_preset_id}, row counts) rather than only the JSON.</p>
 */
class PresetGovernanceApiIntegrationTest extends AbstractReusableIntegrationTest {

    private static final String PASSWORD = "Gov-pass-1";

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private PresetGrantMaterializer materializer;

    @Autowired
    private AuthzContext authzContext;

    private RestTemplate api;

    @BeforeEach
    void resetState() {
        api = new RestTemplate(new JdkClientHttpRequestFactory());
        api.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
        // Custom presets from earlier cases must not survive: compare counts are derived from them.
        jdbc.update("DELETE FROM grant_preset_bindings WHERE role_id IN"
                + " (SELECT id FROM grant_presets WHERE is_system = false)");
        jdbc.update("DELETE FROM grant_preset_atoms WHERE role_id IN"
                + " (SELECT id FROM grant_presets WHERE is_system = false)");
        jdbc.update("DELETE FROM grant_presets WHERE is_system = false");
    }

    @Test
    void aLocallyDeletedAtomIsMissingAndRealignRestoresItAsAssigned() throws Exception {
        String admin = superAdmin("gov-admin-1@test.com");
        String roleId = createRole(admin, "GOV_ROLE_1", List.of("read", "write"));
        register("gov-user-1@test.com");
        String userIdValue = userIdOf(login("gov-user-1@test.com"));
        appendInstanceBinding(admin, userIdValue, roleId);

        JsonNode before = compare(admin, userIdValue);
        assertFalse(before.path("summary").path("changed").asBoolean(),
                "the binding write above materialized the atoms already: " + before);
        assertTrue(before.path("scopes").get(0).path("inSync").asBoolean(), before.toString());
        assertEquals(0, before.path("summary").path("missing").asInt(), before.toString());
        assertEquals(0, before.path("summary").path("extra").asInt(), before.toString());

        // The user deletes one imported atom locally: exactly the import row, nothing else.
        int deleted = jdbc.update("DELETE FROM grants WHERE subject_type = 'user'"
                        + " AND subject_id = CAST(? AS UUID) AND source = 'assigned'"
                        + " AND origin_preset_id = CAST(? AS UUID)"
                        + " AND permissions @> '[{\"actionClass\":\"action:read\"}]'",
                userIdValue, roleId);
        assertEquals(1, deleted, "the imported read atom row must exist before the delete");

        JsonNode drifted = compare(admin, userIdValue);
        assertEquals(1, drifted.path("summary").path("missing").asInt(), drifted.toString());
        assertTrue(drifted.path("summary").path("changed").asBoolean(), drifted.toString());
        JsonNode missingAtom = drifted.path("scopes").get(0).path("missing").get(0);
        assertEquals(AtomNames.action("read"), missingAtom.path("actionClass").asText());
        assertEquals(roleId, missingAtom.path("originPresetIds").get(0).asText(),
                "the missing atom names the group a realign re-imports from");

        ResponseEntity<String> realigned = call(HttpMethod.POST,
                "/api/v1/presets/governance/realign",
                Map.of("subjectType", "user", "subjectId", userIdValue), admin);
        assertEquals(HttpStatus.OK, realigned.getStatusCode(), realigned.getBody());
        JsonNode realignBody = objectMapper.readTree(realigned.getBody());
        assertTrue(realignBody.path("changed").asBoolean(), realigned.getBody());
        assertTrue(realignBody.path("created").asInt() >= 1, realigned.getBody());
        assertEquals(GrantSources.ASSIGNED, realignBody.path("source").asText(),
                "a realign writes the same provenance an import does: " + realigned.getBody());

        JsonNode after = compare(admin, userIdValue);
        assertTrue(after.path("scopes").get(0).path("inSync").asBoolean(), after.toString());
        assertFalse(after.path("summary").path("changed").asBoolean(), after.toString());
        assertEquals(1, countAssigned(userIdValue, roleId, AtomNames.action("read")),
                "exactly one assigned row is restored");
        assertEquals(0, countRows("SELECT COUNT(*) FROM grants WHERE subject_id = CAST(? AS UUID)"
                        + " AND source = 'preset'", userIdValue),
                "the historical 'preset' source is never written");
    }

    @Test
    void aNoOpRealignNeitherWritesNorBumpsTheEpoch() throws Exception {
        String admin = superAdmin("gov-admin-2@test.com");
        String roleId = createRole(admin, "GOV_ROLE_2", List.of("read"));
        register("gov-user-2@test.com");
        String userIdValue = userIdOf(login("gov-user-2@test.com"));
        appendInstanceBinding(admin, userIdValue, roleId);

        int before = tokenVersion(userIdValue);
        ResponseEntity<String> realigned = call(HttpMethod.POST,
                "/api/v1/presets/governance/realign",
                Map.of("subjectType", "user", "subjectId", userIdValue), admin);
        assertEquals(HttpStatus.OK, realigned.getStatusCode(), realigned.getBody());
        JsonNode body = objectMapper.readTree(realigned.getBody());
        assertFalse(body.path("changed").asBoolean(), "the subject is already in sync: " + body);
        assertEquals(0, body.path("created").asInt(), body.toString());
        assertEquals(0, body.path("deleted").asInt(), body.toString());
        assertEquals(before, tokenVersion(userIdValue),
                "a no-op realign must not log the user out (token_version unchanged)");
    }

    @Test
    void aLocalRowIsReportedAndSurvivesARealignThatRestoresTheImportRow() throws Exception {
        String admin = superAdmin("gov-admin-3@test.com");
        String roleId = createRole(admin, "GOV_ROLE_3", List.of("read"));
        String email = "gov-user-3@test.com";
        register(email);
        String userIdValue = userIdOf(login(email));
        appendInstanceBinding(admin, userIdValue, roleId);

        // Delete the imported row and add a manual replacement — the 「我删了又手加」 shape.
        jdbc.update("DELETE FROM grants WHERE subject_type = 'user'"
                        + " AND subject_id = CAST(? AS UUID) AND source = 'assigned'"
                        + " AND origin_preset_id = CAST(? AS UUID)",
                userIdValue, roleId);
        jdbc.update("INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                        + " scope_type, read_state) VALUES (gen_random_uuid(), 'user',"
                        + " CAST(? AS UUID), CAST(? AS jsonb), 'assigned', 'instance', 'read')",
                userIdValue, "[{\"actionClass\":\"action:read\"}]");

        JsonNode drifted = compare(admin, userIdValue);
        JsonNode scope = drifted.path("scopes").get(0);
        assertEquals(1, scope.path("missing").size(), drifted.toString());
        assertEquals(1, scope.path("localAdded").size(), drifted.toString());
        assertEquals(1, scope.path("overridden").size(),
                "the shadowed import atom must be visible as overridden: " + drifted);
        assertEquals(0, scope.path("extra").size(),
                "a NULL-origin row is never an extra: " + drifted);

        ResponseEntity<String> realigned = call(HttpMethod.POST,
                "/api/v1/presets/governance/realign",
                Map.of("subjectType", "user", "subjectId", userIdValue), admin);
        assertEquals(HttpStatus.OK, realigned.getStatusCode(), realigned.getBody());
        assertTrue(objectMapper.readTree(realigned.getBody()).path("changed").asBoolean(),
                realigned.getBody());

        assertEquals(1, countRows("SELECT COUNT(*) FROM grants WHERE subject_id = CAST(? AS UUID)"
                        + " AND source = 'assigned' AND origin_preset_id IS NULL", userIdValue),
                "the manual row survives the realign");
        assertEquals(1, countAssigned(userIdValue, roleId, AtomNames.action("read")),
                "the import row is restored alongside the local one");
    }

    @Test
    void aPlainUserGets403WithoutLearningTheTarget() throws Exception {
        register("gov-target-4@test.com");
        String targetId = userIdOf(login("gov-target-4@test.com"));
        String plain = register("gov-plain-4@test.com");

        ResponseEntity<String> denied = call(HttpMethod.GET,
                "/api/v1/presets/governance/compare?subjectType=user&subjectId=" + targetId,
                null, plain);
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), denied.getBody());
        String deniedBody = denied.getBody() == null ? "" : denied.getBody();
        assertFalse(deniedBody.contains(targetId),
                "a 403 must not name the target subject: " + deniedBody);
        assertFalse(deniedBody.contains("gov-target-4@test.com"),
                "a 403 must not leak the target's email: " + deniedBody);
    }

    @Test
    void anUnknownSubjectIs404OnlyForAnAuthorizedCaller() throws Exception {
        String admin = superAdmin("gov-admin-5@test.com");
        String unknown = UUID.randomUUID().toString();

        ResponseEntity<String> notFound = call(HttpMethod.GET,
                "/api/v1/presets/governance/compare?subjectType=user&subjectId=" + unknown,
                null, admin);
        assertEquals(HttpStatus.NOT_FOUND, notFound.getStatusCode(), notFound.getBody());
        assertEquals("SUBJECT_NOT_FOUND",
                objectMapper.readTree(notFound.getBody()).path("code").asText());

        String plain = register("gov-plain-5@test.com");
        ResponseEntity<String> denied = call(HttpMethod.GET,
                "/api/v1/presets/governance/compare?subjectType=user&subjectId=" + unknown,
                null, plain);
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "authorization runs before the existence probe: " + denied.getBody());
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private JsonNode compare(String token, String subjectId) throws Exception {
        ResponseEntity<String> response = call(HttpMethod.GET,
                "/api/v1/presets/governance/compare?subjectType=user&subjectId=" + subjectId,
                null, token);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody());
    }

    private int countAssigned(String subjectId, String roleId, String actionClass) {
        return countRows("SELECT COUNT(*) FROM grants WHERE subject_type = 'user'"
                + " AND subject_id = CAST(? AS UUID) AND source = 'assigned'"
                + " AND origin_preset_id = CAST(? AS UUID)"
                + " AND permissions @> CAST(? AS jsonb)",
                subjectId, roleId, "[{\"actionClass\":\"" + actionClass + "\"}]");
    }

    /** Instance-scope binding set as PUT-ready pairs (the PUT is a full replacement). */
    private List<Map<String, String>> instanceBindings(String token) throws Exception {
        ResponseEntity<String> listed = call(HttpMethod.GET, "/api/v1/bindings?scope=instance",
                null, token);
        assertEquals(HttpStatus.OK, listed.getStatusCode(), listed.getBody());
        List<Map<String, String>> pairs = new ArrayList<>();
        for (JsonNode binding : objectMapper.readTree(listed.getBody()).path("bindings")) {
            pairs.add(Map.of("subjectId", binding.path("subjectId").asText(),
                    "presetId", binding.path("presetId").asText()));
        }
        return pairs;
    }

    private void appendInstanceBinding(String token, String subjectId, String roleId)
            throws Exception {
        List<Map<String, String>> desired = new ArrayList<>(instanceBindings(token));
        desired.add(Map.of("subjectId", subjectId, "presetId", roleId));
        ResponseEntity<String> replaced = call(HttpMethod.PUT, "/api/v1/bindings?scope=instance",
                Map.of("bindings", desired), token);
        assertEquals(HttpStatus.OK, replaced.getStatusCode(), replaced.getBody());
    }

    private String createRole(String token, String name, List<String> atoms) throws Exception {
        ResponseEntity<String> created = call(HttpMethod.POST, "/api/v1/presets",
                Map.of("name", name, "displayName", name, "atoms", atoms), token);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        return objectMapper.readTree(created.getBody()).path("id").asText();
    }

    private ResponseEntity<String> call(HttpMethod method, String path, Object body, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        return api.exchange(url(path), method, new HttpEntity<>(body, headers), String.class);
    }

    private String superAdmin(String email) throws Exception {
        register(email);
        String userId = userIdOf(login(email));
        grantInstanceRole(userId, SystemGrantPresetCatalog.SUPER_ADMIN);
        return login(email);
    }

    private String register(String email) throws Exception {
        ResponseEntity<String> response = api.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", email, "password", PASSWORD, "name", "Gov"), String.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String login(String email) throws Exception {
        ResponseEntity<String> response = api.postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", email, "password", PASSWORD), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String userIdOf(String token) {
        return jwtTokenProvider.getUserIdFromToken(token);
    }

    private void grantInstanceRole(String userId, String roleName) {
        jdbc.update("DELETE FROM grant_preset_bindings WHERE subject_type = 'user'"
                + " AND subject_id = CAST(? AS UUID) AND scope_type = 'instance'", userId);
        jdbc.update("INSERT INTO grant_preset_bindings (id, role_id, subject_type, subject_id,"
                        + " scope_type, granted_at) SELECT CAST(? AS UUID), r.id, 'user',"
                        + " CAST(? AS UUID), 'instance', NOW() FROM grant_presets r WHERE r.name = ?",
                UUID.randomUUID().toString(), userId, roleName);
        materializer.materializeSubject(AuthzContext.SUBJECT_USER, UUID.fromString(userId), null,
                null);
        authzContext.invalidate(UUID.fromString(userId));
    }

    private int tokenVersion(String userId) {
        Integer value = jdbc.queryForObject("SELECT token_version FROM users"
                + " WHERE id = CAST(? AS UUID)", Integer.class, userId);
        return value == null ? 0 : value;
    }

    private int countRows(String sql, Object... args) {
        Integer count = jdbc.queryForObject(sql, Integer.class, args);
        return count == null ? 0 : count;
    }

}
