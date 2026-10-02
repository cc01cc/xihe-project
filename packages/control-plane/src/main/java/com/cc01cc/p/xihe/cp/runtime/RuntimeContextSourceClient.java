package com.cc01cc.p.xihe.cp.runtime;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

/** Fetches a workspace's AGENTS.md from the Runtime so CP no longer reads the host filesystem. */
@Component
public class RuntimeContextSourceClient {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeContextSourceClient.class);

    /**
     * PLAN-0382 T1.2 (spec §3 wire table): three-state source read.
     *
     * <ul>
     *   <li>{@link SourceReadKind#CONTENT} — HTTP 200 with file content (an empty
     *       string is a legal empty file, {@code l1_status=ok});</li>
     *   <li>{@link SourceReadKind#ABSENT} — HTTP 200 {@code found:false}, the
     *       PLAN-0427 absence fact ({@code l1_status=missing}, legal, never an error);</li>
     *   <li>{@link SourceReadKind#ERROR} — transport failure ({@code httpStatus == null})
     *       or an HTTP/parse failure. Per the frozen wire table: transport or 5xx map to
     *       {@code unavailable}, 4xx (and malformed 200 bodies) map to {@code failed}.</li>
     * </ul>
     */
    public enum SourceReadKind { CONTENT, ABSENT, ERROR }

    public record SourceRead(SourceReadKind kind, String content, Integer httpStatus) {
        public static SourceRead content(String value) {
            return new SourceRead(SourceReadKind.CONTENT, value, null);
        }

        public static SourceRead absent() {
            return new SourceRead(SourceReadKind.ABSENT, "", null);
        }

        public static SourceRead error(Integer status) {
            return new SourceRead(SourceReadKind.ERROR, "", status);
        }

        /** spec §3 wire→status mapping for the two failure branches. */
        public String failureStatus() {
            return (httpStatus == null || httpStatus >= 500) ? "unavailable" : "failed";
        }
    }

    /**
     * PLAN-0382 T1.2/T1.4: bounded retry — at most ONE immediate retry, only for
     * transport failures and 5xx (4xx never retried). No backoff sleep: the CP
     * package rule forbids new {@code Thread.sleep}/fixed waits, so the retry is
     * immediate and logged (see review/ruling-2026-10-01.md addendum).
     */
    private static final int MAX_ATTEMPTS = 2;

    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final String serviceToken;

    public RuntimeContextSourceClient(RestTemplate restTemplate,
                                      @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
                                      @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.restTemplate = restTemplate;
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    public SourceRead readAgents(String workspaceId) {
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                HttpHeaders headers = new HttpHeaders();
                headers.setContentType(MediaType.APPLICATION_JSON);
                headers.setBearerAuth(serviceToken);
                Map<String, Object> body = Map.of("path", "AGENTS.md");
                ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                        runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/files/read",
                        org.springframework.http.HttpMethod.POST,
                        new HttpEntity<>(body, headers),
                        new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() { });
                if (!response.getStatusCode().is2xxSuccessful()) {
                    int code = response.getStatusCode().value();
                    if (code >= 500 && attempt < MAX_ATTEMPTS) {
                        logger.warn("Runtime AGENTS.md read 5xx, retrying workspaceId={} status={}", workspaceId, code);
                        continue;
                    }
                    return SourceRead.error(code);
                }
                Map<String, Object> payload = response.getBody();
                if (payload == null) {
                    return SourceRead.error(200);
                }
                Object found = payload.get("found");
                Object content = payload.get("content");
                if (Boolean.FALSE.equals(found)) {
                    return SourceRead.absent();
                }
                if (content != null) {
                    // 200 with content: found=true (new Runtime) or the found key
                    // absent (Runtime < PLAN-0427, mixed deployment) — both are
                    // a legal read (spec §5 mixed rule: content ⇒ ok).
                    return SourceRead.content(content.toString());
                }
                if (Boolean.TRUE.equals(found)) {
                    return SourceRead.content("");
                }
                // 200 body without found/content keys: malformed contract.
                return SourceRead.error(200);
            } catch (HttpStatusCodeException httpError) {
                int code = httpError.getStatusCode().value();
                if (code >= 500 && attempt < MAX_ATTEMPTS) {
                    logger.warn("Runtime AGENTS.md read 5xx, retrying workspaceId={} status={}", workspaceId, code);
                    continue;
                }
                return SourceRead.error(code);
            } catch (Exception e) {
                if (attempt < MAX_ATTEMPTS) {
                    logger.warn("Runtime AGENTS.md read transport error, retrying workspaceId={}: {}",
                            workspaceId, e.getMessage());
                    continue;
                }
                logger.warn("Runtime AGENTS.md read failed workspaceId={}: {}", workspaceId, e.getMessage());
                return SourceRead.error(null);
            }
        }
        // Unreachable: the loop always returns on the final attempt.
        return SourceRead.error(null);
    }

    /** PLAN-0340: branch + short HEAD for L1b; empty when non-git or unreachable. Same bounded retry as {@link #readAgents}. */
    public java.util.Optional<Map<String, Object>> readGitFacts(String workspaceId) {
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                HttpHeaders headers = new HttpHeaders();
                headers.setBearerAuth(serviceToken);
                var response = restTemplate.exchange(
                        runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/git-facts",
                        org.springframework.http.HttpMethod.GET,
                        new HttpEntity<>(headers),
                        new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() { });
                if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                    int code = response.getStatusCode().value();
                    if (code >= 500 && attempt < MAX_ATTEMPTS) {
                        logger.warn("Runtime git-facts 5xx, retrying workspaceId={} status={}", workspaceId, code);
                        continue;
                    }
                    return java.util.Optional.empty();
                }
                return java.util.Optional.of(response.getBody());
            } catch (HttpStatusCodeException httpError) {
                int code = httpError.getStatusCode().value();
                if (code >= 500 && attempt < MAX_ATTEMPTS) {
                    logger.warn("Runtime git-facts 5xx, retrying workspaceId={} status={}", workspaceId, code);
                    continue;
                }
                return java.util.Optional.empty();
            } catch (Exception e) {
                if (attempt < MAX_ATTEMPTS) {
                    logger.warn("Runtime git-facts transport error, retrying workspaceId={}: {}",
                            workspaceId, e.getMessage());
                    continue;
                }
                logger.warn("Runtime git-facts failed workspaceId={}: {}", workspaceId, e.getMessage());
                return java.util.Optional.empty();
            }
        }
        return java.util.Optional.empty();
    }
}
