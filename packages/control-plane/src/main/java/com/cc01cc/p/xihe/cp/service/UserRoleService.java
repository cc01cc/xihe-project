package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.LocalModeService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.InstanceOwner;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * PLAN-0580: the instance-role decision point
 * (spec {@code api-instance-ownership-contract.md} §5/§8/§9).
 *
 * <p>One transaction owns the whole change: instance lock → owner/last-admin
 * guards → {@code users.role} UPDATE → default-grant resync → {@code
 * users.token_version + 1} → durable audit (I4). The guards read the ADMIN count
 * <b>while holding the singleton row lock</b>, so two concurrent demotions
 * cannot both observe {@code count = 2} (I2).
 */
@Service
public class UserRoleService {

    private static final Logger logger = LoggerFactory.getLogger(UserRoleService.class);

    private final UserRepository users;
    private final InstanceOwnerRepository owners;
    private final GrantDefaultService grantDefaultService;
    private final AuditLogger audit;
    private final DbLockTimeout dbLockTimeout;
    private final LocalModeService localModeService;
    /**
     * Denials roll the guard transaction back (a 409 must not leave a partial
     * write), but the {@code user_role_change_denied} audit row is a durable
     * fact about the attempt (contract §5/§9) — so it is written in its own
     * committed transaction, independent of the rollback.
     */
    private final TransactionTemplate auditTransaction;

    public UserRoleService(UserRepository users,
                           InstanceOwnerRepository owners,
                           GrantDefaultService grantDefaultService,
                           AuditLogger audit,
                           DbLockTimeout dbLockTimeout,
                           LocalModeService localModeService,
                           PlatformTransactionManager transactionManager) {
        this.users = users;
        this.owners = owners;
        this.grantDefaultService = grantDefaultService;
        this.audit = audit;
        this.dbLockTimeout = dbLockTimeout;
        this.localModeService = localModeService;
        this.auditTransaction = new TransactionTemplate(transactionManager);
        this.auditTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    /**
     * PATCH /api/v1/users/{userId}/role (contract §5).
     *
     * <p>Guard priority is frozen: owner protection first
     * ({@code 409 INSTANCE_OWNER_PROTECTED}), then last-admin
     * ({@code 409 LAST_ADMIN}). A request that does not change the role is a
     * no-op 200: no epoch bump and no audit row (avoiding a pointless global
     * re-authentication for every retry).
     */
    @Transactional
    public User changeRole(String actorUserId, UUID targetUserId, UserRole newRole) {
        if (newRole == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE",
                    "role must be ADMIN or USER");
        }
        if (localModeService.enabled()) {
            // PLAN-0526 single-user invariant: changing the only account's role
            // would either break the last-admin rule or lock the machine's owner
            // out (contract §7 / decision #10).
            throw new CpApiException(HttpStatus.CONFLICT, "LOCAL_SINGLE_USER_MODE",
                    "Roles cannot be changed in local single-user mode");
        }
        dbLockTimeout.apply();
        UUID ownerUserId = lockInstanceOwner();

        User target = users.findByIdForUpdate(targetUserId).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found"));
        UserRole previousRole = target.getRole();
        if (previousRole == newRole) {
            return target;
        }

        if (target.getId().equals(ownerUserId)) {
            deny(actorUserId, target, previousRole, newRole, "INSTANCE_OWNER_PROTECTED",
                    HttpStatus.CONFLICT, "The instance owner cannot be demoted");
        }
        if (previousRole == UserRole.ADMIN && newRole == UserRole.USER
                && users.countByRole(UserRole.ADMIN) <= 1) {
            deny(actorUserId, target, previousRole, newRole, "LAST_ADMIN",
                    HttpStatus.CONFLICT, "The instance must keep at least one ADMIN");
        }

        target.setRole(newRole);
        User saved = users.save(target);
        grantDefaultService.resyncUserDefault(saved);
        saved.bumpTokenVersion();
        users.save(saved);
        audit.recordDurableChange(actorUserId, null, "user_role_changed", "user",
                saved.getId().toString(),
                "from=" + previousRole + " to=" + newRole);
        logger.info("[LIFECYCLE] service=cp event=user_role_changed target={} from={} to={} tokenVersion={}",
                saved.getId(), previousRole, newRole, saved.getTokenVersion());
        return saved;
    }

    /** The singleton row is the instance mutex; its owner id is the guard input. */
    private UUID lockInstanceOwner() {
        return owners.lockSingleton()
                .map(InstanceOwner::getOwnerUserId)
                .orElse(null);
    }

    private void deny(String actorUserId, User target, UserRole previousRole, UserRole newRole,
                      String reason, HttpStatus status, String detail) {
        String auditDetail = "from=" + previousRole + " to=" + newRole + " reason=" + reason;
        String targetId = target.getId().toString();
        auditTransaction.executeWithoutResult(txStatus -> audit.recordDurableChange(
                actorUserId, null, "user_role_change_denied", "user", targetId, auditDetail));
        logger.warn("[LIFECYCLE] service=cp event=user_role_change_denied target={} reason={}",
                targetId, reason);
        throw new CpApiException(status, reason, detail);
    }
}
