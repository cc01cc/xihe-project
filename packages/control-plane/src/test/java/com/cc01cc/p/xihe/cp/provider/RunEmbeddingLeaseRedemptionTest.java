package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.ProviderCredentialLease;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class RunEmbeddingLeaseRedemptionTest {
    @Test
    void runBoundEmbeddingLeaseUsesEmbeddingOperationAndEnforcesRunBinding() {
        var repository = mock(ProviderCredentialLeaseRepository.class);
        var templates = mock(ApiRequestTemplateService.class);
        var catalog = mock(ProviderCatalogService.class);
        var types = mock(ApiInputTypeService.class);
        var json = new ObjectMapper();
        var service = new ProviderCredentialLeaseService(repository, mock(ProviderConnectionRepository.class),
                mock(ProviderConnectionService.class), catalog, types, json,
                mock(ProviderCredentialAccess.class));
        ReflectionTestUtils.setField(service, "requestTemplates", templates);
        var connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setProviderId("dashscope");
        connection.setApiTypeId("dashscope-multimodal-embedding");
        connection.setApiTypeVersion(1);
        connection.setRevision(1L);
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        var lease = new ProviderCredentialLease();
        lease.setRunId("run");
        lease.setProviderConnectionId(connection.getId().toString());
        lease.setProviderId("dashscope");
        lease.setModel("embedding-model");
        lease.setExpiresAt(Instant.now().plusSeconds(60));
        when(repository.findByLeaseHash(anyString())).thenReturn(Optional.of(lease));
        when(templates.lockConnection(connection.getId().toString())).thenReturn(connection);
        when(types.operation("dashscope-multimodal-embedding", 1)).thenReturn("embedding");
        when(catalog.require("dashscope")).thenReturn(json.createObjectNode());
        assertThrows(IllegalArgumentException.class, () -> service.redeem(
                new ProviderCredentialLeaseService.RedeemRequest("lease", "other-run",
                        connection.getId().toString(), "dashscope", "embedding-model", 1)));
        var grant = service.redeem(new ProviderCredentialLeaseService.RedeemRequest("lease", "run",
                connection.getId().toString(), "dashscope", "embedding-model", 1));
        assertEquals("embedding", grant.operation());
        assertEquals("embedding-model", grant.model());
        verify(templates, never()).requireModel(any(), anyString());
        verify(repository).save(lease);
    }
}
