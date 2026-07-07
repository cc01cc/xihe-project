package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextSourceHash;
import com.cc01cc.p.xihe.cp.context.repository.ContextSourceHashRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Map;
import java.util.Optional;

/**
 * Refreshes context sources (e.g. AGENTS.md) for a session and emits
 * {@code context.source_changed} events when the source content has changed.
 *
 * <p>This implementation persists the last observed hash per workspace/source
 * to avoid emitting duplicate events when the source has not actually changed.
 */
@Service
public class ContextSourceRefreshService {

    private static final Logger logger = LoggerFactory.getLogger(ContextSourceRefreshService.class);
    private static final String AGENTS_MD = "AGENTS.md";
    private static final String SOURCE_KEY = "AGENTS.md";

    private final ContextService contextService;
    private final WorkspaceService workspaceService;
    private final ContextSourceHashRepository sourceHashRepository;

    public ContextSourceRefreshService(ContextService contextService,
                                       WorkspaceService workspaceService,
                                       ContextSourceHashRepository sourceHashRepository) {
        this.contextService = contextService;
        this.workspaceService = workspaceService;
        this.sourceHashRepository = sourceHashRepository;
    }

    @Transactional
    public Optional<String> refresh(String sessionId, String workspaceId, String userId) {
        String storagePath = workspaceService.resolveStoragePath(workspaceId);
        if (storagePath == null || storagePath.isBlank()) {
            logger.debug("No storage path for workspace {}, skipping source refresh", workspaceId);
            return Optional.empty();
        }

        Path agentsPath = Path.of(storagePath, AGENTS_MD);
        if (!Files.exists(agentsPath)) {
            logger.debug("AGENTS.md not found at {}, skipping source refresh", agentsPath);
            return Optional.empty();
        }

        try {
            String content = Files.readString(agentsPath, StandardCharsets.UTF_8);
            if (content.isBlank()) {
                logger.debug("AGENTS.md is blank at {}, skipping source refresh", agentsPath);
                return Optional.empty();
            }
            String hash = sha256(content);
            Optional<ContextSourceHash> existing = sourceHashRepository
                    .findByWorkspaceIdAndSourceKey(workspaceId, SOURCE_KEY);
            if (existing.isPresent() && hash.equals(existing.get().getHash())) {
                logger.debug("AGENTS.md hash unchanged for workspace {}, skipping source refresh", workspaceId);
                return Optional.of(hash);
            }

            contextService.appendEvent(sessionId, workspaceId, userId, "context.source_changed", Map.of(
                    "source_key", SOURCE_KEY,
                    "rendered_text", content,
                    "baseline_hash", hash
            ));

            ContextSourceHash sourceHash = existing
                    .orElseGet(() -> new ContextSourceHash(workspaceId, SOURCE_KEY, hash));
            sourceHash.setHash(hash);
            sourceHashRepository.save(sourceHash);
            return Optional.of(hash);
        } catch (Exception e) {
            logger.error("Failed to refresh AGENTS.md for session {} workspace {}", sessionId, workspaceId, e);
            return Optional.empty();
        }
    }

    private String sha256(String content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] encoded = digest.digest(content.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(encoded);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }
}
