package com.cc01cc.p.xihe.cp.rag;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.*;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;

@RestController
    @RequestMapping("/api/v1/rag")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class RagProxyController {

    private static final Logger logger = LoggerFactory.getLogger(RagProxyController.class);

    private final RestTemplate restTemplate;
    private final String agentBaseUrl;
    private final String agentApiToken;

    public RagProxyController(
            @Value("${cp.agent-url:http://localhost:12632}") String agentBaseUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String agentApiToken) {
        this.restTemplate = new RestTemplate();
        this.agentBaseUrl = agentBaseUrl;
        this.agentApiToken = agentApiToken;
    }

    private HttpHeaders headersWithToken() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(agentApiToken);
        return headers;
    }

    @GetMapping("/stats")
    public ResponseEntity<String> stats() {
        try {
            HttpEntity<Void> entity = new HttpEntity<>(headersWithToken());
            return restTemplate.exchange(agentBaseUrl + "/internal/v1/agent/rag/stats", HttpMethod.GET, entity, String.class);
        } catch (Exception e) {
            logger.error("RAG stats proxy failed: {}", e.getMessage(), e);
            return problem("RAG_UNAVAILABLE", "RAG service unavailable");
        }
    }

    @PostMapping(value = "/ingest", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<String> ingest(@RequestParam("file") MultipartFile file,
                                          @RequestParam(value = "chunkSize", defaultValue = "1000") int chunkSize,
                                          @RequestParam(value = "chunkOverlap", defaultValue = "200") int chunkOverlap) {
        try {
            MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
            body.add("file", new ByteArrayResource(file.getBytes(), file.getOriginalFilename()) {
                @Override
                public String getFilename() { return file.getOriginalFilename(); }
            });
            body.add("chunkSize", String.valueOf(chunkSize));
            body.add("chunkOverlap", String.valueOf(chunkOverlap));

            HttpHeaders headers = headersWithToken();
            headers.setContentType(MediaType.MULTIPART_FORM_DATA);
            HttpEntity<MultiValueMap<String, Object>> request = new HttpEntity<>(body, headers);

            return restTemplate.postForEntity(agentBaseUrl + "/internal/v1/agent/rag/ingest", request, String.class);
        } catch (Exception e) {
            logger.error("RAG ingest proxy failed: {}", e.getMessage(), e);
            return problem("RAG_INGEST_FAILED", "RAG ingest failed");
        }
    }

    @PostMapping("/search")
    public ResponseEntity<String> search(@RequestParam("query") String query,
                                          @RequestParam(value = "topK", defaultValue = "5") int topK,
                                          @RequestParam(value = "minScore", defaultValue = "0.0") double minScore) {
        try {
            MultiValueMap<String, String> params = new LinkedMultiValueMap<>();
            params.add("query", query);
            params.add("topK", String.valueOf(topK));
            params.add("minScore", String.valueOf(minScore));
            HttpEntity<MultiValueMap<String, String>> searchEntity = new HttpEntity<>(params, headersWithToken());
            return restTemplate.exchange(agentBaseUrl + "/internal/v1/agent/rag/search", HttpMethod.POST, searchEntity, String.class);
        } catch (Exception e) {
            logger.error("RAG search proxy failed: {}", e.getMessage(), e);
            return problem("RAG_SEARCH_FAILED", "RAG search failed");
        }
    }

    @DeleteMapping("/documents/{docId}")
    public ResponseEntity<String> delete(@PathVariable String docId) {
        try {
            HttpEntity<Void> entity = new HttpEntity<>(headersWithToken());
            restTemplate.exchange(agentBaseUrl + "/internal/v1/agent/rag/documents/" + docId, HttpMethod.DELETE, entity, String.class);
            return ResponseEntity.ok("{\"deleted\":true}");
        } catch (Exception e) {
            logger.error("RAG delete proxy failed: {}", e.getMessage(), e);
            return problem("RAG_DELETE_FAILED", "RAG delete failed");
        }
    }

    private ResponseEntity<String> problem(String code, String detail) {
        String requestId = java.util.UUID.randomUUID().toString();
        return ResponseEntity.status(502)
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .header("X-Request-Id", requestId)
                .body("{\"type\":\"https://xihe.dev/problems/" + code.toLowerCase() + "\",\"title\":\"Bad Gateway\",\"status\":502,\"code\":\"" + code + "\",\"detail\":\"" + detail + "\",\"requestId\":\"" + requestId + "\"}");
    }
}
