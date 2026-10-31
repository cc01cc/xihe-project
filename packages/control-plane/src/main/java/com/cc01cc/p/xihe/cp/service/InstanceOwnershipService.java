package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.LocalModeService;
import com.cc01cc.p.xihe.cp.auth.LoginAttemptService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.InstanceOwner;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * PLAN-0580: the instance-ownership decision point (spec
 * {@code api-instance-ownership-contract.md} §3/§4/§8/§9).
 *
 * <p>Ownership is a single-row pointer ({@code instance_owner.id = 1}) that only
 * this service moves. Invariants: the owner is always an ADMIN (I1), the owner
 * cannot be demoted (I3), a transfer is initiated by the current owner only and
 * is re-authenticated by password (I5), and every instance-level write takes the
 * singleton row lock first (I2 / lock order {@code instance_owner → users}).
 */
@Service
public class InstanceOwnershipService {

    private static final Logger logger = LoggerFactory.getLogger(InstanceOwnershipService.class);
    private static final String RESOURCE_TYPE = "instance_owner";

    /** Immutable view of the current owner; {@code null} fields mean "no owner yet". */
    public record OwnerState(UUID ownerUserId, Instant assignedAt) {

        public boolean belongsTo(String userId) {
            return ownerUserId != null && userId != null && ownerUserId.toString().equals(userId);
        }
    }

    private final InstanceOwnerRepository owners;
    private final UserRepository users;
    private final AuditLogger audit;
    private final DbLockTimeout dbLockTimeout;
    private final AuthService authService;
    private final LocalModeService localModeService;
    private final LoginAttemptService loginAttemptService;

    public InstanceOwnershipService(InstanceOwnerRepository owners,
                                    UserRepository users,
                                    AuditLogger audit,
                                    DbLockTimeout dbLockTimeout,
                                    AuthService authService,
                                    LocalModeService localModeService,
                                    LoginAttemptService loginAttemptService) {
        this.owners = owners;
        this.users = users;
        this.audit = audit;
        this.dbLockTimeout = dbLockTimeout;
        this.authService = authService;
        this.localModeService = localModeService;
        this.loginAttemptService = loginAttemptService;
    }

    /** Read the pointer without locking (GET /instance/owner is a plain read). */
    @Transactional(readOnly = true)
    public OwnerState current() {
        return owners.findById(InstanceOwner.SINGLETON_ID)
                .map(owner -> new OwnerState(owner.getOwnerUserId(), owner.getAssignedAt()))
                .orElseGet(() -> new OwnerState(null, null));
    }

    /** True when {@code userId} is the current instance owner (ADMIN-only paths still read this). */
    @Transactional(readOnly = true)
    public boolean isCurrentOwner(String userId) {
        return current().belongsTo(userId);
    }

