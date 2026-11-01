package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.ResourceExhaustedException;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.policy.ResourceGovernor;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionModelLimitRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0622 M1.5 (R2): admission happens before persistence.
 *
 * <p>The negative case is the whole point: with one connection slot, the second concurrent lease is
 * refused with {@code 429 RESOURCE_EXHAUSTED} and the repository stays at <b>one</b> saved lease —
 * a refusal never leaves a durable row behind.</p>
 */
class ResourceGovernorLeasePathTest {

    private static final String USER = "11111111-1111-4111-8111-111111111111";
    private static final String WORKSPACE = "33333333-3333-4333-8333-333333333333";
    private static final String SESSION = "66666666-6666-4666-8666-666666666666";
    private static final String CONNECTION = "88888888-8888-4888-8888-888888888888";
    private static final String MODEL = "gpt-4o";

    private ProviderCredentialLeaseRepository repository;
    private ProviderCredentialLeaseService leases;

    @BeforeEach
    void setUp() {
        repository = mock(ProviderCredentialLeaseRepository.class);
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.fromString(CONNECTION));
        connection.setProviderId("openai");
        connection.setCredentialId(UUID.randomUUID());
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setRevision(7L);
        connection.setMaxInflight(1);
        connection.setMaxQueue(8);

        ProviderCredentialAccess credentialAccess = mock(ProviderCredentialAccess.class);
        ApiInputTypeService apiTypes = mock(ApiInputTypeService.class);
        when(apiTypes.operation("openai-chat-completions", 1)).thenReturn("chat");
        ProviderConnectionModelLimitRepository modelLimits = mock(ProviderConnectionModelLimitRepository.class);
        when(modelLimits.findByConnectionId(UUID.fromString(CONNECTION))).thenReturn(List.of());

        leases = new ProviderCredentialLeaseService(
                repository,
                mock(ProviderConnectionRepository.class),
                mock(ProviderConnectionService.class),
                mock(ProviderCatalogService.class),
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
    void theSecondConcurrentLeaseIsRefusedAndNoRowIsPersisted() {
        leases.issue(USER, WORKSPACE, SESSION, "run-1", CONNECTION, "openai", MODEL, 7L);

        ResourceExhaustedException refused = assertThrows(ResourceExhaustedException.class,
                () -> leases.issue(USER, WORKSPACE, SESSION, "run-2", CONNECTION, "openai", MODEL, 7L));
        assertEquals("RESOURCE_EXHAUSTED", refused.getCode());
        assertEquals("CONNECTION", refused.getResourceKind(), "the connection slot is the one that ran out");
        verify(repository, times(1)).save(any());
    }

    @Test
    void aDifferentModelUnderTheSameConnectionStillCountsAgainstTheConnection() {
        leases.issue(USER, WORKSPACE, SESSION, "run-1", CONNECTION, "openai", MODEL, 7L);

        assertThrows(ResourceExhaustedException.class,
                () -> leases.issue(USER, WORKSPACE, SESSION, "run-2", CONNECTION, "openai", "gpt-4o-mini", 7L),
                "the CONNECTION ceiling governs every model on that connection");
        verify(repository, times(1)).save(any());
    }
}
