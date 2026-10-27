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
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
    private final com.cc01cc.p.xihe.cp.credentials.CredentialService credentialService =
            mock(com.cc01cc.p.xihe.cp.credentials.CredentialService.class);
    private final ProviderCredentialAccess credentialAccess = mock(ProviderCredentialAccess.class);
    private final com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService requestTemplates =
            mock(com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService.class);
    @SuppressWarnings("unchecked")
    private final org.springframework.beans.factory.ObjectProvider<com.cc01cc.p.xihe.cp.config.ConfigService> configService =
            mock(org.springframework.beans.factory.ObjectProvider.class);
    private final ProviderConnectionService service = new ProviderConnectionService(
            repository, auditRepository, leaseRepository, catalog, apiTypes, credentialService,
            credentialAccess, new ObjectMapper(), requestTemplates, configService);

    @org.junit.jupiter.api.BeforeEach
    void wireLockedConnectionDelegation() {
        org.mockito.Mockito.lenient().when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));
        org.mockito.Mockito.lenient().when(repository.saveAndFlush(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));
        org.mockito.Mockito.lenient().when(requestTemplates.lockConnection(anyString())).thenAnswer(
                invocation -> repository.findById(UUID.fromString(invocation.getArgument(0))).orElseThrow());
        org.mockito.Mockito.lenient().when(credentialService.create(any(), anyString()))
                .thenAnswer(invocation -> {
                    com.cc01cc.p.xihe.cp.entity.Credential credential =
                            new com.cc01cc.p.xihe.cp.entity.Credential();
                    credential.setId(UUID.randomUUID());
                    return credential;
                });
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
        when(repository.saveAndFlush(any(ProviderConnection.class)))
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
        assertNotNull(connection.getCredentialId());
        verify(credentialService).create(any(), anyString());
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
    void createRejectsDuplicateLabelIgnoringCaseAndWhitespace() {
        TenantContext.setUserId("user-1");
        stubCatalogForCreate();
        when(repository.findByOwnerTypeAndOwnerIdAndProviderId(
                "USER", "user-1", "deepseek"))
                .thenReturn(List.of(connection("user-1", "deepseek", "Primary account")));

        ProviderConnectionService.LabelConflictException error = assertThrows(
                ProviderConnectionService.LabelConflictException.class,
                () -> service.create(new ProviderConnectionService.ConnectionInput(
                        "deepseek", "  primary ACCOUNT ", "USER", "sk-test-key", null, null,
                        List.of(), null, "second")));

        assertTrue(error.getMessage().contains("already exists"));
    }

    @Test
    void createRejectsBlankAndOverlongLabels() {
        TenantContext.setUserId("user-1");
        stubCatalogForCreate();

        assertThrows(ProviderConnectionService.LabelInvalidException.class,
                () -> service.create(new ProviderConnectionService.ConnectionInput(
                        "deepseek", "   ", "USER", "sk-test-key", null, null, List.of(), null,
                        "blank")));
        assertThrows(ProviderConnectionService.LabelInvalidException.class,
                () -> service.create(new ProviderConnectionService.ConnectionInput(
                        "deepseek", "x".repeat(41), "USER", "sk-test-key", null, null,
                        List.of(), null, "long")));
    }

    @Test
    void createTrimsSurroundingWhitespaceFromLabel() {
        TenantContext.setUserId("user-1");
        stubCatalogForCreate();
        when(repository.saveAndFlush(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection created = service.create(new ProviderConnectionService.ConnectionInput(
                "deepseek", "  Trimmed  ", "USER", "sk-test-key", null, null, List.of(), null,
                "trimmed"));

        assertEquals("Trimmed", created.getLabel());
    }

    @Test
    void updateAllowsCaseOnlyChangeToOwnLabel() {
        TenantContext.setUserId("user-1");
        ProviderConnection connection = connection("user-1", "deepseek", "Primary");
        when(repository.findById(connection.getId())).thenReturn(Optional.of(connection));
        when(repository.findByOwnerTypeAndOwnerIdAndProviderId(
                "USER", "user-1", "deepseek")).thenReturn(List.of(connection));
        when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection updated = service.update(connection.getId().toString(),
                new ProviderConnectionService.ConnectionInput(
                        "deepseek", " PRIMARY ", null, null, null, null, null, null, null));

        assertEquals("PRIMARY", updated.getLabel());
    }

    @Test
    void updateRejectsSiblingLabel() {
        TenantContext.setUserId("user-1");
        ProviderConnection target = connection("user-1", "deepseek", "Primary");
        ProviderConnection sibling = connection("user-1", "deepseek", "Sibling");
        when(repository.findById(target.getId())).thenReturn(Optional.of(target));
        when(repository.findByOwnerTypeAndOwnerIdAndProviderId(
                "USER", "user-1", "deepseek")).thenReturn(List.of(target, sibling));

        assertThrows(ProviderConnectionService.LabelConflictException.class,
                () -> service.update(target.getId().toString(),
                        new ProviderConnectionService.ConnectionInput(
                                "deepseek", " sibling ", null, null, null, null, null, null, null)));
    }

    @Test
    void updateTrimsSurroundingWhitespaceFromLabel() {
        TenantContext.setUserId("user-1");
        ProviderConnection connection = connection("user-1", "deepseek", "Primary");
        when(repository.findById(connection.getId())).thenReturn(Optional.of(connection));
        when(repository.findByOwnerTypeAndOwnerIdAndProviderId(
                "USER", "user-1", "deepseek")).thenReturn(List.of(connection));
        when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection updated = service.update(connection.getId().toString(),
                new ProviderConnectionService.ConnectionInput(
                        "deepseek", "  Renamed  ", null, null, null, null, null, null, null));

        assertEquals("Renamed", updated.getLabel());
    }

    @Test
    void createAcceptsFortyCodePoints() {
        TenantContext.setUserId("user-1");
        stubCatalogForCreate();
        when(repository.saveAndFlush(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection cjk = service.create(new ProviderConnectionService.ConnectionInput(
                "deepseek", "字".repeat(40), "USER", "sk-test-key", null, null, List.of(), null,
                "forty-cjk"));
        ProviderConnection emoji = service.create(new ProviderConnectionService.ConnectionInput(
                "deepseek", "😀".repeat(40), "USER", "sk-test-key", null, null, List.of(), null,
                "forty-emoji"));

        assertEquals("字".repeat(40), cjk.getLabel());
        assertEquals(40, emoji.getLabel().codePointCount(0, emoji.getLabel().length()));
    }

    @Test
    void createRejectsControlCharacters() {
        TenantContext.setUserId("user-1");
        stubCatalogForCreate();

        java.util.List<String> labels = List.of(
                "line\nbreak", "tab\tname", "del\u007f", "line\u2028break");
        for (int i = 0; i < labels.size(); i++) {
            String label = labels.get(i),
                key = "control-" + i;
            assertThrows(ProviderConnectionService.LabelInvalidException.class,
                    () -> service.create(new ProviderConnectionService.ConnectionInput(
                            "deepseek", label, "USER", "sk-test-key", null, null, List.of(), null,
                            key)));
        }
    }

    private void stubCatalogForCreate() {
        ObjectNode definition = new ObjectMapper().createObjectNode();
        definition.put("id", "deepseek");
        definition.put("defaultBaseUrl", "https://api.deepseek.com/v1");
        definition.putObject("credential").put("required", true);
        when(catalog.require("deepseek")).thenReturn(definition);
        when(catalog.supportedPair("deepseek", "openai-chat-completions", 1)).thenReturn(definition);
        when(catalog.requiresCredential("deepseek")).thenReturn(true);
        when(catalog.defaultApiType("deepseek")).thenReturn(
                new ProviderCatalogService.ApiTypeRef("openai-chat-completions", 1, "chat"));
    }

    private ProviderConnection connection(String ownerId, String providerId, String label) {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.randomUUID());
        connection.setOwnerType("USER");
        connection.setOwnerId(ownerId);
        connection.setProviderId(providerId);
        connection.setConnectionKey("conn-" + UUID.randomUUID());
        connection.setApiTypeId("openai-chat-completions");
        connection.setApiTypeVersion(1);
        connection.setLabel(label);
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        return connection;
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
        java.util.UUID credentialId = java.util.UUID.randomUUID();
        connection.setCredentialId(credentialId);
        when(credentialAccess.isUsable(credentialId)).thenReturn(true);

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
        when(repository.saveAndFlush(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection connection = service.create(new ProviderConnectionService.ConnectionInput(
                "deepseek", "Workspace DeepSeek", "WORKSPACE", "sk-test-key", null, null, List.of(), null,
                "default"));

        assertEquals("WORKSPACE", connection.getOwnerType());
        assertEquals("workspace-1", connection.getOwnerId());
    }

    @Test
    void updateRefreshesCredentialReferenceWhenCredentialChanges() {
        // PLAN-0553 #10: a new key creates a new credential and rebinds the
        // connection; the connection never stores ciphertext itself.
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
        connection.setRevision(7L);
        java.util.UUID oldCredentialId = java.util.UUID.randomUUID();
        connection.setCredentialId(oldCredentialId);
        when(repository.findById(connection.getId())).thenReturn(Optional.of(connection));
        when(repository.save(any(ProviderConnection.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        ProviderConnection updated = service.update(connection.getId().toString(),
                new ProviderConnectionService.ConnectionInput(
                        "deepseek", null, null, "sk-new-key", null, null, null, null, null));

        assertNotEquals(oldCredentialId, updated.getCredentialId());
        assertNotNull(updated.getCredentialId());
        assertEquals(8L, updated.getRevision());
        assertEquals(ProviderConnection.STATUS_VERIFYING, updated.getStatus());
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
                repository, auditRepository, leaseRepository, realCatalog, apiTypes, credentialService,
                credentialAccess, mapper, requestTemplates, configService);
        when(repository.saveAndFlush(any(ProviderConnection.class)))
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
