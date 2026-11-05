package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0673 V1.5 — the update ∥ bind concurrency matrix.
 *
 * <p>{@code RoleUpdateBindingRaceTest} pinned the <b>agent target in one workspace</b>; this class
 * closes the rest of the matrix the verify line asks for:</p>
 *
 * <ol>
 *   <li>a <b>user</b> target bound in a workspace the author only partially reaches;</li>
 *   <li>an <b>instance-scope</b> binding;</li>
 *   <li>a <b>capability</b> atom (resolved from {@code role_permissions}, not from a materialized
 *       grant row — so an "checked against the old set, written with the new set" window would be
 *       invisible to any grant-row assertion);</li>
 *   <li>a denied writer leaves {@code role_permissions}, {@code role_bindings} and {@code grants}
 *       untouched in every one of those combinations.</li>
 * </ol>
 *
 * <p><b>Trigger, not sleep.</b> Both writers are parked on a {@link CountDownLatch} and released
 * together, then serialise on the shared instance write mutex (the lock order every authorization
 * write path uses: {@code instance_owner} → role row → subject/binding rows). Whichever writer gets
 * the mutex second therefore reads the first one's committed state — the assertions are written as
 * <b>invariants over both legal interleavings</b>, not as one fixed schedule. The honest limit is the
 * one {@code RoleUpdateBindingRaceTest} states: this is a deterministic-DB harness, not a proof; it
 * cannot enumerate every scheduler interleaving.</p>
 *
 * <p><b>Counter-example contract</b> (recorded in the PLAN evidence): every method here turns red when
 * the subset gate is removed from {@code RoleAdminService.update} /
 * {@code BindingAdminService.replace} — either the expected 403 becomes a successful write
 * ({@link #assertThrows} fails) or the "atom never lands in the wrong scope" invariant breaks.</p>
 */
class RoleUpdateBindingConcurrencyMatrixTest extends AbstractIntegrationTest {

    private static final String READ = ToolFaceRegistry.ACTION_READ;
    private static final String UWR = ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME;
    private static final String WS_ADMIN = PermissionAtomCatalog.CAP_WORKSPACE_ADMIN;

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private RoleAdminService roleAdmin;
    @Autowired private BindingAdminService bindingAdmin;
    @Autowired private AuthzContext authzContext;
    @Autowired private JdbcTemplate jdbcTemplate;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    // ── ① user target, workspace scope ───────────────────────────────────────

    /**
     * The author reaches workspace A fully and workspace B only partially ({@code read} +
     * {@code MANAGE_WORKSPACE_AGENTS}); the role carries {@code read} and is bound in A. One writer
     * adds {@code USE_WORKSPACE_RUNTIME} to the role (held in A only), the other binds the role for a
     * new user in B.
     *
     * <p>Exactly one writer must be refused, in every interleaving: if the bind commits first the
     * update sees a B-scoped binding and refuses; if the update commits first the bind reads the new
     * definition and refuses. {@code USE_WORKSPACE_RUNTIME} must never reach a workspace-B grant.</p>
     */
    @Test
    void userBindingRaceAcrossWorkspacesNeverMaterialisesTheAtomTheAuthorLacksThere() throws Exception {
        User author = newUser("mtw");
        User custodian = newUser("mtwc");
        User holderA = newUser("mtwha");
        User holderB = newUser("mtwhb");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("mt-ws-a", author.getId().toString());
        Workspace workspaceB = workspaceFixture.createOwnedWorkspace("mt-ws-b", custodian.getId().toString());
        AccessRole instanceAuthority = newRole("MTAUTHI", List.of(ToolFaceRegistry.ACTION_MANAGE_ROLES));
        bindRole(instanceAuthority.getId(), author.getId(), AccessScope.instance());
        AccessRole workspaceAuthority = newRole("MTAUTHW",
                List.of(READ, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS));
        bindRole(workspaceAuthority.getId(), author.getId(), AccessScope.workspace(workspaceB.getId()));
        AccessRole role = newRole("MTW", List.of(READ));
        bindRole(role.getId(), holderA.getId(), AccessScope.workspace(workspaceA.getId()));
        // The PUT is a full replacement of workspace B's user binding set: restate what is already
        // there (the owner and the author's own helper role), otherwise the write would delete it.
        List<RoleAdminViews.BindingInput> desiredInB = List.of(
                new RoleAdminViews.BindingInput("user", custodian.getId(),
                        workspaceOwnerRoleId()),
                new RoleAdminViews.BindingInput("user", author.getId(), workspaceAuthority.getId()),
                new RoleAdminViews.BindingInput("user", holderB.getId(), role.getId()));

        int permissionsBefore = permissionsOf(role.getId());

        RaceOutcome outcome = race(
                () -> {
                    actAs(author);
                    roleAdmin.update(role.getId(),
                            new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, UWR)));
                },
                () -> {
                    actAs(author);
                    bindingAdmin.replace(AccessScope.WORKSPACE, workspaceB.getId().toString(),
                            desiredInB);
                });

        assertExactlyOneDenied(outcome, "update ∥ user-bind(A→B)");
        boolean updateWon = outcome.updateFailure() == null;
        List<String> roleAtoms = atomsOf(role.getId());

        // The escalation target: whatever happened, workspace B must not carry the atom.
        assertFalse(grantAtoms(holderB.getId(), AccessScope.WORKSPACE, workspaceB.getId()).contains(UWR),
                "the atom the author holds only in A must never be materialized in B");

        if (updateWon) {
            assertTrue(roleAtoms.contains(UWR), "the winning update must have committed: " + roleAtoms);
            assertEquals(permissionsBefore + 1, permissionsOf(role.getId()));
            assertEquals(0L, bindingsOfRoleInScope(role.getId(), AccessScope.WORKSPACE, workspaceB.getId()),
                    "the refused bind writes no role_binding row");
            assertEquals(Set.of(), Set.copyOf(
                            grantAtoms(holderB.getId(), AccessScope.WORKSPACE, workspaceB.getId())),
                    "the refused bind writes no grants row");
            assertTrue(grantAtoms(holderA.getId(), AccessScope.WORKSPACE, workspaceA.getId()).contains(UWR),
                    "the existing A-scoped holder gains the atom (the update won legitimately)");
        } else {
            assertEquals(List.of(READ), roleAtoms,
                    "the refused update writes nothing to role_permissions");
            assertEquals(1L, bindingsOfRoleInScope(role.getId(), AccessScope.WORKSPACE, workspaceB.getId()),
                    "the winning bind wrote exactly one role_binding row");
            assertEquals(Set.of(READ), Set.copyOf(
                    grantAtoms(holderB.getId(), AccessScope.WORKSPACE, workspaceB.getId())));
        }
    }

    // ── ② instance scope ────────────────────────────────────────────────────

    /**
     * Same race at the instance scope: the role is bound in workspace A only, the author holds
     * {@code read} at the instance (plus A's owner set) and one writer binds the role at the instance.
     * "instance ⊇ workspace" means the A-scoped hold alone must not be enough to place
     * {@code USE_WORKSPACE_RUNTIME} at the instance, where it would cover every workspace.
     */
    @Test
    void instanceScopeRaceNeverMaterialisesTheWorkspaceOnlyAtomAtTheInstance() throws Exception {
        User author = newUser("mti");
        User holderA = newUser("mtiha");
        User holderB = newUser("mtihb");
        User root = newUser("mtiroot");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("mt-inst-a", author.getId().toString());
        UUID superAdminRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.SUPER_ADMIN)
                .orElseThrow().getId();
        bindRole(superAdminRoleId, root.getId(), AccessScope.instance());
        AccessRole instanceAuthority = newRole("MTAUTHI",
                List.of(READ, ToolFaceRegistry.ACTION_MANAGE_ROLES));
        bindRole(instanceAuthority.getId(), author.getId(), AccessScope.instance());
        AccessRole role = newRole("MTI", List.of(READ));
        bindRole(role.getId(), holderA.getId(), AccessScope.workspace(workspaceA.getId()));
        // A full replacement of the instance binding set must restate the existing rows (the last
        // SUPER_ADMIN is an invariant of this very write path).
        List<RoleAdminViews.BindingInput> desiredAtInstance = List.of(
                new RoleAdminViews.BindingInput("user", root.getId(), superAdminRoleId),
                new RoleAdminViews.BindingInput("user", author.getId(), instanceAuthority.getId()),
                new RoleAdminViews.BindingInput("user", holderB.getId(), role.getId()));
        int permissionsBefore = permissionsOf(role.getId());

        RaceOutcome outcome = race(
                () -> {
                    actAs(author);
                    roleAdmin.update(role.getId(),
                            new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, UWR)));
                },
                () -> {
                    actAs(author);
                    bindingAdmin.replace(AccessScope.INSTANCE, null, desiredAtInstance);
                });

        assertExactlyOneDenied(outcome, "update ∥ user-bind(workspace A → instance)");
        boolean updateWon = outcome.updateFailure() == null;
        List<String> roleAtoms = atomsOf(role.getId());

        assertFalse(grantAtoms(holderB.getId(), AccessScope.INSTANCE, null).contains(UWR),
                "an instance-scope grant must never carry a workspace-only hold of the author");

        if (updateWon) {
            assertTrue(roleAtoms.contains(UWR), "the winning update committed: " + roleAtoms);
            assertEquals(permissionsBefore + 1, permissionsOf(role.getId()));
            assertEquals(0L, bindingsOfRoleInScope(role.getId(), AccessScope.INSTANCE, null),
                    "the refused instance bind writes no role_binding row");
            assertEquals(Set.of(), Set.copyOf(grantAtoms(holderB.getId(), AccessScope.INSTANCE, null)));
        } else {
            assertEquals(List.of(READ), roleAtoms,
                    "the refused update writes nothing to role_permissions");
            assertEquals(1L, bindingsOfRoleInScope(role.getId(), AccessScope.INSTANCE, null),
                    "the winning instance bind wrote exactly one role_binding row");
            assertEquals(Set.of(READ), Set.copyOf(grantAtoms(holderB.getId(), AccessScope.INSTANCE, null)));
        }
    }

    // ── ③ capability atom ───────────────────────────────────────────────────

    /**
     * The capability dimension. {@code AuthzContext} answers capability questions straight from
     * {@code role_permissions} × bindings, so a capability atom is effective the instant the role
     * update commits — no materialized grant row stands in the way. The role is already bound in A and
     * B; the author owns A (hence holds {@code workspace:admin} there) but not B. The update therefore
     * has to be refused <b>deterministically</b>, whichever writer wins, and the concurrent bind of
     * another subject in B must still succeed with the unchanged definition.
     *
     * <p>The positive control at the end (the same call, allowed once the author also owns B) keeps
     * the refusal from being a blanket "capabilities are never addable" test.</p>
     */
    @Test
    void capabilityAtomRaceIsRefusedAndNeverBecomesEffectiveInTheOtherWorkspace() throws Exception {
        User author = newUser("mtc");
        User custodian = newUser("mtcc");
        User holderA = newUser("mtcha");
        User holderB = newUser("mtchb");
        User holderC = newUser("mtchc");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("mt-cap-a", author.getId().toString());
        Workspace workspaceB = workspaceFixture.createOwnedWorkspace("mt-cap-b", custodian.getId().toString());
        AccessRole instanceAuthority = newRole("MTAUTHI", List.of(ToolFaceRegistry.ACTION_MANAGE_ROLES));
        bindRole(instanceAuthority.getId(), author.getId(), AccessScope.instance());
        AccessRole workspaceAuthority = newRole("MTAUTHW",
                List.of(READ, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS));
        bindRole(workspaceAuthority.getId(), author.getId(), AccessScope.workspace(workspaceB.getId()));
        AccessRole role = newRole("MTC", List.of(READ));
        bindRole(role.getId(), holderA.getId(), AccessScope.workspace(workspaceA.getId()));
        bindRole(role.getId(), holderB.getId(), AccessScope.workspace(workspaceB.getId()));
        List<RoleAdminViews.BindingInput> desiredInB = List.of(
                new RoleAdminViews.BindingInput("user", custodian.getId(),
                        workspaceOwnerRoleId()),
                new RoleAdminViews.BindingInput("user", author.getId(), workspaceAuthority.getId()),
                new RoleAdminViews.BindingInput("user", holderB.getId(), role.getId()),
                new RoleAdminViews.BindingInput("user", holderC.getId(), role.getId()));
        long permissionsBefore = permissionsOf(role.getId());
        long bindingsBefore = bindingsOfRole(role.getId());

        RaceOutcome outcome = race(
                () -> {
                    actAs(author);
                    roleAdmin.update(role.getId(),
                            new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, WS_ADMIN)));
                },
                () -> {
                    actAs(author);
                    bindingAdmin.replace(AccessScope.WORKSPACE, workspaceB.getId().toString(),
                            desiredInB);
                });

        assertNotNull(outcome.updateFailure(),
                "the capability update must be refused: the author does not hold workspace:admin in B");
        assertPrivilegeEscalation(outcome.updateFailure());
        assertTrue(String.valueOf(outcome.updateFailure().getMessage()).contains(WS_ADMIN),
                "the refusal names the capability atom: " + outcome.updateFailure().getMessage());
        assertNull(outcome.bindFailure(),
                "the concurrent bind only grants read, which the author holds in B: "
                        + outcome.bindFailure());

        assertEquals(permissionsBefore, permissionsOf(role.getId()),
                "the refused capability update writes nothing to role_permissions");
        assertEquals(List.of(READ), atomsOf(role.getId()));
        assertEquals(bindingsBefore + 1L, bindingsOfRole(role.getId()),
                "the concurrent bind added exactly one row");
        assertEquals(Set.of(READ), Set.copyOf(
                grantAtoms(holderC.getId(), AccessScope.WORKSPACE, workspaceB.getId())));

        authzContext.invalidate(holderB.getId());
        authzContext.invalidate(holderC.getId());
        assertFalse(authzContext.capabilitiesFor(holderB.getId()).holdsCapability(WS_ADMIN,
                workspaceB.getId()), "a B-scoped holder must not inherit a refused capability grant");
        assertFalse(authzContext.capabilitiesFor(holderC.getId()).holdsCapability(WS_ADMIN,
                workspaceB.getId()), "a B-scoped holder must not inherit a refused capability grant");

        // Positive control: once the author reaches every binding scope, the same edit is allowed and
        // the capability really does become effective for the B-scoped holder.
        workspaceFixture.bindWorkspaceRole(workspaceB.getId(), author.getId(),
                com.cc01cc.p.xihe.cp.entity.WorkspaceRole.OWNER);
        authzContext.invalidate(author.getId());
        actAs(author);
        roleAdmin.update(role.getId(),
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, WS_ADMIN)));

        assertEquals(List.of(READ, WS_ADMIN), atomsOf(role.getId()),
                "the same edit applies once the author holds the capability in every bound scope");
        authzContext.invalidate(holderB.getId());
        assertTrue(authzContext.capabilitiesFor(holderB.getId()).holdsCapability(WS_ADMIN,
                workspaceB.getId()), "the positive control must be observable through AuthzContext");
    }

    // ── ④ zero partial write per combination ────────────────────────────────

    /** User target, workspace scope: the 403 leaves {@code role_permissions}/{@code role_bindings}/{@code grants} alone. */
    @Test
    void deniedWorkspaceScopeUpdateWritesNothingToTheThreeTables() {
        User author = newUser("mzw");
        User holderA = newUser("mzwha");
        User holderB = newUser("mzwhb");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("mz-ws-a", author.getId().toString());
        Workspace workspaceB = workspaceFixture.createOwnedWorkspace("mz-ws-b", newUser("mzwc").getId().toString());
        AccessRole role = newRole("MZW", List.of(READ));
        bindRole(role.getId(), holderA.getId(), AccessScope.workspace(workspaceA.getId()));
        bindRole(role.getId(), holderB.getId(), AccessScope.workspace(workspaceB.getId()));
        long permissionsBefore = permissionsOf(role.getId());
        long bindingsBefore = bindingsOfRole(role.getId());
        long grantsBefore = totalGrants();

        actAs(author);
        CpApiException denied = assertThrows(CpApiException.class, () -> roleAdmin.update(role.getId(),
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, UWR))));

        assertPrivilegeEscalation(denied);
        assertEquals(permissionsBefore, permissionsOf(role.getId()), "role_permissions untouched");
        assertEquals(bindingsBefore, bindingsOfRole(role.getId()), "role_bindings untouched");
        assertEquals(grantsBefore, totalGrants(), "grants untouched");
    }

    /** Instance scope: the 403 leaves all three tables alone. */
    @Test
    void deniedInstanceScopeUpdateWritesNothingToTheThreeTables() {
        User author = newUser("mzi");
        User holder = newUser("mziha");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("mz-inst-a", author.getId().toString());
        AccessRole role = newRole("MZI", List.of(READ));
        bindRole(role.getId(), holder.getId(), AccessScope.instance());
        long permissionsBefore = permissionsOf(role.getId());
        long bindingsBefore = bindingsOfRole(role.getId());
        long grantsBefore = totalGrants();

        actAs(author);
        CpApiException denied = assertThrows(CpApiException.class, () -> roleAdmin.update(role.getId(),
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, UWR))));

        assertPrivilegeEscalation(denied);
        assertEquals(permissionsBefore, permissionsOf(role.getId()), "role_permissions untouched");
        assertEquals(bindingsBefore, bindingsOfRole(role.getId()), "role_bindings untouched");
        assertEquals(grantsBefore, totalGrants(), "grants untouched");
        assertTrue(grantAtoms(holder.getId(), AccessScope.INSTANCE, null).size() == 1,
                "the instance holder keeps exactly the pre-update atom set");
        assertTrue(workspaceA != null);
    }

    /** Capability: the 403 leaves all three tables alone (capabilities have no grant row of their own). */
    @Test
    void deniedCapabilityUpdateWritesNothingToTheThreeTables() {
        User author = newUser("mzc");
        User custodian = newUser("mzcc");
        User holderA = newUser("mzcha");
        User holderB = newUser("mzchb");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("mz-cap-a", author.getId().toString());
        Workspace workspaceB = workspaceFixture.createOwnedWorkspace("mz-cap-b", custodian.getId().toString());
        AccessRole role = newRole("MZC", List.of(READ));
        bindRole(role.getId(), holderA.getId(), AccessScope.workspace(workspaceA.getId()));
        bindRole(role.getId(), holderB.getId(), AccessScope.workspace(workspaceB.getId()));
        long permissionsBefore = permissionsOf(role.getId());
        long bindingsBefore = bindingsOfRole(role.getId());
        long grantsBefore = totalGrants();

        actAs(author);
        CpApiException denied = assertThrows(CpApiException.class, () -> roleAdmin.update(role.getId(),
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, WS_ADMIN))));

        assertPrivilegeEscalation(denied);
        assertTrue(denied.getMessage().contains(WS_ADMIN), denied.getMessage());
        assertEquals(permissionsBefore, permissionsOf(role.getId()), "role_permissions untouched");
        assertEquals(bindingsBefore, bindingsOfRole(role.getId()), "role_bindings untouched");
        assertEquals(grantsBefore, totalGrants(), "grants untouched");
    }

    // ── race harness (latches only, no sleeps) ──────────────────────────────

    private record RaceOutcome(Throwable updateFailure, Throwable bindFailure) {
    }

    private RaceOutcome race(Runnable update, Runnable bind) throws InterruptedException {
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        AtomicReference<Throwable> updateFailure = new AtomicReference<>();
        AtomicReference<Throwable> bindFailure = new AtomicReference<>();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        pool.execute(writer(update, ready, start, updateFailure));
        pool.execute(writer(bind, ready, start, bindFailure));
        try {
            boolean bothReady = ready.await(30, TimeUnit.SECONDS);
            start.countDown();
            assertTrue(bothReady, "both writers must reach the start gate");
            pool.shutdown();
            assertTrue(pool.awaitTermination(120, TimeUnit.SECONDS), "both writers must terminate");
        } finally {
            pool.shutdownNow();
        }
        return new RaceOutcome(updateFailure.get(), bindFailure.get());
    }

    private static Runnable writer(Runnable body, CountDownLatch ready, CountDownLatch start,
                                   AtomicReference<Throwable> failure) {
        return () -> {
            ready.countDown();
            try {
                if (!start.await(30, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("the race start gate was never opened");
                }
                body.run();
            } catch (Throwable throwable) {
                failure.set(throwable);
            }
        };
    }

    /**
     * Exactly one writer is refused, and that refusal is the grant-side 403. Anything else (both
     * succeeded / both failed / a 409 or an infrastructure error) is a regression, not an
     * interleaving.
     */
    private static void assertExactlyOneDenied(RaceOutcome outcome, String label) {
        boolean updateDenied = outcome.updateFailure() != null;
        boolean bindDenied = outcome.bindFailure() != null;
        assertNotEquals(updateDenied, bindDenied, label + ": exactly one writer must be refused, got"
                + " update=" + outcome.updateFailure() + " bind=" + outcome.bindFailure());
        assertPrivilegeEscalation(updateDenied ? outcome.updateFailure() : outcome.bindFailure());
    }

    private static void assertPrivilegeEscalation(Throwable failure) {
        assertNotNull(failure, "expected a 403 PRIVILEGE_ESCALATION refusal");
        assertTrue(failure instanceof CpApiException, "unexpected refusal type: " + failure);
        CpApiException denied = (CpApiException) failure;
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus(), denied.getMessage());
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode(), denied.getMessage());
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }

    private void actAs(User user) {
        TenantContext.setUserId(user.getId().toString());
    }

    private AccessRole newRole(String prefix, List<String> atoms) {
        String name = prefix + "_" + UUID.randomUUID().toString().replace("-", "")
                .substring(0, 8).toUpperCase();
        AccessRole role = accessRoleRepository.saveAndFlush(new AccessRole(
                UUID.randomUUID(), name, name, null, false));
        for (String atom : atoms) {
            PermissionAtomCatalog.Atom ref = PermissionAtomCatalog.atom(atom);
            permissionRepository.saveAndFlush(
                    new AccessRolePermission(role.getId(), ref.name(), ref.canonicalResource()));
        }
        return role;
    }

    /** The seeded workspace-owner role (kept in the restated binding set so the write is legal). */
    private UUID workspaceOwnerRoleId() {
        return accessRoleRepository.findByName(SystemAccessRoleCatalog.WS_OWNER).orElseThrow().getId();
    }

    private void bindRole(UUID roleId, UUID subjectId, AccessScope scope) {
        bindingRepository.saveAndFlush(new AccessRoleBinding(roleId, "user", subjectId,
                scope.type(), scope.id(), subjectId));
        materializer.materializeSubject("user", subjectId, subjectId, null);
    }

    private int permissionsOf(UUID roleId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM role_permissions WHERE role_id = ?", Integer.class, roleId);
    }

    private long bindingsOfRole(UUID roleId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM role_bindings WHERE role_id = ?", Long.class, roleId);
    }

    private long bindingsOfRoleInScope(UUID roleId, String scopeType, UUID scopeId) {
        if (scopeId == null) {
            return jdbcTemplate.queryForObject("SELECT count(*) FROM role_bindings WHERE role_id = ?"
                    + " AND scope_type = ? AND scope_id IS NULL", Long.class, roleId, scopeType);
        }
        return jdbcTemplate.queryForObject("SELECT count(*) FROM role_bindings WHERE role_id = ?"
                + " AND scope_type = ? AND scope_id = ?", Long.class, roleId, scopeType, scopeId);
    }

    /** Every grant row of the fixture universe for this class (fixture users only, never the seed rows). */
    private long totalGrants() {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM grants WHERE subject_type = 'user'",
                Long.class);
    }

    private List<String> atomsOf(UUID roleId) {
        return jdbcTemplate.queryForList(
                "SELECT action_class FROM role_permissions WHERE role_id = ? ORDER BY action_class",
                String.class, roleId);
    }

    private List<String> grantAtoms(UUID subjectId, String scopeType, UUID scopeId) {
        if (scopeId == null) {
            return jdbcTemplate.queryForList("SELECT a->>'actionClass' FROM grants g,"
                            + " jsonb_array_elements(g.permissions) a WHERE g.subject_type = 'user'"
                            + " AND g.subject_id = ? AND g.scope_type = ? AND g.scope_id IS NULL",
                    String.class, subjectId, scopeType);
        }
        return jdbcTemplate.queryForList("SELECT a->>'actionClass' FROM grants g,"
                        + " jsonb_array_elements(g.permissions) a WHERE g.subject_type = 'user'"
                        + " AND g.subject_id = ? AND g.scope_type = ? AND g.scope_id = ?",
                String.class, subjectId, scopeType, scopeId);
    }
}
