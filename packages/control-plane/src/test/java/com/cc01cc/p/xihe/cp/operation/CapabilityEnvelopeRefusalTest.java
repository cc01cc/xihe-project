package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.client.HttpServerErrorException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * V10 / design #16 (PLAN-0407 G2 Q5): three serial gates, role × envelope zero-coupling. A big
 * role (maximal permission set) never widens the backend envelope: when the envelope cannot
 * physically execute (Runtime refuses the launch, or the Runtime is unreachable) the outcome is a
 * physical error — and the refusal path creates <b>zero</b> pending approval rows, because an
 * envelope refusal must never trigger the approval gate.
 *
 * <p>The capability step itself is reached only after authorization succeeds: the dispatch call
 * happens once and the refusal comes back from the envelope, not from RBAC.</p>
 */
class CapabilityEnvelopeRefusalTest extends AbstractIntegrationTest {

    private static final List<String> LIVE_APPROVAL_STATES =
            List.of("pending", "dispatching", "dispatch_unknown");

    @MockitoBean
    private RuntimeJobClient runtimeJobClient;

    @Autowired
    private OperationService operationService;

    @Autowired
    private GrantAuthorizationService grantAuthorizationService;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private ChatApprovalRepository chatApprovalRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private ObjectMapper objectMapper;

    private String userId;
    private String workspaceId;
    private String bearerToken;

    @Test
    void backendLaunchRefusalIsPhysicalErrorWithZeroPendingApprovalsEvenForAMaximalRole() {
        registerFixture();
        grantMaximalRole();
        Workspace workspace = workspaceRepository.findById(UUID.fromString(workspaceId)).orElseThrow();
        workspace.setExecutionMode("windows-host");
        workspaceRepository.save(workspace);

        assertTrue(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                        "execute_command", List.of("exec"), List.of("run.sh"), ToolShape.STRUCTURED,
                        userId, workspaceId, null)),
                "big role: the actor's permission set authorizes exec — authorization passes");
        when(runtimeJobClient.startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(true, false, true, null,
                        "JOB_BACKEND_LAUNCH_PENDING"));

        HttpServerErrorException error = org.junit.jupiter.api.Assertions.assertThrows(
                HttpServerErrorException.class, () -> postStart("key-envelope-1", jobBody("echo")));

        assertEquals(HttpStatus.NOT_IMPLEMENTED, error.getStatusCode());
        assertTrue(error.getResponseBodyAsString().contains("JOB_BACKEND_LAUNCH_PENDING"),
                "the envelope refuses with its own error code, not an authorization/approval answer");
        assertEquals("interrupted", operationService.listWorkspaceJobs(workspaceId).get(0).get("status"));
        verify(runtimeJobClient, times(1))
                .startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any());
        assertZeroPendingApprovals("envelope refusal must not create a pending approval");
    }

    @Test
    void unreachableRuntimeRefusalIsAlsoPhysicalErrorWithZeroPendingApprovals() {
        registerFixture();
        grantMaximalRole();
        when(runtimeJobClient.startJob(eq(workspaceId), anyString(), anyString(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(false, false, false, null, null));

        HttpServerErrorException error = org.junit.jupiter.api.Assertions.assertThrows(
                HttpServerErrorException.class, () -> postStart("key-envelope-2", jobBody("npm")));

        assertEquals(HttpStatus.BAD_GATEWAY, error.getStatusCode());
        assertTrue(error.getResponseBodyAsString().contains("RUNTIME_UNAVAILABLE"));
        assertEquals("interrupted", operationService.listWorkspaceJobs(workspaceId).get(0).get("status"));
        assertZeroPendingApprovals("an unreachable Runtime refuses physically, never via approval");
    }

    private void assertZeroPendingApprovals(String message) {
        assertTrue(chatApprovalRepository
                        .findByUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
                                userId, workspaceId, LIVE_APPROVAL_STATES)
                        .isEmpty(),
                message + " (V10: 包络拒绝不触发审批)");
    }

    /** design #16: a maximal permission set — every vocabulary action class incl. credential. */
    private void grantMaximalRole() {
        AuthorizationGrant direct = new AuthorizationGrant();
        direct.setId(UUID.randomUUID());
        direct.setSubjectType("user");
        direct.setSubjectId(UUID.fromString(userId));
        direct.setSource("direct");
        direct.setPermissions(atoms("read", "write", "delete", "exec", "network", "credential"));
        grantRepository.save(direct);
    }

    private void registerFixture() {
        String email = "cap-envelope-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "CapEnvelopeTest"),
                AuthResponse.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode());
        assertNotNull(response.getBody());
        bearerToken = response.getBody().getAccessToken();
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();
    }

    private Map<String, Object> jobBody(String command) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("command", command);
        body.put("args", List.of("hi"));
        body.put("scope", "workspace");
        return body;
    }

    private ResponseEntity<Map> postStart(String idempotencyKey, Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(bearerToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Idempotency-Key", idempotencyKey);
        return restTemplate.exchange(
                baseUrl + "/api/v1/workspaces/" + workspaceId + "/jobs",
                HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);
    }

    private ArrayNode atoms(String... actionClasses) {
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            permissions.add(atom);
        }
        return permissions;
    }
}
