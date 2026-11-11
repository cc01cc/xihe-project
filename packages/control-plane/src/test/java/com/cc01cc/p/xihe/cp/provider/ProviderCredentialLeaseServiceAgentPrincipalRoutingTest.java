package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0622 M1.4 (K3): {@code principalId == null} must be <b>byte-equivalent</b> to the pre-0622
 * call path.
 *
 * <p>The legacy overloads keep their signatures and their behaviour: when no agent principal is
 * supplied the lease still calls the untouched three-argument
 * {@code requireUsable(credentialId, userId, workspaceId)}. Only the new overload with a principal
 * routes to the agent arm.</p>
 */
class ProviderCredentialLeaseServiceAgentPrincipalRoutingTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WORKSPACE = "33333333-3333-4333-8333-333333333333";
    private static final String SESSION = "66666666-6666-4666-8666-666666666666";
    private static final String RUN = "77777777-7777-4777-8777-777777777777";
    private static final String CONNECTION = "88888888-8888-4888-8888-888888888888";
    private static final String PRINCIPAL = "55555555-5555-4555-8555-555555555555";
    private static final String MODEL = "gpt-4o";

    private ProviderCredentialAccess credentialAccess;
    private ProviderCredentialLeaseService leases;
    private ProviderConnection connection;

    @BeforeEach
    void setUp() {
        credentialAccess = mock(ProviderCredentialAccess.class);
        leases = new ProviderCredentialLeaseService(
                mock(ProviderCredentialLeaseRepository.class),
                mock(ProviderConnectionRepository.class),
                mock(ProviderConnectionService.class),
                mock(ProviderCatalogService.class),
                mock(ApiInputTypeService.class),
                new ObjectMapper(),
                credentialAccess,
                mock(com.cc01cc.p.xihe.cp.repository.ProviderConnectionModelLimitRepository.class),
                new com.cc01cc.p.xihe.cp.policy.ResourceGovernor());
        ApiRequestTemplateService templates = mock(ApiRequestTemplateService.class);
        ReflectionTestUtils.setField(leases, "requestTemplates", templates);
        connection = new ProviderConnection();
        connection.setId(UUID.fromString(CONNECTION));
        connection.setProviderId("openai");
        connection.setCredentialId(UUID.randomUUID());
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setRevision(7L);
        when(templates.lockConnection(CONNECTION)).thenReturn(connection);
        ApiInputTypeService apiTypes = (ApiInputTypeService) ReflectionTestUtils.getField(leases, "apiTypes");
        when(apiTypes.operation("openai-chat-completions", 1)).thenReturn("chat");
    }

    @Test
    void theLegacyOverloadStillCallsTheUntouchedThreeArgumentGate() {
        leases.issue(USER, WORKSPACE, SESSION, RUN, CONNECTION, "openai", MODEL, 7L);

        verify(credentialAccess).requireUsable(connection.getCredentialId(), USER, WORKSPACE);
        verify(credentialAccess, never()).requireUsableForAgentPrincipal(any(), anyString(), anyString(),
                anyString(), any(Boolean.class));
    }

    @Test
    void aNullPrincipalOnTheNewOverloadIsTheSameOldPath() {
        leases.issue(USER, WORKSPACE, SESSION, RUN, CONNECTION, "openai", MODEL, 7L, null, null, null);

        verify(credentialAccess).requireUsable(connection.getCredentialId(), USER, WORKSPACE);
        verify(credentialAccess, never()).requireUsableForAgentPrincipal(any(), anyString(), anyString(),
                anyString(), any(Boolean.class));
    }

    @Test
    void anInstanceConnectionRoutesToTheSharedCredentialGate() {
        // D-922: the consumer does not own the admin's credential; only the connection gate plus
        // the credential shape apply.
        connection.setOwnerType(ProviderConnection.OWNER_INSTANCE);
        connection.setOwnerId(ProviderConnection.INSTANCE_OWNER_ID);

        leases.issue(USER, WORKSPACE, SESSION, RUN, CONNECTION, "openai", MODEL, 7L);

        verify(credentialAccess).requireUsableForSharedConnection(connection.getCredentialId());
        verify(credentialAccess, never()).requireUsable(eq(connection.getCredentialId()),
                anyString(), anyString());
        verify(credentialAccess, never()).requireUsableForAgentPrincipal(any(), anyString(), anyString(),
                anyString(), any(Boolean.class));
    }

    @Test
    void aPrincipalRoutesToTheAgentArmWithTheCapDecision() {
        ArrayNode cap = new ObjectMapper().createArrayNode();
        ObjectNode atom = cap.addObject();
        atom.put("actionClass", "credential_use");
        atom.put("resource", "credential:" + connection.getCredentialId());

        leases.issue(USER, WORKSPACE, SESSION, RUN, CONNECTION, "openai", MODEL, 7L, null, PRINCIPAL, cap);

        verify(credentialAccess).requireUsableForAgentPrincipal(connection.getCredentialId(), USER, WORKSPACE,
                PRINCIPAL, true);
        verify(credentialAccess, never()).requireUsable(eq(connection.getCredentialId()), anyString(), anyString());
    }
}
