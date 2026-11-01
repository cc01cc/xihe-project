package com.cc01cc.p.xihe.cp.integration;

import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.policy.WorkspaceMembershipService;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * PLAN-0610 W4b: test fixture for workspace membership now that {@code workspace_users} is gone.
 *
 * <p>V89 dropped the legacy table and {@code workspaces.owner_id}, so a fixture that needs "this
 * user is a member (role R) of this workspace" must write the {@code role_bindings} row — which is
 * what this helper does, including the same-transaction materialization the production seam performs
 * (otherwise policy checks in the test would see no atoms).</p>
 *
 * <p>Not a production bean: lives in test sources and is only wired by {@code @SpringBootTest}
 * fixtures.</p>
 */
@Component
public class WorkspaceFixture {

    private static final String SUBJECT_USER = AuthzContext.SUBJECT_USER;

    private final AccessRoleRepository roles;
    private final AccessRoleBindingRepository bindings;
    private final RoleGrantMaterializer materializer;
    private final WorkspaceRepository workspaces;

    public WorkspaceFixture(AccessRoleRepository roles,
                            AccessRoleBindingRepository bindings,
                            RoleGrantMaterializer materializer,
                            WorkspaceRepository workspaces) {
        this.roles = roles;
        this.bindings = bindings;
        this.materializer = materializer;
        this.workspaces = workspaces;
    }

    /**
     * Creates a workspace and binds its owner, replacing fixture code that relied on the retired
     * {@code workspaces.owner_id} column. Returns the persisted row.
     */
    /**
     * PLAN-0618 M2.5 (Lead 裁定): the fixture default is the **product's current shape**, not the
     * frozen docker one — `direct_attach` + a real host directory + `windows-host`. The docker backend
     * is frozen, so seeding docker rows by default would keep "the test world" on a backend the product
     * refuses; it would also make every chat/session test collide with the M1 backend gate (503).
     *
     * <p>This is a fixture writing the row explicitly, not the product choosing `windows-host` for a
     * user, so it does not weaken the "windows-host is an explicit user choice" rule.
     *
     * <p>The host directory lives under one per-JVM root in the system temp dir; the root and every
     * per-workspace child are registered with `deleteOnExit` (JVM deletes in reverse registration order,
     * so children go before the root) — no unmanaged leftovers.
     */
    private static final class HostDirectories {
        private static java.nio.file.Path root;

        private static synchronized java.nio.file.Path root() {
            if (root == null) {
                try {
                    root = java.nio.file.Files.createTempDirectory("xihe-fixture-ws");
                } catch (java.io.IOException cause) {
                    throw new IllegalStateException("cannot create the fixture host root", cause);
                }
                root.toFile().deleteOnExit();
            }
            return root;
        }

        private static String next() {
            java.nio.file.Path child = root().resolve(java.util.UUID.randomUUID().toString());
            try {
                java.nio.file.Files.createDirectories(child);
            } catch (java.io.IOException cause) {
                throw new IllegalStateException("cannot create the fixture host directory", cause);
            }
            child.toFile().deleteOnExit();
            return child.toAbsolutePath().toString();
        }
    }

    /** The product's current workspace shape (PLAN-0618: docker is frozen). */
    private static Workspace directAttachShaped(String name) {
        Workspace workspace = new Workspace(name);
        workspace.setStorageMode("direct_attach");
        workspace.setHostPath(HostDirectories.next());
        workspace.setExecutionMode("windows-host");
        return workspace;
    }

    /**
     * Explicit docker-shaped row, ONLY for tests that verify docker semantics (creation gate 409,
     * import pipeline, workspace jobs, backend policy). Every use is registered in
     * `plans/PLAN-0618-XH-docker-freeze-complete/evidence/m2-defaults.md` and feeds the M3 freeze list.
     */
    private static Workspace dockerShaped(String name) {
        Workspace workspace = new Workspace(name);
        workspace.setStorageMode("managed_import");
        workspace.setExecutionMode("docker");
        return workspace;
    }

    @Transactional
    public Workspace createOwnedWorkspace(String name, String ownerId) {
        return createOwnedWorkspace(name, ownerId, directAttachShaped(name));
    }

    /** Explicit docker-shaped workspace for the (few) tests that verify docker-only semantics. */
    @Transactional
    public Workspace createDockerOwnedWorkspace(String name, String ownerId) {
        return createOwnedWorkspace(name, ownerId, dockerShaped(name));
    }

