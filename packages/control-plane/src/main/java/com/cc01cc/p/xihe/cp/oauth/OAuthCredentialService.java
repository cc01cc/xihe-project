package com.cc01cc.p.xihe.cp.oauth;

import java.net.URI;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.OAuthCredential;
import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUserId;
import com.cc01cc.p.xihe.cp.repository.OAuthCredentialRepository;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

@Service
public class OAuthCredentialService {

    private static final Logger logger = LoggerFactory.getLogger(OAuthCredentialService.class);

    private static final String KEY_VERSION = "v1";
    private final PkceSessionService pkce;
    private final OAuthCredentialRepository repository;
    private final EnvelopeEncryptionService encryption;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final McpServerRepository mcpServerRepository;
    private final DbLockTimeout dbLockTimeout;
    private final OAuthTokenBroker broker;
    private final OAuthRevocationClient revocationClient;

    @org.springframework.beans.factory.annotation.Value("${cp.oauth.allowed-hosts:}")
    private String allowedEndpointHosts;

    public OAuthCredentialService(
            PkceSessionService pkce,
            OAuthCredentialRepository repository,
            EnvelopeEncryptionService encryption,
            ObjectMapper objectMapper,
            WorkspaceRepository workspaceRepository,
            WorkspaceUserRepository workspaceUserRepository,
            McpServerRepository mcpServerRepository,
            DbLockTimeout dbLockTimeout,
            @Lazy OAuthTokenBroker broker,
            OAuthRevocationClient revocationClient) {
        this.pkce = pkce;
        this.repository = repository;
        this.encryption = encryption;
        this.objectMapper = objectMapper;
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.mcpServerRepository = mcpServerRepository;
        this.dbLockTimeout = dbLockTimeout;
        this.broker = broker;
        this.revocationClient = revocationClient;
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    }

    public AuthorizationStart start(StartRequest request) {
        ensureWorkspaceAccess(request.userId(), request.workspaceId());
        validateEndpoints(request);
        registerOrValidateServer(request);
        PkceSessionService.PendingSession session = pkce.start(
                request.userId(), request.workspaceId(), request.serverId(), request.clientId(),
                request.authorizationEndpoint(), request.tokenEndpoint(), request.redirectUri(), request.scope());
        String authorizationUrl = session.authorizationEndpoint()
                + "?response_type=code&client_id=" + encode(session.clientId())
                + "&redirect_uri=" + encode(session.redirectUri())
                + "&scope=" + encode(session.scope())
                + "&state=" + encode(session.state())
                + "&code_challenge=" + encode(session.codeChallenge())
                + "&code_challenge_method=S256";
        return new AuthorizationStart(session.state(), session.codeChallenge(), authorizationUrl,
                session.expiresAtMillis());
    }

    @Transactional
    public AccessGrant complete(String state, String code) {
        if (code == null || code.isBlank()) throw new IllegalArgumentException("OAuth code is required");
        PkceSessionService.PendingSession session = pkce.consume(state);
        TokenPayload token = exchangeCode(session, code);
        if (token.refreshToken() == null || token.refreshToken().isBlank()) {
            throw new IllegalArgumentException("OAuth provider did not return a refresh token");
        }
        OAuthCredential credential = repository
                .findByUserIdAndWorkspaceIdAndServerId(session.userId(), session.workspaceId(), session.serverId())
                .orElseGet(OAuthCredential::new);
        credential.setUserId(session.userId());
        credential.setWorkspaceId(session.workspaceId());
        credential.setServerId(session.serverId());
        credential.setClientId(session.clientId());
        credential.setTokenEndpoint(session.tokenEndpoint());
        credential.setRedirectUri(session.redirectUri());
        credential.setScope(token.scope() == null || token.scope().isBlank() ? session.scope() : token.scope());
        credential.setRefreshTokenCiphertext(encryption.encrypt(
                token.refreshToken(), binding(session.userId(), session.workspaceId(), session.serverId())));
        credential.setEncryptionKeyVersion(KEY_VERSION);
        credential.setStatus("AUTHORIZED");
        repository.save(credential);
        // Re-authorization supersedes any token cached before; drop it defensively.
        broker.invalidate(session.userId(), session.workspaceId(), session.serverId());
        long expiresIn = token.expiresIn() == null ? OAuthTokenBroker.DEFAULT_TTL_SECONDS : token.expiresIn();
        return new AccessGrant(token.accessToken(), expiresIn, credential.getScope());
    }

    /**
     * PLAN-0349: broker entry point. Cache hits and same-key single-flight live
     * in {@link OAuthTokenBroker}; this method only keeps the facade contract
     * used by {@link OAuthController}.
     */
    public AccessGrant issueAccessToken(String userId, String workspaceId, String serverId, String requestedScope) {
        return broker.getAccessToken(userId, workspaceId, serverId, requestedScope);
    }

