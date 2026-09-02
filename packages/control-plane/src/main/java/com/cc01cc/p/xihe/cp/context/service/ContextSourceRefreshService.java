package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.entity.ContextSourceHash;
import com.cc01cc.p.xihe.cp.context.repository.ContextSourceHashRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
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
 * The source bytes are now fetched through Runtime (lazy materialization);
 * CP no longer reads the host filesystem directly.
 */
@Service
public class ContextSourceRefreshService {

    private static final Logger logger = LoggerFactory.getLogger(ContextSourceRefreshService.class);
    private static final String AGENTS_MD = "AGENTS.md";
    private static final String SOURCE_KEY = "AGENTS.md";

    private final ContextService contextService;
    private final ContextSourceHashRepository sourceHashRepository;
    private final RuntimeContextSourceClient runtimeContextSourceClient;

    public ContextSourceRefreshService(ContextService contextService,
                                       ContextSourceHashRepository sourceHashRepository,
                                       RuntimeContextSourceClient runtimeContextSourceClient) {
        this.contextService = contextService;
        this.sourceHashRepository = sourceHashRepository;
        this.runtimeContextSourceClient = runtimeContextSourceClient;
    }

    @Transactional
    public Optional<String> refresh(String sessionId, String workspaceId, String userId) {
        Optional<String> content;
        try {
            content = runtimeContextSourceClient.readAgents(workspaceId);
        } catch (Exception e) {
            logger.warn("Runtime source fetch failed for workspace {}: {}", workspaceId, e.getMessage());
            return Optional.empty();
        }
        if (content.isEmpty()) {
            return Optional.empty();
        }

        String text = content.get();
        if (text.isBlank()) {
            return Optional.empty();
        }
        String hash = sha256(text);
        Optional<ContextSourceHash> existing = sourceHashRepository
                .findByWorkspaceIdAndSourceKey(workspaceId, SOURCE_KEY);
        if (existing.isPresent() && hash.equals(existing.get().getHash())) {
            return Optional.of(hash);
        }

        contextService.appendEvent(sessionId, workspaceId, userId, "context.source_changed", Map.of(
                "source_key", SOURCE_KEY,
                "rendered_text", text,
                "baseline_hash", hash
        ));

        ContextSourceHash sourceHash = existing
                .orElseGet(() -> new ContextSourceHash(workspaceId, SOURCE_KEY, hash));
        sourceHash.setHash(hash);
        sourceHashRepository.save(sourceHash);
        return Optional.of(hash);
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