    private Workspace createOwnedWorkspace(String name, String ownerId, Workspace shape) {
        Workspace workspace = workspaces.save(shape);
        workspace.setStorageRef(workspace.getId().toString());
        Workspace saved = workspaces.saveAndFlush(workspace);
        bindWorkspaceRole(saved.getId(), UUID.fromString(ownerId), WorkspaceRole.OWNER);
        return saved;
    }

    /**
     * PLAN-0614: the workspace a fixture should use for an account. Registering no longer creates a
     * default workspace, so fixtures that need "the caller's workspace" create one explicitly on first
     * use (WS_OWNER binding included) and then reuse it.
     */
    @Transactional
    public Workspace ensureOwnedWorkspace(UUID userId) {
        return ensureOwnedWorkspace(userId, "Fixture Workspace");
    }

    /** Same as {@link #ensureOwnedWorkspace(UUID)} with an explicit workspace name. */
    @Transactional
    public Workspace ensureOwnedWorkspace(UUID userId, String name) {
        return workspaces.findActiveByMemberBinding(userId).stream().findFirst()
                .orElseGet(() -> createOwnedWorkspace(name, userId.toString()));
    }

    /** Active workspaces the subject belongs to (binding-backed replacement of the legacy join). */
    @Transactional(readOnly = true)
    public java.util.List<Workspace> memberWorkspacesOf(UUID userId) {
        return workspaces.findActiveByMemberBinding(userId);
    }

    /** Deletes every workspace-scope binding (fixtures that reset the whole instance). */
    @Transactional
    public void unbindAllWorkspaces() {
        bindings.deleteAll(bindings.findBySubjectTypeAndScopeType(SUBJECT_USER, AccessScope.WORKSPACE));
        bindings.flush();
    }

    /** Creates a workspace row without any membership (tests that seed their own bindings). */
    @Transactional
    public Workspace createWorkspace(String name) {
        Workspace workspace = workspaces.save(directAttachShaped(name));
        workspace.setStorageRef(workspace.getId().toString());
        return workspaces.saveAndFlush(workspace);
    }

    /** One workspace-scope binding as fixtures read it back. */
    public record Binding(UUID workspaceId, UUID userId, WorkspaceRole role, Instant grantedAt) {
    }

