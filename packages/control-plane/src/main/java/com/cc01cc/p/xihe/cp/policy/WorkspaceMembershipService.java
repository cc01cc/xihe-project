package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
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
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0610: the <b>single membership seam</b> of a workspace.
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
 *       just created.</li>
 * </ul>
 *
 * <p>PLAN-0610 W4b (V89): the transitional {@code workspace_users} mirror and read fallback are
 * gone — the table was dropped with the legacy {@code workspaces.owner_id} column, so the binding is
 * the <b>only</b> membership fact. Anything that used to read "the owner of a workspace" now derives
 * it from the {@code WS_OWNER} binding ({@link #ownerOf}).</p>
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
    private final UserRepository users;
    private final RoleGrantMaterializer materializer;
    private final AuditLogger audit;

    public WorkspaceMembershipService(AccessRoleRepository roles,
                                      AccessRoleBindingRepository bindings,
                                      UserRepository users,
                                      RoleGrantMaterializer materializer,
                                      AuditLogger audit) {
        this.roles = roles;
        this.bindings = bindings;
        this.users = users;
        this.materializer = materializer;
        this.audit = audit;
    }

    /** One member as the seam reports it (identity + workspace role + join instant). */
    public record Member(UUID userId, String username, String email, String name,
                         WorkspaceRole role, Instant joinedAt) {
    }

    /** One workspace membership of a subject (for the self-service capability projection). */
    public record WorkspaceRoleRef(UUID workspaceId, WorkspaceRole role) {
    }

    /** The caller's workspace role, from the binding only (V89 dropped the legacy table). */
    @Transactional(readOnly = true)
    public Optional<WorkspaceRole> roleOf(UUID workspaceId, UUID userId) {
        if (workspaceId == null || userId == null) {
            return Optional.empty();
        }
        Map<UUID, String> roleNames = roleNamesById();
        return bindings
                .findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER, AccessScope.WORKSPACE,
                        workspaceId)
                .stream()
                .filter(binding -> userId.equals(binding.getSubjectId()))
                .map(binding -> ROLE_BY_NAME.get(roleNames.get(binding.getRoleId())))
                .filter(Objects::nonNull)
                .findFirst();
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

    /**
     * The workspace owner as the wire/derived view sees it: the earliest-granted {@code WS_OWNER}
     * binding subject. {@code workspaces.owner_id} is gone (V89); an owner is a binding, and the
     * contract keeps a single {@code ownerId} field by reporting the first owner (the creator unless
     * ownership was handed over). Empty when the workspace has no owner binding.
     */
    @Transactional(readOnly = true)
    public Optional<UUID> ownerOf(UUID workspaceId) {
        if (workspaceId == null) {
            return Optional.empty();
        }
        Map<UUID, String> roleNames = roleNamesById();
        return bindings
                .findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER, AccessScope.WORKSPACE,
                        workspaceId)
                .stream()
                .filter(binding -> WorkspaceRole.OWNER
                        == ROLE_BY_NAME.get(roleNames.get(binding.getRoleId())))
                .min(Comparator.comparing(AccessRoleBinding::getGrantedAt))
                .map(AccessRoleBinding::getSubjectId);
    }

    /** OWNER count for the last-owner guard. */
    @Transactional(readOnly = true)
    public long countOwners(UUID workspaceId) {
        return members(workspaceId).stream()
                .filter(member -> member.role().canonicalName().equals("OWNER"))
                .count();
    }

    /** Every workspace membership of a subject, ordered by workspace id (self-service projection). */
    @Transactional(readOnly = true)
    public List<WorkspaceRoleRef> workspaceRolesOf(UUID userId) {
        if (userId == null) {
            return List.of();
        }
        Map<UUID, String> roleNames = roleNamesById();
        List<WorkspaceRoleRef> refs = new ArrayList<>();
        for (AccessRoleBinding binding : bindings.findBySubjectTypeAndSubjectIdAndScopeType(
                SUBJECT_USER, userId, AccessScope.WORKSPACE)) {
            WorkspaceRole role = ROLE_BY_NAME.get(roleNames.get(binding.getRoleId()));
            if (role != null) {
                refs.add(new WorkspaceRoleRef(binding.getScopeId(), role));
            }
        }
        refs.sort(Comparator.comparing(WorkspaceRoleRef::workspaceId));
        return refs;
    }

    /** The workspace's members: one workspace-scope user binding per subject, joined with accounts. */
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
        members.sort(Comparator.comparing(Member::joinedAt).thenComparing(Member::username));
        return members;
    }

    /**
     * Grants or changes a workspace role in one transaction: the binding becomes the truth and the
     * subject's atoms are re-materialized.
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
        materializer.materializeSubject(SUBJECT_USER, userId, actorUserId, null);
        audit.recordDurableChange(actorUserId == null ? null : actorUserId.toString(),
                workspaceId.toString(), "workspace_membership_bound", "workspace_member",
                userId.toString(), "role=" + role.canonicalName());
        logger.info("[POLICY] event=workspace_membership_bound workspace={} user={} role={}",
                workspaceId, userId, role.canonicalName());
    }

    /** Removes the workspace membership (binding only) and re-materializes the subject. */
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
