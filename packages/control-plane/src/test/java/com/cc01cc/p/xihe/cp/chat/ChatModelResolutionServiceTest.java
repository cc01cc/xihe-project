package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.support.TestInstanceIdentity;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0642 V4 (D42-03) L0: the resolution chain is priority-ordered and deterministic.
 *
 * <p>MVP scope: steps 2-5 (Session binding → PRIMARY intent → effective llm-provider profile → 409
 * {@code LLM_NOT_CONFIGURED}). Step 1 (the public {@code ChatRequest.provider/model} legacy hint)
 * is deliberately not implemented — B-3 is pending the user ruling, so the conservative default
 * keeps the hint ignored (no wire semantics change).</p>
 */
class ChatModelResolutionServiceTest {

    private static final String USER = UUID.randomUUID().toString();
    private static final String WORKSPACE = UUID.randomUUID().toString();
    private static final String PRINCIPAL = UUID.randomUUID().toString();

    private final AgentPrincipalService agentPrincipals = mock(AgentPrincipalService.class);
    private final ConfigService configService = mock(ConfigService.class);
    private final ApiRequestTemplateService templates = mock(ApiRequestTemplateService.class);
    private final ChatModelResolutionService service =
            new ChatModelResolutionService(agentPrincipals, configService, templates);

    private Session session() {
        Session session = new Session(WORKSPACE, USER, "mvp");
        session.setId(UUID.randomUUID());
        return session;
    }

    private ProviderConnection connection(String provider) {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setProviderId(provider);
        connection.setRevision(3L);
        return connection;
    }

    @Test
    void completeSessionBindingWinsOverPrincipalAndProfile() {
        Session session = session();
        session.setModelProvider("p-session");
        session.setModelName("m-session");
        session.setProviderConnectionId(UUID.randomUUID().toString());
        session.setConnectionRevision(7L);
        when(agentPrincipals.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel("p-principal", "m-principal"));
        ChatModelResolutionService.Resolution resolved = service.resolve(session, PRINCIPAL);
        assertEquals("p-session", resolved.provider());
        assertEquals("m-session", resolved.model());
        assertEquals("session", resolved.source());
    }

    @Test
    void partialSessionBindingIsNeverTreatedAsUnbound() {
        Session session = session();
        session.setModelProvider("p-session");
        assertThrows(CpApiException.class, () -> service.resolve(session, PRINCIPAL),
                "a half-written bundle must fail closed");
    }

    @Test
    void primaryAgentIntentWinsOverTheProfileChain() {
        Session session = session();
        when(agentPrincipals.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel("p-intent", "m-intent"));
        when(templates.effectiveConnections(USER, WORKSPACE, "p-intent"))
                .thenReturn(List.of(connection("p-intent")));
        when(configService.resolveLlmProfile(any(), any()))
                .thenReturn(new ConfigService.ResolvedLlmProfile("p-profile", "k", "m-profile",
                        UUID.randomUUID().toString(), "USER", USER, 2L, "user"));
        ChatModelResolutionService.Resolution resolved = service.resolve(session, PRINCIPAL);
        assertEquals("p-intent", resolved.provider());
        assertEquals("m-intent", resolved.model());
        assertEquals("agent-principal", resolved.source());
    }

    @Test
    void principalIntentResolvesWithAnInstanceOnlyConnection() {
        Session session = session();
        ProviderConnection instance = connection("p-intent");
        instance.setOwnerType(ProviderConnection.OWNER_INSTANCE);
        instance.setOwnerId(TestInstanceIdentity.OWNER_ID);
        when(agentPrincipals.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel("p-intent", "m-intent"));
        when(templates.effectiveConnections(USER, WORKSPACE, "p-intent"))
                .thenReturn(List.of(instance));

        ChatModelResolutionService.Resolution resolved = service.resolve(session, PRINCIPAL);

        assertEquals("p-intent", resolved.provider());
        assertEquals("m-intent", resolved.model());
        assertEquals("agent-principal", resolved.source());
        assertEquals(instance.getId().toString(), resolved.providerConnectionId());
    }

    @Test
    void fallsBackToTheEffectiveLlmProfileWhenThePrincipalHasNoIntent() {
        Session session = session();
        when(agentPrincipals.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel(null, null));
        when(configService.resolveLlmProfile(any(), any()))
                .thenReturn(new ConfigService.ResolvedLlmProfile("p-profile", "k", "m-profile",
                        UUID.randomUUID().toString(), "USER", USER, 2L, "user"));
        ChatModelResolutionService.Resolution resolved = service.resolve(session, null);
        assertEquals("p-profile", resolved.provider());
        assertEquals("llm-profile", resolved.source());
    }

    @Test
    void noResolutionFailsClosedWithTheReusedCode() {
        Session session = session();
        when(agentPrincipals.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel(null, null));
        when(configService.resolveLlmProfile(any(), any())).thenReturn(null);
        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.resolve(session, PRINCIPAL));
        assertEquals("LLM_NOT_CONFIGURED", refused.getCode());
    }

    @Test
    void theSameInputResolvesIdenticallyEveryTime() {
        Session session = session();
        when(agentPrincipals.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel("p-intent", "m-intent"));
        when(templates.effectiveConnections(USER, WORKSPACE, "p-intent"))
                .thenReturn(List.of(connection("p-intent")));
        ChatModelResolutionService.Resolution first = service.resolve(session, PRINCIPAL);
        ChatModelResolutionService.Resolution second = service.resolve(session, PRINCIPAL);
        assertEquals(first, second, "no hidden defaults / environment drift");
    }

    @Test
    void ambiguousConnectionCandidatesFailClosedInsteadOfGuessing() {
        Session session = session();
        when(agentPrincipals.defaultModel(any(), any()))
                .thenReturn(new AgentPrincipalService.DefaultModel("p-intent", "m-intent"));
        when(templates.effectiveConnections(USER, WORKSPACE, "p-intent"))
                .thenReturn(List.of(connection("p-intent"), connection("p-intent")));
        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.resolve(session, PRINCIPAL));
        assertEquals("LLM_NOT_CONFIGURED", refused.getCode());
    }
}
