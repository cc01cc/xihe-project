package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0407 T2.9 matrix, re-based on PLAN-0610 role materialization (W1a T1.5/T1.6).
 *
 * <p>The contract is unchanged — {@code USER} = 注册最小集, {@code ADMIN} = 全 allow 的一个集
 * including the PLAN-0496 credential atoms — but the storage shape moved: the set is no longer one
 * {@code source='default'} row, it is the union of {@code source='role'} rows (one row per atom,
 * V87 {@code uq_grants_role_atom}) produced by {@link RoleGrantMaterializer}. Capability atoms are
 * part of the role definition and are <b>not</b> materialized (design #23), which is why ADMIN's
 * action atoms (and not its capability atoms) appear in {@code grants}.</p>
 *
 * <p>Deliberately NOT duplicated here: bootstrap idempotency and concurrency
 * ({@code GrantDefaultBootstrapIntegrationTest}), scope isolation
 * ({@code GrantScopeIsolationIntegrationTest}), schema conformance
 * ({@code SpecFieldConformanceTest}), out-of-vocabulary fail-closed ({@code LookupAskGateTest}) and
 * HardGuard L0 counter-proofs ({@code HardGuardTest}).</p>
 */
class DefaultSetMatrixTest extends AbstractIntegrationTest {

    /**
     * spec §4.1 USER row / evidence matrix USER column, extended by PLAN-0622 D8: the five allow
     * rows plus CREATE_OWN_AGENT (an ordinary account may create its own PERSONAL agent principal).
     * credential atoms stay denied.
     */
    private static final Set<String> USER_MATRIX = Set.of(
            "read", "write", "delete", "exec", "network", "CREATE_OWN_AGENT",
            // BL-345 (user ruling 2026-11-06): every account may write memory of the principals
            // it owns; writing arbitrary subjects stays an owner/SUPER_ADMIN atom.
            "MEMORY_WRITE_SELF",
            // PLAN-0691 T1.3 (M1) spec B-4: invoking an already-bound BUILTIN plugin is in the base
            // set (install ≠ grant; a third-party plugin has no default at all).
            "PLUGIN_INVOKE");

    /**
     * spec §4.1 ADMIN row / evidence matrix full-allow column: five rows plus the
     * PLAN-0496 three credential atoms (the legacy single `credential` word retired).
     */
    private static final Set<String> ADMIN_MATRIX = Set.of(
            "read", "write", "delete", "exec", "network", "CREATE_OWN_AGENT",
            "credential_use", "credential_reveal", "credential_manage",
            // PLAN-0651 M1 (D51-26): the two faces that used to be an isInstanceAdmin() bypass.
            // These are action atoms and therefore materialize; workspace:admin does NOT (capability).
            "MANAGE_AGENT_PRINCIPALS", "MANAGE_WORKSPACE_MEMBERS",
            // PLAN-0651 M2 T2.1: the eight P1 atoms are part of the fixed instance-administrator
            // set (D51-27). 20 action atoms + these 8 = 28, plus GRANT_ANY_ATOM (PLAN-0673 M2,
            // D-166) = 29 (see SkillReadFaceTest for the count). MEMORY_WRITE_SELF (BL-345) is in
            // USER's set above and therefore inherited here.
            "READ_INSTANCE_CONTENT", "WRITE_INSTANCE_CONTENT", "VIEW_SECRET_CONTENT",
            "MANAGE_SKILL_LIBRARY", "MANAGE_PROVIDER_CONNECTIONS", "USE_WORKSPACE_RUNTIME",
            "MANAGE_WORKSPACE_RUNTIME", "MANAGE_WORKSPACE_POLICY",
            // D-168 (2026-11-05 user ruling) + migration V125: ADMIN administers roles/bindings, so
            // MANAGE_ROLES is part of its default set. The subset guard (PLAN-0673 M1) still bounds
            // what it can delegate, and GRANT_ANY_ATOM stays SUPER_ADMIN-only (D-166).
            "MANAGE_ROLES",
            // BL-345: ADMIN inherits the USER default set (SELF), but not MEMORY_WRITE (any subject).
            "MEMORY_WRITE_SELF",
            // PLAN-0691 T1.3 (M1): the four plugin atoms make the count 33; ADMIN (the fixed
            // instance-administrator set) holds manage + bind, inherits invoke from USER's set, and
            // never holds PLUGIN_DATA (the data plane belongs to a binding, not to a person).
            "PLUGIN_MANAGE", "PLUGIN_BIND", "PLUGIN_INVOKE");

    /** spec §2.1: vocabulary members that never enter a built-in default set. */
    private static final List<String> OUT_OF_DEFAULT_VOCABULARY = List.of(
            "CREATE_ACCOUNT", "CREATE_TEMPLATE", "MANAGE_WORKSPACE_AGENTS", "SPAWN_AGENT");

    @Autowired
    private AuthService authService;

    @Autowired
    private AccessRoleRepository accessRoleRepository;

    @Autowired
    private AccessRoleBindingRepository accessRoleBindingRepository;

    @Autowired
    private RoleGrantMaterializer roleGrantMaterializer;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService;

    @Autowired
    private GrantAuthorizationService grantAuthorizationService;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private AuditLogRepository auditLogRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private ObjectMapper objectMapper;

    private String userId;
    private String workspaceId;

    @AfterEach
    void cleanFixtures() {
        if (userId == null) {
            return;
        }
        UUID userUuid = UUID.fromString(userId);
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userUuid));
        auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .filter(row -> "authorization_role_grant_materialized".equals(row.getAction()))
                .map(AuditLog::getId)
                .forEach(auditLogRepository::deleteById);
        if (workspaceId != null) {
            UUID workspaceUuid = UUID.fromString(workspaceId);
            workspaceFixture.unbindWorkspace(workspaceUuid);
            workspaceRepository.deleteById(workspaceUuid);
        }
        userRepository.deleteById(userUuid);
    }

    /** spec §4.1 USER row + evidence matrix USER column, behaviorally re-checked by the evaluator. */
    @Test
    void registeredUserDefaultGrantMatchesSpec41AndTheEvidenceMatrixUserRow() {
        register();

        Set<String> userAtoms = materializedAtoms("user", UUID.fromString(userId));
        assertEquals(USER_MATRIX, userAtoms,
                "spec §4.1 USER row (注册最小集) and the evidence matrix USER column agree: "
                        + "read/write/delete/exec/network allow, credential absent");
        assertTrue(userAtoms.stream().noneMatch(actionClass -> actionClass.startsWith("credential_")),
                "evidence matrix: credential = deny for USER, so no credential atom may exist "
                        + "(未列即 deny, spec §2.1)");
        assertCanonicalAtoms("user", UUID.fromString(userId));

        for (String actionClass : USER_MATRIX) {
            assertTrue(grantAuthorizationService.allowsUserOnly(request(actionClass, "notes/today.md")),
                    "behavioral: the evaluator allows " + actionClass
                            + " on an own-workspace resource (evidence matrix USER column)");
        }
        assertTrue(grantAuthorizationService.allowsUserOnly(request("read", "projects/2026/notes.md")),
                "spec §3.1: a missing resource field means '*', so a nested own-workspace "
                        + "path still evaluates allow");
        assertFalse(grantAuthorizationService.allowsUserOnly(
                        request("credential_use", "credential:" + UUID.randomUUID())),
                "evidence matrix V12 zero-over-privilege sample: credential stays denied "
                        + "for the default USER grant (PLAN-0496 atoms)");
    }

    /**
     * spec §4.1 ADMIN row + evidence matrix full-allow column, incl. the credential behavior.
     *
     * <p>PLAN-0610 W1b T1.9: the bootstrap admin is seeded with the SUPER_ADMIN instance binding
     * (invariant I1), so the ADMIN matrix is verified through an explicit ADMIN binding instead of
     * the seeded account — that keeps this assertion about the role, not about the seed.</p>
     */
    @Test
    void adminRoleBindingMatchesSpec41AndTheEvidenceMatrixFullAllowColumn() {
        register();
        UUID userUuid = UUID.fromString(userId);
        AccessRole adminRole = accessRoleRepository.findByName(SystemAccessRoleCatalog.ADMIN)
                .orElseThrow();
        accessRoleBindingRepository.deleteAll(
                accessRoleBindingRepository.findBySubjectTypeAndSubjectId("user", userUuid));
        accessRoleBindingRepository.save(new AccessRoleBinding(adminRole.getId(), "user", userUuid,
                AccessScope.INSTANCE, null, userUuid));
        roleGrantMaterializer.materializeSubject("user", userUuid, userUuid, null);

        Set<String> adminAtoms = materializedAtoms("user", userUuid);
        assertEquals(ADMIN_MATRIX, adminAtoms,
                "spec §4.1 ADMIN row = 全 allow 的一个集: five rows plus the PLAN-0496 credential "
                        + "atoms and the PLAN-0651 management atoms (agent principals/members)");
        assertCanonicalAtoms("user", userUuid);
        assertFalse(adminAtoms.contains("SPAWN_AGENT"),
                "spec §2.1: SPAWN_AGENT stays out of the ADMIN set");
        assertFalse(adminAtoms.contains(PermissionAtomCatalog.CAP_INSTANCE_ADMIN),
                "PLAN-0610 #23: capability atoms are authorities, never grant rows");
        assertTrue(authzContext.isInstanceAdmin(userUuid),
                "the ADMIN role's instance:admin atom resolves as cap:instance:admin");
        assertFalse(authzContext.isInstanceSuper(userUuid), "ADMIN is not SUPER_ADMIN");

        String adminUserId = userUuid.toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, adminUserId, WorkspaceRole.MEMBER);
        assertTrue(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                        "probe_tool", List.of("credential_use"), List.of("credential:" + UUID.randomUUID()),
                        ToolShape.STRUCTURED, adminUserId, workspaceId, null)),
                "behavioral: the ADMIN set (credential_use@credential:*) covers a concrete "
                        + "credential id (evidence matrix ADMIN column, PLAN-0496 #2)");
        assertFalse(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                        "probe_tool", List.of("SPAWN_AGENT"), List.of("*"),
                        ToolShape.STRUCTURED, adminUserId, workspaceId, null)),
                "spec §2.1: even the full-allow ADMIN set denies SPAWN_AGENT (无 grant 在 approval 之前拒绝)");
    }

    /** PLAN-0610 W1b T1.9: the bootstrap admin holds SUPER_ADMIN (all action atoms). */
    @Test
    void seededAdminIsSuperAdminWithEveryActionAtom() {
        User admin = userRepository.findByEmail("admin@xihe.local").orElseThrow();
        assertEquals(new LinkedHashSet<>(PermissionAtomCatalog.actionAtoms()),
                materializedAtoms("user", admin.getId()),
                "SUPER_ADMIN materializes all action atoms (17 since PLAN-0629 MEMORY_WRITE)");
        assertTrue(authzContext.isInstanceSuper(admin.getId()),
                "and resolves cap:instance:super from the seeded binding");
    }

    /** spec §3.1/§2.1 未列即 deny: vocabulary classes absent from the grant evaluate deny. */
    @Test
    void unlistedInVocabularyActionClassesAreDeniedByTheDefaultGrant() {
        register();
        assertTrue(ToolFaceRegistry.builtinActionClasses().containsAll(OUT_OF_DEFAULT_VOCABULARY),
                "these action classes are inside the permission vocabulary (spec §2.1), so their "
                        + "deny must come from 未列即 deny rather than a vocabulary miss");

        // PLAN-0610 W3-3: registration also creates a personal workspace and binds the creator to
        // WS_OWNER, which legitimately carries MANAGE_WORKSPACE_AGENTS *in that workspace*. The
        // default-set claim is about what the USER tier grants anywhere, so probe a workspace the
        // subject does not own.
        String foreignWorkspaceId = foreignWorkspaceId();
        for (String actionClass : OUT_OF_DEFAULT_VOCABULARY) {
            assertFalse(grantAuthorizationService.allowsUserOnly(
                            request(actionClass, "*", foreignWorkspaceId)),
                    "spec §3.1: permissions carry no effect; an in-vocabulary action class the "
                            + "default grant does not list is denied: " + actionClass);
        }
        assertTrue(grantAuthorizationService.allowsUserOnly(request("read", "notes/today.md")),
                "control: the listed classes of the same grant still evaluate allow");
    }

    /** spec §3.1/G1: other sources still union with the materialized role rows. */
    @Test
    void extraSourceAtomsUnionWithTheMaterializedRoleRows() {
        register();
        UUID userUuid = UUID.fromString(userId);
        assertEquals(USER_MATRIX.size(), roleRows("user", userUuid).size(),
                "PLAN-0610: one materialized row per atom (uq_grants_role_atom)");
        String credentialId = "credential:" + UUID.randomUUID();
        assertFalse(grantAuthorizationService.allowsUserOnly(request("credential_use", credentialId)),
                "control: the default matrix alone carries no credential");

        User admin = userRepository.findByEmail("admin@xihe.local").orElseThrow();
        AuthorizationGrant snapshot = new AuthorizationGrant();
        snapshot.setId(UUID.randomUUID());
        snapshot.setSubjectType("user");
        snapshot.setSubjectId(userUuid);
        snapshot.setGranterType("user");
        snapshot.setGranterId(admin.getId());
        // PLAN-0610 T1.6: `template` is one of the union sources; the retired `direct` source is
        // no longer read (T1.13 moves credential bindings to `credential_binding`).
        snapshot.setSource(GrantSources.TEMPLATE);
        snapshot.setScopeType(AccessScope.INSTANCE);
        ArrayNode permissions = objectMapper.createArrayNode();
        ObjectNode credentialAtom = objectMapper.createObjectNode();
        credentialAtom.put("actionClass", "credential_use");
        credentialAtom.put("resource", credentialId);
        permissions.add(credentialAtom);
        snapshot.setPermissions(permissions);
        grantRepository.save(snapshot);

        assertEquals(USER_MATRIX.size(), roleRows("user", userUuid).size(),
                "an extra source must not create additional role rows");
        assertTrue(grantAuthorizationService.allowsUserOnly(request("credential_use", credentialId)),
                "G1: the current permission set is the union of all evaluation sources; the "
                        + "source label carries no precedence");
        assertTrue(grantAuthorizationService.allowsUserOnly(request("read", "notes/today.md")),
                "the role rows still grant the USER classes after the extra source is added");
        assertFalse(grantAuthorizationService.allowsUserOnly(request("SPAWN_AGENT", "*")),
                "the extra source only widened credential_use, never SPAWN_AGENT");
    }

    private void register() {
        // PLAN-0470 #25: reproduces the AuthController register orchestration.
        com.cc01cc.p.xihe.cp.entity.User user = authService.registerUser(new RegisterRequest(
                "default-matrix-" + UUID.randomUUID() + "@test.com", "matrix-test-password",
                "Default matrix test"));
        AuthResponse registered = authService.issueTokens(user, workspaceFixture.createOwnedWorkspace("Fixture Workspace", user.getId().toString()).getId().toString());
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
    }

    /**
     * The subject's <b>instance-tier</b> materialized rows. PLAN-0610 W3-3 registers a personal
     * workspace, whose WS_OWNER binding also materializes rows for the same user; this matrix is
     * about the instance default set, so the workspace scope is excluded here and covered by the
     * workspace-binding tests.
     */
    private List<AuthorizationGrant> roleRows(String subjectType, UUID subjectId) {
        return grantRepository.findBySubjectTypeAndSubjectIdAndSource(subjectType, subjectId,
                        GrantSources.ROLE).stream()
                .filter(grant -> AccessScope.INSTANCE.equals(grant.getScopeType()))
                .toList();
    }

    private Set<String> materializedAtoms(String subjectType, UUID subjectId) {
        Set<String> atoms = new LinkedHashSet<>();
        for (AuthorizationGrant grant : roleRows(subjectType, subjectId)) {
            for (JsonNode atom : grant.getPermissions()) {
                atoms.add(atom.get("actionClass").asText());
            }
        }
        return atoms;
    }

    /** spec §2.1: atoms are {actionClass[, resource]} only — no effect/priority/locked fields. */
    private void assertCanonicalAtoms(String subjectType, UUID subjectId) {
        Set<String> allowedFields = Set.of("actionClass", "resource");
        for (AuthorizationGrant grant : grantRows(subjectType, subjectId)) {
            for (JsonNode atom : grant.getPermissions()) {
                Set<String> fields = new LinkedHashSet<>();
                atom.fieldNames().forEachRemaining(fields::add);
                assertTrue(allowedFields.containsAll(fields),
                        "permission atoms carry only {actionClass, resource}: " + atom);
                JsonNode resource = atom.get("resource");
                String actionClass = atom.get("actionClass").asText();
                boolean canonical;
                if (actionClass.startsWith("credential_")) {
                    canonical = resource != null
                            && ToolFaceRegistry.isCanonicalCredentialResource(resource.asText());
                } else {
                    canonical = resource == null || "*".equals(resource.asText());
                }
                assertTrue(canonical,
                        "atom carries a canonical resource (spec §3.1 / PLAN-0496 #2): " + atom);
            }
        }
    }

    /** Every evaluation source of the subject, used by the canonical-atom assertion. */
    private List<AuthorizationGrant> grantRows(String subjectType, UUID subjectId) {
        return grantRepository.findBySubjectTypeAndSubjectId(subjectType, subjectId).stream()
                .filter(grant -> GrantSources.EVALUATION_SOURCES.contains(grant.getSource()))
                .filter(grant -> AccessScope.INSTANCE.equals(grant.getScopeType()))
                .toList();
    }

    private PolicyRequest request(String actionClass, String resource) {
        return request(actionClass, resource, workspaceId);
    }

    private PolicyRequest request(String actionClass, String resource, String probeWorkspaceId) {
        return new PolicyRequest("probe_tool", List.of(actionClass), List.of(resource),
                ToolShape.STRUCTURED, userId, probeWorkspaceId, null);
    }

    /** A workspace owned by someone else (the subject is not a member). */
    private String foreignWorkspaceId() {
        User other = userRepository.saveAndFlush(new User("matrix-foreign-" + UUID.randomUUID() + "@test.com", "hash",
                "Matrix foreign owner"));
        return workspaceFixture.createOwnedWorkspace("Matrix foreign workspace", other.getId().toString())
                .getId().toString();
    }
}


