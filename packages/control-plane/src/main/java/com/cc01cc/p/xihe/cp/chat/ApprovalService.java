package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class ApprovalService {

    private static final Logger logger = LoggerFactory.getLogger(ApprovalService.class);
    private static final List<String> REPLAYABLE_STATES = List.of("pending", "dispatching");
    private static final int MAX_ACTION_LENGTH = 512;
    private static final int MAX_DETAILS_LENGTH = 8192;

    private final ChatApprovalRepository approvalRepository;
    private final ChatRunRepository chatRunRepository;
    private final ApprovalAgentClient agentClient;

    public ApprovalService(ChatApprovalRepository approvalRepository,
                           ChatRunRepository chatRunRepository,
                           ApprovalAgentClient agentClient) {
        this.approvalRepository = approvalRepository;
        this.chatRunRepository = chatRunRepository;
        this.agentClient = agentClient;
    }

    @Transactional
    public void recordPending(Map<?, ?> payload, String expectedSessionId, String expectedRunId,
                              String userId, String workspaceId) {
        String requestId = required(payload, "requestId");
        String runId = optional(payload, "runId", expectedRunId);
        String sessionId = optional(payload, "sessionId", expectedSessionId);
        if (!expectedRunId.equals(runId) || !expectedSessionId.equals(sessionId)) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                    "Agent approval event does not match the active chat run");
        }
        ChatRun run = chatRunRepository.findById(runId).orElseThrow(() -> new CpApiException(
                HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH", "Approval event references an unknown chat run"));
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())
                || !sessionId.equals(run.getSessionId())) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                    "Agent approval event ownership does not match the active chat run");
        }
        String action = required(payload, "action");
        String details = optional(payload, "details", "");
        if (action.length() > MAX_ACTION_LENGTH || details.length() > MAX_DETAILS_LENGTH) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID",
                    "Approval request payload exceeds the size limit");
        }
        Instant expiresAt = parseExpiresAt(payload.get("expiresAt"));
        ChatApproval existing = approvalRepository.findById(requestId).orElse(null);
        if (existing != null) {
            if (!runId.equals(existing.getRunId()) || !sessionId.equals(existing.getSessionId())
                    || !userId.equals(existing.getUserId()) || !workspaceId.equals(existing.getWorkspaceId())) {
                throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                        "Approval request identity changed for an existing requestId");
            }
            return;
        }
        approvalRepository.save(new ChatApproval(
                requestId,
                runId,
                sessionId,
                userId,
                workspaceId,
                optional(payload, "tool", "request_approval"),
                action,
                details,
                "pending",
                expiresAt));
        logger.info("[LIFECYCLE] service=cp event=chat_approval_pending requestId={} sessionId={} runId={}",
                requestId, sessionId, runId);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> replayPending(String sessionId, String userId, String workspaceId) {
        return approvalRepository
                .findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(
                        sessionId, userId, workspaceId, REPLAYABLE_STATES)
                .stream()
                .filter(approval -> approval.getExpiresAt().isAfter(Instant.now()))
                .map(approval -> toPayload(approval, true))
                .toList();
    }

    @Transactional
    public Map<String, Object> decide(String requestId, String userId, String workspaceId, boolean approved) {
        ChatApproval approval = approvalRepository.findOwnedForUpdate(requestId, userId, workspaceId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "APPROVAL_NOT_FOUND", "Approval request not found"));
        if (approval.getExpiresAt().isBefore(Instant.now()) && !isTerminal(approval.getState())) {
            approval.setState("expired");
            approval.setDecidedAt(Instant.now());
            approvalRepository.save(approval);
            throw new CpApiException(HttpStatus.GONE, "APPROVAL_EXPIRED", "Approval request expired");
        }
        if (isTerminal(approval.getState())) {
            if (approval.getApproved() != null && approval.getApproved() == approved) {
                return decisionResponse(requestId, "accepted", approved);
            }
            throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_CONFLICT",
                    "Approval request already has a different decision");
        }
        if (!"pending".equals(approval.getState())) {
            throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_IN_PROGRESS",
                    "Approval decision is already being dispatched");
        }
        approval.setState("dispatching");
        approval.setApproved(approved);
        approvalRepository.saveAndFlush(approval);
        try {
            agentClient.respond(requestId, approved);
        } catch (CpApiException e) {
            approval.setState("dispatch_unknown");
            approval.setDispatchErrorCode(e.getCode());
            approvalRepository.save(approval);
            throw e;
        }
        approval.setState(approved ? "approved" : "rejected");
        approval.setDecidedAt(Instant.now());
        approvalRepository.save(approval);
        return decisionResponse(requestId, "accepted", approved);
    }

    private Map<String, Object> toPayload(ChatApproval approval, boolean replayed) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestId", approval.getRequestId());
        payload.put("runId", approval.getRunId());
        payload.put("sessionId", approval.getSessionId());
        payload.put("workspaceId", approval.getWorkspaceId());
        payload.put("tool", approval.getTool());
        payload.put("action", approval.getAction());
        payload.put("details", approval.getDetails());
        payload.put("expiresAt", approval.getExpiresAt());
        payload.put("replayed", replayed);
        return payload;
    }

    private Map<String, Object> decisionResponse(String requestId, String status, boolean approved) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", status);
        response.put("requestId", requestId);
        response.put("approved", approved);
        return response;
    }

    private boolean isTerminal(String state) {
        return "approved".equals(state) || "rejected".equals(state) || "expired".equals(state);
    }

    private String required(Map<?, ?> payload, String key) {
        String value = optional(payload, key, "");
        if (value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID", key + " is required");
        }
        return value;
    }

    private String optional(Map<?, ?> payload, String key, String fallback) {
        Object value = payload.get(key);
        return value == null ? fallback : String.valueOf(value);
    }

    private Instant parseExpiresAt(Object raw) {
        if (raw == null) return Instant.now().plus(5, ChronoUnit.MINUTES);
        try {
            return Instant.parse(String.valueOf(raw));
        } catch (Exception e) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID", "expiresAt is invalid", e);
        }
    }
}
