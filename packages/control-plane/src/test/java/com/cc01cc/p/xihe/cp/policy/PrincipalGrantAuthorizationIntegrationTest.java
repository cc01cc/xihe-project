package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0610 W2 / decision #28: the retired PLAN-0585 grant surface no longer unlocks the two gates
 * it existed for, and it must not write anything on the way out.
 *
 * <p>The old scenario (admin grants {@code CREATE_ACCOUNT} → agent-principal creation becomes 201)
 * is replaced by access-role bindings in W3; this test only asserts the retirement contract and the
 * untouched default-deny baseline around agent-principal creation.</p>
 *
 * <p><b>BL-326 (2026-11-05 Lead ruling):</b> agent-principal creation is gated in <b>two layers</b>,
 * and both must stay pinned — (1) <b>precondition</b>: no resolvable workspace context ⇒
 * {@code 409 WORKSPACE_CONTEXT_REQUIRED} (the request never reaches an authorization decision,
 * because without a context there is nothing to decide); (2) <b>atom gate</b>: with a valid context,
 * a subject lacking {@code MANAGE_WORKSPACE_AGENTS} ⇒ {@code 403}. Asserting only the 409 would let
 * the atom gate disappear unnoticed; asserting only the 403 would let the context precondition drift
 * behind it.</p>
 */
class PrincipalGrantAuthorizationIntegrationTest extends AbstractIntegrationTest {

    private RestTemplate patchClient;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    private String adminToken;
    private String targetUsername;
    private UUID adminUserId;

    @BeforeEach
    void usePatchCapableClient() {
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) throws IOException {
                return response.getStatusCode().is5xxServerError();
            }
        });
    }

    private void fixture() {
        User admin = userRepository.saveAndFlush(new User("grant-auth-admin-" + UUID.randomUUID() + "@test.com", "hash",
                "Grant auth admin", "grantadmin" + shortId()));
        User target = userRepository.saveAndFlush(new User("grant-auth-target-" + UUID.randomUUID() + "@test.com", "hash",
                "Grant auth target", "granttarget" + shortId()));
        targetUsername = target.getUsername();
        adminUserId = admin.getId();
        grantInstanceAdmin(admin.getId());
        adminToken = TestDataFactory.createGlobalToken(admin.getId().toString(), admin.getEmail(), "ADMIN", 0);
    }

    /**
     * PLAN-0610 W4a: an instance administrator is a binding holder (the retired {@code users.role}
     * column never authorizes). Capability atoms are never materialized, so no grant row is needed
     * for {@code cap:instance:admin} to reach the request authorities; the cache is dropped because
     * the row is written behind {@code AuthzContext}'s back.
     */
    private void grantInstanceAdmin(UUID userId) {
        jdbcTemplate.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                + " granted_at) SELECT gen_random_uuid(), r.id, 'user', CAST(? AS UUID), 'instance',"
                + " NOW() FROM roles r WHERE r.name = 'ADMIN'", userId);
        authzContext.invalidateAll();
    }

    private static String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    @Test
    void grantingCreateAccountIsRetiredAndWritesNoGrantRow() {
        fixture();
        int grantsBefore = grantRepository.findAll().size();
        int auditBefore = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant'", Integer.class);

        ResponseEntity<Map> response = patch(Map.of(
                "add", List.of(Map.of("actionClass", "CREATE_ACCOUNT"))));

        assertEquals(HttpStatus.GONE, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(PrincipalGrantAdminService.RETIRED_CODE, response.getBody().get("code"));
        assertEquals(grantsBefore, grantRepository.findAll().size(),
                "no grant row may be written by the retired surface");
        assertEquals(auditBefore, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant'", Integer.class),
                "no principal_grant audit row may be written by the retired surface");
    }

    @Test
    void withoutWorkspaceContextTheRequestStopsBeforeTheAtomGate() {
        fixture();
        // Layer 1 of 2 (BL-326): a principal with neither workspace:admin nor the management atoms
        // still answers 409 WORKSPACE_CONTEXT_REQUIRED — the precondition check fires before any
        // authorization decision. Contract: docs/api/openapi.yaml → components/responses/
        // WorkspaceContextRequired ("a request-state conflict, never a 401").
        User plain = userRepository.saveAndFlush(new User(
                "grant-auth-plain-" + UUID.randomUUID() + "@test.com", "hash",
                "Grant auth plain", "grantplain" + shortId()));
        String plainToken = TestDataFactory.createGlobalToken(
                plain.getId().toString(), plain.getEmail(), "USER", 0);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(plainToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> created = patchClient.exchange(
                url("/api/v1/agent-principals"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "noContextProbe"), headers), Map.class);

        assertEquals(HttpStatus.CONFLICT, created.getStatusCode(),
                "no workspace context ⇒ the precondition layer fails closed (409), not the atom gate");
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", created.getBody().get("code"));
    }

    @Test
    void withWorkspaceContextTheAtomGateStillFailsClosedForAPlainMember() {
        fixture();
        // Layer 2 of 2 (BL-326): the security intent of the original test. The caller now HAS a valid
        // workspace context (member of the admin's workspace), so the request reaches the atom gate
        // and must be refused for lacking MANAGE_WORKSPACE_AGENTS — a 201 here would mean the atom
        // gate disappeared while the context precondition still answered 409 above.
        User plain = userRepository.saveAndFlush(new User(
                "grant-auth-member-" + UUID.randomUUID() + "@test.com", "hash",
                "Grant auth member", "grantmember" + shortId()));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("grant-auth-ctx-ws", adminUserId.toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId(), plain.getId(), WorkspaceRole.MEMBER);
        String plainToken = TestDataFactory.createGlobalToken(
                plain.getId().toString(), plain.getEmail(), "USER", 0);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(plainToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Workspace-Id", workspace.getId().toString());
        ResponseEntity<Map> created = patchClient.exchange(
                url("/api/v1/agent-principals"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "atomGateProbe"), headers), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, created.getStatusCode(),
                "a workspace MEMBER holds no MANAGE_WORKSPACE_AGENTS: the atom gate must refuse, "
                        + "not the context precondition");
    }

    @Test
    void administratorWithoutWorkspaceContextIsToldTheContextIsRequired() {
        fixture();
        // PLAN-0651 M1 `f261a5cf` (D51-11): workspace:admin is now part of ADMIN, so the same request
        // that used to fall through to 403 now hits the explicit CONTEXT-REQUIRED branch
        // (AgentPrincipalService:250-262). Pin that new semantics instead of letting it drift back.
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(adminToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> created = patchClient.exchange(
                url("/api/v1/agent-principals"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "adminNoContextProbe"), headers), Map.class);

        assertEquals(HttpStatus.CONFLICT, created.getStatusCode(),
                "ADMIN holds workspace:admin but sent no workspace context: explicit 409");
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", created.getBody().get("code"));
    }

    private ResponseEntity<Map> patch(Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(adminToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return patchClient.exchange(url("/api/v1/principal-grants/" + targetUsername), HttpMethod.PATCH,
                new HttpEntity<>(body, headers), Map.class);
    }
}
