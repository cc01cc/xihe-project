package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterAll;
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
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * V11 / design #13 (PLAN-0407 G2 Q4): an Agent-side caller only holds the internal service
 * bearer ({@code cp.agent-api-token} = {@code dev-token-not-secure}). The public
 * {@code PATCH /api/v1/workspaces/{id}/execution-mode} route is guarded by
 * {@code hasAnyRole('USER', 'ADMIN')}, so that credential must be rejected with 403 and the
 * workspace row's {@code executionMode} must stay untouched — the bare-execution choice is a
 * human decision, not an Agent capability.
 *
 * <p>The positive control proves the rejection is caused by the credential, not by a broken
 * route: the workspace owner's own JWT performs a real switch (the direct-attach capability probe
 * is stubbed with a local Runtime endpoint), and afterwards the same service bearer still cannot
 * flip the bare carrier back off.</p>
 *
 * <p>task-120 (H2 coverage blind spot): the second gate of this route —
 * {@code holdsActionAtom(ACTION_MANAGE_WORKSPACE_RUNTIME)} feeding the service's owner-only branch —
 * had never been executed on the H2 lane, because the atom judgement reads org-unit grants through
 * native ltree SQL and the H2 schema has no org_units family: the evaluation threw, the policy
 * layer fell back to an empty atom set, and {@code canManageRuntime} was false for reasons unrelated
 * to the caller.</p>
 *
 * <p>Running the same two cases on PostgreSQL produced a different fact than the plan assumed, and it
 * is a product fact, not a lane artefact: {@code WorkspaceWriteGuard#requirement} grades
 * {@code PATCH /api/v1/workspaces/{id}/execution-mode} as {@code Requirement.MANAGE}
 * ({@code WorkspaceWriteGuard.isOwnerOnly} — PATCH &#47;execution-mode), and
 * {@code WorkspaceRole#canManage} accepts only {@code OWNER}. The tenant interceptor therefore rejects
 * <em>every</em> non-owner (VIEWER, EDITOR, and the legacy ADMIN/MEMBER that canonicalise to EDITOR)
 * with {@code 403 WORKSPACE_FORBIDDEN} before this controller is reached, so
 * {@code canManageRuntime} is never consulted for a non-owner; for the owner the service's owner
 * branch already passes regardless of the flag. The atom-branch input is consequently unobservable
 * over HTTP. The cases at the bottom pin the two things that are observable: the tenant ordering
 * (a matrix of non-owner roles, atom seeded, still refused) and the owner-only branch the flag feeds
 * (service level: {@code admin=true} opens it for a non-owner member, {@code admin=false} keeps 404).</p>
 */
class ExecutionModeAuthorityTest extends AbstractIntegrationTest {

    private static final String INTERNAL_SERVICE_TOKEN = "dev-token-not-secure";

    /** The host path only has to be lexically absolute; the switch below never touches the disk. */
    private static final String HOST_PATH = "C:\\work\\execution-mode-test";

    private static com.sun.net.httpserver.HttpServer probeServer;

    static {
        try {
            probeServer = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            probeServer.createContext("/internal/v1/runtime/capabilities/direct-attach/probe", exchange -> {
                byte[] body = ("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                        + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                        + "\"executionMode\":\"windows-host\",\"available\":true}")
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
            });
            probeServer.start();
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    @DynamicPropertySource
    static void runtimeProbeUrl(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://127.0.0.1:" + probeServer.getAddress().getPort());
    }

    @AfterAll
    static void stopProbeServer() {
        if (probeServer != null) {
            probeServer.stop(0);
        }
    }

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceService workspaceService;

    @Autowired
    private AccessRoleRepository accessRoleRepository;

    @Autowired
    private AccessRolePermissionRepository permissionRepository;

    @Autowired
    private AccessRoleBindingRepository roleBindingRepository;

    @Autowired
    private RoleGrantMaterializer materializer;

    @Autowired
    private AuthzContext authzContext;

    private String workspaceId;
    private String userToken;
    private RestTemplate patchClient;

    @BeforeEach
    void registerWorkspaceOwner() {
        // The shared test RestTemplate cannot emit PATCH; the JDK client can, and 4xx must come
        // back as a response entity so the rejection itself is assertable.
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
        ResponseEntity<Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", "execution-mode-" + UUID.randomUUID() + "@test.com",
                        "password", "execution-mode-password", "name", "ExecutionModeTest"),
                Map.class);
        assertEquals(HttpStatus.CREATED, registration.getStatusCode());
        assertNotNull(registration.getBody());
        userToken = (String) registration.getBody().get("accessToken");
        java.util.Map<?, ?> user = (java.util.Map<?, ?>) registration.getBody().get("user");
        workspaceId = createWorkspaceViaApi((String) user.get("id"));
        assertNotNull(workspaceId, "PLAN-0614: the fixture creates the workspace explicitly");
    }

    /**
     * PLAN-0614/0618: register/login no longer create a workspace. This class checks *who may switch the
     * execution mode* (not how the workspace was created), so the row is seeded through the fixture —
     * the public API now requires an explicit {@code storageMode=direct_attach} plus a Runtime probe,
     * and this lane has no Runtime.
     */
    @org.springframework.beans.factory.annotation.Autowired
    private WorkspaceFixture workspaceFixture;

    private String createWorkspaceViaApi(String ownerId) {
        return workspaceFixture.createOwnedWorkspace("execution-mode-ws", ownerId).getId().toString();
    }

    @Test
    void internalServiceBearerIsRejectedAndExecutionModeStaysUnchanged() {
        assertEquals("windows-host", workspaceRow().getExecutionMode(),
                "fixture sanity: a fresh workspace starts on the direct_attach execution mode");

        ResponseEntity<Map> rejected = exchangeExecutionMode(INTERNAL_SERVICE_TOKEN, "windows-host");

        assertEquals(HttpStatus.FORBIDDEN, rejected.getStatusCode(),
                "the service bearer carries only ROLE_INTERNAL_SERVICE, never USER/ADMIN");
        assertNotNull(rejected.getBody());
        assertEquals("FORBIDDEN", rejected.getBody().get("code"));
        assertEquals("windows-host", workspaceRow().getExecutionMode(),
                "a rejected Agent-side PATCH must leave executionMode exactly as it was");
    }

    @Test
    void ownerSwitchesToBareHostAndServiceBearerCannotChangeItBack() {
        Workspace workspace = workspaceRow();
        workspace.setStorageMode("direct_attach");
        workspace.setHostPath(HOST_PATH);
        workspaceRepository.save(workspace);

        ResponseEntity<Map> accepted = exchangeExecutionMode(userToken, "windows-host");

        assertEquals(HttpStatus.OK, accepted.getStatusCode());
        assertNotNull(accepted.getBody());
        assertEquals("windows-host", accepted.getBody().get("executionMode"));
        assertEquals("windows-host", workspaceRow().getExecutionMode(),
                "the human owner activates the bare carrier through their own credential");

        ResponseEntity<Map> rejected = exchangeExecutionMode(INTERNAL_SERVICE_TOKEN, "docker");

        assertEquals(HttpStatus.FORBIDDEN, rejected.getStatusCode(),
                "the Agent-side caller is stopped at the route guard, before any mode logic");
        assertEquals("windows-host", workspaceRow().getExecutionMode(),
                "the Agent-side caller cannot flip the bare carrier back off");
    }

    // ------------------------------------------------------------------
    // task-120: the tenant gate is what stops a non-owner, and it runs
    // before the controller — so the atom never decides anything here.
    // ------------------------------------------------------------------

    /**
     * Matrix, PostgreSQL lane. Every non-owner role gets the same refusal even when the caller holds
     * {@code ACTION_MANAGE_WORKSPACE_RUNTIME}. The chain:
     * {@code config/WorkspaceWriteGuard.java:91} routes PATCH /execution-mode into
     * {@code isOwnerOnly} → {@code :52-53} returns {@code Requirement.MANAGE} →
     * {@code :66/:76 allows()} delegates to {@code entity/WorkspaceRole.java:28-30 canManage}, which
     * accepts only {@code OWNER} ({@code :20} canonicalises ADMIN/MEMBER to EDITOR), and
     * {@code config/TenantContextInterceptor.java:146-158} turns the failed grade into
     * {@code 403 WORKSPACE_FORBIDDEN} "Workspace access denied". So the controller is never reached and
     * the row never moves. This case pins <b>the tenant gate running before the atom gate</b>; it does
     * not claim the atom was evaluated. The owner row of the matrix is the positive control above
     * ({@link #ownerSwitchesToBareHostAndServiceBearerCannotChangeItBack}), which reaches 200.
     */
    @Test
    void everyNonOwnerRoleIsRefusedByTheTenantGateEvenWhenTheAtomIsHeld() {
        for (WorkspaceRole role : java.util.List.of(WorkspaceRole.VIEWER, WorkspaceRole.EDITOR)) {
            prepareSwitchableWorkspace();
            Actor member = enrollMember("execution-mode-" + role.name().toLowerCase(java.util.Locale.ROOT), role);
            seedWorkspaceAtom(UUID.fromString(member.id()),
                    ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME);

            ResponseEntity<Map> refused = exchangeExecutionMode(member.token(), "windows-host");

            assertEquals(HttpStatus.FORBIDDEN, refused.getStatusCode(),
                    role + " must be stopped by the tenant MANAGE gate: " + refused.getBody());
            assertNotNull(refused.getBody());
            assertEquals("WORKSPACE_FORBIDDEN", refused.getBody().get("code"), role + " code");
            assertEquals("Workspace access denied", refused.getBody().get("detail"), role + " detail");
            assertEquals("windows-mxc", workspaceRow().getExecutionMode(),
                    role + ": a refused switch must leave the mode exactly as it was");
        }
    }

    /**
     * The branch the atom feeds, pinned where it is reachable.
     * {@code controller/WorkspaceEnvironmentController.java:169-176} computes
     * {@code canManageRuntime} with {@code requesterAuthority.holdsActionAtom(...)} and passes it straight
     * into {@code workspaceService.changeExecutionMode(..., admin, mode)} — that argument is the flag's
     * only feed point, and this case is its only observable surface, because the tenant gate above makes
     * the HTTP path unreachable for a non-owner. {@code admin=true} opens the owner-only branch for a
     * non-owner member, {@code admin=false} keeps it at 404. Deliberately no product change here:
     * relaxing the tenant grade would be a product decision, not this card.
     */
    @Test
    void theOwnerOnlyBranchOpensForTheAdminFlagAndClosesWithoutIt() {
        prepareSwitchableWorkspace();
        Actor member = enrollMember("execution-mode-branch", WorkspaceRole.EDITOR);

        Workspace opened = workspaceService.changeExecutionMode(workspaceId, member.id(), true, "windows-host");

        assertEquals("windows-host", opened.getExecutionMode(),
                "admin=true must open the owner-only branch for a non-owner member");
        assertEquals("windows-host", workspaceRow().getExecutionMode(),
                "the flag really moved the row, it was not just a returned projection");

        prepareSwitchableWorkspace();

        CpApiException refused = assertThrows(CpApiException.class,
                () -> workspaceService.changeExecutionMode(workspaceId, member.id(), false, "windows-host"),
                "admin=false must keep the owner-only branch closed");
        assertEquals("WORKSPACE_NOT_FOUND", refused.getCode(),
                "the owner-only branch answers 404, not 403, so existence stays hidden");
        assertEquals(HttpStatus.NOT_FOUND, refused.getStatus());
        assertEquals("windows-mxc", workspaceRow().getExecutionMode(),
                "a refused switch must leave the mode exactly as it was");
    }

    /**
     * A direct_attach workspace on {@code windows-mxc} — the mode a direct_attach workspace gets by
     * default — so the PATCH below is a real transition (a same-mode PATCH returns before the probe
     * and would weaken the assertion).
     */
    private void prepareSwitchableWorkspace() {
        Workspace workspace = workspaceRow();
        workspace.setStorageMode("direct_attach");
        workspace.setHostPath(HOST_PATH);
        workspace.setExecutionMode("windows-mxc");
        workspaceRepository.save(workspace);
    }

    /**
     * Registration plus a {@code role_bindings} row — membership is that binding alone
     * ({@code WorkspaceMembershipService.roleOf} maps role names to {@link WorkspaceRole}), and the
     * bound role is what the tenant gate grades. The atom under test is seeded separately.
     */
    private Actor enrollMember(String prefix, WorkspaceRole role) {
        ResponseEntity<Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", prefix + "-" + UUID.randomUUID() + "@test.com",
                        "password", "execution-mode-password", "name", "ExecutionModeMember"),
                Map.class);
        assertEquals(HttpStatus.CREATED, registration.getStatusCode(),
                "registration failed: " + registration.getBody());
        assertNotNull(registration.getBody());
        Map<?, ?> user = (Map<?, ?>) registration.getBody().get("user");
        assertNotNull(user, "registration must return the created user: " + registration.getBody());
        String id = String.valueOf(user.get("id"));
        workspaceFixture.bindWorkspaceRole(UUID.fromString(workspaceId), UUID.fromString(id), role);
        return new Actor(id, String.valueOf(registration.getBody().get("accessToken")));
    }

    /**
     * One atom at workspace scope, granted the way the production path grants it: role row,
     * permission row, binding row, then {@code RoleGrantMaterializer} (the atom judgement reads
     * materialized {@code source='role'} grants, not the bare binding) and a cache invalidation.
     * The role name must satisfy ck_roles_name_format (V87).
     */
    private void seedWorkspaceAtom(UUID userId, String atom) {
        UUID scopeId = UUID.fromString(workspaceId);
        UUID roleId = UUID.randomUUID();
        accessRoleRepository.saveAndFlush(new AccessRole(roleId,
                "TEST_EXECMODE_" + roleId.toString().replace("-", "").substring(0, 10).toUpperCase(),
                "Execution mode atom role", "test-only role for the runtime atom (task-120)", false));
        permissionRepository.saveAndFlush(new AccessRolePermission(roleId, atom,
                PermissionAtomCatalog.WILDCARD));
        roleBindingRepository.saveAndFlush(new AccessRoleBinding(roleId, "user", userId,
                AccessScope.WORKSPACE, scopeId, userId));
        materializer.materializeSubject("user", userId, userId, scopeId.toString());
        authzContext.invalidate(userId);
    }

    private ResponseEntity<Map> exchangeExecutionMode(String bearerToken, String executionMode) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(bearerToken);
        return patchClient.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/execution-mode"),
                HttpMethod.PATCH,
                new HttpEntity<>(Map.of("executionMode", executionMode), headers),
                Map.class);
    }

    private Workspace workspaceRow() {
        return workspaceRepository.findByIdAndDeletedAtIsNull(UUID.fromString(workspaceId)).orElseThrow();
    }

    private record Actor(String id, String token) {
    }
}
