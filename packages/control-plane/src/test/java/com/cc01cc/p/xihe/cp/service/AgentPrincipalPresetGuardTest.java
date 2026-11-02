package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0625 F (D25-02/D25-08): a preset guard's cap is fixed at the input side — the WRITE
 * side refuses. resolveCapFor stays the single entry, untouched (no parse-side special case).
 */
class AgentPrincipalPresetGuardTest {

    private AgentPrincipalRepository principals;
    private com.cc01cc.p.xihe.cp.auth.AuthService authService;
    private com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService;
    private com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator evaluator;
    private AgentPrincipalService service;

    @BeforeEach
    void setUp() {
        principals = mock(AgentPrincipalRepository.class);
        com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository grants = mock(com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository.class);
        when(grants.findBySubjectTypeAndSubjectId(any(), any())).thenReturn(java.util.List.of());
        authService = mock(com.cc01cc.p.xihe.cp.auth.AuthService.class);
        workspaceService = mock(com.cc01cc.p.xihe.cp.service.WorkspaceService.class);
        when(workspaceService.isWorkspaceMember(any(), any())).thenReturn(true);
        evaluator = mock(com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.class);
        when(evaluator.union(any())).thenReturn(java.util.Set.of(
                new com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.PermissionAtom(
                        "MANAGE_WORKSPACE_AGENTS", "*")));
        when(authService.userExists(any())).thenReturn(true);
        service = new AgentPrincipalService(principals,
                grants,
                authService,
                workspaceService,
                mock(com.cc01cc.p.xihe.cp.policy.GrantDefaultService.class),
                mock(WorkspaceAgentRepository.class),
                evaluator,
                mock(com.cc01cc.p.xihe.cp.audit.AuditLogger.class),
                new ObjectMapper(),
                mock(AgentTemplateService.class),
                mock(AuthzContext.class));
    }

    @Test
    void presetGuardCapCannotBeRewrittenThroughABinding() {
        AgentPrincipal guard = new AgentPrincipal();
        guard.setId(UUID.randomUUID());
        guard.setOrigin(AgentPrincipal.ORIGIN_SYSTEM_PRESET);
        guard.setPresetId("00000000-0000-4000-8000-0000000000a2");
        when(principals.findById(guard.getId())).thenReturn(Optional.of(guard));

        CpApiException refused = assertThrows(CpApiException.class, () -> service.setWorkspaceCap(
                UUID.randomUUID().toString(), UUID.randomUUID(), guard.getId(),
                new ObjectMapper().createArrayNode()));
        assertEquals("GUARD_CAP_IMMUTABLE", refused.getCode());
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus(),
                "the refusal is a write-side gate, not a parse-side special case");
    }

    @Test
    void userPrincipalCapStaysWritable() {
        AgentPrincipal userPrincipal = new AgentPrincipal();
        userPrincipal.setId(UUID.randomUUID());
        userPrincipal.setOrigin(AgentPrincipal.ORIGIN_USER);
        when(principals.findById(userPrincipal.getId())).thenReturn(Optional.of(userPrincipal));
        when(principals.findById(userPrincipal.getId())).thenReturn(Optional.of(userPrincipal));
        // The guard check must not fire for user principals; the path proceeds past requireMutableCap
        // and fails later on binding validation — proving the refusal is preset-only.
        when(principals.findById(userPrincipal.getId())).thenReturn(Optional.of(userPrincipal));

        RuntimeException laterFailure = assertThrows(RuntimeException.class, () -> service.setWorkspaceCap(
                UUID.randomUUID().toString(), UUID.randomUUID(), userPrincipal.getId(),
                new ObjectMapper().createArrayNode()));
        if (laterFailure instanceof CpApiException api) {
            org.junit.jupiter.api.Assertions.assertNotEquals("GUARD_CAP_IMMUTABLE", api.getCode(),
                    "user principals never see the preset gate");
        }
    }
}
