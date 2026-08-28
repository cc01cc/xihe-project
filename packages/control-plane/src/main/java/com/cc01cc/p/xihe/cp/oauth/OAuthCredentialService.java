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

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

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

    private static final String KEY_VERSION = "v1";
    private final PkceSessionService pkce;
    private final OAuthCredentialRepository repository;
    private final EnvelopeEncryptionService encryption;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final McpServerRepository mcpServerRepository;

    public OAuthCredentialService(
            PkceSessionService pkce,
            OAuthCredentialRepository repository,
            EnvelopeEncryptionService encryption,
            ObjectMapper objectMapper,
            WorkspaceRepository workspaceRepository,
            WorkspaceUserRepository workspaceUserRepository,
            McpServerRepository mcpServerRepository) {
        this.pkce = pkce;
        this.repository = repository;
        this.encryption = encryption;
        this.objectMapper = objectMapper;
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.mcpServerRepository = mcpServerRepository;
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
        return new AccessGrant(token.accessToken(), token.expiresIn(), credential.getScope());
    }

    @Transactional
    public AccessGrant issueAccessToken(String userId, String workspaceId, String serverId, String requestedScope) {
        ensureWorkspaceServerAccess(userId, workspaceId, serverId);
        if (requestedScope == null || requestedScope.isBlank()) {
            throw new IllegalArgumentException("scope_required");
        }
        OAuthCredential credential = repository.findByUserIdAndWorkspaceIdAndServerId(userId, workspaceId, serverId)
                .orElseThrow(() -> new IllegalArgumentException("authorization-required"));
        if (!"AUTHORIZED".equals(credential.getStatus())) {
            throw new IllegalArgumentException("authorization-required");
        }
        if (!requestedScope.equals(credential.getScope())) {
            throw new IllegalArgumentException("scope_mismatch");
        }
        String refreshToken = encryption.decrypt(credential.getRefreshTokenCiphertext(), binding(userId, workspaceId, serverId));
        TokenPayload token = refresh(credential, refreshToken);
        if (token.refreshToken() != null && !token.refreshToken().isBlank()) {
            credential.setRefreshTokenCiphertext(encryption.encrypt(token.refreshToken(), binding(userId, workspaceId, serverId)));
            repository.save(credential);
        }
        return new AccessGrant(token.accessToken(), token.expiresIn(), credential.getScope());
    }

    @Transactional
    public boolean revoke(String userId, String workspaceId, String serverId) {
        ensureWorkspaceServerAccess(userId, workspaceId, serverId);
        Optional<OAuthCredential> credential = repository.findByUserIdAndWorkspaceIdAndServerId(userId, workspaceId, serverId);
        credential.ifPresent(value -> {
            value.setStatus("REVOKED");
            value.setRefreshTokenCiphertext("revoked");
            repository.save(value);
        });
        return credential.isPresent();
    }

    private TokenPayload exchangeCode(PkceSessionService.PendingSession session, String code) {
        return postToken(session.tokenEndpoint(), form(
                "grant_type", "authorization_code",
                "code", code,
                "client_id", session.clientId(),
                "redirect_uri", session.redirectUri(),
                "code_verifier", session.codeVerifier()));
    }

    private TokenPayload refresh(OAuthCredential credential, String refreshToken) {
        return postToken(credential.getTokenEndpoint(), form(
                "grant_type", "refresh_token",
                "refresh_token", refreshToken,
                "client_id", credential.getClientId()));
    }

    private TokenPayload postToken(String endpoint, String body) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                    .timeout(Duration.ofSeconds(15))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            JsonNode json = objectMapper.readTree(response.body());
            if (response.statusCode() / 100 != 2 || json.path("access_token").asText().isBlank()) {
                throw new IllegalArgumentException("OAuth token exchange failed");
            }
            return new TokenPayload(
                    json.path("access_token").asText(),
                    json.path("refresh_token").asText(null),
                    json.path("expires_in").asLong(300),
                    json.path("scope").asText(null));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalArgumentException("OAuth token exchange interrupted", e);
        } catch (Exception e) {
            if (e instanceof IllegalArgumentException illegal) throw illegal;
            throw new IllegalArgumentException("OAuth token exchange failed", e);
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
        mcpServerRepository.findById(serverId)
                .filter(server -> workspaceId.equals(server.getWorkspaceId()) && server.isEnabled())
                .orElseThrow(() -> new IllegalArgumentException("mcp_server_not_found"));
    }

    private void ensureWorkspaceAccess(String userId, String workspaceId) {
        Workspace workspace = workspaceRepository.findById(workspaceId)
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
        OAuthCredentialService.this.mcpServerRepository.findById(request.serverId()).ifPresentOrElse(server -> {
            if (!request.workspaceId().equals(server.getWorkspaceId())) {
                throw new IllegalArgumentException("mcp_server_forbidden");
            }
            if (!server.isEnabled()) throw new IllegalArgumentException("mcp_server_disabled");
            server.setEndpoint(request.remoteEndpoint());
            mcpServerRepository.save(server);
        }, () -> {
            McpServer server = new McpServer(request.workspaceId(), request.serverId(), request.remoteEndpoint());
            server.setId(request.serverId());
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

    private record TokenPayload(String accessToken, String refreshToken, long expiresIn, String scope) {}
}
