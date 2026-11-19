package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-106（用户裁定 2026-11-20 00:28，方案 A）：建会话不带 {@code agentPrincipalId} 时的默认智能体解析链。
 *
 * <p>契约（D-928 同序）：env &gt; 管理员锁 &gt; 工作区默认绑定（{@code workspace_agents.is_default}）
 * &gt; workspace &gt; workspace-default &gt; user &gt; instance；每个候选都要过
 * {@link AgentPrincipalService#isSessionAgentUsable} 复验，不可用则 WARN 跳过继续往下找；
 * 全链为空才 400 {@code INVALID_REQUEST}，且文案要给出可操作出口（不再是一句裸的
 * "agentPrincipalId is required"）。workspaceless 会话跳过三层工作区来源（D-687）。</p>
 */
@ExtendWith(MockitoExtension.class)
class SessionAgentDefaultsTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WORKSPACE = "22222222-2222-4222-8222-222222222222";
    private static final String AGENT_ENV = "33333333-3333-4333-8333-333333333333";
    private static final String AGENT_LOCKED = "44444444-4444-4444-8444-444444444444";
    private static final String AGENT_BOUND = "55555555-5555-4555-8555-555555555555";
    private static final String AGENT_WORKSPACE_ROW = "66666666-6666-4666-8666-666666666666";
    private static final String AGENT_WORKSPACE_DEFAULT_ROW = "77777777-7777-4777-8777-777777777777";
    private static final String AGENT_USER_ROW = "88888888-8888-4888-8888-888888888888";
    private static final String AGENT_INSTANCE = "99999999-9999-4999-8999-999999999999";
    private static final String AGENT_DISABLED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    private static final UUID WORKSPACE_UUID = UUID.fromString(WORKSPACE);
    private static final UUID USER_UUID = UUID.fromString(USER);

    private static final String DOMAIN = SessionAgentDefaults.DOMAIN;
    private static final String KEY = SessionAgentDefaults.KEY;

    @Mock
    private ConfigService configService;

    @Mock
    private AgentPrincipalService agentPrincipalService;

    @InjectMocks
    private SessionAgentDefaults defaults;

    @Test
    void envOverrideWinsOverEveryDatabaseLayer() {
        when(configService.envOverridden(DOMAIN)).thenReturn(Map.of(KEY, AGENT_ENV));
        when(agentPrincipalService.isSessionAgentUsable(WORKSPACE_UUID, UUID.fromString(AGENT_ENV)))
                .thenReturn(true);

        assertEquals(AGENT_ENV, defaults.resolve(USER, WORKSPACE),
                "env 覆盖优先，且命中后不再往下试");
        verify(agentPrincipalService, times(1)).isSessionAgentUsable(any(), any());
    }

    @Test
    void administratorLockEndsTheChain() {
        when(configService.isAdminLocked(DOMAIN, KEY)).thenReturn(true);
        when(configService.instanceValue(DOMAIN, KEY)).thenReturn(AGENT_LOCKED);
        when(agentPrincipalService.isSessionAgentUsable(WORKSPACE_UUID, UUID.fromString(AGENT_LOCKED)))
                .thenReturn(true);

        assertEquals(AGENT_LOCKED, defaults.resolve(USER, WORKSPACE),
                "锁定的 instance 值止链，与 ConfigService.resolve 同构");
        verify(configService, never()).layerEntries(any(), any(), any(), any());
        verify(agentPrincipalService, never()).workspaceDefaultAgentPrincipalId(any());
    }

    @Test
    void workspaceDefaultBindingOutranksWorkspaceConfigRow() {
        when(agentPrincipalService.workspaceDefaultAgentPrincipalId(WORKSPACE_UUID))
                .thenReturn(UUID.fromString(AGENT_BOUND));
        when(configService.layerEntries("workspace", DOMAIN, null, WORKSPACE_UUID))
                .thenReturn(Map.of(KEY, AGENT_WORKSPACE_ROW));
        when(agentPrincipalService.isSessionAgentUsable(WORKSPACE_UUID, UUID.fromString(AGENT_BOUND)))
                .thenReturn(true);

        assertEquals(AGENT_BOUND, defaults.resolve(USER, WORKSPACE),
                "工作区里显式点选的默认智能体优先于同作用域的手配 config 值");
    }

    @Test
    void fallsBackToWorkspaceDefaultRowWhenWorkspaceRowMissing() {
        when(configService.layerEntries("workspace", DOMAIN, null, WORKSPACE_UUID)).thenReturn(Map.of());
        when(configService.layerEntries("workspace-default", DOMAIN, null, null))
                .thenReturn(Map.of(KEY, AGENT_WORKSPACE_DEFAULT_ROW));
        when(agentPrincipalService.isSessionAgentUsable(
                WORKSPACE_UUID, UUID.fromString(AGENT_WORKSPACE_DEFAULT_ROW))).thenReturn(true);

        assertEquals(AGENT_WORKSPACE_DEFAULT_ROW, defaults.resolve(USER, WORKSPACE));
    }

    @Test
    void malformedUuidIsSkippedWithWarnAndChainContinues() {
        when(configService.envOverridden(DOMAIN)).thenReturn(Map.of(KEY, "not-a-uuid"));
        when(agentPrincipalService.workspaceDefaultAgentPrincipalId(WORKSPACE_UUID))
                .thenReturn(UUID.fromString(AGENT_BOUND));
        when(agentPrincipalService.isSessionAgentUsable(WORKSPACE_UUID, UUID.fromString(AGENT_BOUND)))
                .thenReturn(true);

        assertEquals(AGENT_BOUND, defaults.resolve(USER, WORKSPACE),
                "配错格式是配置问题，不该让建会话直接失败");
    }

    @Test
    void unusablePrincipalIsSkippedAndChainContinues() {
        when(configService.envOverridden(DOMAIN)).thenReturn(Map.of(KEY, AGENT_DISABLED));
        when(agentPrincipalService.isSessionAgentUsable(WORKSPACE_UUID, UUID.fromString(AGENT_DISABLED)))
                .thenReturn(false);
        when(agentPrincipalService.isSessionAgentUsable(WORKSPACE_UUID, UUID.fromString(AGENT_INSTANCE)))
                .thenReturn(true);
        when(configService.instanceValue(DOMAIN, KEY)).thenReturn(AGENT_INSTANCE);

        assertEquals(AGENT_INSTANCE, defaults.resolve(USER, WORKSPACE),
                "禁用/未绑定的默认当未命中，继续往下层；不能因此挡住建会话");
    }

    @Test
    void workspacelessSessionSkipsEveryWorkspaceScopedSource() {
        when(configService.layerEntries("user", DOMAIN, USER_UUID, null))
                .thenReturn(Map.of(KEY, AGENT_USER_ROW));
        when(agentPrincipalService.isSessionAgentUsable(null, UUID.fromString(AGENT_USER_ROW)))
                .thenReturn(true);

        assertEquals(AGENT_USER_ROW, defaults.resolve(USER, null));
        verify(agentPrincipalService, never()).workspaceDefaultAgentPrincipalId(any());
        verify(configService, never()).layerEntries(eq("workspace"), any(), any(), any());
        verify(configService, never()).layerEntries(eq("workspace-default"), any(), any(), any());
    }

    @Test
    void emptyChainFailsWithActionableInvalidRequest() {
        CpApiException failure = assertThrows(CpApiException.class,
                () -> defaults.resolve(null, null));

        assertEquals(HttpStatus.BAD_REQUEST, failure.getStatus());
        assertEquals("INVALID_REQUEST", failure.getCode());
        assertTrue(failure.getMessage().contains("no usable default agent"),
                () -> "文案要点明没有可用的默认智能体：" + failure.getMessage());
        assertTrue(failure.getMessage().contains("PUT /api/v1/workspaces/{workspaceId}/agents/{principalId}/default"),
                () -> "文案要给出可操作出口：" + failure.getMessage());
    }

    @Test
    void malformedCallerIdIsBadRequest() {
        CpApiException failure = assertThrows(CpApiException.class,
                () -> defaults.resolve("not-a-uuid", null));

        assertEquals(HttpStatus.BAD_REQUEST, failure.getStatus());
        assertEquals("Malformed id: not-a-uuid", failure.getMessage());
    }
}
