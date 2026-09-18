package com.cc01cc.p.xihe.cp.oauth;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.logging.RequestIdFilter;

/**
 * PLAN-0349 decision #8: best-effort RFC 7009 token revocation.
 *
 * <p>The credential row does not store a revocation endpoint, so the endpoint
 * is discovered per revoke from the token endpoint origin via RFC 8414
 * ({@code /.well-known/oauth-authorization-server}) or OpenID discovery
 * ({@code /.well-known/openid-configuration}). Providers without a published
 * endpoint are skipped (plain local revoke). Any failure is logged and never
 * blocks the local revocation. Known boundary: RFC 8414 issuer path-insertion
 * is not implemented — providers publishing metadata under an issuer path
 * degrade to a local-only revoke (best-effort semantics by decision #8).
 *
 * <p>Logs never contain the token or the provider response body.
 */
@Component
public class OAuthRevocationClient {

    private static final Logger logger = LoggerFactory.getLogger(OAuthRevocationClient.class);
    private static final Duration DISCOVERY_TIMEOUT = Duration.ofSeconds(3);
    private static final Duration REVOKE_TIMEOUT = Duration.ofSeconds(5);

    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;

    public OAuthRevocationClient(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    }

    /**
     * Notifies the provider that the refresh token is no longer valid. Never
     * throws; the local revocation is already authoritative.
     */
    public void revoke(String tokenEndpoint, String clientId, String refreshToken) {
        if (tokenEndpoint == null || tokenEndpoint.isBlank()
                || refreshToken == null || refreshToken.isBlank()) {
            return;
        }
        String revocationEndpoint = discoverRevocationEndpoint(tokenEndpoint);
        if (revocationEndpoint == null) {
            event("oauth_token_revoke", "result=skipped reason=no_revocation_endpoint");
            return;
        }
        try {
            String body = form(
                    "token", refreshToken,
                    "token_type_hint", "refresh_token",
                    "client_id", clientId);
            HttpRequest request = HttpRequest.newBuilder(URI.create(revocationEndpoint))
                    .timeout(REVOKE_TIMEOUT)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            event("oauth_token_revoke", "result=" + (response.statusCode() / 100 == 2 ? "ok" : "rejected")
                    + " status=" + response.statusCode());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            event("oauth_token_revoke", "result=failed reason=interrupted");
        } catch (Exception e) {
            event("oauth_token_revoke", "result=failed reason=" + e.getClass().getSimpleName());
        }
    }

    private String discoverRevocationEndpoint(String tokenEndpoint) {
        URI tokenUri;
        try {
            tokenUri = URI.create(tokenEndpoint);
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (tokenUri.getScheme() == null || tokenUri.getHost() == null) {
            return null;
        }
        String origin = tokenUri.getScheme() + "://" + tokenUri.getHost()
                + (tokenUri.getPort() == -1 ? "" : ":" + tokenUri.getPort());
        for (String path : List.of("/.well-known/oauth-authorization-server", "/.well-known/openid-configuration")) {
            String endpoint = fetchRevocationEndpoint(origin + path);
            if (endpoint != null) {
                return endpoint;
            }
        }
        return null;
    }

    private String fetchRevocationEndpoint(String metadataUrl) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(metadataUrl))
                    .timeout(DISCOVERY_TIMEOUT)
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() / 100 != 2) {
                return null;
            }
            JsonNode metadata = objectMapper.readTree(response.body());
            String endpoint = metadata.path("revocation_endpoint").asText("");
            if (endpoint.isBlank()) {
                return null;
            }
            URI parsed = URI.create(endpoint);
            if (parsed.getScheme() == null || parsed.getHost() == null) {
                return null;
            }
            return endpoint;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception e) {
            // Never log the metadata body (may be attacker-influenced); class only.
            logger.debug("service=cp event=oauth_revocation_discovery_failed url={} reason={}",
                    metadataUrl, e.getClass().getSimpleName());
            return null;
        }
    }

    private static String form(String... values) {
        StringBuilder body = new StringBuilder();
        for (int i = 0; i < values.length; i += 2) {
            if (i > 0) body.append('&');
            body.append(URLEncoder.encode(values[i], StandardCharsets.UTF_8))
                    .append('=')
                    .append(URLEncoder.encode(values[i + 1], StandardCharsets.UTF_8));
        }
        return body.toString();
    }

    private static void event(String event, String fields) {
        String requestId = MDC.get(RequestIdFilter.MDC_KEY);
        logger.info("service=cp event={} requestId={} {}", event, requestId == null ? "-" : requestId, fields);
    }
}
