package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.policy.ResourceGovernor;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionModelLimitRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * task-771: a READY connection may legitimately have no credential when the provider catalog
 * declares {@code credential.required = false} (a local ollama endpoint, for example).
 *
 * <p>{@code GET /api/v1/models} iterated such a connection and the lease path called
 * {@code requireUsable(null)} → {@code CredentialNotFoundException: Credential not found: null},
 * which escaped as an unhandled 500. The lease token must still be minted (the runtime redeems
 * it); only the credential row check is skipped. A required-credential provider with a null link
 * stays an error, but as a typed 400 rather than a 500.</p>
 */
class ProviderCredentialLeaseCredentiallessTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WORKSPACE = "33333333-3333-4333-8333-333333333333";
    private static final String CONNECTION = "88888888-8888-4888-8888-888888888888";

    private ProviderCredentialLeaseRepository repository;
    private ProviderCredentialAccess credentialAccess;
    private ProviderCatalogService catalog;
    private ProviderCredentialLeaseService leases;
    private ProviderConnection connection;

    @BeforeEach
    void setUp() {
        repository = mock(ProviderCredentialLeaseRepository.class);
        credentialAccess = mock(ProviderCredentialAccess.class);
        catalog = mock(ProviderCatalogService.class);

        connection = new ProviderConnection();
        connection.setId(UUID.fromString(CONNECTION));
        connection.setProviderId("ollama");
        connection.setOwnerType(ProviderConnection.OWNER_USER);
        connection.setOwnerId(USER);
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setRevision(1L);
        connection.setCredentialId(null);

        ApiInputTypeService apiTypes = mock(ApiInputTypeService.class);
        when(apiTypes.operation("openai-chat-completions", 1)).thenReturn("chat");
        ProviderConnectionModelLimitRepository modelLimits =
                mock(ProviderConnectionModelLimitRepository.class);
        when(modelLimits.findByConnectionId(UUID.fromString(CONNECTION))).thenReturn(List.of());

        leases = new ProviderCredentialLeaseService(
                repository,
                mock(ProviderConnectionRepository.class),
                mock(ProviderConnectionService.class),
                catalog,
                apiTypes,
                new ObjectMapper(),
                credentialAccess,
                modelLimits,
                new ResourceGovernor());
        ApiRequestTemplateService templates = mock(ApiRequestTemplateService.class);
        when(templates.lockConnection(CONNECTION)).thenReturn(connection);
        ReflectionTestUtils.setField(leases, "requestTemplates", templates);
    }

    @Test
    void credentiallessProviderStillGetsACatalogLease() {
        when(catalog.requiresCredential("ollama")).thenReturn(false);

        ProviderCredentialLeaseService.IssuedLease lease = leases.issue(
                USER, WORKSPACE, null, null, CONNECTION, "ollama", "*");

        assertTrue(lease.token().startsWith("pl_"), "lease token is still minted");
        verify(repository).save(any());
        verifyNoInteractions(credentialAccess);
    }

    @Test
    void requiredCredentialWithNullLinkIsATypedBadRequestNotAnUnhandledFiveHundred() {
        when(catalog.requiresCredential("ollama")).thenReturn(true);

        CpApiException refused = assertThrows(CpApiException.class, () -> leases.issue(
                USER, WORKSPACE, null, null, CONNECTION, "ollama", "*"));

        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatus());
        assertEquals("PROVIDER_CONNECTION_INVALID", refused.getCode());
        verify(repository, never()).save(any());
        verifyNoInteractions(credentialAccess);
    }
}
