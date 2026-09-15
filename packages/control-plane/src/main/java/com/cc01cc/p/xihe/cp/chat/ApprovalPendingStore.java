package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Commits approval rows and their optional metadata in isolated transactions. */
@Component
public class ApprovalPendingStore {

    private static final Logger logger = LoggerFactory.getLogger(ApprovalPendingStore.class);

    private final ChatApprovalRepository approvalRepository;
    private final ObjectMapper objectMapper;
    private final ApprovalPolicySummary policySummary;

    public ApprovalPendingStore(ChatApprovalRepository approvalRepository, ObjectMapper objectMapper,
                                ApprovalPolicySummary policySummary) {
        this.approvalRepository = approvalRepository;
        this.objectMapper = objectMapper;
        this.policySummary = policySummary;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public ChatApproval save(ChatApproval approval) {
        return approvalRepository.save(approval);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public String capturePolicySummary(UUID requestId, String tool, String sessionId,
                                       String userId, String workspaceId) {
        Optional<Map<String, Object>> summary = policySummary.buildAtCreation(
                tool, sessionId, userId, workspaceId);
        if (summary.isEmpty()) {
            return null;
        }
        String serialized;
        try {
            serialized = objectMapper.writeValueAsString(summary.orElseThrow());
        } catch (Exception e) {
            logger.warn("[POLICY] approval_summary_serialize_failed failureType={}",
                    e.getClass().getName());
            return null;
        }
        int updated = approvalRepository.updatePolicySummary(requestId, serialized, Instant.now());
        if (updated != 1) {
            logger.warn("[POLICY] approval_summary_update_failed failureType=row_not_updated");
            return null;
        }
        return serialized;
    }
}
