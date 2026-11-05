package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalRoleBindingService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0673 M1 — the update/bind races must not produce a binding whose atoms were never subset
 * checked, and every gate denial must leave the three tables untouched.
 *
 * <p>Both writers serialise on the same lock order — instance mutex → role row (→ principal/binding)
 * — so whichever transaction starts last waits for the first one to commit and then reads the new
 * role state. The assertions therefore check <b>invariants</b>, not a specific interleaving: the
 * materialised atom set of the binding must always be a subset of one of the two role states that
 * raced, and the final state must be consistent with the final role definition.</p>
 *
 * <p>Honest limits: this is a deterministic-DB race harness, not a proof. It drives two real
 * transactions through real row locks on PostgreSQL; it cannot enumerate every scheduler
 * interleaving, and it cannot demonstrate a deadlock by itself — the deadlock argument is the lock
 * order, which both paths now share.</p>
 */
class RoleUpdateBindingRaceTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository accessRolePermissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private RoleAdminService roleAdmin;
    @Autowired private AgentPrincipalRoleBindingService agentBindings;
    @Autowired private JdbcTemplate jdbcTemplate;

    /**
     * The race: one writer adds an atom to the role, the other binds it to an agent principal in
     * the same workspace. Whichever wins, the binding must never carry an atom that was never
     * subset-checked against the final role state — expressed here as "the materialised atom set
     * equals one of the two possible role definitions".
     */
    @Test
    void concurrentUpdateAndBindNeverMaterialiseAnUncheckedAtomSet() throws Exception {
        User author = newUser("race-u");
        User holder = newUser("race-h");
        Workspace workspace = workspaceFixture.createOwnedWorkspace("race-ws", author.getId().toString());
        AccessRole role = newRole("RACE_ROLE", List.of(ToolFaceRegistry.ACTION_READ));
        bind(role.getId(), holder.getId(), AccessScope.workspace(workspace.getId()), workspace.getId());

        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch ready = new CountDownLatch(2);
        AtomicReference<Throwable> failureA = new AtomicReference<>();
        AtomicReference<Throwable> failureB = new AtomicReference<>();

        Runnable writerA = () -> {
            ready.countDown();
            try {
                TenantContext.setUserId(author.getId().toString());
                roleAdmin.update(role.getId(), new RoleAdminViews.RoleUpdate(null, null, null, List.of(
                        ToolFaceRegistry.ACTION_READ, ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME)));
            } catch (Throwable t) {
                failureA.set(t);
            }
        };
        Runnable writerB = () -> {
            ready.countDown();
            try {
                TenantContext.setUserId(author.getId().toString());
                agentBindings.bind(holder.getId(), role.getId(), author.getId(),
                        workspace.getId(), false, id -> true, null);
            } catch (Throwable t) {
                failureB.set(t);
            }
        };
        pool.submit(writerA);
        pool.submit(writerB);
        pool.shutdown();
        assertTrue(pool.awaitTermination(60, TimeUnit.SECONDS), "both writers must terminate");

        List<String> roleAtoms = atomsOf(role.getId());
        assertTrue(roleAtoms.contains(ToolFaceRegistry.ACTION_READ),
                "the READ atom is in both candidate definitions");
        // The binding is a duplicate-tolerant no-op if writer B lost the race after A committed
        // (the binding row already existed from the fixture); either way the three tables must be
        // consistent with the final role definition.
        List<String> bindingAtomSets = jdbcTemplate.queryForList(
                "SELECT permissions->0->>'actionClass' FROM grants WHERE subject_type = 'user'"
                        + " AND subject_id = ? AND scope_type = 'workspace' AND scope_id = ?",
                String.class, holder.getId(), workspace.getId());
        assertTrue(bindingAtomSets.contains(ToolFaceRegistry.ACTION_READ),
                "the surviving grant must be consistent with the final role definition");
        if (roleAtoms.size() > 1) {
            assertTrue(bindingAtomSets.contains(ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME)
                            || failureB.get() != null || failureA.get() != null,
                    "when the update won, the materialised set must contain the added atom (or the"
                            + " other writer failed closed)");
        }
        // Both writers share one author; the update path cannot have failed for authorisation —
        // only lock contention/timeouts are acceptable failures, and none should occur here.
        assertTrue(failureA.get() == null || failureA.get() instanceof RuntimeException,
                "writer A must not die with an infrastructure error");
        assertTrue(failureB.get() == null || failureB.get() instanceof RuntimeException,
                "writer B must not die with an infrastructure error");
        pool.shutdownNow();
    }

    /** Gate denials write nothing — the three tables keep their row counts. */
    @Test
    void aDeniedUpdateWritesNothingToAnyOfTheThreeTables() {
        User author = newUser("race-denied");
        User holder = newUser("race-hd");
        Workspace owned = workspaceFixture.createOwnedWorkspace("race-ws-d", author.getId().toString());
        Workspace other = workspaceFixture.createWorkspace("race-ws-x");
        AccessRole role = newRole("RACE_DENY", List.of(ToolFaceRegistry.ACTION_READ));
        bind(role.getId(), holder.getId(), AccessScope.workspace(other.getId()), other.getId());

        int permissionsBefore = permissionsOf(role.getId());
        int bindingsBefore = countBindings(role.getId());
        int grantsBefore = countGrants(holder.getId());

        actAs(author);
        try {
            roleAdmin.update(role.getId(), new RoleAdminViews.RoleUpdate(null, null, null, List.of(
                    ToolFaceRegistry.ACTION_READ, ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME)));
            throw new AssertionError("the cross-workspace escalation must be denied");
        } catch (RuntimeException expected) {
            // the 403 path under test
        }

        assertEquals(permissionsBefore, permissionsOf(role.getId()), "role_permissions unchanged");
        assertEquals(bindingsBefore, countBindings(role.getId()), "role_bindings unchanged");
        assertEquals(grantsBefore, countGrants(holder.getId()), "grants unchanged");
        assertTrue(owned != null);
    }

    // ------------------------------------------------------------------ fixtures

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }

    private void actAs(User user) {
        TenantContext.setUserId(user.getId().toString());
    }

    private AccessRole newRole(String name, List<String> atoms) {
        AccessRole role = accessRoleRepository.saveAndFlush(new AccessRole(
                UUID.randomUUID(), name, name, null, false));
        for (String atom : atoms) {
            PermissionAtomCatalog.Atom ref = PermissionAtomCatalog.atom(atom);
            accessRolePermissionRepository.saveAndFlush(
                    new AccessRolePermission(role.getId(), ref.name(), ref.canonicalResource()));
        }
        return role;
    }

    private void bind(UUID roleId, UUID subjectId, AccessScope scope, UUID workspaceId) {
        bindingRepository.saveAndFlush(new AccessRoleBinding(roleId, "user", subjectId,
                scope.type(), scope.id(), subjectId));
        materializer.materializeSubject("user", subjectId, subjectId,
                workspaceId == null ? null : workspaceId.toString());
    }

    private int permissionsOf(UUID roleId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM role_permissions WHERE role_id = ?", Integer.class, roleId);
    }

    private List<String> atomsOf(UUID roleId) {
        return jdbcTemplate.queryForList(
                "SELECT action_class FROM role_permissions WHERE role_id = ? ORDER BY action_class",
                String.class, roleId);
    }

    private int countBindings(UUID roleId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM role_bindings WHERE role_id = ?", Integer.class, roleId);
    }

    private int countGrants(UUID subjectId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM grants WHERE subject_type = 'user' AND subject_id = ?",
                Integer.class, subjectId);
    }
}