    /**
     * PLAN-0349 decision #7: provider refresh under the credential row lock.
     * Called by the broker leader (bypassing the single-flight entry only in
     * the S4 rotation test). Applies the PLAN-0346 lock timeout first; a lock
     * wait beyond {@code cp.lock-timeout-ms} surfaces as
     * {@code CannotAcquireLockException} (503 {@code OPERATION_LOCK_TIMEOUT})
     * and is intentionally not caught here.
     */
    @Transactional
    public RefreshResult refreshLocked(String userId, String workspaceId, String serverId, String requestedScope) {
        try {
            ensureWorkspaceServerAccess(userId, workspaceId, serverId);
        } catch (IllegalArgumentException e) {
            throw new OAuthBrokerException(OAuthBrokerException.Kind.REAUTH_REQUIRED, e.getMessage(), e);
        }
        if (requestedScope == null || requestedScope.isBlank()) {
            throw new OAuthBrokerException(OAuthBrokerException.Kind.REAUTH_REQUIRED, "scope_required");
        }
        dbLockTimeout.apply();
        OAuthCredential credential = repository.findForUpdate(userId, workspaceId, serverId)
                .orElseThrow(() -> new OAuthBrokerException(
                        OAuthBrokerException.Kind.REAUTH_REQUIRED, "authorization-required"));
        if (!"AUTHORIZED".equals(credential.getStatus())) {
            throw new OAuthBrokerException(OAuthBrokerException.Kind.REAUTH_REQUIRED, "authorization-required");
        }
        if (!requestedScope.equals(credential.getScope())) {
            throw new OAuthBrokerException(OAuthBrokerException.Kind.REAUTH_REQUIRED, "scope_mismatch");
        }
        String refreshToken;
        try {
            refreshToken = encryption.decrypt(credential.getRefreshTokenCiphertext(),
                    binding(userId, workspaceId, serverId));
        } catch (IllegalArgumentException e) {
            throw new OAuthBrokerException(
                    OAuthBrokerException.Kind.REAUTH_REQUIRED, "credential_unreadable", e);
        }
        TokenPayload token = refresh(credential, refreshToken);
        if (token.refreshToken() != null && !token.refreshToken().isBlank()) {
            credential.setRefreshTokenCiphertext(encryption.encrypt(token.refreshToken(),
                    binding(userId, workspaceId, serverId)));
            repository.save(credential);
        }
        return new RefreshResult(token.accessToken(), token.expiresIn(), credential.getScope());
    }

