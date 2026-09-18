package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.runtime.RuntimeMcpSessionClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0366 T1.1：stdio MCP 会话状态查询（CP 薄代理；契约见 spec/ui-contract.md §一）。
 *
 * <p>Runtime 拥有状态事实（0347 `SessionSnapshot`，wire 为 snake_case、`state` 小写字面量）；
 * 本层做**唯一一次显式键名映射**（`serverId/lastError/sinceMs/epoch`，`state` 保持小写），
 * 只做映射、鉴权与错误转译，不重算状态语义、不反向修改 Runtime（决策 #2/#13）。
 * 错误表：Runtime 404/409/503 生命周期码白名单透传；其余非 2xx、不可达、响应不可解析
 * 一律 502 `RUNTIME_UNAVAILABLE`。
 */
@RestController
public class McpSessionStatusController {

    private final WorkspaceService workspaceService;
    private final RuntimeMcpSessionClient runtimeMcpSessionClient;
    private final ObjectMapper objectMapper;

    public McpSessionStatusController(WorkspaceService workspaceService,
                                      RuntimeMcpSessionClient runtimeMcpSessionClient,
                                      ObjectMapper objectMapper) {
        this.workspaceService = workspaceService;
        this.runtimeMcpSessionClient = runtimeMcpSessionClient;
        this.objectMapper = objectMapper;
    }

    /** Runtime 生命周期错误码 → CP 透传映射（spec §一错误表冻结白名单）。 */
    private static final Map<String, HttpStatus> RUNTIME_ERROR_STATUS = Map.of(
            "WORKSPACE_NOT_FOUND", HttpStatus.NOT_FOUND,
            "WORKSPACE_DESTROYING", HttpStatus.CONFLICT,
            "WORKSPACE_BUSY", HttpStatus.CONFLICT,
            "WORKSPACE_MATERIALIZATION_FAILED", HttpStatus.SERVICE_UNAVAILABLE);

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{wsId}/mcp/servers")
    public ResponseEntity<?> mcpServers(@PathVariable String wsId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            workspaceService.requireAccessibleWorkspace(wsId, userId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }

        RuntimeMcpSessionClient.Result result = runtimeMcpSessionClient.fetchServers(wsId);
        if (result.unreachable()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime MCP session query failed");
        }
        JsonNode root = readJson(result.body());
        if (result.status() / 100 != 2) {
            return errorResponse(result.status(), root);
        }
        if (root == null || !root.path("servers").isArray()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime MCP session query failed");
        }
        return ResponseEntity.ok(mapServers(root));
    }

    private ResponseEntity<Map<String, Object>> errorResponse(int status, JsonNode root) {
        String code = root == null ? null : root.path("code").asText(null);
        HttpStatus mapped = code == null ? null : RUNTIME_ERROR_STATUS.get(code);
        if (mapped == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime MCP session query failed");
        }
        String detail = switch (code) {
            case "WORKSPACE_NOT_FOUND" -> "Workspace not found in Runtime";
            case "WORKSPACE_DESTROYING" -> "Workspace is being destroyed";
            case "WORKSPACE_BUSY" -> "Workspace is busy";
            default -> "Workspace materialization failed";
        };
        return ProblemDetailsHandler.problemResponse(mapped, code, detail);
    }

    /** 显式键名映射（唯一一次）；值域保持 Runtime 小写字面量，不重命名大小写。 */
    Map<String, Object> mapServers(JsonNode root) {
        List<Map<String, Object>> servers = new ArrayList<>();
        for (JsonNode server : root.path("servers")) {
            Map<String, Object> mapped = new LinkedHashMap<>();
            mapped.put("serverId", server.path("server_id").asText(""));
            mapped.put("state", server.path("state").asText(""));
            mapped.put("attempt", server.path("attempt").asInt(0));
            JsonNode lastError = server.path("last_error");
            mapped.put("lastError", lastError.isMissingNode() || lastError.isNull()
                    ? null : lastError.asText());
            mapped.put("sinceMs", server.path("since_ms").asLong(0));
            mapped.put("epoch", server.path("epoch").asLong(0));
            servers.add(mapped);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("servers", servers);
        body.put("count", servers.size());
        return body;
    }

    private JsonNode readJson(String body) {
        if (body == null || body.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readTree(body);
        } catch (Exception e) {
            return null;
        }
    }
}
