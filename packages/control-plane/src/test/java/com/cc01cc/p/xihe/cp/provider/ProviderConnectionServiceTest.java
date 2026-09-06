package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.oauth.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ProviderConnectionServiceTest {

    private final ProviderConnectionRepository repository = mock(ProviderConnectionRepository.class);
    private final ProviderConnectionAuditRepository auditRepository = mock(ProviderConnectionAuditRepository.class);
    private final ProviderCredentialLeaseRepository leaseRepository = mock(ProviderCredentialLeaseRepository.class);
    private final ProviderCatalogService catalog = mock(ProviderCatalogService.class);
    private final EnvelopeEncryptionService encryption = new EnvelopeEncryptionService(new byte[32]);
    private final ProviderConnectionService service = new ProviderConnectionService(
            repository, auditRepository, leaseRepository, catalog, encryption, new ObjectMapper());

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void createEncryptsApiKeyAndBindsUserScope() {
        TenantContext.setUserId("user-1");
        TenantContext.setWorkspaceId("workspace-1");

        ObjectNode definition = new ObjectMapper().createObjectNode();
        definition.put("id", "deepseek");
        definition.put("defaultBaseUrl", "https://api.deepseek.com/v1");
        definition.putObject("credential").put("required", true);
        when(catalog.require("deepseek")).thenReturn(definition);
        when(catalog.requiresCredential("deepseek")).thenReturn(true);
        when(repository.findByOwnerTypeAndOwnerIdAndProviderId("USER", "user-1", "deepseek"))
                .thenReturn(Optional.empty());
        when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection connection = service.create(new ProviderConnectionService.ConnectionInput(
                "deepseek", "Personal DeepSeek", "USER", "sk-test-key", null, null, List.of(), null));

        assertEquals("USER", connection.getOwnerType());
        assertEquals("user-1", connection.getOwnerId());
        assertEquals(ProviderConnection.STATUS_VERIFYING, connection.getStatus());
        assertTrue(connection.getCredentialCiphertext().startsWith("v1:"));
        assertNotEquals("sk-test-key", connection.getCredentialCiphertext());
        assertEquals("sk-test-key", encryption.decrypt(
                connection.getCredentialCiphertext(), "deepseek|USER|user-1|" + connection.getId()));
    }
}