    @Transactional
    public boolean revoke(String userId, String workspaceId, String serverId) {
        ensureWorkspaceServerAccess(userId, workspaceId, serverId);
        dbLockTimeout.apply();
        Optional<OAuthCredential> credential = repository.findForUpdate(userId, workspaceId, serverId);
        // Cache invalidation + revocation epoch happen before any early return so a
        // stale cache entry can never outlive the revocation.
        broker.invalidate(userId, workspaceId, serverId);
        if (credential.isEmpty()) {
            return false;
        }
        OAuthCredential value = credential.get();
        String refreshToken = null;
        if ("AUTHORIZED".equals(value.getStatus())) {
            try {
                refreshToken = encryption.decrypt(value.getRefreshTokenCiphertext(),
                        binding(userId, workspaceId, serverId));
            } catch (IllegalArgumentException e) {
                logger.warn("service=cp event=oauth_token_revoke reason=credential_unreadable "
                        + "userId={} workspaceId={} serverId={}", userId, workspaceId, serverId);
            }
        }
        value.setStatus("REVOKED");
        value.setRefreshTokenCiphertext("revoked");
        repository.save(value);
        if (refreshToken != null) {
            String tokenEndpoint = value.getTokenEndpoint();
            String clientId = value.getClientId();
            String revocableToken = refreshToken;
            // Decision #8: best-effort RFC 7009 after commit; never blocks the local revoke.
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    revocationClient.revoke(tokenEndpoint, clientId, revocableToken);
                }
            });
        }
        return true;
    }

    private TokenPayload exchangeCode(PkceSessionService.PendingSession session, String code) {
        try {
            return postToken(session.tokenEndpoint(), form(
                    "grant_type", "authorization_code",
                    "code", code,
                    "client_id", session.clientId(),
                    "redirect_uri", session.redirectUri(),
                    "code_verifier", session.codeVerifier()));
        } catch (OAuthBrokerException e) {
            // The callback is UI-facing and keeps its 400 INVALID_REQUEST semantics.
            throw new IllegalArgumentException("OAuth token exchange failed", e);
        }
    }

    private TokenPayload refresh(OAuthCredential credential, String refreshToken) {
        return postToken(credential.getTokenEndpoint(), form(
                "grant_type", "refresh_token",
                "refresh_token", refreshToken,
                "client_id", credential.getClientId()));
    }

    /**
     * PLAN-0349 decision #12: classify provider outcomes into the two broker
     * tiers. 4xx (or a parseable OAuth {@code error}) is a definite rejection →
     * REAUTH; unreachable/timeout/5xx/unparseable 2xx → UNAVAILABLE. Neither
     * the request form (carries the refresh token) nor the provider response
     * body is ever logged.
     */
    private TokenPayload postToken(String endpoint, String body) {
        HttpRequest request;
        try {
            request = HttpRequest.newBuilder(URI.create(endpoint))
                    .timeout(Duration.ofSeconds(15))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
        } catch (IllegalArgumentException e) {
            throw new OAuthBrokerException(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE,
                    "OAuth token endpoint is invalid", e);
        }
        HttpResponse<String> response;
        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new OAuthBrokerException(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE,
                    "OAuth token exchange interrupted", e);
        } catch (Exception e) {
            logger.warn("service=cp event=oauth_token_failure errorKind=unavailable reason=request_failed "
                    + "exception={}", e.getClass().getSimpleName());
            throw new OAuthBrokerException(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE,
                    "OAuth token endpoint request failed", e);
        }
        int status = response.statusCode();
        if (status / 100 == 2) {
            JsonNode json;
            try {
                json = objectMapper.readTree(response.body());
            } catch (Exception e) {
                // Jackson messages can embed the response body; wrap with a body-free cause.
                throw new OAuthBrokerException(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE,
                        "OAuth token response is not JSON",
                        new IllegalStateException("OAuth provider response could not be parsed"));
            }
            String accessToken = json.path("access_token").asText("");
            if (accessToken.isBlank()) {
                throw new OAuthBrokerException(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE,
                        "OAuth token response has no access token");
            }
            Long expiresIn = json.hasNonNull("expires_in") ? json.get("expires_in").asLong() : null;
            return new TokenPayload(accessToken, json.path("refresh_token").asText(null), expiresIn,
                    json.path("scope").asText(null));
        }
        if (status >= 400 && status < 500) {
            String providerError = providerErrorCode(response.body());
            throw new OAuthBrokerException(OAuthBrokerException.Kind.REAUTH_REQUIRED,
                    providerError == null ? "provider_rejected" : "provider_rejected:" + providerError);
        }
        throw new OAuthBrokerException(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE,
                "OAuth token endpoint failed with status " + status);
    }

    /** Extracts only the sanitized OAuth {@code error} code; never the raw body. */
    private String providerErrorCode(String responseBody) {
        try {
            String error = objectMapper.readTree(responseBody).path("error").asText("");
            if (error.isBlank()) {
                return null;
            }
            String sanitized = error.replaceAll("[^a-zA-Z0-9_.-]", "");
            return sanitized.length() > 40 ? sanitized.substring(0, 40) : sanitized;
        } catch (Exception e) {
            return null;
        }
    }

    private static String form(String... values) {
        StringBuilder body = new StringBuilder();
        for (int i = 0; i < values.length; i += 2) {
            if (i > 0) body.append('&');
            body.append(encode(values[i])).append('=').append(encode(values[i + 1]));
        }
        return body.toString();
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static String binding(String userId, String workspaceId, String serverId) {
        return userId + ":" + workspaceId + ":" + serverId;
    }

    private void ensureWorkspaceServerAccess(String userId, String workspaceId, String serverId) {
        ensureWorkspaceAccess(userId, workspaceId);
        mcpServerRepository.findById(UUID.fromString(serverId))
                .filter(server -> workspaceId.equals(server.getWorkspaceId()) && server.isEnabled())
                .orElseThrow(() -> new IllegalArgumentException("mcp_server_not_found"));
    }

    private void ensureWorkspaceAccess(String userId, String workspaceId) {
        Workspace workspace = workspaceRepository.findById(UUID.fromString(workspaceId))
                .orElseThrow(() -> new IllegalArgumentException("workspace_not_found"));
        boolean owner = userId.equals(workspace.getOwnerId());
        boolean member = workspaceUserRepository.existsById(new WorkspaceUserId(workspaceId, userId));
        if (!owner && !member) throw new IllegalArgumentException("workspace_forbidden");
    }

    private void registerOrValidateServer(StartRequest request) {
        if (request.serverId().length() > 36) throw new IllegalArgumentException("serverId is too long");
        if (request.remoteEndpoint() == null || request.remoteEndpoint().isBlank()) {
            throw new IllegalArgumentException("remoteEndpoint must not be blank");
        }
        OAuthCredentialService.this.mcpServerRepository.findById(UUID.fromString(request.serverId())).ifPresentOrElse(server -> {
            if (!request.workspaceId().equals(server.getWorkspaceId())) {
                throw new IllegalArgumentException("mcp_server_forbidden");
            }
            if (!server.isEnabled()) throw new IllegalArgumentException("mcp_server_disabled");
            server.setEndpoint(request.remoteEndpoint());
            mcpServerRepository.save(server);
        }, () -> {
            McpServer server = new McpServer(request.workspaceId(), request.serverId(), request.remoteEndpoint());
            server.setId(UUID.fromString(request.serverId()));
            server.setEnabled(true);
            mcpServerRepository.save(server);
        });
    }

    private void validateEndpoints(StartRequest request) {
        validateEndpoint(request.remoteEndpoint(), EndpointKind.REMOTE);
        validateEndpoint(request.authorizationEndpoint(), EndpointKind.AUTHORIZATION);
        validateEndpoint(request.tokenEndpoint(), EndpointKind.TOKEN);
        URI redirect = parseUri(request.redirectUri(), "redirectUri");
        if (redirect.getUserInfo() != null || redirect.getFragment() != null
                || redirect.getHost() == null || !isLoopbackHost(redirect.getHost())
                || !("http".equalsIgnoreCase(redirect.getScheme())
                        || "https".equalsIgnoreCase(redirect.getScheme()))) {
            throw new IllegalArgumentException("redirectUri is not allowed");
        }
    }

    private void validateEndpoint(String value, EndpointKind kind) {
        URI uri = parseUri(value, kind.name().toLowerCase() + "Endpoint");
        if (uri.getUserInfo() != null || uri.getHost() == null) {
            throw new IllegalArgumentException(kind + " endpoint is not allowed");
        }
        String scheme = uri.getScheme().toLowerCase();
        boolean localHost = isLoopbackHost(uri.getHost()) || "host.docker.internal".equalsIgnoreCase(uri.getHost());
        if (!isAllowedHost(uri.getHost())) {
            throw new IllegalArgumentException(kind + " endpoint host is not in the configured allowlist");
        }
        boolean localHttp = "http".equals(scheme) && localHost;
        if (kind == EndpointKind.REMOTE && isLoopbackHost(uri.getHost())) {
            throw new IllegalArgumentException("remote endpoint must not target localhost");
        }
        if (!"https".equals(scheme) && !localHttp) {
            throw new IllegalArgumentException(kind + " endpoint must use HTTPS");
        }
        if ("https".equals(scheme) && uri.getPort() != -1 && uri.getPort() != 443) {
            throw new IllegalArgumentException(kind + " endpoint port is not allowed");
        }
        if (kind == EndpointKind.REMOTE && "http".equals(scheme)
                && !"host.docker.internal".equalsIgnoreCase(uri.getHost())) {
            throw new IllegalArgumentException("remote endpoint must use HTTPS");
        }
        if (!localHost) {
            try {
                for (InetAddress address : InetAddress.getAllByName(uri.getHost())) {
                    if (isPrivate(address)) throw new IllegalArgumentException(kind + " endpoint resolves to a private address");
                }
            } catch (UnknownHostException e) {
                throw new IllegalArgumentException(kind + " endpoint DNS lookup failed", e);
            }
        }
    }

    private boolean isAllowedHost(String host) {
        if (allowedEndpointHosts == null || allowedEndpointHosts.isBlank()) return true;
        String normalized = host.toLowerCase();
        for (String configured : allowedEndpointHosts.split(",")) {
            String allowed = configured.trim().toLowerCase();
            if (normalized.equals(allowed)
                    || (allowed.startsWith("*.") && normalized.endsWith(allowed.substring(1)))) {
                return true;
            }
        }
        return false;
    }

    private static URI parseUri(String value, String name) {
        try {
            if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
            return URI.create(value);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(name + " is invalid", e);
        }
    }

    private static boolean isLoopbackHost(String host) {
        return "localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host) || "[::1]".equals(host) || "::1".equals(host);
    }

    private static boolean isPrivate(InetAddress address) {
        return address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
                || address.isSiteLocalAddress() || address.isMulticastAddress();
    }

    private enum EndpointKind { REMOTE, AUTHORIZATION, TOKEN }

    public record StartRequest(String userId, String workspaceId, String serverId, String remoteEndpoint, String clientId,
                               String authorizationEndpoint, String tokenEndpoint, String redirectUri, String scope) {}

    public record AuthorizationStart(String state, String codeChallenge, String authorizationUrl,
                                     long expiresAtMillis) {}

    public record AccessGrant(String accessToken, long expiresIn, String scope) {}

    /**
     * PLAN-0349: provider-fresh token plus the raw {@code expires_in} the
     * provider returned ({@code null} = omitted). The broker needs the
     * distinction because a missing value maps to the conservative 300s TTL
     * while an explicit value subtracts the 60s skew first.
     */
    public record RefreshResult(String accessToken, Long expiresInSeconds, String scope) {}

    private record TokenPayload(String accessToken, String refreshToken, Long expiresIn, String scope) {}
}
