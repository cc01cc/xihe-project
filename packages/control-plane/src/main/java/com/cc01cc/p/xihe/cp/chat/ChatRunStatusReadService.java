package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0470 (decision #18): the ChatRun-domain minimal-field read used by
 * authorization/judgment callers (grant principal path, tiered status query).
 * Deliberately a separate leaf from {@link ChatRunReadService} — that public-API
 * projection also injects ApprovalService, which would create an authorization
 * bean cycle. Only {@link ChatRunRepository} is injected here, and callers get a
 * bounded view, never a {@code ChatRun} entity.
 */
@Service
public class ChatRunStatusReadService {

    private final ChatRunRepository chatRuns;

    public ChatRunStatusReadService(ChatRunRepository chatRuns) {
        this.chatRuns = chatRuns;
    }

    /** Lease/status fields plus correlation ids needed by authorization chains. */
    public record ChatRunStatusView(
            UUID id,
            String status,
            String sessionId,
            String userId,
            String workspaceId,
            Instant createdAt,
            Instant updatedAt) {}

    @Transactional(readOnly = true)
    public Optional<ChatRunStatusView> findById(UUID id) {
        return chatRuns.findById(id).map(ChatRunStatusReadService::toView);
    }

    /** PLAN-0407 Tier-1 ordering: newest run first, id as the tie-breaker. */
    @Transactional(readOnly = true)
    public Optional<ChatRunStatusView> findLatestBySession(String sessionId) {
        return chatRuns.findFirstBySessionIdOrderByCreatedAtDescIdDesc(sessionId)
                .map(ChatRunStatusReadService::toView);
    }

    /** Re-export of the repository's in-flight lease statuses for judgment callers. */
    public static boolean isActiveLeaseStatus(String status) {
        return ChatRunRepository.ACTIVE_LEASE_STATUSES.contains(status);
    }

    private static ChatRunStatusView toView(com.cc01cc.p.xihe.cp.entity.ChatRun run) {
        return new ChatRunStatusView(
                run.getId(),
                run.getStatus(),
                run.getSessionId(),
                run.getUserId(),
                run.getWorkspaceId(),
                run.getCreatedAt(),
                run.getUpdatedAt());
    }
}
