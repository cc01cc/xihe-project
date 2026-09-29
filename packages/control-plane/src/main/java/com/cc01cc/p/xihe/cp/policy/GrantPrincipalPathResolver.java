package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.LedgerOperation;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.stereotype.Component;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.locks.LockSupport;

/** Resolves stable principal identities for one tool-call authorization snapshot. */
@Component
public class GrantPrincipalPathResolver {

    public static final String USER = "user";
    public static final String AGENT_PRINCIPAL = "agent_principal";
    private static final Duration TOOL_CALL_ITEM_WAIT_LIMIT = Duration.ofSeconds(1);
    private static final Duration TOOL_CALL_ITEM_POLL_INTERVAL = Duration.ofMillis(20);

    private final SessionRepository sessionRepository;
    private final ChatRunRepository chatRunRepository;
    private final LedgerOperationRepository operationRepository;
    private final OperationItemRepository operationItemRepository;
    private final DbLockTimeout dbLockTimeout;

    public GrantPrincipalPathResolver(SessionRepository sessionRepository,
                                      ChatRunRepository chatRunRepository,
                                      LedgerOperationRepository operationRepository,
                                      OperationItemRepository operationItemRepository,
                                      DbLockTimeout dbLockTimeout) {
        this.sessionRepository = sessionRepository;
        this.chatRunRepository = chatRunRepository;
        this.operationRepository = operationRepository;
        this.operationItemRepository = operationItemRepository;
        this.dbLockTimeout = dbLockTimeout;
    }

    public AgentPath resolveAgent(String userId, String workspaceId, String sessionId) {
        UUID userUuid = parseUuid(userId);
        UUID workspaceUuid = parseUuid(workspaceId);
        Session current = sessionRepository.findById(parseUuid(sessionId))
                .orElseThrow(GrantPrincipalPathResolver::invalidPath);
        UUID agentPrincipalId = parseUuid(current.getAgentPrincipalId());
        List<Session> reverseSessionPath = new ArrayList<>();
        Set<UUID> visited = new HashSet<>();

        while (true) {
            UUID currentId = current.getId();
            if (!userUuid.equals(parseUuid(current.getUserId()))
                    || !workspaceUuid.equals(parseUuid(current.getWorkspaceId()))
                    || !agentPrincipalId.equals(parseUuid(current.getAgentPrincipalId()))
                    || !visited.add(currentId)) {
                throw invalidPath();
            }
            reverseSessionPath.add(current);

            UUID parentSessionId = current.getSpawnedFromSessionId();
            UUID parentRunId = current.getSpawnedFromRunId();
            boolean hasParent = parentSessionId != null || parentRunId != null || current.getSpawnedAt() != null;
            String kind = current.getKind();

            if (kind == null) {
                if (hasParent) {
                    throw invalidPath();
                }
                break;
            }
            if (!hasParent || parentSessionId == null || parentRunId == null || current.getSpawnedAt() == null) {
                throw invalidPath();
            }
            if (!Session.KIND_FORK.equals(kind) && !Session.KIND_SPAWN.equals(kind)) {
                throw invalidPath();
            }

            if (Session.KIND_FORK.equals(kind)) {
                // Fork is a new permission root. Validate live lineage when both
                // source rows remain, but source deletion must not invalidate the child.
                Session parent = sessionRepository.findById(parentSessionId).orElse(null);
                ChatRun parentRun = chatRunRepository.findById(parentRunId).orElse(null);
                if ((parent == null) != (parentRun == null)) {
                    throw invalidPath();
                }
                if (parent != null && (!parentSessionId.toString().equals(parentRun.getSessionId())
                        || !userId.equals(parentRun.getUserId())
                        || !workspaceId.equals(parentRun.getWorkspaceId())
                        || !userUuid.equals(parseUuid(parent.getUserId()))
                        || !workspaceUuid.equals(parseUuid(parent.getWorkspaceId()))
                        || !agentPrincipalId.equals(parseUuid(parent.getAgentPrincipalId())))) {
                    throw invalidPath();
                }
                break;
            }

            Session parent = sessionRepository.findById(parentSessionId)
                    .orElseThrow(GrantPrincipalPathResolver::invalidPath);
            ChatRun parentRun = chatRunRepository.findById(parentRunId)
                    .orElseThrow(GrantPrincipalPathResolver::invalidPath);
            if (!parentSessionId.toString().equals(parentRun.getSessionId())
                    || !userId.equals(parentRun.getUserId())
                    || !workspaceId.equals(parentRun.getWorkspaceId())
                    || !userUuid.equals(parseUuid(parent.getUserId()))
                    || !workspaceUuid.equals(parseUuid(parent.getWorkspaceId()))
                    || !agentPrincipalId.equals(parseUuid(parent.getAgentPrincipalId()))) {
                throw invalidPath();
            }
            current = parent;
        }

        Collections.reverse(reverseSessionPath);
        return new AgentPath(agentPrincipalId, List.copyOf(reverseSessionPath));
    }

