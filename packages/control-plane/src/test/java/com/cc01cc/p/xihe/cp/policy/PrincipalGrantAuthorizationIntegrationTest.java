package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0610 W2 / decision #28: the retired PLAN-0585 grant surface no longer unlocks the two gates
 * it existed for, and it must not write anything on the way out.
 *
 * <p>The old scenario (admin grants {@code CREATE_ACCOUNT} → agent-principal creation becomes 201)
 * is replaced by access-role bindings in W3; this test only asserts the retirement contract and the
 * untouched default-deny baseline around agent-principal creation.</p>
 *
 * <p><b>Creation has two doors (PLAN-0750 M1, G1=(1a), user ruling 2026-11-10).</b> No workspace
 * context routes to the <b>user-level</b> door, authorized by {@code CREATE_OWN_AGENT} (re-planted by
 * V148 after BL-312 removed it); an explicit context routes to the <b>workspace-tier</b> door,
 * authorized by {@code MANAGE_WORKSPACE_AGENTS}. The two are never alias-merged. D-196/BL-336
 * (revising D22) removed the old unconditional {@code 409 WORKSPACE_CONTEXT_REQUIRED} from
 * creation and made it <b>scope-aware</b>: it now guards the write paths of an already-existing
 * workspace-owned principal, which is the negative case pinned at the bottom of this class.</p>
 *
 * <p><b>Fixture rule (why {@code ensureUserDefault} is called):</b> the atom gate reads
 * <b>materialized</b> grants ({@code RequesterAuthority.allowsForUser} →
 * {@code AuthorizationGrantRepository.findScopedGrants}), so an actor must be bound through the same
 * production path registration uses. A bare {@code users} row plus a JWT has no grant rows at all and
 * is refused by the atom gate — which is exactly what the retired assertions were masking.</p>
 */
class PrincipalGrantAuthorizationIntegrationTest extends AbstractReusableIntegrationTest {

    private RestTemplate patchClient;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private GrantDefaultService grantDefaultService;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

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
        // The tier binding alone authorizes nothing: capability atoms are evaluated from
        // MATERIALIZED grants, so the ADMIN row must be materialized through the same production
        // entry point registration uses. ensureInstanceTierBinding leaves an existing binding in
        // place, then materializeSubject turns it into grant rows (ADMIN inherits
        // CREATE_OWN_AGENT via USER_DEFAULT_ATOMS, so the user-level door is reachable).
        grantDefaultService.ensureUserDefault(userRepository.findById(userId).orElseThrow());
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
    void withoutWorkspaceContextCreatesAUserLevelPrincipal() {
        fixture();
        // Door 1 of 2 (PLAN-0750 M1): no workspace context ⇒ the user-level door, authorized by
        // CREATE_OWN_AGENT ⇒ 201. The old unconditional 409 for creation is gone by design
        // (D-196/BL-336 removed it, a183fd955 contracted the removal and
        // OpenApiYamlContractTest:707 asserts the operation must not declare it any more).
        User plain = userRepository.saveAndFlush(new User(
                "grant-auth-plain-" + UUID.randomUUID() + "@test.com", "hash",
                "Grant auth plain", "grantplain" + shortId()));
        // Production binding path (registration does exactly this): without materialized grants the
        // atom gate — not a precondition — would answer 403, which is the failure this class used to
        // hide behind the retired 409.
        grantDefaultService.ensureUserDefault(plain);
        String plainToken = TestDataFactory.createGlobalToken(
                plain.getId().toString(), plain.getEmail(), "USER", 0);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(plainToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> created = patchClient.exchange(
                url("/api/v1/agent-principals"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "userLevelDoorProbe"), headers), Map.class);

        assertEquals(HttpStatus.CREATED, created.getStatusCode(),
                "no workspace context + CREATE_OWN_AGENT ⇒ the user-level door creates (201)");
        assertNotNull(created.getBody().get("principalId"));
        assertNull(created.getBody().get("code"), "a 201 never carries a Problem Details code");
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
        // Measured, not assumed: the atom gate answers the generic FORBIDDEN code and names the missing
        // action class in the detail — unlike the submission-time gate, which has a dedicated code.
        assertEquals("FORBIDDEN", created.getBody().get("code"));
        assertTrue(String.valueOf(created.getBody().get("detail")).contains("permission is required"),
                "the refusal must name the missing action class: " + created.getBody().get("detail"));
    }

    @Test
    void administratorWithoutWorkspaceContextAlsoUsesTheUserLevelDoor() {
        fixture();
        // ADMIN derives from USER_DEFAULT_ATOMS (SystemAccessRoleCatalog:107-113), so it inherits
        // CREATE_OWN_AGENT and creates its own principal through the same user-level door. Pinning
        // this stops a future "instance administration authorizes creation" drift: the atom, not the
        // role name, is what the gate decides on.
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(adminToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> created = patchClient.exchange(
                url("/api/v1/agent-principals"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "adminUserLevelProbe"), headers), Map.class);

        assertEquals(HttpStatus.CREATED, created.getStatusCode(),
                "ADMIN with no workspace context creates through the user-level door (201)");
        assertNotNull(created.getBody().get("principalId"));
        assertNull(created.getBody().get("code"), "a 201 never carries a Problem Details code");
    }

    @Test
    void workspaceScopedPrincipalStillRequiresTheContextToBeChanged() {
        fixture();
        // The 409 did not disappear — it moved (D-196/BL-336): it now guards the write paths of an
        // existing principal the workspace owns (owner_user_id null, origin USER), never creation.
        // Keeping this negative case is what stops the scope-aware gate from being dropped unnoticed
        // while every creation test stays green. The subject row is seeded directly (the D-174 shape,
        // same as AgentPrincipalVisibilityContractTest.createInstancePrincipal) so the case depends on
        // the principal scope only, not on which tier may run the workspace create door.
        AgentPrincipal workspaceOwned = new AgentPrincipal();
        workspaceOwned.setName("workspaceScopedProbe");
        workspaceOwned.setCreatedByUserId(adminUserId.toString());
        String principalId = agentPrincipalRepository.saveAndFlush(workspaceOwned).getId().toString();

        // Same actor, NO workspace context on the write path:
        HttpHeaders noContext = new HttpHeaders();
        noContext.setBearerAuth(adminToken);
        noContext.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> disabled = patchClient.exchange(
                url("/api/v1/agent-principals/" + principalId + "/disable"), HttpMethod.POST,
                new HttpEntity<>(Map.of(), noContext), Map.class);

        assertEquals(HttpStatus.CONFLICT, disabled.getStatusCode(),
                "a workspace-scoped principal cannot be changed without a workspace context (D-196)");
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", disabled.getBody().get("code"));
    }

    private ResponseEntity<Map> patch(Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(adminToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return patchClient.exchange(url("/api/v1/principal-grants/" + targetUsername), HttpMethod.PATCH,
                new HttpEntity<>(body, headers), Map.class);
    }
}
