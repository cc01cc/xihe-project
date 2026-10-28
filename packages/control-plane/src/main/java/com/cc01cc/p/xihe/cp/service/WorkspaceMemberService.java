package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.controller.MemberView;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUserId;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0565: workspace membership management (spec/api-members-contract.md).
 *
 * <p>The full permission matrix is self-held here (spec §3): a caller's
 * membership in the <em>path</em> workspace plus the instance role decide every
 * branch, in the fixed order authorization → workspace existence → operation.
 * The 0559 interceptor/guard are deliberately untouched; with an
 * {@code X-Workspace-Id} header a VIEWER's writes are pre-empted with 403
 * WORKSPACE_READ_ONLY before reaching this service, and a non-member's request
 * is rejected with 403 WORKSPACE_FORBIDDEN at the tenant gate.</p>
 *
 * <p>All writes serialize on the workspace row lock
 * ({@code findByIdForUpdate}) before any membership read or mutation, so
 * last-owner checks, duplicate-add checks and mutations share one
 * serialization point (spec §4). Last-owner protection is server-authoritative
 * with no role exception, including instance-ADMIN emergency removal.</p>
 */
@Service
public class WorkspaceMemberService {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceMemberService.class);

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final UserRepository userRepository;
    private final AuditLogger auditLogger;

    public WorkspaceMemberService(WorkspaceRepository workspaceRepository,
            WorkspaceUserRepository workspaceUserRepository,
            UserRepository userRepository,
            AuditLogger auditLogger) {
        this.workspaceRepository = workspaceRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.userRepository = userRepository;
        this.auditLogger = auditLogger;
    }

    /** spec §3: GET list — OWNER/EDITOR see the list; VIEWER and outsiders do not. */
    @Transactional(readOnly = true)
    public List<MemberView> listMembers(String workspaceId, String callerUserId,
            String callerInstanceRole) {
        Caller caller = authorize(workspaceId, callerUserId, callerInstanceRole);
        if (caller.workspaceRole() != null && "VIEWER".equals(caller.workspaceRole())) {
            throw forbidden();
        }
        return workspaceUserRepository.findMemberRows(UUID.fromString(workspaceId)).stream()
                .map(WorkspaceMemberService::toView)
                .toList();
    }

    /** spec §3: POST — OWNER only (instance ADMIN cannot add, ruling #3). */
    @Transactional
    public MemberView addMember(String workspaceId, String username, String role,
            String callerUserId, String callerInstanceRole) {
        Caller caller = authorize(workspaceId, callerUserId, callerInstanceRole);
        requireOwner(caller);
        WorkspaceRole targetRole = requireAssignableRole(role);
        String targetUsername = requireUsername(username);

        lockWorkspace(workspaceId);
        User target = userRepository.findByUsername(targetUsername)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND",
                        "No registered account for this username"));
        if (workspaceUserRepository.existsById(new WorkspaceUserId(workspaceId,
                target.getId().toString()))) {
            throw new CpApiException(HttpStatus.CONFLICT, "MEMBER_ALREADY_EXISTS",
                    "User is already a member of this workspace");
        }
        WorkspaceUser row = new WorkspaceUser(workspaceId, target.getId().toString(), targetRole);
        workspaceUserRepository.save(row);
        auditLogger.recordDurableChange(callerUserId, workspaceId, "workspace_member_added",
                "workspace_member", target.getId().toString(), "role=" + targetRole.name());
        logger.info("Member added: workspace={} user={} role={}", workspaceId,
                target.getId(), targetRole);
        return toView(row, target);
    }

    /** spec §3: PATCH role — OWNER only; unique OWNER downgrade is rejected. */
    @Transactional
    public MemberView updateMemberRole(String workspaceId, String targetUserId, String role,
            String callerUserId, String callerInstanceRole) {
        Caller caller = authorize(workspaceId, callerUserId, callerInstanceRole);
        requireOwner(caller);
        WorkspaceRole newRole = requireAssignableRole(role);
        UUID targetId = requireTargetUserId(targetUserId);

        lockWorkspace(workspaceId);
        WorkspaceUser target = requireMemberRow(workspaceId, targetId);
        if (target.getRole() == WorkspaceRole.OWNER && countOwners(workspaceId) <= 1) {
            throw lastOwner();
        }
        User identity = requireIdentity(targetId);
        String from = target.getRole().canonicalName();
        target.setRole(newRole);
        workspaceUserRepository.save(target);
        auditLogger.recordDurableChange(callerUserId, workspaceId, "workspace_member_role_changed",
                "workspace_member", targetId.toString(),
                "role=" + from + "->" + newRole.canonicalName());
        logger.info("Member role changed: workspace={} user={} role={}->{}", workspaceId,
                targetId, from, newRole.canonicalName());
        return toView(target, identity);
    }

    /** spec §3: DELETE — workspace OWNER, or instance-ADMIN emergency removal (ruling #3). */
    @Transactional
    public void removeMember(String workspaceId, String targetUserId, String callerUserId,
            String callerInstanceRole) {
        Caller caller = authorize(workspaceId, callerUserId, callerInstanceRole);
        boolean owner = "OWNER".equals(caller.workspaceRole());
        if (!owner && !caller.instanceAdmin()) {
            throw forbidden();
        }
        UUID targetId = requireTargetUserId(targetUserId);

        lockWorkspace(workspaceId);
        WorkspaceUser target = requireMemberRow(workspaceId, targetId);
        if (target.getRole() == WorkspaceRole.OWNER && countOwners(workspaceId) <= 1) {
            throw lastOwner();
        }
        String from = target.getRole().canonicalName();
        workspaceUserRepository.delete(target);
        auditLogger.recordDurableChange(callerUserId, workspaceId, "workspace_member_removed",
                "workspace_member", targetId.toString(), "role=" + from);
        logger.info("Member removed: workspace={} user={} role={} emergency={}", workspaceId,
                targetId, from, !owner);
    }

    private Caller authorize(String workspaceId, String callerUserId, String callerInstanceRole) {
        requireWorkspaceId(workspaceId);
        boolean instanceAdmin = "ADMIN".equals(callerInstanceRole);
        Optional<WorkspaceUser> membership = workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId),
                        UUID.fromString(callerUserId));
        if (membership.isEmpty()) {
            if (!instanceAdmin) {
                throw forbidden();
            }
            // Ruling #3: instance ADMIN bypasses the membership gate, but an
            // unknown or deleted workspace stays 404 (spec §3.2).
            workspaceRepository.findByIdAndDeletedAtIsNull(UUID.fromString(workspaceId))
                    .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                            "WORKSPACE_NOT_FOUND", "Workspace not found"));
            return new Caller(null, true);
        }
        return new Caller(membership.get().getRole().canonicalName(), instanceAdmin);
    }

    private void requireOwner(Caller caller) {
        if (!"OWNER".equals(caller.workspaceRole())) {
            throw forbidden();
        }
    }

    private WorkspaceUser requireMemberRow(String workspaceId, UUID targetId) {
        return workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), targetId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "MEMBER_NOT_FOUND",
                        "Target user is not a member of this workspace"));
    }

    private User requireIdentity(UUID userId) {
        return userRepository.findById(userId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "MEMBER_NOT_FOUND",
                        "Target user is not a member of this workspace"));
    }

    private Workspace lockWorkspace(String workspaceId) {
        return workspaceRepository.findByIdForUpdate(UUID.fromString(workspaceId))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND",
                        "Workspace not found"));
    }

    private long countOwners(String workspaceId) {
        return workspaceUserRepository.countByIdWorkspaceIdAndRole(
                UUID.fromString(workspaceId), WorkspaceRole.OWNER);
    }

    private WorkspaceRole requireAssignableRole(String role) {
        if (role != null) {
            try {
                WorkspaceRole parsed = WorkspaceRole.valueOf(role);
                if (parsed == WorkspaceRole.EDITOR || parsed == WorkspaceRole.VIEWER) {
                    return parsed;
                }
            } catch (IllegalArgumentException e) {
                logger.debug("Invalid member role value");
            }
        }
        throw invalidRequest();
    }

    private String requireUsername(String username) {
        if (username == null || username.isBlank()) {
            throw invalidRequest();
        }
        return username.trim();
    }

    private UUID requireTargetUserId(String targetUserId) {
        try {
            return UUID.fromString(targetUserId);
        } catch (IllegalArgumentException e) {
            logger.debug("Invalid member target user id");
            throw invalidRequest();
        }
    }

    private void requireWorkspaceId(String workspaceId) {
        try {
            UUID.fromString(workspaceId);
        } catch (IllegalArgumentException e) {
            logger.debug("Invalid workspace id");
            throw new CpApiException(HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND",
                    "Workspace not found");
        }
    }

    private static MemberView toView(WorkspaceUser row, User identity) {
        return new MemberView(row.getId().getUserId(), identity.getUsername(),
                identity.getEmail(), identity.getName(), row.getRole().canonicalName(),
                row.getCreatedAt());
    }

    private static MemberView toView(Object[] row) {
        return new MemberView((UUID) row[0], (String) row[1], (String) row[2], (String) row[3],
                ((WorkspaceRole) row[4]).canonicalName(), (java.time.Instant) row[5]);
    }

    private static CpApiException forbidden() {
        return new CpApiException(HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                "Workspace access denied");
    }

    private static CpApiException lastOwner() {
        return new CpApiException(HttpStatus.CONFLICT, "LAST_OWNER",
                "Cannot remove or downgrade the last owner of this workspace");
    }

    private static CpApiException invalidRequest() {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                "Invalid member request");
    }

    private record Caller(String workspaceRole, boolean instanceAdmin) {
    }
}
