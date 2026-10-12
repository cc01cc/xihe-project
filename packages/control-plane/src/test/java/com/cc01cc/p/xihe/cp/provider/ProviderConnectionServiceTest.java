package com.cc01cc.p.xihe.cp.provider;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionAuditRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderCredentialLeaseRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ProviderConnectionServiceTest {

    private final ProviderConnectionRepository repository = mock(ProviderConnectionRepository.class);
    private final ProviderConnectionAuditRepository auditRepository = mock(ProviderConnectionAuditRepository.class);
    private final ProviderCredentialLeaseRepository leaseRepository = mock(ProviderCredentialLeaseRepository.class);
    private final ProviderCatalogService catalog = mock(ProviderCatalogService.class);
    private final ApiInputTypeService apiTypes = new ApiInputTypeService(new ObjectMapper());
    private final EnvelopeEncryptionService encryption = new EnvelopeEncryptionService(new byte[32]);
    private final com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService requestTemplates =
            mock(com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService.class);
    private final ProviderConnectionService service = new ProviderConnectionService(
            repository, auditRepository, leaseRepository, catalog, apiTypes, encryption, new ObjectMapper(),
            requestTemplates);

    @org.junit.jupiter.api.BeforeEach
    void wireLockedConnectionDelegation() {
        org.mockito.Mockito.lenient().when(requestTemplates.lockConnection(anyString())).thenAnswer(
                invocation -> repository.findById(UUID.fromString(invocation.getArgument(0))).orElseThrow());
    }

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
        when(catalog.supportedPair("deepseek", "openai-chat-completions", 1)).thenReturn(definition);
        when(catalog.requiresCredential("deepseek")).thenReturn(true);
        when(catalog.defaultApiType("deepseek")).thenReturn(
                new ProviderCatalogService.ApiTypeRef("openai-chat-completions", 1, "chat"));
        when(repository.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                "USER", "user-1", "deepseek", "default")).thenReturn(Optional.empty());
        when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection connection = service.create(new ProviderConnectionService.ConnectionInput(
                "deepseek", "Personal DeepSeek", "USER", "sk-test-key", null, null, List.of(), null,
                "default"));

        assertEquals("USER", connection.getOwnerType());
        assertEquals("user-1", connection.getOwnerId());
        assertEquals("default", connection.getConnectionKey());
        assertEquals("openai-chat-completions", connection.getApiTypeId());
        assertEquals(1, connection.getApiTypeVersion());
        assertEquals(ProviderConnection.STATUS_VERIFYING, connection.getStatus());
        assertTrue(connection.getCredentialCiphertext().startsWith("v1:"));
        assertNotEquals("sk-test-key", connection.getCredentialCiphertext());
        assertEquals("sk-test-key", encryption.decrypt(
                connection.getCredentialCiphertext(), "deepseek|USER|user-1|" + connection.getId()));
    }

    @Test
    void modelDescriptorUseCasePreservesDistinctConnectionsForSameProvider() {
        ProviderConnectionService visibleConnections = mock(ProviderConnectionService.class);
        ProviderCredentialLeaseService leases = mock(ProviderCredentialLeaseService.class);
        ProviderCatalogService providerCatalog = mock(ProviderCatalogService.class);
        ProviderModelDescriptorService descriptorService = new ProviderModelDescriptorService(
                visibleConnections, leases, providerCatalog, apiTypes);

        UUID connectionId = UUID.randomUUID();
        ProviderConnection active = mock(ProviderConnection.class);
        when(active.isEnabled()).thenReturn(true);
        when(active.getStatus()).thenReturn(ProviderConnection.STATUS_READY);
        when(active.getProviderId()).thenReturn("deepseek");
        when(active.getId()).thenReturn(connectionId);
        when(active.getConnectionKey()).thenReturn("default");
        when(active.getApiTypeId()).thenReturn("openai-chat-completions");
        when(active.getApiTypeVersion()).thenReturn(1);
        when(active.getOwnerType()).thenReturn(ProviderConnection.OWNER_USER);
        when(active.getRevision()).thenReturn(7L);

        UUID secondConnectionId = UUID.randomUUID();
        ProviderConnection secondConnection = mock(ProviderConnection.class);
        when(secondConnection.isEnabled()).thenReturn(true);
        when(secondConnection.getStatus()).thenReturn(ProviderConnection.STATUS_READY);
        when(secondConnection.getProviderId()).thenReturn("deepseek");
        when(secondConnection.getId()).thenReturn(secondConnectionId);
        when(secondConnection.getConnectionKey()).thenReturn("secondary");
        when(secondConnection.getApiTypeId()).thenReturn("openai-chat-completions");
        when(secondConnection.getApiTypeVersion()).thenReturn(1);
        when(secondConnection.getOwnerType()).thenReturn(ProviderConnection.OWNER_WORKSPACE);
        when(secondConnection.getRevision()).thenReturn(4L);

        ProviderConnection disabled = mock(ProviderConnection.class);
        when(disabled.isEnabled()).thenReturn(false);
        when(disabled.getProviderId()).thenReturn("disabled-provider");

        when(visibleConnections.listVisibleEntities()).thenReturn(List.of(active, secondConnection, disabled));
        when(leases.issue("user-1", "workspace-1", null, null,
                connectionId.toString(), "deepseek", "*"))
                .thenReturn(new ProviderCredentialLeaseService.IssuedLease(
                        "lease-only-for-test", Instant.EPOCH));
        when(leases.issue("user-1", "workspace-1", null, null,
                secondConnectionId.toString(), "deepseek", "*"))
                .thenReturn(new ProviderCredentialLeaseService.IssuedLease(
                        "lease-second-for-test", Instant.EPOCH));
        ObjectNode definition = new ObjectMapper().createObjectNode();
        definition.put("id", "deepseek");
        definition.put("displayName", "DeepSeek");
        when(providerCatalog.require("deepseek")).thenReturn(definition);

        List<Map<String, Object>> result = descriptorService.scopedModelDescriptors("user-1", "workspace-1");

        assertEquals(2, result.size());
        Map<String, Object> descriptor = result.get(0);
        assertEquals("lease-only-for-test", descriptor.get("lease"));
        assertEquals(connectionId, descriptor.get("connectionId"));
        assertEquals("default", descriptor.get("connectionKey"));
        assertEquals("deepseek", descriptor.get("providerId"));
        assertEquals("DeepSeek", descriptor.get("displayName"));
        assertEquals("USER", descriptor.get("scope"));
        assertEquals(7L, descriptor.get("connectionRevision"));
        assertEquals("openai-chat-completions", descriptor.get("apiTypeId"));
        assertEquals(1, descriptor.get("apiTypeVersion"));
        assertEquals("chat", descriptor.get("operation"));
        assertFalse(descriptor.containsKey("apiKey"));
        assertEquals(secondConnectionId, result.get(1).get("connectionId"));
        assertEquals("secondary", result.get(1).get("connectionKey"));
        verify(leases).issue("user-1", "workspace-1", null, null,
                connectionId.toString(), "deepseek", "*");
        verify(leases).issue("user-1", "workspace-1", null, null,
                secondConnectionId.toString(), "deepseek", "*");
    }

    @Test
    void createRejectsInvalidConnectionKey() {
        TenantContext.setUserId("user-1");

        ProviderConnectionService.KeyInvalidException error = assertThrows(
                ProviderConnectionService.KeyInvalidException.class,
                () -> service.create(new ProviderConnectionService.ConnectionInput(
                        "deepseek", "Invalid Key", "USER", "sk-test-key", null, null, List.of(), null,
                        "Invalid_Key")));

        assertTrue(error.getMessage().contains("lowercase slug"));
    }

    @Test
    void createRejectsDuplicateConnectionKeyInSameScope() {
        TenantContext.setUserId("user-1");
        ObjectNode definition = new ObjectMapper().createObjectNode();
        definition.put("id", "deepseek");
        definition.put("defaultBaseUrl", "https://api.deepseek.com/v1");
        definition.putObject("credential").put("required", true);
        when(catalog.require("deepseek")).thenReturn(definition);
        when(catalog.supportedPair("deepseek", "openai-chat-completions", 1)).thenReturn(definition);
        when(catalog.requiresCredential("deepseek")).thenReturn(true);
        when(catalog.defaultApiType("deepseek")).thenReturn(
                new ProviderCatalogService.ApiTypeRef("openai-chat-completions", 1, "chat"));
        when(repository.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                "USER", "user-1", "deepseek", "default"))
                .thenReturn(Optional.of(new ProviderConnection()));

        ProviderConnectionService.KeyConflictException error = assertThrows(
                ProviderConnectionService.KeyConflictException.class,
                () -> service.create(new ProviderConnectionService.ConnectionInput(
                        "deepseek", "Duplicate", "USER", "sk-test-key", null, null, List.of(), null,
                        "default")));

        assertTrue(error.getMessage().contains("already exists"));
    }

    @Test
    void updateRejectsConnectionKeyRename() {
        TenantContext.setUserId("user-1");
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType("USER");
        connection.setOwnerId("user-1");
        connection.setProviderId("deepseek");
        connection.setConnectionKey("default");
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel("Personal");
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        when(repository.findById(connection.getId())).thenReturn(Optional.of(connection));

        ProviderConnectionService.KeyImmutableException error = assertThrows(
                ProviderConnectionService.KeyImmutableException.class,
                () -> service.update(connection.getId().toString(),
                        new ProviderConnectionService.ConnectionInput(
                                "deepseek", null, null, null, null, null, null, null, "renamed")));

        assertTrue(error.getMessage().contains("cannot be changed"));
    }

    @Test
    void ordinaryViewDoesNotDeriveCredentialSuffix() {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType("USER");
        connection.setOwnerId("user-1");
        connection.setProviderId("deepseek");
        connection.setConnectionKey("default");
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel("Personal");
        connection.setCredentialCiphertext("v1:ciphertext");
        connection.setEncryptionKeyVersion(encryption.currentVersion());

        ProviderConnectionService.ProviderConnectionView view = service.view(connection);

        assertTrue(view.hasKey());
        assertNull(view.maskedKey());
        assertEquals("default", view.connectionKey());
        assertEquals("openai-chat-completions", view.apiTypeId());
        assertEquals("chat", view.operation());
    }

    @Test
    void createRejectsBaseUrlsMissingApiTypePathPrefix() {
        TenantContext.setUserId("user-1");
        ObjectNode definition = new ObjectMapper().createObjectNode();
        definition.put("id", "deepseek");
        definition.put("defaultBaseUrl", "https://api.deepseek.com/v1");
        definition.putObject("credential").put("required", true);
        when(catalog.require("deepseek")).thenReturn(definition);
        when(catalog.requiresCredential("deepseek")).thenReturn(true);
        when(catalog.defaultApiType("deepseek")).thenReturn(
                new ProviderCatalogService.ApiTypeRef("openai-chat-completions", 1, "chat"));
        when(catalog.supportedPair("deepseek", "openai-chat-completions", 1)).thenReturn(definition);

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> service.create(new ProviderConnectionService.ConnectionInput(
                        "deepseek", "No Prefix", "USER", "sk-test-key",
                        "https://gateway.example.com", null, List.of(), null, "default")));

        assertTrue(error.getMessage().contains("Invalid provider Base URL"));
        assertTrue(error.getCause().getMessage().contains("/v1"));
    }

    // ------------------------------------------------------------------
    // PLAN-0307 T2.20 (decisions #34/#35/#37): scope permission matrix
    // ------------------------------------------------------------------

    @Test
    void createRejectsSystemScope() {
        TenantContext.setUserId("user-1");

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
                service.create(new ProviderConnectionService.ConnectionInput(
                        "deepseek", "System DeepSeek", "SYSTEM", "sk-test-key", null, null, List.of(), null,
                        "default")));

        assertEquals("Unsupported provider connection scope", error.getMessage());
    }

    @Test
    void createRejectsWorkspaceScopeWithoutWorkspaceAdminRole() {
        TenantContext.setUserId("user-1");
        TenantContext.setWorkspaceId("workspace-1");
        TenantContext.setWorkspaceRole("MEMBER");

        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
                service.create(new ProviderConnectionService.ConnectionInput(
                        "deepseek", "Workspace DeepSeek", "WORKSPACE", "sk-test-key", null, null, List.of(), null,
                        "default")));

        assertEquals("Workspace administrator permission is required", error.getMessage());
    }

    @Test
    void createAllowsWorkspaceScopeForOwnerAndBindsWorkspace() {
        TenantContext.setUserId("user-1");
        TenantContext.setWorkspaceId("workspace-1");
        TenantContext.setWorkspaceRole("OWNER");
        ObjectNode definition = new ObjectMapper().createObjectNode();
        definition.put("id", "deepseek");
        definition.put("defaultBaseUrl", "https://api.deepseek.com/v1");
        definition.putObject("credential").put("required", true);
        when(catalog.require("deepseek")).thenReturn(definition);
        when(catalog.supportedPair("deepseek", "openai-chat-completions", 1)).thenReturn(definition);
        when(catalog.requiresCredential("deepseek")).thenReturn(true);
        when(catalog.defaultApiType("deepseek")).thenReturn(
                new ProviderCatalogService.ApiTypeRef("openai-chat-completions", 1, "chat"));
        when(repository.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                "WORKSPACE", "workspace-1", "deepseek", "default")).thenReturn(Optional.empty());
        when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection connection = service.create(new ProviderConnectionService.ConnectionInput(
                "deepseek", "Workspace DeepSeek", "WORKSPACE", "sk-test-key", null, null, List.of(), null,
                "default"));

        assertEquals("WORKSPACE", connection.getOwnerType());
        assertEquals("workspace-1", connection.getOwnerId());
    }

    @Test
    void updateRefreshesEncryptionKeyVersionWhenCredentialChanges() {
        // PLAN-0307 T2.24 (review P1-7): re-encryption must stamp the active key
        // version instead of keeping the stale one.
        TenantContext.setUserId("user-1");
        ProviderConnection connection = new ProviderConnection();
        connection.setId(java.util.UUID.randomUUID());
        connection.setOwnerType("USER");
        connection.setOwnerId("user-1");
        connection.setProviderId("deepseek");
        connection.setConnectionKey("default");
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel("Personal");
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        connection.setEncryptionKeyVersion("v0-stale");
        when(repository.findById(connection.getId())).thenReturn(Optional.of(connection));
        when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection updated = service.update(connection.getId().toString(),
                new ProviderConnectionService.ConnectionInput(
                        "deepseek", null, null, "sk-new-key", null, null, null, null, null));

        assertNotEquals("v0-stale", updated.getEncryptionKeyVersion());
        assertEquals(encryption.currentVersion(), updated.getEncryptionKeyVersion());
    }

    @Test
    void createAndResetConsumeSupportedPairOverrides() {
        TenantContext.setUserId("user-1");
        ObjectMapper mapper = new ObjectMapper();
        ProviderCatalogService realCatalog = new ProviderCatalogService(mapper, apiTypes);
        ObjectNode pair = (ObjectNode) realCatalog.require("deepseek").path("supportedApiTypes").get(0);
        pair.put("defaultBaseUrl", "https://pair.example/v1");
        pair.put("modelDiscovery", "manual");
        ProviderConnectionService pairService = new ProviderConnectionService(
                repository, auditRepository, leaseRepository, realCatalog, apiTypes, encryption, mapper,
                requestTemplates);
        when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection created = pairService.create(new ProviderConnectionService.ConnectionInput(
                "deepseek", "Pair", "USER", "test-key", null, null, List.of("pair-model"), null, "default"));
        assertEquals("https://pair.example/v1", created.getBaseUrl());
        assertEquals("manual", created.getModelDiscovery());
        assertEquals("openai-chat-completions", created.getApiTypeId());
        when(repository.findById(created.getId())).thenReturn(Optional.of(created));
        created.setBaseUrl("https://custom.example/v1");
        ProviderConnection reset = pairService.update(created.getId().toString(),
                new ProviderConnectionService.ConnectionInput(
                        null, null, null, null, "", null, null, null, null));
        assertEquals("https://pair.example/v1", reset.getBaseUrl());
    }

    @Test
    void ordinaryReadAndLabelEditPreserveModelSettings() {
        TenantContext.setUserId("user-1");
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType("USER");
        connection.setOwnerId("user-1");
        connection.setProviderId("deepseek");
        connection.setConnectionKey("default");
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setModelDiscovery("manual");
        connection.setManualModels("[\"model-a\",\"model-b\"]");
        when(repository.findById(connection.getId())).thenReturn(Optional.of(connection));
        when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        var view = service.view(connection);
        assertEquals("manual", view.modelDiscovery());
        assertEquals(List.of("model-a", "model-b"), view.manualModels());
        ProviderConnection updated = service.update(connection.getId().toString(),
                new ProviderConnectionService.ConnectionInput(
                        null, "Renamed", null, null, null, view.modelDiscovery(), view.manualModels(), null, null));
        assertEquals("Renamed", updated.getLabel());
        assertEquals(view.manualModels(), service.view(updated).manualModels());
        assertEquals("manual", updated.getModelDiscovery());
        connection.setManualModels("invalid-json");
        assertThrows(IllegalStateException.class, () -> service.view(connection));
    }
}
