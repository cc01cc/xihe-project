package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0470 (decision #18): the Session-domain minimal-field read used by
 * authorization/judgment callers (grant principal path, tiered query chain).
 * Leaf component — only {@link SessionRepository} is injected, so consumers in
 * policy/ never reach back through the application-service graph. It returns a
 * bounded view, never a {@code Session} entity.
 */
@Service
public class SessionReadService {

    private final SessionRepository sessionRepository;

    public SessionReadService(SessionRepository sessionRepository) {
        this.sessionRepository = sessionRepository;
    }

    /** Fields needed to validate provenance chains and evaluate session caps. */
    public record SessionPathView(
            UUID id,
            String userId,
            String workspaceId,
            String agentPrincipalId,
            UUID spawnedFromSessionId,
            UUID spawnedFromRunId,
            Instant spawnedAt,
            String kind,
            JsonNode agentPermissionsSnapshot) {}

    @Transactional(readOnly = true)
    public Optional<SessionPathView> findById(UUID id) {
        return sessionRepository.findById(id).map(session -> new SessionPathView(
                session.getId(),
                session.getUserId(),
                session.getWorkspaceId(),
                session.getAgentPrincipalId(),
                session.getSpawnedFromSessionId(),
                session.getSpawnedFromRunId(),
                session.getSpawnedAt(),
                session.getKind(),
                session.getAgentPermissionsSnapshot()));
    }

    /**
     * PLAN-0470 #24/D1a: the minimal routing fields the LLM summary hop needs
     * (provider connection, revision and model routing); never the Session
     * entity.
     */
    public record SummaryRoutingView(
            String providerConnectionId,
            Long connectionRevision,
            String modelProvider,
            String modelName) {}

    @Transactional(readOnly = true)
    public Optional<SummaryRoutingView> findSummaryRouting(UUID id) {
        return sessionRepository.findById(id).map(session -> new SummaryRoutingView(
                session.getProviderConnectionId(),
                session.getConnectionRevision(),
                session.getModelProvider(),
                session.getModelName()));
    }
}
