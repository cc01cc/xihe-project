package com.cc01cc.p.xihe.cp.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/**
 * BL-352：workspace 级绑定的**可见性**三态（bound / creator / 其他）。
 *
 * <p>缺陷：新建的 agent principal 既没有 ownerUserId（D-174：create 不自动归属）也没有工作区
 * 绑定，而绑定端点要求"主体已在工作区可见"，可见性又由绑定产生 ⇒ 死锁。修复只放宽可见性
 * （创建者首绑权），**原子门仍在前面**：创建者身份不能替代 MANAGE_WORKSPACE_AGENTS。</p>
 */
class AgentPrincipalBindingAuthorityTest {

    private static final String ACTION_WORKSPACE = ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS;
    private static final String ACTION_INSTANCE = ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS;

    private RequesterAuthority requesterAuthority;
    private AgentPrincipalService agentPrincipalService;
    private AgentPrincipalRepository agentPrincipalRepository;
    private AgentPrincipalBindingAuthority authority;
    private UUID actor;
    private UUID principalId;
    private UUID workspaceId;

    @BeforeEach
    void setUp() {
        requesterAuthority = mock(RequesterAuthority.class);
        agentPrincipalService = mock(AgentPrincipalService.class);
        agentPrincipalRepository = mock(AgentPrincipalRepository.class);
        authority = new AgentPrincipalBindingAuthority(
                requesterAuthority, agentPrincipalService, agentPrincipalRepository);
        actor = UUID.randomUUID();
        principalId = UUID.randomUUID();
        workspaceId = UUID.randomUUID();
        TenantContext.setUserId(actor.toString());
    }

    @AfterEach
    void tearDown() {
        TenantContext.setUserId(null);
    }

    private AgentPrincipal principalCreatedBy(String createdBy) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("bl352subject");
        principal.setCreatedByUserId(createdBy);
        return principal;
    }

    private AgentPrincipalService.WorkspaceAgentView view(UUID id) {
        return new AgentPrincipalService.WorkspaceAgentView(
                id, "bl352subject", null, null, Instant.now(), null, true, false, null, null,
                List.of(), "explicit");
    }

    private CpApiException expectProblem(HttpStatus status, String code) {
        return assertThrows(CpApiException.class, () -> authority.require(principalId.toString(), workspaceId.toString()));
    }

    @Test
    @DisplayName("instance tier：持有 MANAGE_AGENT_PRINCIPALS 且无 workspace 上下文 ⇒ 放行")
    void instanceTierIsEnoughWithoutWorkspace() {
        when(requesterAuthority.holdsActionAtom(ACTION_INSTANCE)).thenReturn(true);
        when(agentPrincipalRepository.findById(principalId))
                .thenReturn(java.util.Optional.of(principalCreatedBy(null)));

        var caller = authority.require(principalId.toString(), null);

        assertFalse(caller.instanceTier() == false, "instance tier must be reported");
        assertEquals(actor, caller.actorUuid());
    }

    @Test
    @DisplayName("bound：主体已绑定该工作区 ⇒ 放行")
    void boundPrincipalIsVisible() {
        when(requesterAuthority.holdsActionAtom(actor, ACTION_WORKSPACE, workspaceId)).thenReturn(true);
        when(agentPrincipalService.listWorkspaceAgents(anyString(), any(UUID.class)))
                .thenReturn(List.of(view(principalId)));

        var caller = authority.require(principalId.toString(), workspaceId.toString());

        assertEquals(workspaceId, caller.workspaceId());
    }

    @Test
    @DisplayName("creator：创建者即使未绑定也可见（BL-352 首绑权）")
    void creatorIsVisibleEvenWhenUnbound() {
        when(requesterAuthority.holdsActionAtom(actor, ACTION_WORKSPACE, workspaceId)).thenReturn(true);
        when(agentPrincipalService.listWorkspaceAgents(anyString(), any(UUID.class))).thenReturn(List.of());
        when(agentPrincipalRepository.findById(principalId))
                .thenReturn(java.util.Optional.of(principalCreatedBy(actor.toString())));

        var caller = authority.require(principalId.toString(), workspaceId.toString());

        assertEquals(principalId, caller.principalId());
    }

    @Test
    @DisplayName("其他 + 有原子但未绑定、非创建者 ⇒ 404（不放宽给同工作区其他管理员）")
    void nonCreatorUnboundIsNotFound() {
        when(requesterAuthority.holdsActionAtom(actor, ACTION_WORKSPACE, workspaceId)).thenReturn(true);
        when(agentPrincipalService.listWorkspaceAgents(anyString(), any(UUID.class))).thenReturn(List.of());
        when(agentPrincipalRepository.findById(principalId))
                .thenReturn(java.util.Optional.of(principalCreatedBy(UUID.randomUUID().toString())));

        CpApiException exception = expectProblem(HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND");
        assertEquals("AGENT_PRINCIPAL_NOT_FOUND", exception.getCode());
    }

    @Test
    @DisplayName("creator 但无 MANAGE_WORKSPACE_AGENTS ⇒ 403（原子门在前，创建者不是特权）")
    void creatorWithoutAtomIsForbidden() {
        when(requesterAuthority.holdsActionAtom(actor, ACTION_WORKSPACE, workspaceId)).thenReturn(false);
        when(requesterAuthority.holdsActionAtom(ACTION_INSTANCE)).thenReturn(false);

        CpApiException exception = expectProblem(HttpStatus.FORBIDDEN, "FORBIDDEN");
        assertEquals("FORBIDDEN", exception.getCode());
    }
}
