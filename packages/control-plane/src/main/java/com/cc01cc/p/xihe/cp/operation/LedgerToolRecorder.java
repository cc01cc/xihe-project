package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;
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
 * PLAN-0326 决策 #8/#9：Agent 侧工具事实的记账组件。
 *
 * <p>账本单位 = 通道事实：本组件只写 {@code source=agent} 的行（调用/结果/被拒），
 * 网关的派发事实（source=mcp）由 {@code McpProxyController} 自行记账——两通道
 * 各持己行，靠显式 {@code toolCallId} 关联，不存在跨源复用或启发式匹配。</p>
 *
 * <p>从 ChatController（PLAN-0317 T2.8 的中继记账）迁移而来，语义变化：</p>
 * <ul>
 *   <li>建项幂等限定同源（operation_id + source + tool_call_id），不再查找
 *       网关的行——mcp 行的存在与否是派发事实的读端信号（spec §0.6）；</li>
 *   <li>删除 {@code findLatestOpenItem} 启发式（0317 决策 #17 的遗留）；</li>
 *   <li>断流/重启场景由 run 恢复对账收敛（reconcileStaleOperation），无启发式回退。</li>
 * </ul>
 */
@Component
public class LedgerToolRecorder {

    private static final Logger logger = LoggerFactory.getLogger(LedgerToolRecorder.class);

    private final OperationService operationService;
    private final ChatRunRepository chatRunRepository;
    private final ObjectMapper objectMapper;

    public LedgerToolRecorder(OperationService operationService,
                              ChatRunRepository chatRunRepository, ObjectMapper objectMapper) {
        this.operationService = operationService;
        this.chatRunRepository = chatRunRepository;
        this.objectMapper = objectMapper;
    }

    /** 一次 run 内的记账游标：toolCallId → item 行；itemId → 未结 attempt 行。 */
    public record RunLedger(Map<String, UUID> itemsByToolCallId, Map<UUID, UUID> attemptsByItemId) {
        public static RunLedger create() {
            return new RunLedger(new LinkedHashMap<>(), new LinkedHashMap<>());
        }
    }

