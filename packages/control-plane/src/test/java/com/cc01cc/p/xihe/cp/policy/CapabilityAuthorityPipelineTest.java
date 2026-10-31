package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0610 W1b-1 (design §12 R2-5/R2-9): the {@code cap:<atom>} authority pipeline, end to end.
 *
 * <p>Four contract facts are pinned here, all through the real HTTP chain (H2 profile):</p>
 *
 * <ol>
 *   <li>an instance-administration capability — and <b>only</b> the capability — satisfies the
 *       URL-layer gate ({@code POST /api/v1/logs}); the caller's JWT still says {@code USER}, so a
 *       role name cannot be what allowed it;</li>
 *   <li>a plain authenticated user without the capability is 403 (and is authenticated, not 401);</li>
 *   <li>the internal service token keeps working on {@code /internal/v1/**} (service
 *       authentication is not user authorization) and is still not an instance administrator;</li>
 *   <li>an access token issued before a {@code users.token_version} bump is 401.</li>
 * </ol>
 *
 * <p>Plus the T1.9 seed fact: the bootstrap admin starts with the SUPER_ADMIN binding, so the
 * 15 action atoms are materialized and {@code cap:instance:super} resolves — before any login.</p>
 */
class CapabilityAuthorityPipelineTest extends AbstractH2Test {

    private static final String INTERNAL_TOKEN = "dev-token-not-secure";

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AccessRoleRepository accessRoleRepository;

    @Autowired
    private AccessRoleBindingRepository bindingRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private RoleGrantMaterializer materializer;

    @Autowired
    private AuthzContext authzContext;

    @Test
    void capabilityOnlyAdminPassesTheUrlLayerGate() {
        Session session = register("cap-admin-" + UUID.randomUUID() + "@test.com");
        assertEquals(HttpStatus.FORBIDDEN.value(), postLogs(session.token()),
                "control: a registered USER has no instance-administration capability");

        bindInstanceRole(session.userId(), SystemAccessRoleCatalog.ADMIN);
        assertTrue(authzContext.isInstanceAdmin(session.userId()),
                "PLAN-0610 W4a: cap:instance:admin comes from the binding — users.role is not "
                        + "mapped any more, so the capability is the only decision input");
        assertEquals(HttpStatus.OK.value(), postLogs(session.token()),
                "cap:instance:admin alone satisfies hasAuthority() on the URL layer");
    }

    @Test
    void plainAuthenticatedUserIsForbiddenButAuthenticated() {
        Session session = register("cap-user-" + UUID.randomUUID() + "@test.com");
        assertEquals(HttpStatus.OK.value(), getSessions(session.token()),
                "authenticated() still admits an ordinary user on /api/v1/**");
        assertEquals(HttpStatus.FORBIDDEN.value(), postLogs(session.token()),
                "the LOGS endpoint now requires cap:instance:admin");
        assertEquals(HttpStatus.UNAUTHORIZED.value(), getSessions(null),
                "no token stays 401");
    }

    @Test
    void internalServiceTokenKeepsItsSurfaceAndIsNotAnAdministrator() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(INTERNAL_TOKEN);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> heartbeat = restTemplate.exchange(
                baseUrl + "/internal/v1/runtime/heartbeat", HttpMethod.POST,
                new HttpEntity<>(Map.of("deviceId", "cap-pipeline-test", "status", "READY"), headers),
                Map.class);
        assertEquals(HttpStatus.OK.value(), heartbeat.getStatusCode().value(),
                "ROLE_INTERNAL_SERVICE (+ cap:internal_service) still passes /internal/v1/**");

        assertEquals(HttpStatus.FORBIDDEN.value(), postLogs(INTERNAL_TOKEN),
                "the service identity is not an instance administrator");
    }

    @Test
    void tokenIsRejectedAfterTheEpochBump() {
        Session session = register("cap-epoch-" + UUID.randomUUID() + "@test.com");
        assertEquals(HttpStatus.OK.value(), getSessions(session.token()));

        User user = userRepository.findById(session.userId()).orElseThrow();
        user.bumpTokenVersion();
        userRepository.save(user);

        assertEquals(HttpStatus.UNAUTHORIZED.value(), getSessions(session.token()),
                "a token issued before the epoch bump must not authenticate (I4/old-token 401)");
    }

    @Test
    void bootstrapAdminStartsWithSuperAdminBindingAndMaterializedAtoms() {
        User admin = userRepository.findByEmail("admin@xihe.local").orElseThrow();

        assertTrue(authzContext.isInstanceSuper(admin.getId()),
                "T1.9 seed: the bootstrap admin holds cap:instance:super before any login");
        assertTrue(authzContext.isInstanceAdmin(admin.getId()));
        assertTrue(authzContext.canWorkspaceAdmin(admin.getId(), UUID.randomUUID()),
                "instance:admin covers every workspace (decision #15 / V12)");

        List<AuthorizationGrant> rows = grantRepository.findBySubjectTypeAndSubjectIdAndSource(
                "user", admin.getId(), GrantSources.ROLE);
        assertEquals(PermissionAtomCatalog.actionAtoms().size(), rows.size(),
                "SUPER_ADMIN materializes its 15 action atoms; the 3 capability atoms are authorities");
        rows.forEach(row -> assertFalse(
                PermissionAtomCatalog.isCapabilityAtom(
                        row.getPermissions().get(0).get("actionClass").asText()),
                "capability atoms never reach grants (design #23)"));
    }

    // ---------------------------------------------------------------- helpers

    private record Session(String token, UUID userId) {
    }

    private Session register(String email) {
        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                Map.of("email", email, "password", TestDataFactory.PASSWORD, "name", "CapPipeline"),
                Map.class);
        assertEquals(HttpStatus.CREATED.value(), response.getStatusCode().value());
        Map<?, ?> body = assertNotNullBody(response.getBody());
        String token = (String) body.get("accessToken");
        Map<?, ?> user = (Map<?, ?>) body.get("user");
        assertNotNull(token, "registration must return an access token");
        assertNotNull(user, "registration must return the user view");
        return new Session(token, UUID.fromString((String) user.get("id")));
    }

    private static Map<?, ?> assertNotNullBody(Map<?, ?> body) {
        assertNotNull(body, "response body must not be empty");
        return body;
    }

    /** Replaces the subject's instance tier binding with the given system role. */
    private void bindInstanceRole(UUID userId, String roleName) {
        AccessRole role = accessRoleRepository.findByName(roleName).orElseThrow();
        bindingRepository.deleteAll(bindingRepository.findBySubjectTypeAndSubjectId("user", userId));
        bindingRepository.save(new AccessRoleBinding(role.getId(), "user", userId,
                AccessScope.INSTANCE, null, userId));
        materializer.materializeSubject("user", userId, userId, null);
    }

    private int postLogs(String token) {
        HttpHeaders headers = new HttpHeaders();
        if (token != null) {
            headers.setBearerAuth(token);
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.exchange(baseUrl + "/api/v1/logs",
                HttpMethod.POST, new HttpEntity<>(Map.of("entries", List.of()), headers), Map.class);
        return response.getStatusCode().value();
    }

    private int getSessions(String token) {
        HttpHeaders headers = new HttpHeaders();
        if (token != null) {
            headers.setBearerAuth(token);
        }
        ResponseEntity<Map> response = restTemplate.exchange(baseUrl + "/api/v1/sessions",
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
        return response.getStatusCode().value();
    }
}
