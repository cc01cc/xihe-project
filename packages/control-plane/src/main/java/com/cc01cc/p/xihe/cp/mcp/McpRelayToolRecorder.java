package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0464 T2.2: records the SSE-relay half of the MCP execution domain.
 *
 * <p>It opens the {@code source=agent} invocation
 * for a relayed {@code tool_call} (so an early relay event wins the
 * {@code (runId, toolCallId)} key before the MCP gate) and running the
 * {@code agent_tool} attempt in {@code mcp_attempts}. Every write is
 * best-effort — a bookkeeping failure is logged and never breaks the relay.</p>
 */
@Component
public class McpRelayToolRecorder {

    private static final Logger logger = LoggerFactory.getLogger(McpRelayToolRecorder.class);

    private final ChatRunRepository chatRunRepository;
    private final McpInvocationService mcpInvocationService;
    private final ObjectMapper objectMapper;

    public McpRelayToolRecorder(ChatRunRepository chatRunRepository,
                                McpInvocationService mcpInvocationService,
                                ObjectMapper objectMapper) {
        this.chatRunRepository = chatRunRepository;
        this.mcpInvocationService = mcpInvocationService;
        this.objectMapper = objectMapper;
    }

    /** One run's relay bookkeeping cursor: toolCallId → invocation / attempt ids. */
    public record RunState(Map<String, UUID> invocationsByToolCallId,
                           Map<String, UUID> attemptsByToolCallId) {
        public static RunState create() {
            return new RunState(new LinkedHashMap<>(), new LinkedHashMap<>());
        }
    }

    /**
     * @param eventName {@code tool_call} or {@code tool_result}
     * @param payload   event payload (tool / arguments / result / toolCallId)
     * @param runId     durable run correlation key
     * @param requestId request id written onto the attempt row
     * @param state     per-run cursor
     */
    public void record(String eventName, Map<?, ?> payload, String runId,
                       String requestId, RunState state) {
        if (!"tool_call".equals(eventName) && !"tool_result".equals(eventName)) {
            return;
        }
        if (isRunCancellingOrCancelled(runId)) {
            logger.info("[LIFECYCLE] service=cp event=mcp_tool_event_skipped_after_cancel runId={} event={}",
                    runId, eventName);
            return;
        }
        String toolName = stringValue(payload, "tool");
        if (toolName == null) {
            toolName = "unknown";
        }
        String rawToolCallId = stringValue(payload, "toolCallId");
        if (rawToolCallId == null) {
            rawToolCallId = stringValue(payload, "run_id");
        }
        String toolCallId = canonicalToolCallId(rawToolCallId, runId, toolName, payload);
        try {
            if ("tool_call".equals(eventName)) {
                UUID invocationId = openInvocation(runId, toolCallId, toolName, requestId,
                        safeJsonPreview(payload.get("arguments")));
                if (invocationId != null) {
                    state.invocationsByToolCallId().put(toolCallId, invocationId);
                    startAgentToolAttempt(invocationId, toolCallId, requestId, state);
                }
                return;
            }
            finishToolResult(toolCallId, payload, state);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_tool_record_failed runId={} toolCallId={} toolName={} failureType={}",
                    runId, toolCallId, toolName, e.getClass().getName(), e);
        }
    }

    private void startAgentToolAttempt(UUID invocationId, String toolCallId, String requestId,
                                       RunState state) {
        if (state.attemptsByToolCallId().containsKey(toolCallId)) {
            return;
        }
        try {
            mcpInvocationService.startAgentToolAttempt(invocationId, requestId)
                    .ifPresent(attemptId -> state.attemptsByToolCallId().put(toolCallId, attemptId));
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_agent_tool_attempt_start_failed toolCallId={} failureType={}",
                    toolCallId, e.getClass().getName(), e);
        }
    }

    private void finishToolResult(String toolCallId, Map<?, ?> payload, RunState state) {
        Object rawResult = payload.get("result");
        boolean failed = rawResult != null && String.valueOf(rawResult).startsWith("Tool error:");
        UUID invocationId = state.invocationsByToolCallId().remove(toolCallId);
        UUID attemptId = state.attemptsByToolCallId().remove(toolCallId);
        if (invocationId == null || attemptId == null) {
            // No cursor: the run's terminal reconciliation settles the row.
            logger.warn("[LIFECYCLE] service=cp event=mcp_tool_result_unmatched toolCallId={}", toolCallId);
            return;
        }
        try {
            mcpInvocationService.finishAgentToolAttempt(invocationId, attemptId, failed);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_agent_tool_attempt_finish_failed toolCallId={} failureType={}",
                    toolCallId, e.getClass().getName(), e);
        }
    }

    private UUID openInvocation(String runId, String toolCallId, String toolName,
                                String requestId, String preview) {
        try {
            return mcpInvocationService.openAgentInvocation(runId, toolCallId, toolName,
                    requestId, preview).orElse(null);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_invocation_open_failed runId={} toolCallId={} failureType={}",
                    runId, toolCallId, e.getClass().getName(), e);
            return null;
        }
    }

    private boolean isRunCancellingOrCancelled(String runId) {
        if (runId == null || runId.isBlank()) {
            return false;
        }
        try {
            return chatRunRepository.findById(UUID.fromString(runId))
                    .map(run -> "cancelling".equals(run.getStatus()) || "cancelled".equals(run.getStatus()))
                    .orElse(false);
        } catch (IllegalArgumentException e) {
            logger.debug("[LIFECYCLE] service=cp event=run_status_guard_skipped runId={} reason=invalid_uuid",
                    runId);
            return false;
        }
    }

    private String stringValue(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        return value instanceof String s && !s.isBlank() ? s : null;
    }

    private String safeJsonPreview(Object value) {
        try {
            String json = objectMapper.writeValueAsString(value == null ? Map.of() : value);
            return json.length() <= 4096 ? json : json.substring(0, 4096);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=mcp_arguments_serialization_failed exceptionType={}",
                    e.getClass().getSimpleName());
            return "null";
        }
    }

    private String canonicalToolCallId(String rawToolCallId, String runId, String toolName,
                                       Map<?, ?> payload) {
        if (rawToolCallId != null) {
            try {
                return UUID.fromString(rawToolCallId).toString();
            } catch (IllegalArgumentException ignored) {
                // Same derivation as the CP gate so relay and gate agree on the key.
                return UUID.nameUUIDFromBytes(rawToolCallId.getBytes(StandardCharsets.UTF_8))
                        .toString();
            }
        }
        return UUID.nameUUIDFromBytes((runId + ":" + toolName + ":" + safeJsonPreview(payload))
                .getBytes(StandardCharsets.UTF_8)).toString();
    }
}
