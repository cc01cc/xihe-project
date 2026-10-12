package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.provider.ApiInputTypeService;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** PLAN-0485: whole-unit profile parsing, workspace-wins resolution, env gate. */
class EmbeddingProfileServiceTest {

    private final ConfigJpaRepository configs = mock(ConfigJpaRepository.class);
    private final ProviderConnectionRepository connections = mock(ProviderConnectionRepository.class);
    private final EnvOverlayRegistry envOverlay = mock(EnvOverlayRegistry.class);
    private final ProviderCredentialLeaseService leaseService = mock(ProviderCredentialLeaseService.class);
    private final EmbeddingProfileService service = new EmbeddingProfileService(
            configs, connections, envOverlay,
            new ApiInputTypeService(new ObjectMapper()), leaseService, new ObjectMapper());

    private static final UUID USER = UUID.fromString("22222222-2222-2222-2222-222222222222");
    private static final UUID WORKSPACE = UUID.fromString("11111111-1111-1111-1111-111111111111");
    private static final String MODEL = "tongyi-embedding-vision-flash-2026-03-06";

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    private static String profileJson() {
        return "{\"providerId\":\"dashscope-qwen\",\"connectionKey\":\"embedding\",\"model\":\"" + MODEL + "\"}";
    }

    private static ConfigEntity config(String value) {
        ConfigEntity entity = new ConfigEntity();
        entity.setConfigValue(value);
        return entity;
    }

    private static ProviderConnection readyConnection() {
        ProviderConnection connection = new ProviderConnection();
        connection.setId(UUID.fromString("33333333-3333-3333-3333-333333333333"));
        connection.setProviderId("dashscope-qwen");
        connection.setConnectionKey("embedding");
        connection.setOwnerType("WORKSPACE");
        connection.setOwnerId(WORKSPACE.toString());
        connection.setApiTypeId("dashscope-multimodal-embedding");
        connection.setApiTypeVersion(1);
        connection.setEnabled(true);
        connection.setStatus(ProviderConnection.STATUS_READY);
        connection.setRevision(4L);
        return connection;
    }

    @Test
    void parseAcceptsCompleteUnitAndRejectsPartialOrUnsupported() {
        EmbeddingProfileService.LayerProfile parsed = service.parseProfile(profileJson());
        assertEquals("dashscope-qwen", parsed.providerId());
        assertEquals("embedding", parsed.connectionKey());
        assertEquals(MODEL, parsed.model());

        assertNull(service.parseProfile(null));
        assertNull(service.parseProfile("  "));

        CpApiException partial = assertThrows(CpApiException.class,
                () -> service.parseProfile("{\"providerId\":\"dashscope-qwen\"}"));
        assertEquals(400, partial.getStatus().value());

        CpApiException extra = assertThrows(CpApiException.class, () -> service.parseProfile(
                "{\"providerId\":\"dashscope-qwen\",\"connectionKey\":\"embedding\",\"model\":\"" + MODEL
                        + "\",\"dimension\":768}"));
        assertEquals(400, extra.getStatus().value());

        CpApiException unsupported = assertThrows(CpApiException.class, () -> service.parseProfile(
                "{\"providerId\":\"dashscope-qwen\",\"connectionKey\":\"embedding\",\"model\":\"text-embedding-3-small\"}"));
        assertEquals(400, unsupported.getStatus().value());
        assertEquals("EMBEDDING_MODEL_UNSUPPORTED", unsupported.getCode());
    }

    @Test
    void workspaceProfileWinsWholeAndUserIsIgnored() {
        when(configs.findByWorkspaceIdAndDomainAndConfigKey(WORKSPACE, "embedding", "profile"))
                .thenReturn(Optional.of(config(profileJson())));
        when(configs.findByUserIdAndDomainAndConfigKey(USER, "embedding", "profile"))
                .thenReturn(Optional.of(config(
                        "{\"providerId\":\"other\",\"connectionKey\":\"other\",\"model\":\"" + MODEL + "\"}")));
        when(envOverlay.activeOverrides("embedding")).thenReturn(Map.of());
        when(connections.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                eq("WORKSPACE"), eq(WORKSPACE.toString()), eq("dashscope-qwen"), eq("embedding")))
                .thenReturn(Optional.of(readyConnection()));

