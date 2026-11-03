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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 2026-11-04 P0（task-24）：会话默认 provider 绑定的解析顺序。
 *
 * <p>契约：agent 主体默认模型优先；缺失时用生效 llm-provider profile（并带上它解析出的
 * connectionId）；两者都没有 ⇒ 400 {@code PROVIDER_REQUIRED}；profile 存在但解析不到连接 ⇒
 * 保留 {@code LLM_PROFILE_CONFLICT}（配置错 ≠ 没配置）。</p>
 */
@ExtendWith(MockitoExtension.class)
class SessionProviderDefaultsTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WORKSPACE = "22222222-2222-4222-8222-222222222222";
    private static final String PRINCIPAL = "33333333-3333-4333-8333-333333333333";

    @Mock
    private AgentPrincipalService agentPrincipalService;

    @Mock
    private ConfigService configService;

    @InjectMocks
    private SessionProviderDefaults defaults;

    @Test
    void agentDefaultModelWinsOverEffectiveProfile() {
        when(agentPrincipalService.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel("anthropic", "claude-sonnet-4.5"));

        SessionProviderDefaults.Defaults resolved = defaults.resolve(USER, WORKSPACE, PRINCIPAL);

        assertEquals("anthropic", resolved.modelProvider());
        assertEquals("claude-sonnet-4.5", resolved.modelName());
        assertNull(resolved.providerConnectionId(),
                "agent 默认只给 provider/model，连接交给「唯一可用 chat 连接」解析");
        assertEquals("agent-principal", resolved.source());
        verifyNoInteractions(configService);
    }

    @Test
    void fallsBackToEffectiveProfileWithConnectionSnapshot() {
        when(agentPrincipalService.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel(null, null));
        when(configService.resolveLlmProfile(any(), any()))
                .thenReturn(new ConfigService.ResolvedLlmProfile("deepseek", "deepseek-main",
                        "deepseek-flash", "conn-1", "USER", USER, 7L, "instance"));

        SessionProviderDefaults.Defaults resolved = defaults.resolve(USER, WORKSPACE, PRINCIPAL);

        assertEquals("deepseek", resolved.modelProvider());
        assertEquals("deepseek-flash", resolved.modelName());
        assertEquals("conn-1", resolved.providerConnectionId());
        assertEquals("llm-profile", resolved.source());
    }

    @Test
    void noConfigurationFailsWithProviderRequired() {
        when(agentPrincipalService.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel(" ", null));
        when(configService.resolveLlmProfile(any(), any())).thenReturn(null);

        CpApiException error = assertThrows(CpApiException.class,
                () -> defaults.resolve(USER, WORKSPACE, PRINCIPAL));

        assertEquals("PROVIDER_REQUIRED", error.getCode());
        assertEquals(400, error.getStatus().value());
    }

    @Test
    void profileConflictIsNotFlattenedIntoProviderRequired() {
        when(agentPrincipalService.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel(null, null));
        when(configService.resolveLlmProfile(any(), any()))
                .thenThrow(new CpApiException(HttpStatus.CONFLICT, "LLM_PROFILE_CONFLICT",
                        "No usable provider connection matches the profile"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> defaults.resolve(USER, WORKSPACE, PRINCIPAL));

        assertEquals("LLM_PROFILE_CONFLICT", error.getCode());
        assertEquals(409, error.getStatus().value());
    }
}
