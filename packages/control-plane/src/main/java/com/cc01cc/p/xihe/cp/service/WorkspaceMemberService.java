package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.NameFormat;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.controller.MemberView;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.policy.MaintenanceWriteFreeze;
import com.cc01cc.p.xihe.cp.policy.WorkspaceMembershipService;
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
 * <p>PLAN-0610 W3-3: the <b>membership fact</b> is no longer read or written here — it comes from
 * {@link WorkspaceMembershipService}, the single seam over
 * {@code role_bindings(scope=workspace)} (bindings are the truth; the legacy
 * {@code workspace_users} row is mirrored until V89). This class keeps only the 0565 policy matrix,
 * the API shape and the audit rows, so the member surface, the tenant interceptor, D9 and the grant
 * evaluation can no longer disagree about who a member is (round-4 P2-5).</p>
 *
 * <p>All writes serialize on the workspace row lock ({@code findByIdForUpdate}) before any
 * membership read or mutation, so last-owner checks, duplicate-add checks and mutations share one
 * serialization point (spec §4). Last-owner protection is server-authoritative with no role
 * exception, including instance-ADMIN emergency removal.</p>
 */
@Service
public class WorkspaceMemberService {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceMemberService.class);

    private final WorkspaceRepository workspaceRepository;
    private final UserRepository userRepository;
    private final WorkspaceMembershipService memberships;
    private final AuditLogger auditLogger;
    private final MaintenanceWriteFreeze writeFreeze;
    /** PLAN-0651 T1.3 (A7): the instance-administrator bypass is an action atom, not a role name. */
    private final RequesterAuthority requesterAuthority;

    public WorkspaceMemberService(WorkspaceRepository workspaceRepository,
            UserRepository userRepository,
            WorkspaceMembershipService memberships,
            AuditLogger auditLogger,
            MaintenanceWriteFreeze writeFreeze,
            RequesterAuthority requesterAuthority) {
        this.workspaceRepository = workspaceRepository;
        this.userRepository = userRepository;
        this.memberships = memberships;
        this.auditLogger = auditLogger;
        this.writeFreeze = writeFreeze;
        this.requesterAuthority = requesterAuthority;
    }

    /** spec §3: GET list — OWNER/EDITOR see the list; VIEWER and outsiders do not. */
    @Transactional(readOnly = true)
    public List<MemberView> listMembers(String workspaceId, String callerUserId) {
        Caller caller = authorize(workspaceId, callerUserId);
        if (caller.workspaceRole() != null && "VIEWER".equals(caller.workspaceRole())) {
            throw forbidden();
        }
        return memberships.members(UUID.fromString(workspaceId)).stream()
                .map(WorkspaceMemberService::toView)
                .toList();
    }

    /** spec §3: POST — OWNER only (instance ADMIN cannot add, ruling #3). */
    @Transactional
    public MemberView addMember(String workspaceId, String username, String role,
            String callerUserId) {
        writeFreeze.requireWritable("workspace member add");
        Caller caller = authorize(workspaceId, callerUserId);
        requireOwner(caller);
        WorkspaceRole targetRole = requireAssignableRole(role);
        String targetUsername = requireUsername(username);

        lockWorkspace(workspaceId);
        UUID workspaceUuid = UUID.fromString(workspaceId);
        User target = userRepository.findByUsername(targetUsername)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "USER_NOT_FOUND",
                        "No registered account for this username"));
        if (memberships.isMember(workspaceUuid, target.getId())) {
            throw new CpApiException(HttpStatus.CONFLICT, "MEMBER_ALREADY_EXISTS",
                    "User is already a member of this workspace");
        }
        memberships.assign(workspaceUuid, target.getId(), targetRole, actor(callerUserId));
        auditLogger.recordDurableChange(callerUserId, workspaceId, "workspace_member_added",
                "workspace_member", target.getId().toString(), "role=" + targetRole.name());
        logger.info("Member added: workspace={} user={} role={}", workspaceId,
                target.getId(), targetRole);
        return toView(new WorkspaceMembershipService.Member(target.getId(), target.getUsername(),
                target.getEmail(), target.getName(), targetRole, java.time.Instant.now()));
    }

    /** spec §3: PATCH role — OWNER only; unique OWNER downgrade is rejected. */
    @Transactional
    public MemberView updateMemberRole(String workspaceId, String targetUserId, String role,
            String callerUserId) {
        writeFreeze.requireWritable("workspace member role change");
        Caller caller = authorize(workspaceId, callerUserId);
        requireOwner(caller);
        WorkspaceRole newRole = requireAssignableRole(role);
        UUID targetId = requireTargetUserId(targetUserId);

        lockWorkspace(workspaceId);
        UUID workspaceUuid = UUID.fromString(workspaceId);
        WorkspaceRole currentRole = requireMemberRole(workspaceUuid, targetId);
        if (isOwner(currentRole) && memberships.countOwners(workspaceUuid) <= 1) {
            throw lastOwner();
        }
        User identity = requireIdentity(targetId);
        memberships.assign(workspaceUuid, targetId, newRole, actor(callerUserId));
        auditLogger.recordDurableChange(callerUserId, workspaceId, "workspace_member_role_changed",
                "workspace_member", targetId.toString(),
                "role=" + currentRole.canonicalName() + "->" + newRole.canonicalName());
        logger.info("Member role changed: workspace={} user={} role={}->{}", workspaceId,
                targetId, currentRole.canonicalName(), newRole.canonicalName());
        return toView(new WorkspaceMembershipService.Member(targetId, identity.getUsername(),
                identity.getEmail(), identity.getName(), newRole, java.time.Instant.now()));
    }

    /** spec §3: DELETE — workspace OWNER, or instance-ADMIN emergency removal (ruling #3). */
    @Transactional
    public void removeMember(String workspaceId, String targetUserId, String callerUserId) {
        writeFreeze.requireWritable("workspace member removal");
        Caller caller = authorize(workspaceId, callerUserId);
        boolean owner = "OWNER".equals(caller.workspaceRole());
        if (!owner && !caller.instanceAdmin()) {
            throw forbidden();
        }
        UUID targetId = requireTargetUserId(targetUserId);

        lockWorkspace(workspaceId);
        UUID workspaceUuid = UUID.fromString(workspaceId);
        WorkspaceRole currentRole = requireMemberRole(workspaceUuid, targetId);
        if (isOwner(currentRole) && memberships.countOwners(workspaceUuid) <= 1) {
            throw lastOwner();
        }
        memberships.remove(workspaceUuid, targetId, actor(callerUserId));
        auditLogger.recordDurableChange(callerUserId, workspaceId, "workspace_member_removed",
                "workspace_member", targetId.toString(), "role=" + currentRole.canonicalName());
        logger.info("Member removed: workspace={} user={} role={} emergency={}", workspaceId,
                targetId, currentRole.canonicalName(), !owner);
    }

    private Caller authorize(String workspaceId, String callerUserId) {
        requireWorkspaceId(workspaceId);
        UUID workspaceUuid = UUID.fromString(workspaceId);
        // PLAN-0651 T1.3 (A7, D51-26): the instance-administrator bypass is the instance-scope
        // MANAGE_WORKSPACE_MEMBERS atom (ADMIN/SUPER_ADMIN hold it through the seeded roles). It
        // replaces the former capability read and the transitional instance-role string. WS_OWNER
        // deliberately does NOT hold this atom: it keeps managing members through its workspace
        // role (the owner branch below), so this atom only restores the previous instance-admin
        // reach — it grants no new workspace-scope power.
        boolean instanceAdmin = callerUserId != null
                && requesterAuthority.holdsActionAtom(UUID.fromString(callerUserId),
                        ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS, workspaceUuid);
        Optional<WorkspaceRole> membership = callerUserId == null ? Optional.empty()
                : memberships.roleOf(workspaceUuid, UUID.fromString(callerUserId));
        if (membership.isEmpty()) {
            if (!instanceAdmin) {
                throw forbidden();
            }
            // Ruling #3: instance ADMIN bypasses the membership gate, but an
            // unknown or deleted workspace stays 404 (spec §3.2).
            workspaceRepository.findByIdAndDeletedAtIsNull(workspaceUuid)
                    .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                            "WORKSPACE_NOT_FOUND", "Workspace not found"));
            return new Caller(null, true);
        }
        return new Caller(membership.get().canonicalName(), instanceAdmin);
    }

    private void requireOwner(Caller caller) {
        if (!"OWNER".equals(caller.workspaceRole())) {
            throw forbidden();
        }
    }

    /** The target's current workspace role, or 404 MEMBER_NOT_FOUND (the 0565 contract code). */
    private WorkspaceRole requireMemberRole(UUID workspaceId, UUID targetId) {
        return memberships.roleOf(workspaceId, targetId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "MEMBER_NOT_FOUND",
                        "Target user is not a member of this workspace"));
    }

    private User requireIdentity(UUID userId) {
        return userRepository.findById(userId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "MEMBER_NOT_FOUND",
                        "Target user is not a member of this workspace"));
    }

    private void lockWorkspace(String workspaceId) {
        workspaceRepository.findByIdForUpdate(UUID.fromString(workspaceId))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND",
                        "Workspace not found"));
    }

    private static boolean isOwner(WorkspaceRole role) {
        return "OWNER".equals(role.canonicalName());
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
        // 用户 2026-11-03/04 裁定（v23/v29）：username 只允许 字母/汉字/数字 且不得数字开头、
        // 不得含空格与符号。对**原始输入**判定（不 trim）：含空格即非法，静默 trim 会把前导空格
        // 当成合法。长度上限取 username 面的 32（列宽 VARCHAR(32)），不是 agent 名的 64。
        NameFormat.require(username, "username", NameFormat.USERNAME_MAX_LENGTH);
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

    private static UUID actor(String callerUserId) {
        try {
            return callerUserId == null ? null : UUID.fromString(callerUserId);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static MemberView toView(WorkspaceMembershipService.Member member) {
        return new MemberView(member.userId(), member.username(), member.email(),
                member.name(), member.role().canonicalName(), member.joinedAt());
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
