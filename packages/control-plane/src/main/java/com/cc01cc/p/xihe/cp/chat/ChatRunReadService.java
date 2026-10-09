package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/** Read-side ChatRun projections used by the public Chat API. */
@Service
public class ChatRunReadService {

    private final ChatRunRepository chatRunRepository;
    private final ApprovalService approvalService;

    public ChatRunReadService(ChatRunRepository chatRunRepository, ApprovalService approvalService) {
        this.chatRunRepository = chatRunRepository;
        this.approvalService = approvalService;
    }

    public Map<String, Object> getStatus(UUID runUuid, String runId, String userId, String workspaceId) {
        ChatRun run = chatRunRepository.findById(runUuid).orElse(null);
        if (run == null) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Chat run does not belong to current user/workspace");
        }
        boolean leaseExpired = run.getLeaseExpiresAt() != null
                && run.getLeaseExpiresAt().isBefore(Instant.now());
        List<Map<String, Object>> pendingApprovals = approvalService.findActiveForRun(runId, userId, workspaceId);
        String status = run.getStatus();
        String effectiveStatus = !pendingApprovals.isEmpty() && ("running".equals(status) || "cancelling".equals(status))
                ? "awaiting_approval"
                : status;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runId", runId);
        body.put("sessionId", run.getSessionId());
        body.put("origin", run.getOrigin());
        body.put("status", effectiveStatus);
        body.put("terminalOutcome", run.getTerminalOutcome());
        body.put("leaseExpired", leaseExpired);
        body.put("pendingApprovals", pendingApprovals);
        return body;
    }

    public Map<String, Object> listSessionRuns(String sessionId, int page, int size) {
        List<ChatRun> runs = chatRunRepository.findBySessionIdOrderByCreatedAtDescIdDesc(
                sessionId, PageRequest.of(page, size));
        List<Map<String, Object>> items = new ArrayList<>(runs.size());
        for (ChatRun run : runs) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("runId", run.getId().toString());
            item.put("sessionId", run.getSessionId());
            item.put("origin", run.getOrigin());
            item.put("status", run.getStatus());
            item.put("terminalOutcome", run.getTerminalOutcome());
            item.put("errorCode", run.getErrorCode());
            item.put("createdAt", run.getCreatedAt() == null ? null : run.getCreatedAt().toString());
            item.put("terminalAt", run.getTerminalAt() == null ? null : run.getTerminalAt().toString());
            item.put("waitingOnRunId", run.getWaitingOnRunId());
            item.put("waitingToolCallId", run.getWaitingToolCallId());
            items.add(item);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", sessionId);
        body.put("page", page);
        body.put("size", size);
        body.put("runs", items);
        return body;
    }

    /** Current durable Run status, or null when the Run no longer exists. */
    public String statusOrNull(String runId) {
        if (runId == null || runId.isBlank()) {
            return null;
        }
        return chatRunRepository.findById(UUID.fromString(runId))
                .map(ChatRun::getStatus)
                .orElse(null);
    }

    Optional<DispatchRun> findDispatchRun(String runId) {
        return chatRunRepository.findById(UUID.fromString(runId))
                .map(run -> new DispatchRun(
                        run.getId().toString(), run.getSessionId(), run.getUserId(), run.getWorkspaceId(),
                        run.getOrigin(), run.getStatus(), run.getUserMessageId(), run.getProvider(),
                        run.getModel(), run.getToolMode()));
    }

    record DispatchRun(String id, String sessionId, String userId, String workspaceId, String origin,
                       String status, String userMessageId, String provider, String model,
                       String toolMode) {
    }
}
