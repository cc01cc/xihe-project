package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.AuthService;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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
 * PLAN-0407 T2.9: the default permission matrix of {@code source=default} grants, asserted
 * against BOTH contract sources at once:
 *
 * <ul>
 *   <li>spec §4.1/§4.2 ({@code plans/PLAN-0407-XH-principal-scope-derivation/spec/
 *       authorization-and-derivation.md}): {@code USER} = 注册最小集, {@code ADMIN} = 全 allow 的一个集;</li>
 *   <li>evidence matrix ({@code evidence/policy-domains-matrix.md}): the USER column allows
 *       read/write/delete/exec/network and denies credential; the ADMIN column is the
 *       full-allow column including credential.</li>
 * </ul>
 *
 * <p>Deliberately NOT duplicated here: bootstrap idempotency and concurrency
 * ({@code GrantDefaultBootstrapIntegrationTest}), partial index schema conformance
 * ({@code SpecFieldConformanceTest#grantsColumnsSourceVocabularyAndDefaultIndexConformToSpec31}),
 * out-of-vocabulary fail-closed ({@code LookupAskGateTest#outOfVocabularyActionClassIsDeniedByTheLookup
 * EvenWithDefaultGrants}) and HardGuard L0 counter-proofs ({@code HardGuardTest}).</p>
 */
class DefaultSetMatrixTest extends AbstractIntegrationTest {

    /** spec §4.1 USER row / evidence matrix USER column: five allow rows, credential deny. */
    private static final Set<String> USER_MATRIX = Set.of(
            "read", "write", "delete", "exec", "network");

    /** spec §4.1 ADMIN row / evidence matrix full-allow column: six allow rows incl. credential. */
    private static final Set<String> ADMIN_MATRIX = Set.of(
            "read", "write", "delete", "exec", "network", "credential");

    /** spec §2.1: vocabulary members that never enter a built-in default set. */
    private static final List<String> OUT_OF_DEFAULT_VOCABULARY = List.of(
            "CREATE_ACCOUNT", "CREATE_TEMPLATE", "MANAGE_WORKSPACE_AGENTS", "SPAWN_AGENT");

    @Autowired
    private AuthService authService;

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
    private WorkspaceUserRepository workspaceUserRepository;

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
                .filter(row -> "authorization_default_grant_created".equals(row.getAction()))
                .map(AuditLog::getId)
                .forEach(auditLogRepository::deleteById);
        if (workspaceId != null) {
            UUID workspaceUuid = UUID.fromString(workspaceId);
            workspaceUserRepository.deleteAll(workspaceUserRepository.findByIdWorkspaceId(workspaceUuid));
            workspaceRepository.deleteById(workspaceUuid);
        }
        userRepository.deleteById(userUuid);
    }

    /** spec §4.1 USER row + evidence matrix USER column, behaviorally re-checked by the evaluator. */
    @Test
    void registeredUserDefaultGrantMatchesSpec41AndTheEvidenceMatrixUserRow() {
        register();

        AuthorizationGrant userDefault = defaultGrant("user", UUID.fromString(userId));
        assertEquals(USER_MATRIX, actionClassesOf(userDefault),
                "spec §4.1 USER row (注册最小集) and the evidence matrix USER column agree: "
                        + "read/write/delete/exec/network allow, credential absent");
        assertFalse(actionClassesOf(userDefault).contains("credential"),
                "evidence matrix: credential = deny for USER, so the atom must not exist "
                        + "(未列即 deny, spec §2.1)");
        assertCanonicalAtoms(userDefault);

        for (String actionClass : USER_MATRIX) {
            assertTrue(grantAuthorizationService.allowsUserOnly(request(actionClass, "notes/today.md")),
                    "behavioral: the evaluator allows " + actionClass
                            + " on an own-workspace resource (evidence matrix USER column)");
        }
        assertTrue(grantAuthorizationService.allowsUserOnly(request("read", "projects/2026/notes.md")),
                "spec §3.1: a missing resource field means '*', so a nested own-workspace "
                        + "path still evaluates allow");
        assertFalse(grantAuthorizationService.allowsUserOnly(
                        request("credential", "provider_connections/*")),
                "evidence matrix V12 zero-over-privilege sample: credential stays denied "
                        + "for the default USER grant");
    }

    /** spec §4.1 ADMIN row + evidence matrix full-allow column, incl. the credential behavior. */
    @Test
    void seededAdminDefaultGrantMatchesSpec41AndTheEvidenceMatrixFullAllowColumn() {
        register();
        User admin = userRepository.findByEmail("admin@xihe.local").orElseThrow();

        AuthorizationGrant adminDefault = defaultGrant("user", admin.getId());
        assertEquals(ADMIN_MATRIX, actionClassesOf(adminDefault),
                "spec §4.1 ADMIN row = 全 allow 的一个集: exactly the six matrix action classes, "
                        + "credential included");
        assertCanonicalAtoms(adminDefault);
        assertFalse(actionClassesOf(adminDefault).contains("SPAWN_AGENT"),
                "spec §2.1: SPAWN_AGENT stays out of the USER/ADMIN default sets even for ADMIN");

        String adminUserId = admin.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, adminUserId, WorkspaceRole.MEMBER));
        assertTrue(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                        "probe_tool", List.of("credential"), List.of("provider_connections/*"),
                        ToolShape.STRUCTURED, adminUserId, workspaceId, null)),
                "behavioral: the seeded ADMIN default evaluates allow for credential "
                        + "(evidence matrix ADMIN column)");
        assertFalse(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                        "probe_tool", List.of("SPAWN_AGENT"), List.of("*"),
                        ToolShape.STRUCTURED, adminUserId, workspaceId, null)),
                "spec §2.1: even the full-allow ADMIN set denies SPAWN_AGENT (无 grant 在 approval 之前拒绝)");
    }

    /** spec §3.1/§2.1 未列即 deny: vocabulary classes absent from the grant evaluate deny. */
    @Test
    void unlistedInVocabularyActionClassesAreDeniedByTheDefaultGrant() {
        register();
        assertTrue(ToolFaceRegistry.builtinActionClasses().containsAll(OUT_OF_DEFAULT_VOCABULARY),
                "these action classes are inside the permission vocabulary (spec §2.1), so their "
                        + "deny must come from 未列即 deny rather than a vocabulary miss");

        for (String actionClass : OUT_OF_DEFAULT_VOCABULARY) {
            assertFalse(grantAuthorizationService.allowsUserOnly(request(actionClass, "*")),
                    "spec §3.1: permissions carry no effect; an in-vocabulary action class the "
                            + "default grant does not list is denied: " + actionClass);
        }
        assertTrue(grantAuthorizationService.allowsUserOnly(request("read", "notes/today.md")),
                "control: the listed classes of the same grant still evaluate allow");
    }

    /** spec §3.1: many non-default grants per subject, at most one default row (G1 union). */
    @Test
    void directGrantUnionsWithTheSingleDefaultGrantWithoutCreatingASecondDefault() {
        register();
        UUID userUuid = UUID.fromString(userId);
        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                        "user", userUuid, "default"),
                "spec §3.1: registration materializes exactly one default row per subject "
                        + "(uq_grants_default_subject)");
        assertFalse(grantAuthorizationService.allowsUserOnly(request("credential", "provider_connections/*")),
                "control: the default matrix alone carries no credential");

        User admin = userRepository.findByEmail("admin@xihe.local").orElseThrow();
        AuthorizationGrant direct = new AuthorizationGrant();
        direct.setId(UUID.randomUUID());
        direct.setSubjectType("user");
        direct.setSubjectId(userUuid);
        direct.setGranterType("user");
        direct.setGranterId(admin.getId());
        direct.setSource("direct");
        ArrayNode permissions = objectMapper.createArrayNode();
        ObjectNode credentialAtom = objectMapper.createObjectNode();
        credentialAtom.put("actionClass", "credential");
        permissions.add(credentialAtom);
        direct.setPermissions(permissions);
        grantRepository.save(direct);

        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                        "user", userUuid, "default"),
                "spec §3.1: an extra direct grant must not create a second default row");
        assertEquals(2, grantRepository.findBySubjectTypeAndSubjectId("user", userUuid).size(),
                "spec §3.1: spawn/direct/template grants may be many for one subject");
        assertTrue(grantAuthorizationService.allowsUserOnly(request("credential", "provider_connections/*")),
                "G1: the current permission set is the union of all grants; source carries "
                        + "no precedence, so the direct grant widens the union");
        assertTrue(grantAuthorizationService.allowsUserOnly(request("read", "notes/today.md")),
                "the default row still grants the USER classes after the direct grant is added");
        assertFalse(grantAuthorizationService.allowsUserOnly(request("SPAWN_AGENT", "*")),
                "the direct grant only widened credential, never SPAWN_AGENT");
    }

    private void register() {
        // PLAN-0470 #25: reproduces the AuthController register orchestration.
        com.cc01cc.p.xihe.cp.entity.User user = authService.registerUser(new RegisterRequest(
                "default-matrix-" + UUID.randomUUID() + "@test.com", "matrix-test-password",
                "Default matrix test"));
        AuthResponse registered = authService.issueTokens(user, workspaceService
                .getOrCreateDefaultWorkspace(user.getId().toString()).getId().toString());
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
    }

    private AuthorizationGrant defaultGrant(String subjectType, UUID subjectId) {
        return grantRepository.findBySubjectTypeAndSubjectId(subjectType, subjectId).stream()
                .filter(grant -> "default".equals(grant.getSource()))
                .findFirst()
                .orElseThrow(() -> new AssertionError(
                        "no source=default grant exists for " + subjectType + " " + subjectId));
    }

    private static Set<String> actionClassesOf(AuthorizationGrant grant) {
        Set<String> actionClasses = new LinkedHashSet<>();
        for (JsonNode atom : grant.getPermissions()) {
            actionClasses.add(atom.get("actionClass").asText());
        }
        return actionClasses;
    }

    /** spec §2.1: atoms are {actionClass[, resource]} only — no effect/priority/locked fields. */
    private static void assertCanonicalAtoms(AuthorizationGrant grant) {
        Set<String> allowedFields = Set.of("actionClass", "resource");
        for (JsonNode atom : grant.getPermissions()) {
            Set<String> fields = new LinkedHashSet<>();
            atom.fieldNames().forEachRemaining(fields::add);
            assertTrue(allowedFields.containsAll(fields),
                    "permission atoms carry only {actionClass, resource}: " + atom);
            JsonNode resource = atom.get("resource");
            assertTrue(resource == null || "*".equals(resource.asText()),
                    "a missing resource means '*' (spec §3.1): " + atom);
        }
    }

    private PolicyRequest request(String actionClass, String resource) {
        return new PolicyRequest("probe_tool", List.of(actionClass), List.of(resource),
                ToolShape.STRUCTURED, userId, workspaceId, null);
    }
}
