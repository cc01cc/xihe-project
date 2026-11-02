package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M1 (taskbook T6): the seven `/api/v1/skill*` routes against a real Tomcat.
 *
 * <p>Scope note: the full admin-side 403 matrix needs an instance-administration grant fixture,
 * which this batch does not have; what is asserted here is everything a plain registered user can
 * reach, plus the two read-surface semantics that are most likely to be "simplified" into 403 by a
 * later change:</p>
 *
 * <ul>
 *   <li>a workspace-scope definition is <b>404 SKILL_NOT_FOUND</b>, never 403, to a caller who
 *       cannot see that workspace — the difference between the codes is an existence oracle;</li>
 *   <li>listing a workspace library you are not a member of is an <b>empty set</b>, not 403, for the
 *       same reason.</li>
 * </ul>
 */
class SkillControllerContractTest extends AbstractIntegrationTest {

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private ObjectMapper objectMapper;

    /** PLAN-0610: instance administration is a DB binding, so the fixture grants it, not a token. */
    @Autowired
    private AccessRoleBindingRepository bindingRepository;

    @Autowired
    private AccessRoleRepository accessRoleRepository;

    @Autowired
    private AuthzContext authzContext;

    private static final String[] SKILL_ROUTES = {
            "/api/v1/skills/import",
            "/api/v1/skills",
            "/api/v1/skills/" + UUID.randomUUID(),
            "/api/v1/skills/" + UUID.randomUUID() + "/bindings",
            "/api/v1/skill-bindings",
            "/api/v1/skill-bindings/" + UUID.randomUUID(),
    };

    @Test
    void everySkillRouteRefusesAnAnonymousCaller() {
        for (String route : SKILL_ROUTES) {
            HttpMethod method = route.endsWith("/import") || route.equals("/api/v1/skill-bindings")
                    ? HttpMethod.POST : HttpMethod.GET;
            ResponseEntity<String> response = restTemplate.exchange(baseUrl + route, method,
                    new HttpEntity<>(new HttpHeaders()), String.class);
            assertTrue(response.getStatusCode() == HttpStatus.UNAUTHORIZED
                            || response.getStatusCode() == HttpStatus.FORBIDDEN,
                    route + " must not be anonymous-accessible, got " + response.getStatusCode());
        }
    }

