package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.credentials.CredentialEnvelope;
import com.cc01cc.p.xihe.cp.entity.Credential;
import com.cc01cc.p.xihe.cp.entity.CredentialEvent;
import com.cc01cc.p.xihe.cp.repository.CredentialEventRepository;
import com.cc01cc.p.xihe.cp.repository.CredentialRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PLAN-0497 T3.1 (contract: 0497 design §方案 3, decisions #3/#7/#10, I3/I5/I6):
 * the human reveal channel — user-only {@code credential_reveal} intersection
 * ({@link GrantAuthorizationService#allowsUserOnly}), step-up re-verification of
 * the login password with an in-process failure throttle (5 failures / 15
 * minutes per user, EW parity), reveal-tier gate, decrypt under the credential
 * AAD and a value-free audit trail ({@code credential_revealed} +
 * credential_events.revealed). Failed step-up attempts leave the
 * {@code credential_reveal_failed} audit stream record only — no credential
 * event row, no pending approval (v1 wires no ask).
 */
@Service
public class CredentialRevealService {

    static final int MAX_STEP_UP_FAILURES = 5;
    static final Duration STEP_UP_FAILURE_WINDOW = Duration.ofMinutes(15);

    private final CredentialRepository credentialRepository;
    private final CredentialEventRepository credentialEventRepository;
    private final CredentialEnvelope credentialEnvelope;
    private final GrantAuthorizationService grantAuthorizationService;
    private final AuthService authService;
    private final AuditLogger auditLogger;
    private final Map<UUID, Deque<Instant>> stepUpFailures = new ConcurrentHashMap<>();

    public CredentialRevealService(CredentialRepository credentialRepository,
            CredentialEventRepository credentialEventRepository,
            CredentialEnvelope credentialEnvelope,
            GrantAuthorizationService grantAuthorizationService,
            AuthService authService,
            AuditLogger auditLogger) {
        this.credentialRepository = credentialRepository;
        this.credentialEventRepository = credentialEventRepository;
        this.credentialEnvelope = credentialEnvelope;
        this.grantAuthorizationService = grantAuthorizationService;
        this.authService = authService;
        this.auditLogger = auditLogger;
    }

    public record RevealedCredential(String credentialId, int revision, String plaintext) {}

    /**
     * Authorization ({@code credential_reveal@credential:&lt;id&gt;} on the user
     * path) fails closed before the credential is even loaded; the tier gate
     * keeps the delivery channels disjoint (decision #7). The method is not
     * transactional on purpose: a failed step-up must keep its audit record
     * after the exception rolls the request back.
     */
    public RevealedCredential reveal(String actorUserId, UUID credentialId, String workspaceId,
            String password) {
        UUID actorId = requireActor(actorUserId);
        requireRevealGrant(actorId, credentialId, workspaceId);
        Credential credential = requireCredential(credentialId);
        if (!Credential.STATUS_ACTIVE.equals(credential.getStatus())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "CREDENTIAL_DISABLED",
                    "Only active credentials can be revealed");
        }
        if (!Credential.TIER_REVEAL.equals(credential.getDeliveryTier())) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "CREDENTIAL_TIER_MISMATCH",
                    "reveal only serves the reveal delivery tier (decision #7)");
        }
        requireStepUp(actorId, credential, password);
        String plaintext = credentialEnvelope.decrypt(credential);
        recordRevealed(credential, actorId);
        return new RevealedCredential(credential.getId().toString(), credential.getRevision(), plaintext);
    }

    private void requireRevealGrant(UUID actorId, UUID credentialId, String workspaceId) {
        // Wave review: a missing workspace claim must fail closed (403) instead of
        // reaching the workspace-membership check with a null id.
        if (workspaceId == null || workspaceId.isBlank()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "credential_reveal requires a workspace context");
        }
        PolicyRequest request = new PolicyRequest("credential_reveal",
                List.of(ToolFaceRegistry.ACTION_CREDENTIAL_REVEAL),
                List.of("credential:" + credentialId), ToolShape.OPAQUE, actorId.toString(),
                workspaceId, null);
        if (!grantAuthorizationService.allowsUserOnly(request)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "credential_reveal@credential:" + credentialId + " is required");
        }
    }

    private void requireStepUp(UUID actorId, Credential credential, String password) {
        Instant now = Instant.now();
        Deque<Instant> failures = stepUpFailures.computeIfAbsent(actorId, key -> new ArrayDeque<>());
        synchronized (failures) {
            prune(failures, now);
            if (failures.size() >= MAX_STEP_UP_FAILURES) {
                throw new CpApiException(HttpStatus.TOO_MANY_REQUESTS, "CREDENTIAL_REVEAL_RATE_LIMITED",
                        "Too many failed step-up attempts; retry within the 15 minute window");
            }
        }
        if (authService.verifyPassword(actorId, password)) {
            synchronized (failures) {
                failures.clear();
            }
            return;
        }
        synchronized (failures) {
            prune(failures, now);
            failures.addLast(now);
        }
        recordFailure(credential, actorId);
        throw new CpApiException(HttpStatus.UNAUTHORIZED, "CREDENTIAL_REVEAL_STEP_UP_FAILED",
                "Password verification failed");
    }

    private void recordRevealed(Credential credential, UUID actorId) {
        CredentialEvent event = new CredentialEvent();
        event.setId(UUID.randomUUID());
        event.setCredentialId(credential.getId().toString());
        event.setEventType(CredentialEvent.TYPE_REVEALED);
        event.setActor(userActor(actorId));
        event.setOwnerType(credential.getOwnerType());
        event.setOwnerId(credential.getOwnerId());
        credentialEventRepository.save(event);
        recordAudit(credential, userActor(actorId), "credential_revealed");
    }

    private void recordFailure(Credential credential, UUID actorId) {
        recordAudit(credential, userActor(actorId), "credential_reveal_failed");
    }

    private void recordAudit(Credential credential, String actor, String action) {
        auditLogger.recordCredentialEvent(actor, action, credential.getId().toString(),
                credential.getOwnerType(), credential.getOwnerId(), credential.getKind(),
                credential.getDeliveryTier(), credential.getFingerprint());
    }

    private static void prune(Deque<Instant> failures, Instant now) {
        Instant cutoff = now.minus(STEP_UP_FAILURE_WINDOW);
        while (!failures.isEmpty() && failures.peekFirst().isBefore(cutoff)) {
            failures.removeFirst();
        }
    }

    private Credential requireCredential(UUID credentialId) {
        return credentialRepository.findByIdAndDeletedAtIsNull(credentialId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "CREDENTIAL_NOT_FOUND",
                        "Credential not found"));
    }

    private UUID requireActor(String actorUserId) {
        if (actorUserId == null || actorUserId.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
        }
        UUID actorId;
        try {
            actorId = UUID.fromString(actorUserId);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ACTOR", "A valid UUID is required", e);
        }
        if (!authService.userExists(actorId)) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found");
        }
        return actorId;
    }

    private static String userActor(UUID actorId) {
        return "user:" + actorId;
    }
}
