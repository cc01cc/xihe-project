package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;

import java.util.UUID;

/**
 * PLAN-0464 T2.1: shared spawn-test seeding for the execution-domain invocation
 * row that the spawn path now reads (the MCP gate creates it in production).
 */
final class SpawnTestSupport {

    private SpawnTestSupport() {
    }

    static void seedAgentInvocation(McpInvocationRepository invocations, String sessionId, String runId,
                                    String workspaceId, String userId, String toolCallId, String toolName,
                                    String argumentsPreview) {
        McpInvocation invocation = new McpInvocation();
        invocation.setId(UUID.randomUUID());
        invocation.setSessionId(sessionId);
        invocation.setRunId(runId);
        invocation.setWorkspaceId(workspaceId);
        invocation.setUserId(userId);
        invocation.setToolCallId(toolCallId);
        invocation.setToolName(toolName);
        invocation.setSource(McpInvocation.SOURCE_AGENT);
        invocation.setStatus(McpInvocation.STATUS_ACTIVE);
        invocation.setArgumentsPreview(argumentsPreview);
        invocations.saveAndFlush(invocation);
    }

    static void clearForWorkspace(McpInvocationRepository invocations, org.springframework.jdbc.core.JdbcTemplate jdbc,
                                  String workspaceId) {
        jdbc.update(
                "DELETE FROM mcp_dispatch_history WHERE invocation_id IN "
                        + "(SELECT id FROM mcp_invocations WHERE CAST(workspace_id AS VARCHAR) = ?)",
                workspaceId);
        jdbc.update(
                "DELETE FROM mcp_attempts WHERE invocation_id IN "
                        + "(SELECT id FROM mcp_invocations WHERE CAST(workspace_id AS VARCHAR) = ?)",
                workspaceId);
        jdbc.update("DELETE FROM mcp_invocations WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
    }
}
