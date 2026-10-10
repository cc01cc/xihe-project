package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * V14 (PLAN-0407 verify, P0=A): the lookup/ask-list three states after the T2.8 retirement of
 * rule adjudication.
 *
 * <ol>
 *   <li>no permission → denied by the grant lookup, never reaching an approval ask;</li>
 *   <li>permission + action class on the ask list → approval ask;</li>
 *   <li>permission + action class off the list → direct pass.</li>
 * </ol>
 *
 * The "deny never creates a pending approval" ordering itself is proven at the real MCP gate by
 * {@code McpProxyTest#handleToolsCall_grantDenied_doesNotEvaluateApproval} (approval is never
 * evaluated, zero pending rows); the {@code .git}/{@code .xihe-shadow} L0 critical-path
 * counter-proof stays in {@code HardGuardTest#blocksCriticalPathDeletion} — HardGuard is outside
 * the T2.8 retirement scope (design #21).
 */
class LookupAskGateTest extends AbstractIntegrationTest {

    @Autowired
    private AuthService authService;

    @Autowired
    private com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService;

    @Autowired
    private PolicyEngine policyEngine;

    @Autowired
    private GrantAuthorizationService grantAuthorizationService;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private AuditLogRepository auditLogRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    private String userId;
    private String workspaceId;
    private final String sessionId = UUID.randomUUID().toString();

    @AfterEach
    void cleanFixtures() {
        if (userId == null) {
            return;
        }
        UUID userUuid = UUID.fromString(userId);
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userUuid));
        auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .filter(row -> "authorization_default_grant_created".equals(row.getAction()))
                .map(AuditLog::getId)
                .forEach(auditLogRepository::deleteById);
        if (workspaceId != null) {
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
        }
        userRepository.deleteById(userUuid);
    }

    @Test
    void stateOneNoPermissionIsDeniedByTheLookupBeforeAnyAsk() {
        register();
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                "user", UUID.fromString(userId)));

        assertFalse(grantGate("write_file", writeBody()),
                "no grant → the lookup denies (state 1); the gate order keeps approval out of it");
    }

    @Test
    void stateTwoPermissionWithOnListActionClassAsksForApproval() {
        register();

        assertTrue(grantGate("write_file", writeBody()),
                "the registered default grant authorizes the write");
        PolicyVerdict verdict = policyEngine.evaluateVerdict(
                "write_file", "{}", sessionId, null, userId, workspaceId);
        assertEquals(PolicyEffect.ASK, verdict.effect(),
                "write sits on the approval ask list → approval ask (state 2)");
        assertEquals("action class on the approval ask list", verdict.reason());
        assertNull(verdict.matchedRule(), "no rule participates in the decision anymore");
    }

    @Test
    void stateThreePermissionWithOffListActionClassPassesDirectly() {
        register();

        assertTrue(grantGate("read_file", readBody()),
                "the registered default grant authorizes the read");
        PolicyVerdict verdict = policyEngine.evaluateVerdict(
                "read_file", "{}", sessionId, null, userId, workspaceId);
        assertEquals(PolicyEffect.ALLOW, verdict.effect(),
                "read is off the ask list → direct pass (state 3)");
        assertEquals("action class not on the approval ask list", verdict.reason());
    }

    @Test
    void outOfVocabularyActionClassIsDeniedByTheLookupEvenWithDefaultGrants() {
        register();

        assertFalse(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                        "mcp__custom_tool", List.of("db-migration"), List.of("orders"),
                        ToolShape.OPAQUE, userId, workspaceId, null)),
                "an action class outside the permission vocabulary fails closed (V14)");
        assertTrue(grantGate("write_file", writeBody()),
                "the same grants still authorize in-vocabulary classes");
    }

    @Test
    void hardGuardStillRefusesEscapingResourcesBeforeTheLookup() {
        register();

        assertFalse(grantGate("write_file",
                        "{\"params\":{\"arguments\":{\"path\":\"C:\\\\outside\\\\secret\"}}}"),
                "L0 absolute-path refusal precedes the lookup and survives the retirement");
        assertTrue(grantGate("write_file", writeBody()),
                "an ordinary workspace-relative path still passes");
    }

    private boolean grantGate(String tool, String body) {
        return policyEngine.allowsByGrant(PolicyContext.EMPTY, tool, body, sessionId,
                userId, workspaceId, true);
    }

    private void register() {
        // PLAN-0470 #25: register orchestration moved to AuthController; the
        // fixture reproduces the entry sequence (registerUser -> default
        // Workspace -> issueTokens) directly.
        com.cc01cc.p.xihe.cp.entity.User user = authService.registerUser(new RegisterRequest(
                "lookup-ask-" + UUID.randomUUID() + "@test.com", "gate-test-password",
                "Lookup ask gate"));
        AuthResponse registered = authService.issueTokens(user, workspaceService
                .getOrCreateDefaultWorkspace(user.getId().toString()).getId().toString());
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
    }

    private static String writeBody() {
        return "{\"params\":{\"arguments\":{\"path\":\"src/main.java\"}}}";
    }

    private static String readBody() {
        return "{\"params\":{\"arguments\":{\"path\":\"notes/today.md\"}}}";
    }
}
