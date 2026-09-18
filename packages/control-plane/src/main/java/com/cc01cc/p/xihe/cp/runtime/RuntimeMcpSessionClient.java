package com.cc01cc.p.xihe.cp.runtime;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * PLAN-0366 T1.1：CP → Runtime 的 stdio MCP 会话状态读通道
 * （{@code GET /internal/v1/runtime/workspaces/{ws}/mcp/servers}）。
 *
 * <p>只做传输：状态折叠（白名单错误码 / 不可达）在调用方
 * {@code McpSessionStatusController}。Runtime handler 会先 {@code ensure_workspace}，
 * 首次查询可能触发物化，读取上限 10s（CP→Runtime 恒有界，超时走显式降级）。
 */
@Component
public class RuntimeMcpSessionClient {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeMcpSessionClient.class);
    private static final Duration CALL_TIMEOUT = Duration.ofSeconds(10);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
    private final String runtimeUrl;
    private final String serviceToken;

    public RuntimeMcpSessionClient(
            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    /** unreachable=true：连接失败/超时（此时 status/body 无意义）。 */
    public record Result(boolean unreachable, int status, String body) {

        static Result unreachableResult() {
            return new Result(true, 0, null);
        }
    }

    public Result fetchServers(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return Result.unreachableResult();
        }
        String url = runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/mcp/servers";
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Authorization", "Bearer " + serviceToken)
                    .header("Accept", "application/json")
                    .timeout(CALL_TIMEOUT)
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request,
                    HttpResponse.BodyHandlers.ofString());
            return new Result(false, response.statusCode(), response.body());
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=runtime_mcp_servers_unreachable workspaceId={} error={}",
                    workspaceId, e.getMessage());
            return Result.unreachableResult();
        }
    }
}
