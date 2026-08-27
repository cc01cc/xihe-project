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
@RequestMapping("/rag")
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
            return restTemplate.exchange(agentBaseUrl + "/rag/stats", HttpMethod.GET, entity, String.class);
        } catch (Exception e) {
            logger.error("RAG stats proxy failed: {}", e.getMessage(), e);
            return ResponseEntity.status(502).body("{\"error\":\"RAG service unavailable\"}");
        }
    }

    @PostMapping(value = "/ingest", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<String> ingest(@RequestParam("file") MultipartFile file,
                                          @RequestParam(value = "chunk_size", defaultValue = "1000") int chunkSize,
                                          @RequestParam(value = "chunk_overlap", defaultValue = "200") int chunkOverlap) {
        try {
            MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
            body.add("file", new ByteArrayResource(file.getBytes(), file.getOriginalFilename()) {
                @Override
                public String getFilename() { return file.getOriginalFilename(); }
            });
            body.add("chunk_size", String.valueOf(chunkSize));
            body.add("chunk_overlap", String.valueOf(chunkOverlap));

            HttpHeaders headers = headersWithToken();
            headers.setContentType(MediaType.MULTIPART_FORM_DATA);
            HttpEntity<MultiValueMap<String, Object>> request = new HttpEntity<>(body, headers);

            return restTemplate.postForEntity(agentBaseUrl + "/rag/ingest", request, String.class);
        } catch (Exception e) {
            logger.error("RAG ingest proxy failed: {}", e.getMessage(), e);
            return ResponseEntity.status(502).body("{\"error\":\"Ingest failed\"}");
        }
    }

    @PostMapping("/search")
    public ResponseEntity<String> search(@RequestParam("query") String query,
                                          @RequestParam(value = "top_k", defaultValue = "5") int topK,
                                          @RequestParam(value = "min_score", defaultValue = "0.0") double minScore) {
        try {
            MultiValueMap<String, String> params = new LinkedMultiValueMap<>();
            params.add("query", query);
            params.add("top_k", String.valueOf(topK));
            params.add("min_score", String.valueOf(minScore));
            HttpEntity<MultiValueMap<String, String>> searchEntity = new HttpEntity<>(params, headersWithToken());
            return restTemplate.exchange(agentBaseUrl + "/rag/search", HttpMethod.POST, searchEntity, String.class);
        } catch (Exception e) {
            logger.error("RAG search proxy failed: {}", e.getMessage(), e);
            return ResponseEntity.status(502).body("{\"error\":\"Search failed\"}");
        }
    }

    @DeleteMapping("/documents/{docId}")
    public ResponseEntity<String> delete(@PathVariable String docId) {
        try {
            HttpEntity<Void> entity = new HttpEntity<>(headersWithToken());
            restTemplate.exchange(agentBaseUrl + "/rag/documents/" + docId, HttpMethod.DELETE, entity, String.class);
            return ResponseEntity.ok("{\"deleted\":true}");
        } catch (Exception e) {
            logger.error("RAG delete proxy failed: {}", e.getMessage(), e);
            return ResponseEntity.status(502).body("{\"error\":\"Delete failed\"}");
        }
    }
}
