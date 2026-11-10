package com.cc01cc.p.xihe.cp.oauth;

import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.mcp.McpProxyCatalogService;
import com.cc01cc.p.xihe.cp.repository.OAuthCredentialRepository;
import com.cc01cc.p.xihe.cp.crypto.EnvelopeEncryptionService;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0759 / BL-548 (D2): the stored server-level OAuth block is authoritative and
 * request parameters are optional overrides. Blank request fields must fall back to
 * the stored values; non-blank ones keep the caller's value.
 */
class OAuthCredentialServiceD2Test {

    private McpProxyCatalogService catalog;
    private PkceSessionService pkce;
    private OAuthCredentialService service;

    @BeforeEach
    void setUp() {
        catalog = mock(McpProxyCatalogService.class);
        pkce = mock(PkceSessionService.class);
        OAuthCredentialRepository repository = mock(OAuthCredentialRepository.class);
        EnvelopeEncryptionService encryption = mock(EnvelopeEncryptionService.class);
        DbLockTimeout lockTimeout = mock(DbLockTimeout.class);
        service = new OAuthCredentialService(pkce, repository, encryption, new ObjectMapper(),
                catalog, lockTimeout, null, null);
        when(pkce.start(any(), any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new PkceSessionService.PendingSession(
                        "state", "user-1", "ws-1", "server-1",
                        "client-123", "https://example.com/authorize",
                        "https://example.com/token", "http://localhost:5173/cb",
                        "mcp:read", "verifier", "challenge",
                        System.currentTimeMillis() + 60_000));
    }

    private OAuthCredentialService.StartRequest request(String serverId) {
        return new OAuthCredentialService.StartRequest(
                "user-1", "ws-1", serverId,
                "https://example.com/mcp", "", "", "", "", "");
    }

    private void storedRow(String serverId, String clientId, String authorizationEndpoint,
                           String tokenEndpoint, String redirectUri, String scope) {
        McpServer row = new McpServer("ws-1", serverId, "https://example.com/mcp");
        row.setOauthClientId(clientId);
        row.setOauthAuthorizationEndpoint(authorizationEndpoint);
        row.setOauthTokenEndpoint(tokenEndpoint);
        row.setOauthRedirectUri(redirectUri);
        row.setOauthScope(scope);
        when(catalog.findEnabledRemoteServerRow("ws-1", serverId)).thenReturn(Optional.of(row));
    }

    @Test
    void blankRequestFields_fallBackToStoredOauthBlock() {
        String serverId = UUID.randomUUID().toString();
        storedRow(serverId, "client-123", "https://example.com/authorize",
                "https://example.com/token", "http://localhost:5173/cb", "mcp:read");

        service.start(request(serverId));

        ArgumentCaptor<String> clientId = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> authorization = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> token = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> redirect = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> scope = ArgumentCaptor.forClass(String.class);
        verify(pkce).start(any(), any(), any(), clientId.capture(), authorization.capture(),
                token.capture(), redirect.capture(), scope.capture());
        assertEquals("client-123", clientId.getValue());
        assertEquals("https://example.com/authorize", authorization.getValue());
        assertEquals("https://example.com/token", token.getValue());
        assertEquals("http://localhost:5173/cb", redirect.getValue());
        assertEquals("mcp:read", scope.getValue());
    }

    @Test
    void nonBlankRequestFields_overrideStoredValues() {
        String serverId = UUID.randomUUID().toString();
        storedRow(serverId, "stored-client", "https://example.com/stored-authorize",
                "https://example.com/stored-token", "http://localhost:5173/stored", "stored:scope");

        service.start(new OAuthCredentialService.StartRequest(
                "user-1", "ws-1", serverId, "https://example.com/mcp",
                "caller-client", "https://example.com/caller-authorize", "https://example.com/caller-token",
                "http://localhost:5173/caller", "caller:scope"));

        ArgumentCaptor<String> clientId = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> authorization = ArgumentCaptor.forClass(String.class);
        verify(pkce).start(any(), any(), any(), clientId.capture(), authorization.capture(),
                any(), any(), any());
        assertEquals("caller-client", clientId.getValue());
        assertEquals("https://example.com/caller-authorize", authorization.getValue());
    }

    @Test
    void noStoredRow_usesRequestValuesOnly() {
        String serverId = UUID.randomUUID().toString();
        when(catalog.findEnabledRemoteServerRow("ws-1", serverId)).thenReturn(Optional.empty());

        service.start(new OAuthCredentialService.StartRequest(
                "user-1", "ws-1", serverId, "https://example.com/mcp",
                "caller-client", "https://example.com/caller-authorize", "https://example.com/caller-token",
                "http://localhost:5173/caller", "caller:scope"));

        verify(pkce).start(any(), any(), any(), any(), any(), any(), any(), any());
        verify(catalog, never()).saveRemoteEndpoints(any(), any());
    }
}