    @Test
    void aPlainUserMayNotImportIntoTheInstanceLibrary() {
        String token = register("0628-plain@test.com");

        ResponseEntity<String> response = post(token, "/api/v1/skills/import",
                Map.of("definitionScope", Map.of("type", "instance"),
                        "skills", List.of(item("writing", "do the thing"))));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), response.getBody());
        assertEquals("SKILL_IMPORT_FORBIDDEN", problemCode(response.getBody()));
    }

    /**
     * The positive half of the same gate. Without it the 403 above cannot distinguish "correctly
     * refused" from "always refused" — a one-directional matrix says nothing about whether the
     * authorization check evaluates anything at all.
     *
     * <p>The grant path is copied from {@code LocalModeSuperAdminBootstrapTest}
     * ({@code grantDefaultService.ensureInstanceSuperAdmin} + {@code authzContext.invalidate}), not
     * invented here.</p>
     */
    @Test
    void anInstanceAdministratorMayImportIntoTheInstanceLibrary() {
        AuthResponse registered = registerAuth("0628-admin@test.com");
        UUID userId = UUID.fromString(registered.getUser().getId());
        // Copied from LocalModeSuperAdminBootstrapTest#downgradeTo: instance administration is an
        // AccessRoleBinding at instance scope, and the capability projection is cached per user, so
        // the grant is invisible until invalidation. (ensureInstanceSuperAdmin additionally requires
        // the instance-owner singleton, which a fresh DB does not have — hence the explicit binding.)
        UUID adminRoleId = accessRoleRepository
                .findByName(SystemAccessRoleCatalog.ADMIN).orElseThrow().getId();
        bindingRepository.save(new AccessRoleBinding(adminRoleId, "user", userId,
                AccessScope.INSTANCE, null, userId));
        authzContext.invalidate(userId);

        ResponseEntity<String> response = post(registered.getAccessToken(), "/api/v1/skills/import",
                Map.of("definitionScope", Map.of("type", "instance"),
                        "skills", List.of(item("writing", "do the thing"))));

        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        JsonNode body = parse(response.getBody());
        assertEquals("created", body.path("results").get(0).path("action").asText(),
                response.getBody());
        assertEquals(1, body.path("summary").path("created").asInt(), response.getBody());
        // The request never carried the bookkeeping fields, and the response does not echo a hash.
        assertTrue(body.path("results").get(0).path("contentHash").isMissingNode(),
                "contentHash must not be echoed: " + response.getBody());
    }

    @Test
    void importRequestShapeErrors() {
        String token = register("0628-shape@test.com");

        // Missing definitionScope.
        ResponseEntity<String> missing = post(token, "/api/v1/skills/import",
                Map.of("skills", List.of(item("writing", "b"))));
        assertEquals(HttpStatus.BAD_REQUEST, missing.getStatusCode(), missing.getBody());
        assertEquals("INVALID_REQUEST", problemCode(missing.getBody()));

        // Workspace scope without a workspaceId.
        ResponseEntity<String> noWorkspace = post(token, "/api/v1/skills/import",
                Map.of("definitionScope", Map.of("type", "workspace"),
                        "skills", List.of(item("writing", "b"))));
        assertEquals(HttpStatus.BAD_REQUEST, noWorkspace.getStatusCode(), noWorkspace.getBody());
    }

    @Test
    void aMalformedIdIsABadRequestNotAServerError() {
        String token = register("0628-badid@test.com");

        ResponseEntity<String> response = get(token, "/api/v1/skills/not-a-uuid");
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), response.getBody());
        assertEquals("INVALID_REQUEST", problemCode(response.getBody()));
    }

    /**
     * The owner imports into its own workspace library; then the two read-surface semantics are
     * asserted from a <b>second</b> user's point of view.
     */
    @Test
    void aWorkspacePrivateDefinitionIsInvisibleToANonMemberAndSaysSoAs404() throws Exception {
        AuthResponse owner = registerAuth("0628-owner@test.com");
        AuthResponse stranger = registerAuth("0628-stranger@test.com");
        UUID workspaceId = workspaceFixture.createOwnedWorkspace("0628 skills ws",
                owner.getUser().getId()).getId();

        ResponseEntity<String> imported = post(owner.getAccessToken(), "/api/v1/skills/import",
                Map.of("definitionScope", Map.of("type", "workspace",
                                "workspaceId", workspaceId.toString()),
                        "skills", List.of(item("private-skill", "only for this workspace"))));
        assertEquals(HttpStatus.OK, imported.getStatusCode(), imported.getBody());
        JsonNode body = objectMapper.readTree(imported.getBody());
        assertEquals("created", body.path("results").get(0).path("action").asText(), imported.getBody());
        String skillId = body.path("results").get(0).path("skillId").asText();
        assertNotNull(skillId);

        // 1) Non-member listing the workspace library: empty set, NOT 403.
        ResponseEntity<String> listed = get(stranger.getAccessToken(),
                "/api/v1/skills?definitionScope=workspace&workspaceId=" + workspaceId);
        assertEquals(HttpStatus.OK, listed.getStatusCode(), listed.getBody());
        assertEquals(0, objectMapper.readTree(listed.getBody()).path("items").size(),
                "a non-member must get an empty set: " + listed.getBody());

        // 2) Non-member reading the definition by id: 404 SKILL_NOT_FOUND, NOT 403.
        ResponseEntity<String> direct = get(stranger.getAccessToken(), "/api/v1/skills/" + skillId);
        assertEquals(HttpStatus.NOT_FOUND, direct.getStatusCode(),
                "must not reveal existence: " + direct.getBody());
        assertEquals("SKILL_NOT_FOUND", problemCode(direct.getBody()));

        // 3) …and the bindings of an invisible definition behave the same way.
        ResponseEntity<String> bindingList = get(stranger.getAccessToken(),
                "/api/v1/skills/" + skillId + "/bindings");
        assertEquals(HttpStatus.NOT_FOUND, bindingList.getStatusCode(), bindingList.getBody());

        // 4) The owner still sees it, so the assertions above are about visibility, not about a
        //    definition that failed to be created.
        ResponseEntity<String> ownerView = get(owner.getAccessToken(), "/api/v1/skills/" + skillId);
        assertEquals(HttpStatus.OK, ownerView.getStatusCode(), ownerView.getBody());
        assertEquals("private-skill",
                objectMapper.readTree(ownerView.getBody()).path("name").asText());
        // The body is not sent unless asked for.
        assertTrue(objectMapper.readTree(ownerView.getBody()).path("body").isNull()
                        || objectMapper.readTree(ownerView.getBody()).path("body").isMissingNode(),
                ownerView.getBody());
    }

    // ------------------------------------------------------------------ helpers

    private static Map<String, Object> item(String name, String body) {
        Map<String, Object> skill = new LinkedHashMap<>();
        skill.put("name", name);
        skill.put("description", "desc of " + name);
        skill.put("body", body);
        skill.put("sourcePath", ".agents/skills/" + name + "/SKILL.md");
        skill.put("attachments", List.of());
        skill.put("trusted", false);
        return skill;
    }

    private String register(String email) {
        return registerAuth(email).getAccessToken();
    }

    private AuthResponse registerAuth(String email) {
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "0628"),
                AuthResponse.class);
        assertTrue(response.getStatusCode().is2xxSuccessful(), String.valueOf(response.getBody()));
        return response.getBody();
    }

    private JsonNode parse(String body) {
        try {
            return objectMapper.readTree(body);
        } catch (Exception e) {
            throw new AssertionError("unparseable body: " + body, e);
        }
    }

    private ResponseEntity<String> get(String token, String path) {
        return restTemplate.exchange(baseUrl + path, HttpMethod.GET,
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

    private String problemCode(String body) {
        try {
            return objectMapper.readTree(body).path("code").asText();
        } catch (Exception e) {
            return "<unparseable: " + body + ">";
        }
    }
}
