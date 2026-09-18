package com.cc01cc.p.xihe.cp.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * PLAN-0344 T1.2：CP → Runtime 的内部 job 读/取消通道
 * （{@code /internal/v1/runtime/workspaces/{ws}/jobs/...}）。
 *
 * <p>与 MCP 工具面分离：字节游标分页协议与对账轮询不暴露给 Agent。
 * 语义约定：job 不存在时 Runtime 返回 404（状态）或 200 + {@code available=false}
 * （输出），CP 再结合档案状态给出 {@code JOB_OUTPUT_LOST}/{@code JOB_OUTPUT_EXPIRED}。
 */
@Component
public class RuntimeJobClient {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeJobClient.class);
    private static final Duration CALL_TIMEOUT = Duration.ofSeconds(10);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final String runtimeUrl;
    private final String serviceToken;

    public RuntimeJobClient(
            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    /** found=false：Runtime 明确没有该 job（404）；unreachable=true：调用失败。 */
    public record JobStatusResult(boolean found, boolean unreachable, JsonNode job) {

        static JobStatusResult notFound() {
            return new JobStatusResult(false, false, null);
        }

        static JobStatusResult unreachable() {
            return new JobStatusResult(false, true, null);
        }
    }

    /** available=false：job 或输出文件缺失（由调用方决定 LOST/EXPIRED）；unreachable=true：调用失败。 */
    public record JobOutputResult(boolean available, boolean unreachable, JsonNode chunk) {

        static JobOutputResult unavailable() {
            return new JobOutputResult(false, false, null);
        }

        static JobOutputResult unreachable() {
            return new JobOutputResult(false, true, null);
        }
    }

    public JobStatusResult jobStatus(String workspaceId, String jobId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jobId", jobId);
        HttpResponse<String> response = post(workspaceId, "/jobs/status", body);
        if (response == null) {
            return JobStatusResult.unreachable();
        }
        if (response.statusCode() == 404) {
            return JobStatusResult.notFound();
        }
        if (response.statusCode() / 100 != 2) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_status_http_error workspaceId={} jobId={} status={}",
                    workspaceId, jobId, response.statusCode());
            return JobStatusResult.unreachable();
        }
        JsonNode job = readTree(response.body());
        return job == null ? JobStatusResult.unreachable() : new JobStatusResult(true, false, job);
    }

    public JobOutputResult jobOutput(String workspaceId, String jobId, String stream,
                                     Long offset, Long limit) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jobId", jobId);
        body.put("stream", stream);
        body.put("offset", offset);
        body.put("limit", limit);
        HttpResponse<String> response = post(workspaceId, "/jobs/output", body);
        if (response == null) {
            return JobOutputResult.unreachable();
        }
        if (response.statusCode() == 404) {
            return JobOutputResult.unavailable();
        }
        if (response.statusCode() / 100 != 2) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_output_http_error workspaceId={} jobId={} status={}",
                    workspaceId, jobId, response.statusCode());
            return JobOutputResult.unreachable();
        }
        JsonNode chunk = readTree(response.body());
        if (chunk == null) {
            return JobOutputResult.unreachable();
        }
        if (!chunk.path("available").asBoolean(false)) {
            return JobOutputResult.unavailable();
        }
        return new JobOutputResult(true, false, chunk);
    }

    private HttpResponse<String> post(String workspaceId, String suffix, Map<String, Object> body) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return null;
        }
        String url = runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + suffix;
        try {
            String payload = objectMapper.writeValueAsString(body);
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Authorization", "Bearer " + serviceToken)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(payload))
                    .timeout(CALL_TIMEOUT)
                    .build();
            return httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_call_unreachable workspaceId={} path={} error={}",
                    workspaceId, suffix, e.getMessage());
            return null;
        }
    }

    private JsonNode readTree(String body) {
        try {
            return objectMapper.readTree(body);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_response_unparseable error={}", e.getMessage());
            return null;
        }
    }
}