    /**
     * 按 SSE 事件阶段映射 Agent 侧工具事实（决策 #8）。
     *
     * @param eventName {@code tool_call} 或 {@code tool_result}
     * @param payload   事件载荷（tool / arguments / result / run_id / toolCallId）
     * @param runId     run 标识（账本根定位 + 键派生回退）
     * @param requestId 取消定位用的请求 id（写入 attempt.request_id）
     * @param ledger    run 内记账游标
     */
    public void record(String eventName, Map<?, ?> payload, String runId,
                       String requestId, RunLedger ledger) {
        if (!"tool_call".equals(eventName) && !"tool_result".equals(eventName)) {
            return;
        }
        UUID operationId = operationService.findOperationIdByRunId(runId);
        if (operationId == null) {
            return;
        }
        String toolName = stringValue(payload, "tool");
        if (toolName == null) {
            toolName = "unknown";
        }
        // PLAN-0317 决策 #8 补充（2026-09-13 E2E）：run 进入取消流程后，取消副作用
        // （Agent 侧工具中止）产生的 Tool error 不是执行事实，四层终态由取消路径自主落定。
        if (isRunCancellingOrCancelled(runId)) {
            logger.info("[LIFECYCLE] service=cp event=operation_tool_event_skipped_after_cancel runId={} event={} tool={}",
                    runId, eventName, toolName);
            return;
        }
        // PLAN-0317 T2.8④：优先用 Agent 显式携带的 toolCallId（call/result 同一值），
        // 回退到 run_id（本地工具的历史路径）。
        String rawToolCallId = stringValue(payload, "toolCallId");
        if (rawToolCallId == null) {
            rawToolCallId = stringValue(payload, "run_id");
        }
        String toolCallId = canonicalToolCallId(rawToolCallId, runId, toolName, payload);
        try {
            if ("tool_call".equals(eventName)) {
                onToolCall(operationId, toolCallId, toolName, payload, requestId, ledger);
                return;
            }
            onToolResult(toolCallId, toolName, payload, ledger);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=operation_tool_record_failed runId={} toolCallId={} toolName={}",
                    runId, toolCallId, toolName, e);
            if (e instanceof CpApiException apiException
                    && "OPERATION_STATE_CONFLICT".equals(apiException.getCode())) {
                return;
            }
            throw e;
        }
    }

    /** tool_call 阶段：幂等建 source=agent 行 + agent_tool attempt + running。 */
    private void onToolCall(UUID operationId, String toolCallId, String toolName,
                            Map<?, ?> payload, String requestId, RunLedger ledger) {
        // 决策 #9：幂等收敛限定同源；mcp 行与本行互不相干（读端以行存在性区分派发事实）。
        OperationItem item = operationService.appendItem(
                operationId, toolCallId, null, "tool_call", toolName, "agent",
                safeJsonPreview(payload.get("arguments")), null, null);
        ledger.itemsByToolCallId().put(toolCallId, item.getId());
        if ("pending".equals(item.getStatus())) {
            operationService.transitionItem(item.getId(), "running", null, null, null, null);
        }
        if (!ledger.attemptsByItemId().containsKey(item.getId())) {
            OperationAttempt attempt = operationService.startAttempt(
                    item.getId(), "agent_tool", null, "agent", requestId);
            ledger.attemptsByItemId().put(item.getId(), attempt.getId());
        }
    }

    /** tool_result 阶段：结算本 run 游标内的 agent 行与 attempt（被拒 → failed）。 */
    private void onToolResult(String toolCallId, String toolName,
                              Map<?, ?> payload, RunLedger ledger) {
        UUID itemId = ledger.itemsByToolCallId().get(toolCallId);
        if (itemId == null) {
            // v3 无启发式回退：断流/重启丢游标时交给 run 恢复对账（决策 #8）。
            logger.warn("[LIFECYCLE] service=cp event=operation_tool_result_unmatched runId={} toolCallId={} toolName={}",
                    "unknown", toolCallId, toolName);
            return;
        }
        Object rawResult = payload.get("result");
        boolean failed = rawResult != null && String.valueOf(rawResult).startsWith("Tool error:");
        UUID attemptId = ledger.attemptsByItemId().get(itemId);
        if (attemptId != null) {
            operationService.finishAttempt(attemptId, failed ? "failed" : "succeeded",
                    failed ? 500 : 200, failed ? "TOOL_FAILED" : null, null, null);
        }
        operationService.transitionItem(itemId, failed ? "failed" : "completed",
                failed ? null : "allow", null, null, failed ? "TOOL_FAILED" : null);
        ledger.attemptsByItemId().remove(itemId);
        ledger.itemsByToolCallId().remove(toolCallId);
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
            String redacted = LogRedactor.redact(json);
            return redacted.length() <= 4096 ? redacted : redacted.substring(0, 4096);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=operation_arguments_redaction_failed");
            return "{\"redacted\":true}";
        }
    }

    private String canonicalToolCallId(String rawToolCallId, String runId, String toolName,
                                       Map<?, ?> payload) {
        if (rawToolCallId != null) {
            try {
                return UUID.fromString(rawToolCallId).toString();
            } catch (IllegalArgumentException ignored) {
                // PLAN-0317 T2.8④（决策 #12）：与网关侧派生规则统一为
                // nameUUIDFromBytes，使中继与网关对同一原始 id 得到同一个键。
                return UUID.nameUUIDFromBytes(rawToolCallId.getBytes(StandardCharsets.UTF_8))
                        .toString();
            }
        }
        return UUID.nameUUIDFromBytes((runId + ":" + toolName + ":" + safeJsonPreview(payload))
                .getBytes(StandardCharsets.UTF_8)).toString();
    }
}