    /**
     * PUT /api/v1/instance/owner (contract §4): the current owner hands the
     * pointer to another ADMIN after re-authenticating with their password.
     *
     * <p>Order is frozen: instance lock → caller-is-owner → target exists and is
     * ADMIN → password step-up → single-row UPDATE → durable audit. The previous
     * owner stays ADMIN (only the pointer moves). A wrong password counts as a
     * 0558 credential failure and changes neither the owner nor the audit trail.
     */
    @Transactional
    public OwnerState transfer(String actorUserId, UUID targetUserId, String rawPassword, String clientIp) {
        if (localModeService.enabled()) {
            // PLAN-0526 single-user invariant: there is no second account to hand
            // ownership to, so the endpoint answers with a stable 409 instead of
            // pretending the action does not exist (contract §7 / decision #10).
            throw new CpApiException(HttpStatus.CONFLICT, "LOCAL_SINGLE_USER_MODE",
                    "Instance ownership cannot be transferred in local single-user mode");
        }
        dbLockTimeout.apply();
        InstanceOwner owner = lockSingleton();
        OwnerState state = new OwnerState(owner.getOwnerUserId(), owner.getAssignedAt());
        if (state.ownerUserId() == null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "NOT_INSTANCE_OWNER",
                    "Only the current instance owner can transfer ownership");
        }
        if (!state.belongsTo(actorUserId)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "NOT_INSTANCE_OWNER",
                    "Only the current instance owner can transfer ownership");
        }

        User target = users.findById(targetUserId).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
        if (target.getRole() != UserRole.ADMIN) {
            throw new CpApiException(HttpStatus.CONFLICT, "OWNER_TARGET_NOT_ADMIN",
                    "The instance owner must be an ADMIN");
        }

        reauthenticateOwner(actorUserId, rawPassword, clientIp);

        UUID previousOwner = owner.getOwnerUserId();
        owner.assignTo(target.getId(), UUID.fromString(actorUserId));
        owners.save(owner);
        audit.recordDurableChange(actorUserId, null, "instance_owner_transferred", RESOURCE_TYPE,
                target.getId().toString(),
                "from=" + previousOwner + " to=" + target.getId());
        logger.info("[LIFECYCLE] service=cp event=instance_owner_transferred from={} to={}",
                previousOwner, target.getId());
        return new OwnerState(owner.getOwnerUserId(), owner.getAssignedAt());
    }

    /**
     * Bootstrap assignment (decision #10, spec §3 "无 ADMIN/空库"): the seeder and
     * the local-mode registration path make sure a fresh instance has an owner.
     * Idempotent: an existing pointer is never overwritten, so a manual transfer
     * survives restarts.
     */
    @Transactional
    public void ensureAssigned(User user, String actorUserId) {
        if (user == null || user.getId() == null) {
            throw new IllegalArgumentException("A persisted user is required to assign the instance owner");
        }
        dbLockTimeout.apply();
        InstanceOwner owner = lockSingleton();
        if (owner.getOwnerUserId() != null) {
            return;
        }
        owner.assignTo(user.getId(), null);
        owners.save(owner);
        audit.recordDurableChange(actorUserId, null, "instance_owner_assigned", RESOURCE_TYPE,
                user.getId().toString(), "reason=bootstrap");
        logger.info("[LIFECYCLE] service=cp event=instance_owner_assigned owner={} reason=bootstrap",
                user.getId());
    }

    /**
     * The singleton row always exists on PostgreSQL (V85 inserts it). A missing
     * row can only happen on the H2 profile, which builds the schema from the
     * entities and never runs Flyway; there the instance-level mutex degrades to
     * "no row to lock" and the caller proceeds in its own transaction — H2 is
     * explicitly not schema-gate evidence (spec §10).
     */
    private InstanceOwner lockSingleton() {
        Optional<InstanceOwner> locked = owners.lockSingleton();
        if (locked.isPresent()) {
            return locked.get();
        }
        logger.warn("instance_owner singleton row missing; instance-level lock is not enforceable");
        InstanceOwner created = new InstanceOwner();
        return owners.save(created);
    }

    /**
     * Password step-up reusing the 0558 primitives (decision #9): the failure is
     * counted against the owner's account lockout and consumes the shared BCrypt
     * concurrency slot, so the transfer endpoint cannot be used as an unmetered
     * password oracle. No new counter is introduced.
     */
    private void reauthenticateOwner(String actorUserId, String rawPassword, String clientIp) {
        String identifier = users.findById(UUID.fromString(actorUserId))
                .map(User::getEmail)
                .orElse(actorUserId);
        LoginAttemptService.Lease lease = loginAttemptService.beginLogin(identifier, clientIp);
        boolean slot = false;
        boolean verified = false;
        try {
            if (!loginAttemptService.tryAcquireBcryptSlot()) {
                throw new CpApiException(HttpStatus.TOO_MANY_REQUESTS, "AUTH_RATE_LIMITED",
                        "Too many concurrent credential checks; retry later");
            }
            slot = true;
            verified = authService.verifyPassword(UUID.fromString(actorUserId), rawPassword);
            if (!verified) {
                loginAttemptService.recordCredentialFailure(lease);
                logger.warn("[LIFECYCLE] service=cp event=instance_owner_transfer_denied reason=invalid_credentials");
                throw new CpApiException(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS",
                        "Password verification failed");
            }
            loginAttemptService.recordSuccess(lease);
        } finally {
            if (slot) {
                loginAttemptService.releaseBcryptSlot();
            }
            loginAttemptService.release(lease);
        }
    }
}