        EmbeddingProfileService.ResolvedProfile resolved = service.resolve(USER, WORKSPACE);
        assertEquals("workspace", resolved.profileScope());
        assertEquals("WORKSPACE", resolved.connectionOwnerType());
        assertEquals("33333333-3333-3333-3333-333333333333", resolved.providerConnectionId());
        assertEquals(768, resolved.dimension());
    }

    @Test
    void userFallbackWhenWorkspaceAbsent() {
        when(configs.findByWorkspaceIdAndDomainAndConfigKey(WORKSPACE, "embedding", "profile"))
                .thenReturn(Optional.empty());
        when(configs.findByUserIdAndDomainAndConfigKey(USER, "embedding", "profile"))
                .thenReturn(Optional.of(config(profileJson())));
        when(envOverlay.activeOverrides("embedding")).thenReturn(Map.of());
        when(connections.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                eq("USER"), eq(USER.toString()), eq("dashscope-qwen"), eq("embedding")))
                .thenReturn(Optional.of(readyConnection()));

        EmbeddingProfileService.ResolvedProfile resolved = service.resolve(USER, WORKSPACE);
        assertEquals("user", resolved.profileScope());
    }

    @Test
    void noProfileAnywhereFailsClosed() {
        when(envOverlay.activeOverrides("embedding")).thenReturn(Map.of());
        when(configs.findByWorkspaceIdAndDomainAndConfigKey(any(), any(), any()))
                .thenReturn(Optional.empty());
        when(configs.findByUserIdAndDomainAndConfigKey(any(), any(), any()))
                .thenReturn(Optional.empty());

        CpApiException missing = assertThrows(CpApiException.class,
                () -> service.resolve(USER, WORKSPACE));
        assertEquals(409, missing.getStatus().value());
        assertEquals("EMBEDDING_PROFILE_REQUIRED", missing.getCode());
    }

    @Test
    void conflictingConnectionTypeFailsClosed() {
        when(configs.findByWorkspaceIdAndDomainAndConfigKey(WORKSPACE, "embedding", "profile"))
                .thenReturn(Optional.of(config(profileJson())));
        when(envOverlay.activeOverrides("embedding")).thenReturn(Map.of());
        ProviderConnection wrongType = readyConnection();
        wrongType.setApiTypeId("openai-chat-completions");
        when(connections.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                eq("WORKSPACE"), eq(WORKSPACE.toString()), eq("dashscope-qwen"), eq("embedding")))
                .thenReturn(Optional.of(wrongType));

        CpApiException conflict = assertThrows(CpApiException.class,
                () -> service.resolve(USER, WORKSPACE));
        assertEquals("EMBEDDING_PROFILE_CONFLICT", conflict.getCode());
    }

    @Test
    void envModelOverrideMustMatchV1Model() {
        when(configs.findByWorkspaceIdAndDomainAndConfigKey(WORKSPACE, "embedding", "profile"))
                .thenReturn(Optional.of(config(profileJson())));
        when(envOverlay.activeOverrides("embedding")).thenReturn(Map.of("model", MODEL));
        when(connections.findByOwnerTypeAndOwnerIdAndProviderIdAndConnectionKey(
                eq("WORKSPACE"), eq(WORKSPACE.toString()), eq("dashscope-qwen"), eq("embedding")))
                .thenReturn(Optional.of(readyConnection()));

        assertEquals("workspace", service.resolve(USER, WORKSPACE).profileScope());
    }

    @Test
    void envModelMismatchIsConflict() {
        when(configs.findByWorkspaceIdAndDomainAndConfigKey(WORKSPACE, "embedding", "profile"))
                .thenReturn(Optional.of(config(profileJson())));
        when(envOverlay.activeOverrides("embedding")).thenReturn(Map.of("model", "text-embedding-3-small"));

        CpApiException conflict = assertThrows(CpApiException.class,
                () -> service.resolve(USER, WORKSPACE));
        assertEquals(409, conflict.getStatus().value());
        assertEquals("EMBEDDING_PROFILE_CONFLICT", conflict.getCode());
    }
}
