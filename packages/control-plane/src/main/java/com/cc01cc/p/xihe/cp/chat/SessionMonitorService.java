package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.provider.ProviderConnectionService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0507: read-only Session monitor aggregate over existing durable facts
 * (sessions row, chat_runs, provider verify facts, agent readiness snapshot).
 * No new durable state; unavailable values stay explicit (null), never zero-filled.
 * Contract: plans/PLAN-0507-XH-session-monitor-panel/spec/monitor-endpoint-contract.md
 */
@Service
public class SessionMonitorService {

    private static final int HISTORY_WINDOW = 20;

    /** Terminal set owned by ChatRunTerminalService; activity = its complement. */
    static final List<String> TERMINAL_STATUSES =
            List.of("succeeded", "partial", "failed", "cancelled", "ambiguous");

    private final ChatRunRepository chatRuns;
    private final ApprovalService approvalService;
    private final ProviderConnectionService providerConnections;
    private final HealthMonitor healthMonitor;

    public SessionMonitorService(ChatRunRepository chatRuns, ApprovalService approvalService,
                                 ProviderConnectionService providerConnections, HealthMonitor healthMonitor) {
        this.chatRuns = chatRuns;
        this.approvalService = approvalService;
        this.providerConnections = providerConnections;
        this.healthMonitor = healthMonitor;
    }

    public Map<String, Object> getMonitor(Session session, String userId, String workspaceId) {
        String sessionId = session.getId().toString();
        List<ChatRun> window = chatRuns.findBySessionIdAndStatusInOrderByTerminalAtDescIdDesc(
                sessionId, TERMINAL_STATUSES, PageRequest.of(0, HISTORY_WINDOW));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("generatedAt", Instant.now().toString());
        body.put("session", sessionView(session));
        body.put("activity", activity(sessionId, userId, workspaceId));
        body.put("history", history(window));
        body.put("readiness", readiness(session, window));
        return body;
    }

    private static Map<String, Object> sessionView(Session session) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", session.getId().toString());
        view.put("title", session.getTitle());
        view.put("agentPrincipalId", session.getAgentPrincipalId());
        view.put("modelProvider", session.getModelProvider());
        view.put("modelName", session.getModelName());
        view.put("providerConnectionId", session.getProviderConnectionId());
        view.put("connectionRevision", session.getConnectionRevision());
        view.put("createdAt", session.getCreatedAt() == null ? null : session.getCreatedAt().toString());
        view.put("updatedAt", session.getUpdatedAt() == null ? null : session.getUpdatedAt().toString());
        return view;
    }

    private List<Map<String, Object>> activity(String sessionId, String userId, String workspaceId) {
        List<ChatRun> runs = chatRuns.findBySessionIdAndStatusNotInOrderByCreatedAtDescIdDesc(
                sessionId, TERMINAL_STATUSES);
        List<Map<String, Object>> items = new ArrayList<>(runs.size());
        for (ChatRun run : runs) {
            String runId = run.getId().toString();
            List<Map<String, Object>> pending = approvalService.findActiveForRun(runId, userId, workspaceId);
            String status = run.getStatus();
            String effectiveStatus = !pending.isEmpty() && ("running".equals(status) || "cancelling".equals(status))
                    ? "awaiting_approval"
                    : status;
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("runId", runId);
            item.put("origin", run.getOrigin());
            item.put("status", effectiveStatus);
            item.put("createdAt", run.getCreatedAt() == null ? null : run.getCreatedAt().toString());
            item.put("waitingOnRunId", run.getWaitingOnRunId());
            item.put("waitingToolCallId", run.getWaitingToolCallId());
            item.put("leaseExpired", run.getLeaseExpiresAt() != null
                    && run.getLeaseExpiresAt().isBefore(Instant.now()));
            items.add(item);
        }
        return items;
    }

    private static Map<String, Object> history(List<ChatRun> window) {
        Map<String, Long> counts = new LinkedHashMap<>();
        List<Map<String, Object>> recent = new ArrayList<>(window.size());
        for (ChatRun run : window) {
            String outcome = run.getTerminalOutcome() == null ? "unknown" : run.getTerminalOutcome();
            counts.merge(outcome, 1L, Long::sum);
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("runId", run.getId().toString());
            item.put("origin", run.getOrigin());
            item.put("terminalOutcome", run.getTerminalOutcome());
            item.put("errorCode", run.getErrorCode());
            item.put("createdAt", run.getCreatedAt() == null ? null : run.getCreatedAt().toString());
            item.put("terminalAt", run.getTerminalAt() == null ? null : run.getTerminalAt().toString());
            recent.add(item);
        }
        Map<String, Object> history = new LinkedHashMap<>();
        history.put("windowSize", HISTORY_WINDOW);
        history.put("counts", counts);
        history.put("recent", recent);
        return history;
    }

    private Map<String, Object> readiness(Session session, List<ChatRun> window) {
        Map<String, Object> readiness = new LinkedHashMap<>();
        readiness.put("connection", connectionReadiness(session.getProviderConnectionId()));
        HealthMonitor.ServiceHealth agent = healthMonitor.getAgentHealth();
        Map<String, Object> agentView = new LinkedHashMap<>();
        agentView.put("status", agent.status());
        agentView.put("llmReady", agent.llmReady());
        agentView.put("verifiedAt", agent.verifiedAt() == null ? null : agent.verifiedAt().toString());
        agentView.put("configRevision", agent.configRevision());
        readiness.put("agent", agentView);
        readiness.put("lastObservedRun", window.isEmpty() ? null : lastObserved(window.getFirst()));
        return readiness;
    }

    private Map<String, Object> connectionReadiness(String connectionId) {
        if (connectionId == null || connectionId.isBlank()) {
            return null;
        }
        ProviderConnection connection;
        try {
            connection = providerConnections.requireVisible(connectionId);
        } catch (IllegalArgumentException notVisible) {
            // Missing row or no visibility: explicit null, never a fabricated state.
            return null;
        }
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("status", connection.getStatus());
        view.put("lastErrorCode", connection.getLastErrorCode());
        view.put("lastVerifiedAt", connection.getLastVerifiedAt() == null
                ? null : connection.getLastVerifiedAt().toString());
        return view;
    }

    private static Map<String, Object> lastObserved(ChatRun run) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("runId", run.getId().toString());
        view.put("terminalOutcome", run.getTerminalOutcome());
        view.put("errorCode", run.getErrorCode());
        view.put("terminalAt", run.getTerminalAt() == null ? null : run.getTerminalAt().toString());
        return view;
    }
}
