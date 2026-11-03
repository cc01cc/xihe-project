package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.chat.SessionProviderDefaults;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.SessionPolicyState;
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionForkRequestRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 2026-11-04 P0（task-24）：{@code SessionService.createAgentSession} 的默认绑定行为。
 *
 * <p>四个契约：①三件套全空 + 有默认 ⇒ 补齐 connection/model/template 且 revision 快照正确；
 * ②显式传值优先（不查默认、不被覆盖）；③解析不到默认 ⇒ 400 {@code PROVIDER_REQUIRED} 且不落库；
 * ④多候选连接 ⇒ 可读 400 {@code PROVIDER_CONNECTION_AMBIGUOUS}（不是 500）。</p>
 */
@ExtendWith(MockitoExtension.class)
class SessionServiceProviderDefaultsTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WORKSPACE = "22222222-2222-4222-8222-222222222222";
    private static final String PRINCIPAL = "33333333-3333-4333-8333-333333333333";
    private static final String TEMPLATE_ID = "55555555-5555-4555-8555-555555555555";

    @Mock private SessionRepository sessionRepository;
    @Mock private SessionForkRequestRepository forkRequestRepository;
    @Mock private SessionBranchRepository sessionBranchRepository;
    @Mock private MessageRepository messageRepository;
    @Mock private WorkspaceService workspaceService;
    @Mock private ChatAttachmentService chatAttachmentService;
    @Mock private ProviderConnectionService providerConnectionService;
    @Mock private SessionPolicyState sessionPolicyState;
    @Mock private DbLockTimeout dbLockTimeout;
    @Mock private AgentPrincipalService agentPrincipalService;
    @Mock private EntityManager entityManager;
    @Mock private ContextService contextService;
    @Mock private McpInvocationService mcpInvocationService;
    @Mock private GrantDefaultService grantDefaultService;
    @Mock private WorkspaceBackendPolicy backendPolicy;
    @Mock private SessionParticipantService sessionParticipantService;
    @Mock private ApiRequestTemplateService apiRequestTemplates;
    @Mock private SessionProviderDefaults sessionProviderDefaults;

    @InjectMocks private SessionService sessionService;

    @org.junit.jupiter.api.BeforeEach
    void injectFieldDependencies() {
        // SessionService 有两个 @Autowired 字段（模板服务与默认值解析器），构造器注入覆盖不到。
        ReflectionTestUtils.setField(sessionService, "apiRequestTemplates", apiRequestTemplates);
        ReflectionTestUtils.setField(sessionService, "sessionProviderDefaults", sessionProviderDefaults);
    }

    private static ProviderConnection connection(String provider, long revision) {
        ProviderConnection connection = mock(ProviderConnection.class);
        when(connection.getProviderId()).thenReturn(provider);
        when(connection.getRevision()).thenReturn(revision);
        when(connection.getId()).thenReturn(UUID.randomUUID());
        return connection;
    }

    private void stubCapAndSave() {
        when(agentPrincipalService.resolveCapFor(anyString(), anyString()))
                .thenReturn(JsonNodeFactory.instance.objectNode());
        when(sessionRepository.save(any(Session.class))).thenAnswer(invocation -> invocation.getArgument(0));
    }

    private void stubTemplateSnapshot(ProviderConnection connection, String model) {
        ObjectNode snapshot = JsonNodeFactory.instance.objectNode();
        snapshot.put("layer", "instance");
        snapshot.put("templateId", TEMPLATE_ID);
        snapshot.put("version", 3);
        when(apiRequestTemplates.resolve(any(), eq(model), any(), any(), any()))
                .thenReturn(snapshot);
    }

    @Test
    void defaultsFillBindingAndTemplateSnapshot() {
        stubCapAndSave();
        ProviderConnection bound = connection("deepseek", 7L);
        when(sessionProviderDefaults.resolve(USER, WORKSPACE, PRINCIPAL))
                .thenReturn(new SessionProviderDefaults.Defaults("deepseek", "deepseek-flash",
                        "conn-1", "llm-profile"));
        when(apiRequestTemplates.lockConnection("conn-1")).thenReturn(bound);
        when(providerConnectionService.requireUsableForOwner(anyString(), anyString(), anyString()))
                .thenReturn(bound);
        stubTemplateSnapshot(bound, "deepseek-flash");

        Session session = sessionService.createAgentSession(USER, WORKSPACE, "t",
                null, null, null, PRINCIPAL);

        assertEquals(bound.getId().toString(), session.getProviderConnectionId(),
                "落库的是连接行的规范化 id（不是请求里的任意字符串）");
        assertEquals(7L, session.getConnectionRevision(), "revision 快照必须与连接一致");
        assertEquals("deepseek", session.getModelProvider());
        assertEquals("deepseek-flash", session.getModelName());
        assertEquals("instance", session.getContextTemplateLayer());
        assertEquals(UUID.fromString(TEMPLATE_ID), session.getContextTemplateId());
        assertEquals(3, session.getContextTemplateVersion());
    }

    @Test
    void explicitValuesAreNeverOverridden() {
        stubCapAndSave();
        ProviderConnection explicit = connection("openai", 2L);
        when(apiRequestTemplates.lockConnection("conn-explicit")).thenReturn(explicit);
        when(providerConnectionService.requireUsableForOwner(anyString(), anyString(), anyString()))
                .thenReturn(explicit);
        stubTemplateSnapshot(explicit, "gpt-5.1");

        Session session = sessionService.createAgentSession(USER, WORKSPACE, "t",
                "openai", "gpt-5.1", "conn-explicit", PRINCIPAL);

        verify(sessionProviderDefaults, never()).resolve(any(), any(), any());
        assertEquals(explicit.getId().toString(), session.getProviderConnectionId());
        assertEquals(2L, session.getConnectionRevision());
        assertEquals("openai", session.getModelProvider());
        assertEquals("gpt-5.1", session.getModelName());
    }

    @Test
    void missingDefaultsRejectsBareSession() {
        when(agentPrincipalService.resolveCapFor(anyString(), anyString()))
                .thenReturn(JsonNodeFactory.instance.objectNode());
        when(sessionProviderDefaults.resolve(USER, WORKSPACE, PRINCIPAL))
                .thenThrow(new CpApiException(HttpStatus.BAD_REQUEST, "PROVIDER_REQUIRED",
                        "No provider binding"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> sessionService.createAgentSession(USER, WORKSPACE, "t",
                        null, null, null, PRINCIPAL));

        assertEquals("PROVIDER_REQUIRED", error.getCode());
        assertEquals(400, error.getStatus().value());
        verify(sessionRepository, never()).save(any(Session.class));
    }

    @Test
    void ambiguousConnectionsFailWithReadable400() {
        when(agentPrincipalService.resolveCapFor(anyString(), anyString()))
                .thenReturn(JsonNodeFactory.instance.objectNode());
        ProviderConnection first = mock(ProviderConnection.class);
        ProviderConnection second = mock(ProviderConnection.class);
        when(apiRequestTemplates.effectiveConnections(anyString(), anyString(), anyString()))
                .thenReturn(List.of(first, second));

        CpApiException error = assertThrows(CpApiException.class,
                () -> sessionService.createAgentSession(USER, WORKSPACE, "t",
                        "deepseek", "deepseek-flash", null, PRINCIPAL));

        assertEquals("PROVIDER_CONNECTION_AMBIGUOUS", error.getCode());
        assertEquals(400, error.getStatus().value());
        assertTrue(error.getMessage().contains("Multiple usable chat connections"),
                "多候选必须是可读 400：" + error.getMessage());
        verify(sessionRepository, never()).save(any(Session.class));
    }
}
