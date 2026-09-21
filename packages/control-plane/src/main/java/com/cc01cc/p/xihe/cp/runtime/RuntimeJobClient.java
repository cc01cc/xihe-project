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
import java.util.List;
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

        static JobStatusResult unreachableResult() {
            return new JobStatusResult(false, true, null);
        }
    }

    /** available=false：job 或输出文件缺失（由调用方决定 LOST/EXPIRED）；unreachable=true：调用失败。 */
    public record JobOutputResult(boolean available, boolean unreachable, JsonNode chunk) {

        static JobOutputResult unavailable() {
            return new JobOutputResult(false, false, null);
        }

        static JobOutputResult unreachableResult() {
            return new JobOutputResult(false, true, null);
        }
    }

    /**
     * reachable=false：调用失败（不可达/超时/非 2xx/响应不可解析）；
     * found=false：Runtime 明确没有该 job（404 `JOB_NOT_FOUND`）；
     * status：`cancelled` 或 `failed`（终止未确认，由 CP 折叠 502）。
     */
    public record JobCancelResult(boolean reachable, boolean found, String status) {

        static JobCancelResult unreachableResult() {
            return new JobCancelResult(false, false, null);
        }

        static JobCancelResult notFound() {
            return new JobCancelResult(true, false, null);
        }
    }

    public JobStatusResult jobStatus(String workspaceId, String jobId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jobId", jobId);
        HttpResponse<String> response = post(workspaceId, "/jobs/status", body);
        if (response == null) {
            return JobStatusResult.unreachableResult();
        }
        if (response.statusCode() == 404) {
            return JobStatusResult.notFound();
        }
        if (response.statusCode() / 100 != 2) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_status_http_error workspaceId={} jobId={} status={}",
                    workspaceId, jobId, response.statusCode());
            return JobStatusResult.unreachableResult();
        }
        JsonNode job = readTree(response.body());
        return job == null ? JobStatusResult.unreachableResult() : new JobStatusResult(true, false, job);
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
            return JobOutputResult.unreachableResult();
        }
        if (response.statusCode() == 404) {
            return JobOutputResult.unavailable();
        }
        if (response.statusCode() / 100 != 2) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_output_http_error workspaceId={} jobId={} status={}",
                    workspaceId, jobId, response.statusCode());
            return JobOutputResult.unreachableResult();
        }
        JsonNode chunk = readTree(response.body());
        if (chunk == null) {
            return JobOutputResult.unreachableResult();
        }
        if (!chunk.path("available").asBoolean(false)) {
            return JobOutputResult.unavailable();
        }
        return new JobOutputResult(true, false, chunk);
    }

    /**
     * PLAN-0366 T1.3：取消单个 job（Runtime internal `jobs/cancel`，复用四阶段终止）。
     * 找不到 job → notFound（由 CP 决定落 orphaned，不臆造已取消）。
     */
    public JobCancelResult cancelJob(String workspaceId, String jobId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jobId", jobId);
        HttpResponse<String> response = post(workspaceId, "/jobs/cancel", body);
        if (response == null) {
            return JobCancelResult.unreachableResult();
        }
        if (response.statusCode() == 404) {
            return JobCancelResult.notFound();
        }
        if (response.statusCode() / 100 != 2) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_cancel_http_error workspaceId={} jobId={} status={}",
                    workspaceId, jobId, response.statusCode());
            return JobCancelResult.unreachableResult();
        }
        JsonNode node = readTree(response.body());
        String status = node == null ? null : node.path("status").asText(null);
        if (!"cancelled".equals(status) && !"failed".equals(status)) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_cancel_unexpected_status workspaceId={} jobId={} status={}",
                    workspaceId, jobId, status);
            return JobCancelResult.unreachableResult();
        }
        return new JobCancelResult(true, true, status);
    }

    /**
     * PLAN-0390 M2：启动一个 durable Job（Runtime internal `jobs/start`）。
     *
     * <p>`launched=true` 表示 Runtime 返回 2xx 且带 jobId；`backendPending=true`
     * 表示 backend 无 launcher（direct-attach，Runtime 501 `JOB_BACKEND_LAUNCH_PENDING`），
     * 由 CP 折叠为 501，不 fallback 到其它 backend。
     */
    public record JobStartResult(boolean reachable, boolean launched, boolean backendPending,
                                 String jobId, String errorCode) {

        static JobStartResult unreachableResult() {
            return new JobStartResult(false, false, false, null, null);
        }
    }

    public JobStartResult startJob(String workspaceId, String operationItemId, String command,
                                   List<String> args, String cwd, Long timeoutSecs,
                                   Map<String, String> env) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("operationItemId", operationItemId);
        body.put("command", command);
        body.put("args", args == null ? List.of() : args);
        if (cwd != null && !cwd.isBlank()) {
            body.put("cwd", cwd);
        }
        body.put("timeoutSecs", timeoutSecs == null ? 0L : timeoutSecs);
        if (env != null && !env.isEmpty()) {
            body.put("env", env);
        }
        HttpResponse<String> response = post(workspaceId, "/jobs/start", body);
        if (response == null) {
            return JobStartResult.unreachableResult();
        }
        if (response.statusCode() == 501) {
            return new JobStartResult(true, false, true, null, "JOB_BACKEND_LAUNCH_PENDING");
        }
        if (response.statusCode() / 100 != 2) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_start_http_error workspaceId={} status={}",
                    workspaceId, response.statusCode());
            return JobStartResult.unreachableResult();
        }
        JsonNode node = readTree(response.body());
        String jobId = node == null ? null : node.path("jobId").asText(null);
        if (jobId == null || jobId.isBlank()) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_start_missing_job_id workspaceId={}",
                    workspaceId);
            return JobStartResult.unreachableResult();
        }
        return new JobStartResult(true, true, false, jobId, null);
    }

    /**
     * PLAN-0396：Runtime `jobs/capabilities` 的三态结果。
     *
     * <p>`reachable=false` 表示 Runtime 不可达/超时；`containerJobs=true` 表示
     * Runtime 明确回答「容器 Job 由 Docker 路径服务」（501）。两种情况下
     * `capability` 为 null，由调用方折叠成显式 unavailable，而不是猜测可用性。
     */
    public record JobCapabilityResult(boolean reachable, boolean containerJobs, JsonNode capability,
                                      String problemCode) {

        static JobCapabilityResult unreachableResult() {
            return new JobCapabilityResult(false, false, null, null);
        }

        static JobCapabilityResult containerJobsResult() {
            return new JobCapabilityResult(true, true, null, null);
        }

        public static JobCapabilityResult problemResult(String problemCode) {
            return new JobCapabilityResult(true, false, null, problemCode);
        }
    }

    public JobCapabilityResult jobCapabilities(String workspaceId) {
        HttpResponse<String> response = post(workspaceId, "/jobs/capabilities", Map.of());
        if (response == null) {
            return JobCapabilityResult.unreachableResult();
        }
        if (response.statusCode() == 501) {
            return JobCapabilityResult.containerJobsResult();
        }
        if (response.statusCode() / 100 != 2) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_job_capabilities_http_error workspaceId={} status={}",
                    workspaceId, response.statusCode());
            // A Runtime that answers with an error is reachable: surface its code
            // instead of pretending the transport failed.
            JsonNode problem = readTree(response.body());
            String code = problem == null ? null : problem.path("code").asText(null);
            return JobCapabilityResult.problemResult(
                    code == null || code.isBlank() ? "RUNTIME_CAPABILITY_ERROR" : code);
        }
        JsonNode node = readTree(response.body());
        if (node == null || !node.isObject()) {
            return JobCapabilityResult.problemResult("RUNTIME_CAPABILITY_UNPARSABLE");
        }
        return new JobCapabilityResult(true, false, node, null);
    }

    /**
     * PLAN-0390 决策 #11：Runtime 进程 bootId（每次启动重新生成）。
     * 经 internal diagnostics 通道读取（`/health` 的 body 契约保持 `OK` 不变）。
     * 读不到（不可达/字段缺失）返回 null，调用方按「未知」处理而不误判重启。
     */
    public String runtimeBootId() {
        HttpResponse<String> response = get("/internal/v1/runtime/diagnostics");
        if (response == null || response.statusCode() / 100 != 2) {
            return null;
        }
        JsonNode node = readTree(response.body());
        if (node == null) {
            return null;
        }
        String bootId = node.path("bootId").asText(null);
        return bootId == null || bootId.isBlank() ? null : bootId;
    }

    private HttpResponse<String> get(String path) {
        String url = runtimeUrl + path;
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Authorization", "Bearer " + serviceToken)
                    .GET()
                    .timeout(CALL_TIMEOUT)
                    .build();
            return httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_get_unreachable path={} error={}",
                    path, e.getMessage());
            return null;
        }
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
