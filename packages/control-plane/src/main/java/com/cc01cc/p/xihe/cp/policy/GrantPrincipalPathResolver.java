package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/** Resolves stable principal identities for one tool-call authorization snapshot. */
@Component
public class GrantPrincipalPathResolver {

    public static final String USER = "user";
    public static final String AGENT_PRINCIPAL = "agent_principal";

    private final SessionRepository sessionRepository;
    private final ChatRunRepository chatRunRepository;
    private final McpInvocationRepository mcpInvocationRepository;

    public GrantPrincipalPathResolver(SessionRepository sessionRepository,
                                      ChatRunRepository chatRunRepository,
                                      McpInvocationRepository mcpInvocationRepository) {
        this.sessionRepository = sessionRepository;
        this.chatRunRepository = chatRunRepository;
        this.mcpInvocationRepository = mcpInvocationRepository;
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

    /**
     * PLAN-0463 T1.3 → PLAN-0464 T2.2 (sole path): validate one Agent tool call
     * against the MCP execution domain — {@code ChatRun lease + invocation
     * active + scope}. Empty means no invocation row governs this
     * {@code (runId, toolCallId)} yet and the caller fails closed; when an
     * invocation <em>does</em> exist its verdict is final.
     */
    @Transactional(readOnly = true, isolation = Isolation.READ_COMMITTED, propagation = Propagation.REQUIRES_NEW)
    public Optional<Boolean> validateAgentInvocationContext(String userId, String workspaceId,
                                                            String sessionId, String runId,
                                                            String toolCallId, String toolName) {
        UUID runUuid = parseOptionalUuid(runId);
        UUID toolCallUuid = parseOptionalUuid(toolCallId);
        if (runUuid == null || toolCallUuid == null) {
            return Optional.empty();
        }
        McpInvocation invocation = mcpInvocationRepository
                .findByRunIdAndToolCallIdAndSource(runUuid.toString(), toolCallUuid.toString(),
                        McpInvocation.SOURCE_AGENT)
                .orElse(null);
        if (invocation == null) {
            return Optional.empty();
        }

        UUID userUuid = parseUuid(userId);
        UUID workspaceUuid = parseUuid(workspaceId);
        UUID sessionUuid = parseUuid(sessionId);

        ChatRun run = chatRunRepository.findById(runUuid)
                .orElseThrow(GrantPrincipalPathResolver::invalidPath);
        if (!ChatRunRepository.ACTIVE_LEASE_STATUSES.contains(run.getStatus())
                || !sessionUuid.equals(parseUuid(run.getSessionId()))
                || !userUuid.equals(parseUuid(run.getUserId()))
                || !workspaceUuid.equals(parseUuid(run.getWorkspaceId()))) {
            throw invalidPath();
        }
        if (!McpInvocation.STATUS_ACTIVE.equals(invocation.getStatus())
                || !sessionUuid.equals(parseUuid(invocation.getSessionId()))
                || !userUuid.equals(parseUuid(invocation.getUserId()))
                || !workspaceUuid.equals(parseUuid(invocation.getWorkspaceId()))
                || !runUuid.equals(parseUuid(invocation.getRunId()))
                || (toolName != null && !toolName.equals(invocation.getToolName()))) {
            throw invalidPath();
        }

        resolveAgent(userId, workspaceId, sessionId);
        return Optional.of(Boolean.TRUE);
    }

    private static UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (RuntimeException e) {
            throw invalidPath();
        }
    }

    /** Absent/unparsable correlation key ⇒ {@code null} (no invocation context). */
    private static UUID parseOptionalUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static IllegalArgumentException invalidPath() {
        return new IllegalArgumentException("Session principal path is invalid");
    }

    public record AgentPath(UUID principalId, List<Session> sessionPath) {}
}
