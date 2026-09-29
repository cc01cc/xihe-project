package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.chat.ChatRunCancellationService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.SessionBranch;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

@Service
public class SessionBranchActionService {

    private final SessionService sessionService;
    private final SessionBranchRepository sessionBranchRepository;
    private final ChatRunRepository chatRunRepository;
    private final BranchPathService branchPathService;
    private final DbLockTimeout dbLockTimeout;

    public SessionBranchActionService(SessionService sessionService,
                                      SessionBranchRepository sessionBranchRepository,
                                      ChatRunRepository chatRunRepository,
                                      BranchPathService branchPathService,
                                      DbLockTimeout dbLockTimeout) {
        this.sessionService = sessionService;
        this.sessionBranchRepository = sessionBranchRepository;
        this.chatRunRepository = chatRunRepository;
        this.branchPathService = branchPathService;
        this.dbLockTimeout = dbLockTimeout;
    }

    @Transactional(readOnly = true)
    public BranchList list(String sessionId, String userId, String workspaceId) {
        String canonicalSessionId = parseSessionId(sessionId).toString();
        sessionService.requireCurrent(canonicalSessionId, userId, workspaceId);
        List<BranchView> items = sessionBranchRepository
                .findBySessionIdOrderByCreatedAtAscIdAsc(canonicalSessionId).stream()
                .map(SessionBranchActionService::toView)
                .toList();
        return new BranchList(canonicalSessionId, items);
    }

    @Transactional
    public BranchCreated create(String sessionId, String userId, String workspaceId,
                                String idempotencyKey, String sourceBranchId, String anchorMessageId) {
        String canonicalSessionId = parseSessionId(sessionId).toString();
        String canonicalSourceBranchId = parseUuid(
                sourceBranchId, "INVALID_REQUEST", "sourceBranchId must be a UUID").toString();
        String canonicalAnchorMessageId = parseUuid(
                anchorMessageId, "INVALID_REQUEST", "anchorMessageId must be a UUID").toString();
        String normalizedKey = normalizeIdempotencyKey(idempotencyKey);

        dbLockTimeout.apply();
        branchPathService.lockSessionRow(canonicalSessionId);
        sessionService.requireCurrent(canonicalSessionId, userId, workspaceId);

        String requestHash = requestHash(canonicalSourceBranchId, canonicalAnchorMessageId);
        SessionBranch existing = sessionBranchRepository
                .findBySessionIdAndIdempotencyKey(canonicalSessionId, normalizedKey)
                .orElse(null);
        if (existing != null) {
            if (!requestHash.equals(existing.getRequestHash())) {
                throw new CpApiException(HttpStatus.CONFLICT, "IDEMPOTENCY_KEY_CONFLICT",
                        "Idempotency-Key was already used for a different branch request");
            }
            return toCreated(existing);
        }

        if (chatRunRepository.existsBySessionIdAndStatusIn(
                canonicalSessionId, ChatRunCancellationService.NON_TERMINAL_STATUSES)) {
            throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_LOCK",
                    "Branch mutation is unavailable while a ChatRun is active");
        }

        BranchPathService.BranchVisibility visibility = branchPathService.resolveVisibility(
                canonicalSessionId, canonicalSourceBranchId);
        BranchPathService.AnchorResolution anchor = branchPathService.resolveAnchor(
                canonicalSessionId, workspaceId, canonicalAnchorMessageId);
        if (!visibility.isVisible(anchor.branchId(), anchor.cursor())) {
            throw new CpApiException(HttpStatus.CONFLICT, "BRANCH_ANCHOR_INVALID",
                    "The anchor message is not visible on the selected source branch path");
        }

        // V43 anchors each branch row to the branch that owns its anchor Message/Run.
        SessionBranch branch = new SessionBranch(UUID.randomUUID(), canonicalSessionId);
        branch.setParentBranchId(anchor.branchId());
        branch.setForkPointMessageId(anchor.messageId());
        branch.setForkPointRunId(anchor.runId());
        branch.setForkPointSequence(anchor.cursor());
        branch.setIdempotencyKey(normalizedKey);
        branch.setRequestHash(requestHash);
        return toCreated(sessionBranchRepository.saveAndFlush(branch));
    }

    private static String normalizeIdempotencyKey(String value) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "IDEMPOTENCY_KEY_REQUIRED",
                    "Idempotency-Key header is required");
        }
        String key = value.trim();
        if (key.length() > 128) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Idempotency-Key exceeds 128 characters");
        }
        return key;
    }

    private static UUID parseUuid(String value, String code, String detail) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, code, detail);
        }
    }

    private static UUID parseSessionId(String value) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
    }

    private static String requestHash(String sourceBranchId, String anchorMessageId) {
        try {
            String normalized = "branch-create-v1\n" + sourceBranchId + "\n" + anchorMessageId;
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(normalized.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("Unable to hash branch request", e);
        }
    }

    private static BranchView toView(SessionBranch branch) {
        return new BranchView(branch.getId().toString(), branch.getParentBranchId(),
                branch.getForkPointMessageId(), branch.getForkPointRunId(), branch.getCreatedAt());
    }

    private static BranchCreated toCreated(SessionBranch branch) {
        return new BranchCreated(branch.getId().toString(), branch.getParentBranchId(),
                branch.getForkPointMessageId());
    }

    public record BranchList(String sessionId, List<BranchView> items) {}

    public record BranchView(String branchId, String parentBranchId, String forkPointMessageId,
                             String forkPointRunId, Instant createdAt) {}

    public record BranchCreated(String branchId, String parentBranchId, String forkPointMessageId) {}
}
