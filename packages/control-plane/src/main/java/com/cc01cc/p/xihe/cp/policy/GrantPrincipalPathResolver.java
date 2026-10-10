package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.chat.ChatRunStatusReadService;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.service.SessionReadService;
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

    // PLAN-0470 (decision #18): authorization reads go through the Session/Chat/MCP
    // owner read services (bounded views) — no cross-domain repositories here.
    private final SessionReadService sessionReadService;
    private final ChatRunStatusReadService chatRunStatusReadService;
    private final McpInvocationService mcpInvocationService;

    public GrantPrincipalPathResolver(SessionReadService sessionReadService,
                                      ChatRunStatusReadService chatRunStatusReadService,
                                      McpInvocationService mcpInvocationService) {
        this.sessionReadService = sessionReadService;
        this.chatRunStatusReadService = chatRunStatusReadService;
        this.mcpInvocationService = mcpInvocationService;
    }

    public AgentPath resolveAgent(String userId, String workspaceId, String sessionId) {
        UUID userUuid = parseUuid(userId);
        UUID workspaceUuid = parseUuid(workspaceId);
        SessionReadService.SessionPathView current = sessionReadService.findById(parseUuid(sessionId))
                .orElseThrow(GrantPrincipalPathResolver::invalidPath);
        UUID agentPrincipalId = parseUuid(current.agentPrincipalId());
        List<SessionReadService.SessionPathView> reverseSessionPath = new ArrayList<>();
        Set<UUID> visited = new HashSet<>();

        while (true) {
            UUID currentId = current.id();
            if (!userUuid.equals(parseUuid(current.userId()))
                    || !workspaceUuid.equals(parseUuid(current.workspaceId()))
                    || !agentPrincipalId.equals(parseUuid(current.agentPrincipalId()))
                    || !visited.add(currentId)) {
                throw invalidPath();
            }
            reverseSessionPath.add(current);

            UUID parentSessionId = current.spawnedFromSessionId();
            UUID parentRunId = current.spawnedFromRunId();
            boolean hasParent = parentSessionId != null || parentRunId != null || current.spawnedAt() != null;
            String kind = current.kind();

            if (kind == null) {
                if (hasParent) {
                    throw invalidPath();
                }
                break;
            }
            if (!hasParent || parentSessionId == null || parentRunId == null || current.spawnedAt() == null) {
                throw invalidPath();
            }
            if (!Session.KIND_FORK.equals(kind) && !Session.KIND_SPAWN.equals(kind)) {
                throw invalidPath();
            }

            if (Session.KIND_FORK.equals(kind)) {
                // Fork is a new permission root. Validate live lineage when both
                // source rows remain, but source deletion must not invalidate the child.
                SessionReadService.SessionPathView parent = sessionReadService.findById(parentSessionId).orElse(null);
                ChatRunStatusReadService.ChatRunStatusView parentRun = chatRunStatusReadService.findById(parentRunId).orElse(null);
                if ((parent == null) != (parentRun == null)) {
                    throw invalidPath();
                }
                if (parent != null && (!parentSessionId.toString().equals(parentRun.sessionId())
                        || !userId.equals(parentRun.userId())
                        || !workspaceId.equals(parentRun.workspaceId())
                        || !userUuid.equals(parseUuid(parent.userId()))
                        || !workspaceUuid.equals(parseUuid(parent.workspaceId()))
                        || !agentPrincipalId.equals(parseUuid(parent.agentPrincipalId())))) {
                    throw invalidPath();
                }
                break;
            }

            SessionReadService.SessionPathView parent = sessionReadService.findById(parentSessionId)
                    .orElseThrow(GrantPrincipalPathResolver::invalidPath);
            ChatRunStatusReadService.ChatRunStatusView parentRun = chatRunStatusReadService.findById(parentRunId)
                    .orElseThrow(GrantPrincipalPathResolver::invalidPath);
            if (!parentSessionId.toString().equals(parentRun.sessionId())
                    || !userId.equals(parentRun.userId())
                    || !workspaceId.equals(parentRun.workspaceId())
                    || !userUuid.equals(parseUuid(parent.userId()))
                    || !workspaceUuid.equals(parseUuid(parent.workspaceId()))
                    || !agentPrincipalId.equals(parseUuid(parent.agentPrincipalId()))) {
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
        McpInvocationService.InvocationContextView invocation = mcpInvocationService
                .findAgentInvocationContext(runUuid.toString(), toolCallUuid.toString())
                .orElse(null);
        if (invocation == null) {
            return Optional.empty();
        }

        UUID userUuid = parseUuid(userId);
        UUID workspaceUuid = parseUuid(workspaceId);
        UUID sessionUuid = parseUuid(sessionId);

        ChatRunStatusReadService.ChatRunStatusView run = chatRunStatusReadService.findById(runUuid)
                .orElseThrow(GrantPrincipalPathResolver::invalidPath);
        if (!ChatRunStatusReadService.isActiveLeaseStatus(run.status())
                || !sessionUuid.equals(parseUuid(run.sessionId()))
                || !userUuid.equals(parseUuid(run.userId()))
                || !workspaceUuid.equals(parseUuid(run.workspaceId()))) {
            throw invalidPath();
        }
        if (!McpInvocation.STATUS_ACTIVE.equals(invocation.status())
                || !sessionUuid.equals(parseUuid(invocation.sessionId()))
                || !userUuid.equals(parseUuid(invocation.userId()))
                || !workspaceUuid.equals(parseUuid(invocation.workspaceId()))
                || !runUuid.equals(parseUuid(invocation.runId()))
                || (toolName != null && !toolName.equals(invocation.toolName()))) {
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

    public record AgentPath(UUID principalId, List<SessionReadService.SessionPathView> sessionPath) {}
}