    /** Revalidates the existing Agent correlation keys against the current durable tool call. */
    @Transactional(readOnly = true, isolation = Isolation.READ_COMMITTED, propagation = Propagation.REQUIRES_NEW)
    public void validateAgentToolCallContext(String userId, String workspaceId, String sessionId,
                                             String runId, String operationId, String toolCallId,
                                             String toolName) {
        UUID userUuid = parseUuid(userId);
        UUID workspaceUuid = parseUuid(workspaceId);
        UUID sessionUuid = parseUuid(sessionId);
        UUID runUuid = parseUuid(runId);
        UUID operationUuid = parseUuid(operationId);
        UUID toolCallUuid = parseUuid(toolCallId);

        ChatRun run = chatRunRepository.findById(runUuid)
                .orElseThrow(GrantPrincipalPathResolver::invalidPath);
        if (!ChatRunRepository.ACTIVE_LEASE_STATUSES.contains(run.getStatus())
                || !sessionUuid.equals(parseUuid(run.getSessionId()))
                || !userUuid.equals(parseUuid(run.getUserId()))
                || !workspaceUuid.equals(parseUuid(run.getWorkspaceId()))) {
            throw invalidPath();
        }

        LedgerOperation operation = operationRepository.findById(operationUuid)
                .orElseThrow(GrantPrincipalPathResolver::invalidPath);
        if (!runUuid.equals(parseUuid(operation.getRunId()))
                || !sessionUuid.equals(parseUuid(operation.getSessionId()))
                || !userUuid.equals(parseUuid(operation.getUserId()))
                || !workspaceUuid.equals(parseUuid(operation.getWorkspaceId()))
                || operation.getFinishedAt() != null) {
            throw invalidPath();
        }

        OperationItem item = findAgentToolCallItem(operationUuid, toolCallUuid);
        if (!"tool_call".equals(item.getKind())
                || !toolName.equals(item.getToolName())
                || item.getFinishedAt() != null
                || !Set.of("pending", "running", "waiting_for_approval", "resolving")
                        .contains(item.getStatus())) {
            throw invalidPath();
        }

        resolveAgent(userId, workspaceId, sessionId);
    }

    private OperationItem findAgentToolCallItem(UUID operationId, UUID toolCallId) {
        long deadline = System.nanoTime() + TOOL_CALL_ITEM_WAIT_LIMIT.toNanos();
        while (true) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0 || Thread.currentThread().isInterrupted()) {
                throw invalidToolCallDeadline();
            }
            long queryTimeoutMs = Math.max(1, (remaining + 999_999L) / 1_000_000L);
            Optional<OperationItem> item;
            try {
                dbLockTimeout.applyBounded(queryTimeoutMs);
                item = operationItemRepository.findByOperationIdAndSourceAndToolCallId(
                        operationId.toString(), "agent", toolCallId.toString());
            } catch (PessimisticLockingFailureException | QueryTimeoutException e) {
                throw invalidToolCallDeadline();
            }
            if (System.nanoTime() >= deadline || Thread.currentThread().isInterrupted()) {
                throw invalidToolCallDeadline();
            }
            if (item.isPresent()) {
                return item.get();
            }
            remaining = deadline - System.nanoTime();
            if (remaining <= 0) {
                throw invalidToolCallDeadline();
            }
            LockSupport.parkNanos(Math.min(TOOL_CALL_ITEM_POLL_INTERVAL.toNanos(), remaining));
        }
    }

    private static IllegalArgumentException invalidToolCallDeadline() {
        return new IllegalArgumentException("Agent ToolCall was not persisted before the bounded CP deadline");
    }

    private static UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException e) {
            throw invalidPath();
        }
    }

    private static IllegalArgumentException invalidPath() {
        return new IllegalArgumentException("Session principal path is invalid");
    }

    public record AgentPath(UUID principalId, List<Session> sessionPath) {}
}
