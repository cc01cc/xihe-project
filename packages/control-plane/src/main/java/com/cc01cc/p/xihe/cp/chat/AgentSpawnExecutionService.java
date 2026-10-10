package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.context.ApplicationEventPublisher;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.UUID;

/** Resolves an MCP spawn caller and hands off a committed child Run. */
@Service
public class AgentSpawnExecutionService {
    private static final Logger logger = LoggerFactory.getLogger(AgentSpawnExecutionService.class);

    private final ChatSubmissionService submissions;
    private final ApplicationEventPublisher eventPublisher;

    public AgentSpawnExecutionService(ChatSubmissionService submissions,
                                      ApplicationEventPublisher eventPublisher) {
        this.submissions = submissions;
        this.eventPublisher = eventPublisher;
    }

    public ChatSubmissionService.SpawnInvocation prepareMcpInvocation(
            String mcpBody, HttpHeaders headers, String sessionId, String userId, String workspaceId) {
        if (sessionId == null || sessionId.isBlank() || userId == null || userId.isBlank()
                || workspaceId == null || workspaceId.isBlank()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "SPAWN_AGENT_CONTEXT_REQUIRED",
                    "Spawn requires an authenticated Agent Session context");
        }

        String runId = requiredUuidHeader(headers, "X-Chat-Run-Id");
        String toolCallId = requiredUuidHeader(headers, "X-Tool-Call-Id");
        ChatSubmissionService.SpawnInvocation invocation = submissions.prepareSpawnInvocation(runId, toolCallId);
        if (!sessionId.equals(invocation.parentSessionId())
                || !userId.equals(invocation.userId())
                || !workspaceId.equals(invocation.workspaceId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "SPAWN_AGENT_CONTEXT_MISMATCH",
                    "MCP caller context does not match the durable parent tool call");
        }
        submissions.validateSpawnMcpArguments(invocation, mcpBody);
        return invocation;
    }

    public ChatSubmissionService.SpawnResult execute(
            ChatSubmissionService.SpawnInvocation invocation,
            ChatSubmissionService.SpawnAuthorization authorization) {
        ChatSubmissionService.SpawnResult result = submissions.createSpawnFromParent(
                invocation.parentRunId(), invocation.toolCallId(), authorization);
        try {
            eventPublisher.publishEvent(new SpawnRunDispatchRequestedEvent(
                    invocation.parentRunId(), result.runId()));
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=spawn_dispatch_failed parentRunId={} childRunId={} failureType={}",
                    invocation.parentRunId(), result.runId(), e.getClass().getSimpleName(), e);
        }
        return result;
    }

    private static String requiredUuidHeader(HttpHeaders headers, String name) {
        String value = headers.getFirst(name);
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "SPAWN_AGENT_CONTEXT_REQUIRED",
                    "Required MCP caller context is missing");
        }
        return parseUuidHeader(value, name);
    }

    private static String parseUuidHeader(String value, String name) {
        try {
            return UUID.fromString(value).toString();
        } catch (IllegalArgumentException e) {
            logger.warn("[LIFECYCLE] service=cp event=spawn_context_header_invalid headerName={} failureType={}",
                    name, e.getClass().getSimpleName());
            throw new CpApiException(HttpStatus.BAD_REQUEST, "SPAWN_AGENT_CONTEXT_INVALID",
                    "MCP caller context is invalid");
        }
    }
}
