package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthLog;
import com.cc01cc.p.xihe.cp.auth.CapabilityProjectionService;
import com.cc01cc.p.xihe.cp.auth.NameFormat;
import com.cc01cc.p.xihe.cp.auth.UserAdminView;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.InstanceOwner;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserStatus;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import jakarta.persistence.criteria.Predicate;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * PLAN-0581 §1/§4/§5/§7: the single writer of the account-lifecycle columns.
 *
 * <p>Every mutating operation runs in <b>one</b> transaction with the frozen
 * order: instance lock ({@code instance_owner} singleton, the mutex PLAN-0580
 * defined) → target row lock → guards → column write →
 * {@link #revokeSessions(User)} → durable audit. The guards re-read the ADMIN
 * count while the singleton row is locked, so "disable A + demote B" cannot both
 * succeed and leave zero usable admins (I3).
 *
 * <p>Revocation is dual-channel (contract §4): the access epoch
 * {@code users.token_version} (PLAN-0580's column, checked by
 * {@code AccessTokenAuthenticator}) and the refresh epoch
 * {@code users.session_version} (V86, checked by {@code AuthService.verifyRefresh})
 * both move here. Role changes, by contrast, belong to PLAN-0580 and bump only
 * the access epoch — that asymmetry is the whole point of two scalars.
 */
@Service
public class UserAdminService {

    private static final Logger logger = LoggerFactory.getLogger(UserAdminService.class);
    private static final String RESOURCE_TYPE = "user";
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    private static final int MAX_PAGE_SIZE = 100;
    private static final int DEFAULT_PAGE_SIZE = 20;

    /** Result of an admin-driven account creation: the view plus the one-time password (when generated). */
    public record CreatedUser(UserAdminView view, String temporaryPassword) {}

    private final UserRepository users;
    private final InstanceOwnerRepository owners;
    private final GrantDefaultService grantDefaultService;
    private final PasswordEncoder passwordEncoder;
    private final AuditLogger audit;
    private final DbLockTimeout dbLockTimeout;
    /**
     * Guard denials roll their transaction back, but a refused admin action is a
     * durable fact (contract §7) — so the {@code user_admin_action_denied} row is
     * written in its own committed transaction, exactly like PLAN-0580's
     * {@code user_role_change_denied}.
     */
    private final TransactionTemplate auditTransaction;
    /** PLAN-0610 W3-2b: binding-backed capabilities replace the legacy {@code role} on the wire. */
    private final CapabilityProjectionService capabilityProjection;

    public UserAdminService(UserRepository users,
                            InstanceOwnerRepository owners,
                            GrantDefaultService grantDefaultService,
                            PasswordEncoder passwordEncoder,
                            AuditLogger audit,
                            DbLockTimeout dbLockTimeout,
                            CapabilityProjectionService capabilityProjection,
                            PlatformTransactionManager transactionManager) {
        this.users = users;
        this.owners = owners;
        this.grantDefaultService = grantDefaultService;
        this.passwordEncoder = passwordEncoder;
        this.audit = audit;
        this.dbLockTimeout = dbLockTimeout;
        this.capabilityProjection = capabilityProjection;
        this.auditTransaction = new TransactionTemplate(transactionManager);
        this.auditTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    // ── reads ────────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/users (contract §3 #1): filters are all optional, ordering is
     * always {@code createdAt DESC}, page size is clamped to 100.
     *
     * <p>PLAN-0610 W3-2b: the {@code role} filter is retired with the legacy tier column; callers
     * select administrators by capability (the binding-backed {@link UserAdminView#getCapabilities()})
     * instead of a {@code users.role} string.</p>
     */
    @Transactional(readOnly = true)
    public Page<UserAdminView> list(String query, UserStatus status,
                                    boolean includeDeleted, int page, int size) {
        int effectiveSize = size <= 0 ? DEFAULT_PAGE_SIZE : Math.min(size, MAX_PAGE_SIZE);
        Pageable pageable = PageRequest.of(Math.max(page, 0), effectiveSize,
                Sort.by(Sort.Direction.DESC, "createdAt"));
        Specification<User> spec = buildFilter(query, status, includeDeleted);
        return users.findAll(spec, pageable).map(this::toView);
    }

    /** GET /api/v1/users/{userId}: 404 when the row does not exist at all. */
    @Transactional(readOnly = true)
    public UserAdminView detail(UUID targetUserId) {
        return toView(users.findById(targetUserId).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found")));
    }

    /** Binding-backed view projection (PLAN-0610 W3-2b: no {@code users.role} on the wire). */
    private UserAdminView toView(User user) {
        return UserAdminView.from(user,
                capabilityProjection.capabilitiesFor(user.getId()));
    }

    private Specification<User> buildFilter(String query, UserStatus status,
                                            boolean includeDeleted) {
        return (root, criteriaQuery, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (!includeDeleted) {
                predicates.add(cb.isNull(root.get("deletedAt")));
            }
            if (status != null) {
                predicates.add(cb.equal(root.get("status"), status));
            }
            if (query != null && !query.isBlank()) {
                String pattern = "%" + query.trim().toLowerCase(Locale.ROOT) + "%";
                predicates.add(cb.or(
                        cb.like(cb.lower(root.get("email")), pattern),
                        cb.like(cb.lower(root.get("username")), pattern),
                        cb.like(cb.lower(root.get("name")), pattern)));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
    }

    // ── writes ───────────────────────────────────────────────────────────────

    /**
     * PATCH /api/v1/users/{userId}/status (contract §3 #4).
     *
     * <p>ACTIVE→DISABLED revokes both channels; DISABLED→ACTIVE changes nothing
     * else — the old credentials stay dead on purpose (contract §4: "旧凭据已失效，
     * 不复活"), the user simply logs in again. A request that does not change the
     * status is a 200 no-op with no epoch bump and no audit row (§3 无变更判定).
     */
    @Transactional
    public UserAdminView changeStatus(String actorUserId, UUID targetUserId, UserStatus newStatus) {
        if (newStatus == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_STATUS",
                    "status must be ACTIVE or DISABLED");
        }
        dbLockTimeout.apply();
        UUID ownerUserId = lockInstanceOwner();
        User target = lockTarget(targetUserId);
        // Soft delete is irreversible (decision #3): a re-enable would violate
        // ck_users_deleted_status (deleted_at non-null requires status=DISABLED) and
        // surface as an unmapped 500. The API layer therefore refuses it explicitly —
        // the DB CHECK stays as the safety net, not as the error contract.
        requireNotDeleted(target);

        if (target.getStatus() == newStatus) {
            // No-op: a retry (or a click on the current state) must not kick the
            // user out of an otherwise healthy session.
            return UserAdminView.from(target);
        }
        UserStatus previous = target.getStatus();
        if (newStatus == UserStatus.DISABLED) {
            guard(actorUserId, target, ownerUserId, true);
            target.setStatus(UserStatus.DISABLED);
            revokeSessions(target);
        } else {
            target.setStatus(UserStatus.ACTIVE);
        }
        User saved = users.save(target);
        audit.recordDurableChange(actorUserId, null, "user_status_changed", RESOURCE_TYPE,
                saved.getId().toString(), "from=" + previous + " to=" + newStatus);
        logger.info("[LIFECYCLE] service=cp event=user_status_changed target={} from={} to={}",
                saved.getId(), previous, newStatus);
        return UserAdminView.from(saved);
    }

    /**
     * DELETE /api/v1/users/{userId} (contract §3 #5): soft delete is
     * {@code deletedAt = now()} + {@code status = DISABLED} + dual revocation, in
     * one transaction. v1 is irreversible (decision #3); a second call on an
     * already-deleted row is a no-op so a retried request does not bump the epochs
     * again.
     */
    @Transactional
    public void softDelete(String actorUserId, UUID targetUserId) {
        dbLockTimeout.apply();
        UUID ownerUserId = lockInstanceOwner();
        User target = lockTarget(targetUserId);
        if (target.getDeletedAt() != null) {
            return;
        }
        guard(actorUserId, target, ownerUserId, true);
        target.setDeletedAt(Instant.now());
        target.setStatus(UserStatus.DISABLED);
        revokeSessions(target);
        User saved = users.save(target);
        audit.recordDurableChange(actorUserId, null, "user_soft_deleted", RESOURCE_TYPE,
                saved.getId().toString(), "from=ACTIVE to=DISABLED");
        logger.info("[LIFECYCLE] service=cp event=user_soft_deleted target={}", saved.getId());
    }

    /**
     * POST /api/v1/users/{userId}/password-reset (contract §3 #6, decision #6):
     * the server generates a one-time password, stores only its hash, revokes both
     * channels and returns the plaintext exactly once. The plaintext never reaches
     * the audit row, the logs or any event (I4).
     */
    @Transactional
    public String resetPassword(String actorUserId, UUID targetUserId) {
        dbLockTimeout.apply();
        UUID ownerUserId = lockInstanceOwner();
        User target = lockTarget(targetUserId);
        // Same irreversibility rule as the status change: rotating the password of a
        // deleted account would hand out a credential that cannot log in (login is
        // blocked by isUsable()) and would exit with a 200 that looks like a recovery.
        requireNotDeleted(target);
        // A password reset does not change the role or the account state, so the
        // owner and last-admin guards do not apply — only "not yourself" (decision #5).
        guard(actorUserId, target, ownerUserId, false);
        String temporaryPassword = generateTemporaryPassword();
        target.setPasswordHash(passwordEncoder.encode(temporaryPassword));
        revokeSessions(target);
        User saved = users.save(target);
        audit.recordDurableChange(actorUserId, null, "user_password_reset", RESOURCE_TYPE,
                saved.getId().toString(), "reason=admin_reset");
        logger.info("[LIFECYCLE] service=cp event=user_password_reset target={}", saved.getId());
        return temporaryPassword;
    }

    /**
     * POST /api/v1/users (contract §3 #3, decision #9): the only account source
     * when registration is closed. It is not an {@code /auth/register} alias — the
     * response shape, the audit action and the temporary-password rule differ, and
     * it must work with the public registration throttle switched off.
     */
    @Transactional
    public CreatedUser createUser(String actorUserId, String email, String username,
                                  String rawPassword, String name) {
        if (email == null || email.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "email is required");
        }
        String normalizedEmail = email.trim().toLowerCase(Locale.ROOT);
        if (users.existsByEmail(normalizedEmail)) {
            throw new CpApiException(HttpStatus.CONFLICT, "EMAIL_TAKEN", "Email already registered");
        }
        // PLAN-0610 W3-2b/W4a: creation is "create account + assign the USER instance binding". The
        // retired role field is not accepted, and {@code users.role} is no longer written at all —
        // elevation is a role-binding write, not a create flag.
        String resolvedUsername = resolveUsername(username, normalizedEmail);

        String temporaryPassword = (rawPassword == null || rawPassword.isBlank())
                ? generateTemporaryPassword() : null;
        String effectivePassword = temporaryPassword != null ? temporaryPassword : rawPassword;

        User user = new User(normalizedEmail, passwordEncoder.encode(effectivePassword),
                name != null && !name.isBlank() ? name.trim() : normalizedEmail.split("@")[0],
                resolvedUsername);
        User saved = users.save(user);
        grantDefaultService.ensureUserDefault(saved);
        audit.recordDurableChange(actorUserId, null, "user_created", RESOURCE_TYPE,
                saved.getId().toString(),
                "email=" + AuthLog.maskEmail(saved.getEmail()) + " tier=USER source=admin");
        logger.info("[LIFECYCLE] service=cp event=user_created target={} tier=USER source=admin",
                saved.getId());
        return new CreatedUser(toView(saved), temporaryPassword);
    }

    /**
     * Contract §4: the dual-channel revocation primitive. Bumping both epochs in
     * the caller's transaction is what makes "disable" observable on the very next
     * request instead of after the access TTL (or the 7-day refresh window).
     *
     * <p>Package-visible on purpose: {@link UserRoleService} must <b>not</b> call
     * it (a role change keeps refresh alive), and no controller may call it
     * directly — revocation is always a side effect of a lifecycle write.
     */
    void revokeSessions(User user) {
        user.bumpTokenVersion();
        user.bumpSessionVersion();
    }

    // ── guards ───────────────────────────────────────────────────────────────

    /**
     * Frozen guard priority (contract §5): self → instance owner → last admin.
     * {@code removesAdmin} is false for a password reset, which cannot remove an
     * administrator from the usable set.
     */
    private void guard(String actorUserId, User target, UUID ownerUserId, boolean removesAdmin) {
        if (target.getId().toString().equals(actorUserId)) {
            deny(actorUserId, target, "SELF", HttpStatus.CONFLICT, "SELF_OPERATION_FORBIDDEN",
                    "Administrators cannot perform this action on their own account");
        }
        if (ownerUserId != null && target.getId().equals(ownerUserId)) {
            deny(actorUserId, target, "OWNER", HttpStatus.CONFLICT, "INSTANCE_OWNER_PROTECTED",
                    "The instance owner cannot be disabled or deleted; transfer ownership first");
        }
        if (removesAdmin && grantDefaultService.holdsInstanceAdminCapability(target.getId())
                && grantDefaultService.countActiveInstanceAdmins() <= (target.isUsable() ? 1 : 0)) {
            // PLAN-0610 W4a: "administrator" is an instance ADMIN/SUPER_ADMIN binding, not the
            // retired {@code users.role} column (R2-9). The count includes the target only when it
            // is still usable; disabling an already-disabled/deleted administrator removes nothing
            // from the usable set, so the threshold drops to 0 instead of rejecting a harmless
            // request.
            deny(actorUserId, target, "LATEST_ADMIN", HttpStatus.CONFLICT, "LAST_ADMIN",
                    "The instance must keep at least one usable ADMIN");
        }
    }

    /**
     * PLAN-0581 (merge-audit P1-1): {@code deletedAt != null} is terminal for v1
     * (decision #3). Without this guard a re-enable reached the DB CHECK
     * {@code ck_users_deleted_status} and surfaced as an unmapped 500; the API must
     * answer a contract code instead. The CHECK stays as the safety net.
     */
    private void requireNotDeleted(User target) {
        if (target.getDeletedAt() != null) {
            logger.info("[LIFECYCLE] service=cp event=user_admin_action_denied target={}"
                    + " reason=USER_DELETED", target.getId());
            throw new CpApiException(HttpStatus.CONFLICT, "USER_DELETED",
                    "A soft-deleted account cannot be modified (deletion is irreversible in v1)");
        }
    }

    private void deny(String actorUserId, User target, String reason, HttpStatus status,
                      String code, String detail) {
        String targetId = target.getId().toString();
        auditTransaction.executeWithoutResult(txStatus -> audit.recordDurableChange(
                actorUserId, null, "user_admin_action_denied", RESOURCE_TYPE, targetId,
                "reason=" + reason));
        logger.warn("[LIFECYCLE] service=cp event=user_admin_action_denied target={} reason={}",
                targetId, reason);
        throw new CpApiException(status, code, detail);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /** The singleton row is the instance mutex; its owner id is the guard input. */
    private UUID lockInstanceOwner() {
        return owners.lockSingleton()
                .map(InstanceOwner::getOwnerUserId)
                .orElse(null);
    }

    private User lockTarget(UUID targetUserId) {
        return users.findByIdForUpdate(targetUserId).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
    }

    /** Username rules follow PLAN-0565 #7's shape plus 决策 v29's character set; blank derives from email. */
    private String resolveUsername(String requested, String email) {
        if (requested != null && !requested.isBlank()) {
            // 决策 v29（2026-11-04）：与注册面同一规则（NameFormat 单一供给）；对原始输入判定、
            // 不 trim/不改写；错误码保留 USERNAME_INVALID（D61-05 暂定 (ii)）。
            if (!NameFormat.isValidUsername(requested)) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "USERNAME_INVALID",
                        "Username must be 1-32 characters of letters (any case), Chinese characters "
                                + "or digits, must not start with a digit, and must not contain "
                                + "spaces or symbols");
            }
            if (users.existsByUsername(requested)) {
                throw new CpApiException(HttpStatus.CONFLICT, "USERNAME_TAKEN",
                        "Username already taken");
            }
            return requested;
        }
        String base = User.defaultUsernameFromEmail(email);
        String candidate = base;
        int n = 1;
        while (users.existsByUsername(candidate)) {
            n++;
            String suffix = Integer.toString(n);
            candidate = base.length() + suffix.length() > 32
                    ? base.substring(0, 32 - suffix.length()) + suffix
                    : base + suffix;
        }
        return candidate;
    }

    /** 24 random bytes, URL-safe Base64 (same shape as {@code DataSeeder}'s admin password). */
    private static String generateTemporaryPassword() {
        byte[] bytes = new byte[24];
        SECURE_RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
