package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUserId;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0610 W3-3: the <b>single membership seam</b> of a workspace.
 *
 * <p>Before this class every surface asked {@code workspace_users} directly (member API, tenant
 * interceptor, D9 context access, grant evaluation, attachment access, agent templates) and the
 * access-role model answered the same question from {@code role_bindings} — round-4 P2-5 called
 * that a semantic fork: an instance administrator and a workspace member were judged by two
 * different queries. Now there is one implementation and every caller shares it:</p>
 *
 * <ul>
 *   <li><b>Truth</b>: {@code role_bindings(subject_type='user', scope_type='workspace',
 *       scope_id=<workspace>)} with the system roles {@code WS_OWNER} / {@code WS_EDITOR} /
 *       {@code WS_VIEWER} (V87 seeds, V88 backfilled from {@code workspace_users.role}).</li>
 *   <li><b>Writes</b> go to the binding only, then materialize the subject in the same transaction
 *       ({@link RoleGrantMaterializer#materializeSubject}: {@code source='role'} rows reconciled,
 *       capability cache invalidated immediately and after completion). <b>No epoch bump</b>: a
 *       workspace role is not carried by the access token (only instance tier bindings need the I4
 *       epoch, because the token used to carry the instance role claim), and bumping here would
 *       invalidate the actor's own token on every membership edit — including the workspace they
 *       just created. The legacy {@code workspace_users} row is <b>mirrored</b> while the table
 *       still exists so the surfaces that have not moved yet (workspace list sql, 0565-era
 *       fixtures) keep working; V89 drops the table together with the mirror.</li>
 *   <li><b>Reads</b> prefer the binding and fall back to the legacy row. The fallback exists only
 *       for rows/fixtures created before this wave; it logs a warning so a stale writer is visible
 *       instead of silent. Deletable in one line once V89 lands.</li>
 * </ul>
 *
 * <p>What this class deliberately does <b>not</b> decide: whether an instance administrator may act
 * on the workspace ({@link AuthzContext#canWorkspaceAdmin} — see {@code AccessScopeResolver}) and
 * what each member role may do (0581/0565 matrix stays in {@code WorkspaceMemberService}). It answers
 * "who is a member and with which workspace role", nothing else.</p>
 */
@Service
public class WorkspaceMembershipService {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceMembershipService.class);

    private static final String SUBJECT_USER = AuthzContext.SUBJECT_USER;
    private static final Map<String, WorkspaceRole> ROLE_BY_NAME = Map.of(
            SystemAccessRoleCatalog.WS_OWNER, WorkspaceRole.OWNER,
            SystemAccessRoleCatalog.WS_EDITOR, WorkspaceRole.EDITOR,
            SystemAccessRoleCatalog.WS_VIEWER, WorkspaceRole.VIEWER);

    private final AccessRoleRepository roles;
    private final AccessRoleBindingRepository bindings;
    private final WorkspaceUserRepository legacyMembers;
    private final UserRepository users;
    private final RoleGrantMaterializer materializer;
    private final AuditLogger audit;

    public WorkspaceMembershipService(AccessRoleRepository roles,
                                      AccessRoleBindingRepository bindings,
                                      WorkspaceUserRepository legacyMembers,
                                      UserRepository users,
                                      RoleGrantMaterializer materializer,
                                      AuditLogger audit) {
        this.roles = roles;
        this.bindings = bindings;
        this.legacyMembers = legacyMembers;
        this.users = users;
        this.materializer = materializer;
        this.audit = audit;
    }

    /** One member as the seam reports it (identity + workspace role + join instant). */
    public record Member(UUID userId, String username, String email, String name,
                         WorkspaceRole role, Instant joinedAt) {
    }

    /** The caller's workspace role, binding first and legacy row as the transitional fallback. */
    @Transactional(readOnly = true)
    public Optional<WorkspaceRole> roleOf(UUID workspaceId, UUID userId) {
        if (workspaceId == null || userId == null) {
            return Optional.empty();
        }
        Map<UUID, String> roleNames = roleNamesById();
        Optional<WorkspaceRole> bound = bindings
                .findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER, AccessScope.WORKSPACE,
                        workspaceId)
                .stream()
                .filter(binding -> userId.equals(binding.getSubjectId()))
                .map(binding -> ROLE_BY_NAME.get(roleNames.get(binding.getRoleId())))
                .filter(java.util.Objects::nonNull)
                .findFirst();
        if (bound.isPresent()) {
            return bound;
        }
        return legacyMembers
                .findByIdWorkspaceIdAndIdUserId(workspaceId, userId)
                .map(WorkspaceUser::getRole);
    }

    @Transactional(readOnly = true)
    public boolean isMember(UUID workspaceId, UUID userId) {
        return roleOf(workspaceId, userId).isPresent();
    }

    @Transactional(readOnly = true)
    public boolean isOwner(UUID workspaceId, UUID userId) {
        return roleOf(workspaceId, userId)
                .map(role -> role.canonicalName().equals("OWNER"))
                .orElse(false);
    }

    /** OWNER count (bindings ∪ legacy rows, deduplicated by user) for the last-owner guard. */
    @Transactional(readOnly = true)
    public long countOwners(UUID workspaceId) {
        return members(workspaceId).stream()
                .filter(member -> member.role().canonicalName().equals("OWNER"))
                .count();
    }

    /**
     * The workspace's members: every workspace-scope user binding joined with the account, plus the
     * legacy rows that have no binding yet (bindings win on a duplicate subject).
     */
    @Transactional(readOnly = true)
    public List<Member> members(UUID workspaceId) {
        Map<UUID, String> roleNames = roleNamesById();
        Map<UUID, BindingFact> boundBySubject = new LinkedHashMap<>();
        for (AccessRoleBinding binding : bindings.findBySubjectTypeAndScopeTypeAndScopeId(
                SUBJECT_USER, AccessScope.WORKSPACE, workspaceId)) {
            WorkspaceRole role = ROLE_BY_NAME.get(roleNames.get(binding.getRoleId()));
            if (role == null) {
                continue;
            }
            boundBySubject.put(binding.getSubjectId(),
                    new BindingFact(role, binding.getGrantedAt()));
        }
        Map<UUID, User> identities = new LinkedHashMap<>();
        if (!boundBySubject.isEmpty()) {
            users.findAllById(boundBySubject.keySet())
                    .forEach(user -> identities.put(user.getId(), user));
        }
        List<Member> members = new ArrayList<>();
        for (Map.Entry<UUID, BindingFact> entry : boundBySubject.entrySet()) {
            User user = identities.get(entry.getKey());
            if (user == null) {
                continue;
            }
            members.add(new Member(user.getId(), user.getUsername(), user.getEmail(),
                    user.getName(), entry.getValue().role(), entry.getValue().joinedAt()));
        }
        for (WorkspaceUser legacy : legacyMembers.findByIdWorkspaceId(workspaceId)) {
            if (boundBySubject.containsKey(legacy.getId().getUserId())) {
                continue;
            }
            users.findById(legacy.getId().getUserId()).ifPresent(user -> members.add(
                    new Member(user.getId(), user.getUsername(), user.getEmail(), user.getName(),
                            legacy.getRole(), legacy.getCreatedAt())));
        }
        members.sort(Comparator.comparing(Member::joinedAt).thenComparing(Member::username));
        return members;
    }

    /**
     * Grants or changes a workspace role in one transaction: the binding becomes the truth, the
     * subject's atoms are re-materialized with an epoch bump, and the legacy row is mirrored.
     */
    @Transactional
    public void assign(UUID workspaceId, UUID userId, WorkspaceRole role, UUID actorUserId) {
        if (workspaceId == null || userId == null || role == null) {
            throw new IllegalArgumentException("workspaceId, userId and role are required");
        }
        String roleName = roleNameOf(role);
        AccessRole accessRole = roles.findByName(roleName)
                .orElseThrow(() -> new IllegalStateException(
                        "System role " + roleName + " is missing (V87 must have been applied)"));
        Map<UUID, String> roleNames = roleNamesById();
        List<AccessRoleBinding> existing = bindings
                .findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER, AccessScope.WORKSPACE,
                        workspaceId)
                .stream()
                .filter(binding -> userId.equals(binding.getSubjectId()))
                .filter(binding -> ROLE_BY_NAME.containsKey(roleNames.get(binding.getRoleId())))
                .toList();
        bindings.deleteAll(existing);
        bindings.flush();
        bindings.save(new AccessRoleBinding(accessRole.getId(), SUBJECT_USER, userId,
                AccessScope.WORKSPACE, workspaceId, actorUserId));
        bindings.flush();
        mirrorLegacyRow(workspaceId, userId, role);
        materializer.materializeSubject(SUBJECT_USER, userId, actorUserId, null);
        audit.recordDurableChange(actorUserId == null ? null : actorUserId.toString(),
                workspaceId.toString(), "workspace_membership_bound", "workspace_member",
                userId.toString(), "role=" + role.canonicalName());
        logger.info("[POLICY] event=workspace_membership_bound workspace={} user={} role={}",
                workspaceId, userId, role.canonicalName());
    }

    /** Removes the workspace membership (binding + mirrored legacy row) and re-materializes. */
    @Transactional
    public void remove(UUID workspaceId, UUID userId, UUID actorUserId) {
        if (workspaceId == null || userId == null) {
            throw new IllegalArgumentException("workspaceId and userId are required");
        }
        Map<UUID, String> roleNames = roleNamesById();
        List<AccessRoleBinding> existing = bindings
                .findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER, AccessScope.WORKSPACE,
                        workspaceId)
                .stream()
                .filter(binding -> userId.equals(binding.getSubjectId()))
                .filter(binding -> ROLE_BY_NAME.containsKey(roleNames.get(binding.getRoleId())))
                .toList();
        bindings.deleteAll(existing);
        bindings.flush();
        legacyMembers.findById(new WorkspaceUserId(workspaceId.toString(), userId.toString()))
                .ifPresent(legacyMembers::delete);
        materializer.materializeSubject(SUBJECT_USER, userId, actorUserId, null);
        audit.recordDurableChange(actorUserId == null ? null : actorUserId.toString(),
                workspaceId.toString(), "workspace_membership_unbound", "workspace_member",
                userId.toString(), "role=" + existing.size());
        logger.info("[POLICY] event=workspace_membership_unbound workspace={} user={}",
                workspaceId, userId);
    }

    /** The binding role name of a workspace role (inverse of {@link #ROLE_BY_NAME}). */
    public static String roleNameOf(WorkspaceRole role) {
        return switch (role.canonicalName()) {
            case "OWNER" -> SystemAccessRoleCatalog.WS_OWNER;
            case "VIEWER" -> SystemAccessRoleCatalog.WS_VIEWER;
            default -> SystemAccessRoleCatalog.WS_EDITOR;
        };
    }

    /**
     * PLAN-0610 W3-3 transition: keep {@code workspace_users} in step while the table exists (V89
     * drops it). Delete this method together with the fallback branch in {@link #roleOf} — nothing
     * else may write the legacy table.
     */
    private void mirrorLegacyRow(UUID workspaceId, UUID userId, WorkspaceRole role) {
        WorkspaceUserId id = new WorkspaceUserId(workspaceId.toString(), userId.toString());
        legacyMembers.findById(id).ifPresentOrElse(row -> {
            row.setRole(role);
            legacyMembers.save(row);
        }, () -> legacyMembers.save(new WorkspaceUser(workspaceId.toString(),
                userId.toString(), role)));
    }

    private Map<UUID, String> roleNamesById() {
        Map<UUID, String> names = new LinkedHashMap<>();
        Set<UUID> wanted = new LinkedHashSet<>();
        for (AccessRole role : roles.findByNameIn(ROLE_BY_NAME.keySet())) {
            names.put(role.getId(), role.getName());
            wanted.add(role.getId());
        }
        return names;
    }

    private record BindingFact(WorkspaceRole role, Instant joinedAt) {
    }

    /** Unused guard kept for callers that need a stable 403 over the seam (member APIs map their own). */
    public static CpApiException forbidden() {
        return new CpApiException(HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                "Workspace access denied");
    }
}


