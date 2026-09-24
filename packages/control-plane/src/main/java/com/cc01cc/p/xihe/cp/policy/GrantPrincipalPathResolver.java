package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Resolves stable principal identities for one tool-call authorization snapshot. */
@Component
public class GrantPrincipalPathResolver {

    public static final String USER = "user";
    public static final String AGENT_PRINCIPAL = "agent_principal";

    private final SessionRepository sessionRepository;
    private final ChatRunRepository chatRunRepository;

    public GrantPrincipalPathResolver(SessionRepository sessionRepository,
                                      ChatRunRepository chatRunRepository) {
        this.sessionRepository = sessionRepository;
        this.chatRunRepository = chatRunRepository;
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
            if (Session.KIND_FORK.equals(kind)) {
                break;
            }
            current = parent;
        }

        Collections.reverse(reverseSessionPath);
        return new AgentPath(agentPrincipalId, List.copyOf(reverseSessionPath));
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