    @Transactional
    public void bindWorkspaceRole(UUID workspaceId, UUID userId, WorkspaceRole role) {
        if (workspaceId == null || userId == null || role == null) {
            throw new IllegalArgumentException("workspaceId, userId and role are required");
        }
        AccessRole accessRole = roles.findByName(roleName(role))
                .orElseThrow(() -> new IllegalStateException("System role " + roleName(role)
                        + " is missing (V87 must have been applied)"));
        bindings.findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER, AccessScope.WORKSPACE,
                        workspaceId).stream()
                .filter(binding -> userId.equals(binding.getSubjectId()))
                .filter(binding -> isWorkspaceRole(binding.getRoleId()))
                .toList()
                .forEach(binding -> {
                    bindings.delete(binding);
                    bindings.flush();
                });
        bindings.save(new AccessRoleBinding(accessRole.getId(), SUBJECT_USER, userId,
                AccessScope.WORKSPACE, workspaceId, userId));
        bindings.flush();
        materializer.materializeSubject(SUBJECT_USER, userId, userId, null);
    }

    @Transactional
    public void bindWorkspaceRole(String workspaceId, String userId, WorkspaceRole role) {
        bindWorkspaceRole(UUID.fromString(workspaceId), UUID.fromString(userId), role);
    }

    @Transactional
    public void unbindWorkspaceRole(UUID workspaceId, UUID userId) {
        bindings.findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER, AccessScope.WORKSPACE,
                        workspaceId).stream()
                .filter(binding -> userId.equals(binding.getSubjectId()))
                .toList()
                .forEach(bindings::delete);
        bindings.flush();
        materializer.materializeSubject(SUBJECT_USER, userId, userId, null);
    }

    @Transactional
    public void unbindWorkspaceRole(String workspaceId, String userId) {
        unbindWorkspaceRole(UUID.fromString(workspaceId), UUID.fromString(userId));
    }

    @Transactional
    public void unbindWorkspace(UUID workspaceId) {
        List<AccessRoleBinding> existing = bindings.findBySubjectTypeAndScopeTypeAndScopeId(
                SUBJECT_USER, AccessScope.WORKSPACE, workspaceId);
        List<UUID> subjects = existing.stream().map(AccessRoleBinding::getSubjectId).distinct()
                .toList();
        bindings.deleteAll(existing);
        bindings.flush();
        subjects.forEach(subject -> materializer.materializeSubject(SUBJECT_USER, subject,
                subject, null));
    }

    @Transactional
    public void unbindWorkspace(String workspaceId) {
        unbindWorkspace(UUID.fromString(workspaceId));
    }

    /** Insert a binding row without touching {@code grants} (assertions that only look at rows). */
    @Transactional
    public void bindWorkspaceRoleRowOnly(UUID workspaceId, UUID userId, WorkspaceRole role) {
        AccessRole accessRole = roles.findByName(roleName(role))
                .orElseThrow(() -> new IllegalStateException("System role " + roleName(role)
                        + " is missing (V87 must have been applied)"));
        bindings.save(new AccessRoleBinding(accessRole.getId(), SUBJECT_USER, userId,
                AccessScope.WORKSPACE, workspaceId, userId));
        bindings.flush();
    }

    @Transactional(readOnly = true)
    public Optional<WorkspaceRole> roleOf(UUID workspaceId, UUID userId) {
        Map<UUID, String> roleNames = roleNamesById();
        return bindings.findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER,
                        AccessScope.WORKSPACE, workspaceId).stream()
                .filter(binding -> userId.equals(binding.getSubjectId()))
                .map(binding -> roleByBindingName(roleNames.get(binding.getRoleId())))
                .filter(java.util.Objects::nonNull)
                .findFirst();
    }

    @Transactional(readOnly = true)
    public Optional<WorkspaceRole> roleOf(String workspaceId, String userId) {
        return roleOf(UUID.fromString(workspaceId), UUID.fromString(userId));
    }

    @Transactional(readOnly = true)
    public boolean isMember(UUID workspaceId, UUID userId) {
        return roleOf(workspaceId, userId).isPresent();
    }

    @Transactional(readOnly = true)
    public List<Binding> bindingsOfWorkspace(UUID workspaceId) {
        Map<UUID, String> roleNames = roleNamesById();
        return bindings.findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER,
                        AccessScope.WORKSPACE, workspaceId).stream()
                .map(binding -> new Binding(workspaceId, binding.getSubjectId(),
                        roleByBindingName(roleNames.get(binding.getRoleId())),
                        binding.getGrantedAt()))
                .toList();
    }

    @Transactional(readOnly = true)
    public List<UUID> memberIdsOfWorkspace(UUID workspaceId) {
        return bindingsOfWorkspace(workspaceId).stream().map(Binding::userId).toList();
    }

    @Transactional(readOnly = true)
    public List<Binding> bindingsOfUser(UUID userId) {
        Map<UUID, String> roleNames = roleNamesById();
        return bindings.findBySubjectTypeAndSubjectIdAndScopeType(SUBJECT_USER, userId,
                        AccessScope.WORKSPACE).stream()
                .map(binding -> new Binding(binding.getScopeId(), userId,
                        roleByBindingName(roleNames.get(binding.getRoleId())),
                        binding.getGrantedAt()))
                .toList();
    }

    private boolean isWorkspaceRole(UUID roleId) {
        String name = roleNamesById().get(roleId);
        return roleByBindingName(name) != null;
    }

    private Map<UUID, String> roleNamesById() {
        Map<UUID, String> names = new LinkedHashMap<>();
        for (AccessRole role : roles.findByNameIn(List.of(SystemAccessRoleCatalog.WS_OWNER,
                SystemAccessRoleCatalog.WS_EDITOR, SystemAccessRoleCatalog.WS_VIEWER))) {
            names.put(role.getId(), role.getName());
        }
        return names;
    }

    private static String roleName(WorkspaceRole role) {
        return WorkspaceMembershipService.roleNameOf(role);
    }

    private static WorkspaceRole roleByBindingName(String name) {
        if (name == null) {
            return null;
        }
        return switch (name) {
            case SystemAccessRoleCatalog.WS_OWNER -> WorkspaceRole.OWNER;
            case SystemAccessRoleCatalog.WS_EDITOR -> WorkspaceRole.EDITOR;
            case SystemAccessRoleCatalog.WS_VIEWER -> WorkspaceRole.VIEWER;
            default -> null;
        };
    }
}
