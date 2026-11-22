package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.GrantPreset;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.GrantPresetAtom;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.PresetGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetAtomRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.ConfigLockRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-265 (D-1640 #5): the wire contract of the two layout key families on the real HTTP write
 * path: PUT /api/v1/config/user/user-preference with a Map&lt;String,String&gt; body whose layout
 * values are JSON <em>text</em>.
 *
 * <p>Three things are pinned here that a schema-only test cannot show:
 * <ul>
 *   <li>the semantic layout (design 3.4.2 panels.groups) round-trips byte for byte;</li>
 *   <li>a dockview SerializedDockview snapshot is <b>refused with 400</b> and the previously stored
 *       layout survives untouched (design 7-6: no framework snapshot as storage format);</li>
 *   <li>design 10.2 item 6: layout.* is <b>not lockable</b>. A layout is not a policy; an admin lock
 *       would freeze the interface of the user themselves. The control assertion (theme IS lockable)
 *       keeps this from passing because the catalog says false for everything.</li>
 * </ul>
 *
 * <p>task-120 (H2 coverage blind spot): the two <b>atom gates</b> that sit above this controller had
 * never been executed on the H2 lane. The atom judgement reads org-unit grants through native
 * ltree SQL, and the H2 schema carries no org_units family, so the evaluation threw and the policy
 * layer fell back to an empty atom set — every atom branch answered "false" for reasons unrelated
 * to the caller. The cases below run on PostgreSQL (the real dialect) and each door is covered by a
 * pair: the same request with and without the atom.</p>
 *
 * <p>Real stack, no mocks: {@link AbstractIntegrationTest} boots the app on a random port against a
 * freshly migrated database and every call below goes through HTTP, security, ConfigController,
 * ConfigService and the policy layer.</p>
 */
class UserPreferenceLayoutContractTest extends AbstractIntegrationTest {

    private static final String WS = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    private static final String WS_KEY = "layout.ws." + WS;

    /** The semantic model: geometry scalars plus panel groups, never a framework snapshot. */
    private static final String SEMANTIC_LAYOUT = "{\"treeCollapsed\":false,\"treeWidth\":240,"
            + "\"dockCollapsed\":false,\"dockWidth\":360,\"dockTabs\":[\"code\",\"changes\"],"
            + "\"activeDockTab\":\"code\",\"dockMode\":\"pinned\",\"dockModeManual\":true,"
            + "\"dockFocus\":false,\"activeColumn\":\"main\",\"panels\":{\"groups\":["
            + "{\"id\":\"center\",\"panels\":[\"page:sessions\"],\"active\":\"page:sessions\",\"size\":0.7},"
            + "{\"id\":\"right\",\"panels\":[\"code\",\"changes\"],\"active\":\"code\",\"size\":0.3}],"
            + "\"activeGroup\":\"center\"}}";

    private static final String GLOBAL_LAYOUT = "{\"navOpen\":true,\"navWidth\":280}";

    /** dockview toJSON(): grid plus a panels record plus activeGroup. Must never be storable. */
    private static final String DOCKVIEW_SNAPSHOT = "{\"grid\":{\"root\":{\"type\":\"branch\","
            + "\"data\":[],\"size\":50},\"width\":1600,\"height\":900,\"orientation\":\"HORIZONTAL\"},"
            + "\"panels\":{\"code\":{\"id\":\"code\",\"title\":\"Code\",\"renderer\":\"onlyWhenVisible\"}},"
            + "\"activeGroup\":\"group-1\"}";

    @Autowired
    private ConfigJpaRepository configRepo;

    @Autowired
    private ConfigLockRepository lockRepo;

    @Autowired
    private GrantPresetRepository accessRoleRepository;

    @Autowired
    private GrantPresetAtomRepository permissionRepository;

    @Autowired
    private GrantPresetBindingRepository roleBindingRepository;

    @Autowired
    private PresetGrantMaterializer materializer;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @BeforeEach
    void cleanLayoutRows() {
        lockRepo.deleteAll();
        configRepo.deleteAll(configRepo.findByLayerAndDomain("user", "user-preference"));
    }

    @Test
    void theSemanticLayoutRoundTripsThroughTheUserLayer() {
        String token = userToken();

        ResponseEntity<Map> put = putPreferences(token,
                Map.of("layout.global", GLOBAL_LAYOUT, WS_KEY, SEMANTIC_LAYOUT));

        assertEquals(HttpStatus.OK, put.getStatusCode(), "semantic layout must be accepted: " + put.getBody());
        assertEquals("ok", put.getBody().get("status"));
        assertEquals(2, put.getBody().get("keys"));

        Map<String, Object> stored = readUserLayer(token);
        assertEquals(GLOBAL_LAYOUT, stored.get("layout.global"), "global layout must round-trip verbatim");
        assertEquals(SEMANTIC_LAYOUT, stored.get(WS_KEY), "workspace layout must round-trip verbatim");
    }

    @Test
    void aDockviewSnapshotIsRefusedAndTheStoredLayoutSurvives() {
        String token = userToken();
        assertEquals(HttpStatus.OK, putPreferences(token, Map.of(WS_KEY, SEMANTIC_LAYOUT)).getStatusCode());

        ResponseEntity<Map> refused = putPreferences(token, Map.of(WS_KEY, DOCKVIEW_SNAPSHOT));
        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatusCode(),
                "design 7-6: SerializedDockview must be refused, got: " + refused.getBody());

        // Same refusal without grid, so the guard is the shape and not a one-word blacklist.
        String withoutGrid = "{\"panels\":{\"code\":{\"id\":\"code\",\"title\":\"Code\"}},"
                + "\"activeGroup\":\"group-1\"}";
        assertEquals(HttpStatus.BAD_REQUEST,
                putPreferences(token, Map.of(WS_KEY, withoutGrid)).getStatusCode(),
                "a panels record without grid is still a snapshot, not the group model");

        assertEquals(SEMANTIC_LAYOUT, readUserLayer(token).get(WS_KEY),
                "a refused write must not touch the stored layout");
    }

    @Test
    void theRetiredOpenTabsFieldIsRefused() {
        String token = userToken();
        String withOpenTabs = "{\"dockWidth\":360,\"openTabs\":[\"session:" + WS + "\"]}";

        ResponseEntity<Map> refused = putPreferences(token, Map.of(WS_KEY, withOpenTabs));

        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatusCode(),
                "design 5 retires openTabs with the tab bar: " + refused.getBody());
    }

    @Test
    void layoutKeysAreNotLockableWhileOrdinaryPreferencesStay() {
        HttpHeaders admin = authHeaders(adminToken());

        ResponseEntity<Map> catalog = restTemplate.exchange(
                url("/api/v1/config-locks?domain=user-preference"), HttpMethod.GET,
                new HttpEntity<>(admin), Map.class);
        assertEquals(HttpStatus.OK, catalog.getStatusCode());
        List<Map<String, Object>> keys = (List<Map<String, Object>>) catalog.getBody().get("keys");
        assertNotNull(keys);

        Map<String, Object> layoutGlobal = keys.stream()
                .filter(k -> "layout.global".equals(k.get("key"))).findFirst().orElseThrow();
        assertEquals(Boolean.FALSE, layoutGlobal.get("lockable"),
                "10.2 item 6: a layout key must never enter the config-locks whitelist");
        assertEquals("WHOLE_UNIT", layoutGlobal.get("notLockableReason"));
        assertTrue(keys.stream().noneMatch(k -> String.valueOf(k.get("key")).startsWith("layout.ws.")),
                "per-workspace layout keys are pattern keys and must not appear as lock candidates");
        // Control: without this, a catalog that marks everything non-lockable would also pass.
        assertTrue(keys.stream().anyMatch(k -> "theme".equals(k.get("key"))
                        && Boolean.TRUE.equals(k.get("lockable"))),
                "the ordinary preference key theme must stay lockable");

        for (String key : List.of("layout.global", WS_KEY)) {
            ResponseEntity<Map> lock = restTemplate.exchange(
                    url("/api/v1/config-locks/user-preference/" + key), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("reason", "freeze the layout", "value", "{}",
                            "revision", 0), admin), Map.class);
            assertEquals(HttpStatus.BAD_REQUEST, lock.getStatusCode(),
                    "locking a layout key must fail: " + lock.getBody());
            assertEquals("NOT_LOCKABLE", lock.getBody().get("code"));
        }
        assertFalse(lockRepo.findAll().iterator().hasNext(), "no lock row may be created for layout keys");
    }

    // ------------------------------------------------------------------
    // task-120: the instance read door (L5) and the workspace write door
    // (H1) above this controller. Each pair answers the same request twice,
    // once without and once with the atom.
    // ------------------------------------------------------------------

    @Test
    void theInstanceLayerReadIsRefusedWithoutTheReadInstanceContentAtom() {
        Actor plain = registerActor("layout-plain");

        ResponseEntity<Map> refused = restTemplate.exchange(
                url("/api/v1/config/user-preference?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(authHeaders(plain.token())), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, refused.getStatusCode(),
                "an instance layer read is gated by READ_INSTANCE_CONTENT: " + refused.getBody());
        assertNotNull(refused.getBody());
        assertEquals("FORBIDDEN", refused.getBody().get("code"));
        assertEquals("Instance config is not readable by this user", refused.getBody().get("detail"));
    }

    @Test
    void theInstanceLayerReadOpensForTheHolderOfTheReadInstanceContentAtom() {
        Actor reader = registerActor("layout-instance-reader");
        seedInstanceAtom(reader.id(), ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT);

        ResponseEntity<Map> allowed = restTemplate.exchange(
                url("/api/v1/config/user-preference?layer=instance"), HttpMethod.GET,
                new HttpEntity<>(authHeaders(reader.token())), Map.class);

        assertEquals(HttpStatus.OK, allowed.getStatusCode(),
                "holding READ_INSTANCE_CONTENT must open the very request that 403s above: "
                        + allowed.getBody());
        assertNotNull(allowed.getBody());
        assertFalse(allowed.getBody().containsKey("code"),
                "a layer view is a key/value map, not a problem document: " + allowed.getBody());
    }

    /**
     * The tenant interceptor rejects a VIEWER's write before the controller runs
     * ({@code TenantContextInterceptor.enforceWorkspaceRole} → {@code WorkspaceWriteGuard}), so a
     * read-only member never reaches the atom gate at all and the body is the tenant's
     * WORKSPACE_READ_ONLY, not the door's FORBIDDEN. Recorded here so the ordering is pinned: if
     * the tenant gate ever stops covering this route, this case turns red instead of silently
     * letting a viewer's write through to the later gates.
     */
    @Test
    void aViewerMemberIsStoppedByTheTenantReadOnlyGate() {
        UUID workspaceId = newOwnedWorkspace();
        Actor viewer = registerActor("layout-viewer");
        workspaceFixture.bindWorkspaceRole(workspaceId, UUID.fromString(viewer.id()), WorkspaceRole.VIEWER);

        ResponseEntity<Map> refused = putWorkspacePreferences(viewer.token(), workspaceId);

        assertEquals(HttpStatus.FORBIDDEN, refused.getStatusCode(),
                "a read-only member cannot write workspace config: " + refused.getBody());
        assertNotNull(refused.getBody());
        assertEquals("WORKSPACE_READ_ONLY", refused.getBody().get("code"));
        assertEquals("Viewer cannot modify this workspace", refused.getBody().get("detail"));
        assertTrue(configRepo.findByWorkspaceIdAndDomain(workspaceId, "user-preference").isEmpty(),
                "a refused 403 must not leave a workspace-layer row behind");
    }

    @Test
    void anEditorMemberPassesTheWorkspaceWriteAtomGateAndIsStoppedByTheDomainRule() {
        UUID workspaceId = newOwnedWorkspace();
        Actor editor = registerActor("layout-editor");
        workspaceFixture.bindWorkspaceRole(workspaceId, UUID.fromString(editor.id()), WorkspaceRole.EDITOR);

        ResponseEntity<Map> refused = putWorkspacePreferences(editor.token(), workspaceId);

        // The discriminator that proves the atom was actually evaluated: writeLayer's layer/domain
        // guard runs AFTER the atom gate, so this 400 can only be reached by a caller that passed
        // it. A 403 here would mean the atom branch was short-circuited to false.
        assertEquals(HttpStatus.BAD_REQUEST, refused.getStatusCode(),
                "an editor holds WRITE_WORKSPACE_CONTENT, so the refusal must be the domain rule: "
                        + refused.getBody());
        assertNotNull(refused.getBody());
        assertEquals("DOMAIN_NOT_WORKSPACE_WRITABLE", refused.getBody().get("code"));
        assertEquals("Domain is not writable at the workspace layer: user-preference",
                refused.getBody().get("detail"));
        assertTrue(configRepo.findByWorkspaceIdAndDomain(workspaceId, "user-preference").isEmpty(),
                "user-preference stays unwritable at the workspace layer, atom or no atom");
    }

    /**
     * A non-member is rejected by the tenant gate with the generic 403 WORKSPACE_FORBIDDEN — the
     * same body the interceptor produces for any workspace it will not resolve — and it happens
     * before {@code requireAccessibleWorkspace} and before the atom gate. The assertion on the
     * generic detail (not a workspace-shaped one) is the point: the refusal must not tell a
     * stranger whether the id exists.
     */
    @Test
    void aNonMemberIsStoppedByTheTenantGateBeforeTheController() {
        UUID workspaceId = newOwnedWorkspace();
        Actor stranger = registerActor("layout-stranger");

        ResponseEntity<Map> refused = putWorkspacePreferences(stranger.token(), workspaceId);

        assertEquals(HttpStatus.FORBIDDEN, refused.getStatusCode(),
                "the tenant gate answers before the controller: " + refused.getBody());
        assertNotNull(refused.getBody());
        assertEquals("WORKSPACE_FORBIDDEN", refused.getBody().get("code"));
        assertEquals("Workspace access denied", refused.getBody().get("detail"));
    }

    private ResponseEntity<Map> putPreferences(String token, Map<String, String> body) {
        return restTemplate.exchange(url("/api/v1/config/user/user-preference"), HttpMethod.PUT,
                new HttpEntity<>(body, authHeaders(token)), Map.class);
    }

    private ResponseEntity<Map> putWorkspacePreferences(String token, UUID workspaceId) {
        HttpHeaders headers = authHeaders(token);
        headers.set("X-Workspace-Id", workspaceId.toString());
        return restTemplate.exchange(url("/api/v1/config/workspace/user-preference"), HttpMethod.PUT,
                new HttpEntity<>(Map.of(WS_KEY, SEMANTIC_LAYOUT), headers), Map.class);
    }

    private Map<String, Object> readUserLayer(String token) {
        ResponseEntity<Map> get = restTemplate.exchange(
                url("/api/v1/config/user-preference?layer=user"), HttpMethod.GET,
                new HttpEntity<>(authHeaders(token)), Map.class);
        assertEquals(HttpStatus.OK, get.getStatusCode());
        return (Map<String, Object>) get.getBody();
    }

    private HttpHeaders authHeaders(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private String userToken() {
        return registerActor("layout-user").token();
    }

    private String adminToken() {
        ResponseEntity<Map> login = restTemplate.postForEntity(
                url("/api/v1/auth/login"),
                Map.of("identifier", "admin@xihe.local", "password", DataSeeder.seededAdminPassword()),
                Map.class);
        assertEquals(HttpStatus.OK, login.getStatusCode());
        return (String) login.getBody().get("accessToken");
    }

    private Actor registerActor(String prefix) {
        ResponseEntity<Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", prefix + "-" + System.nanoTime() + "@test.com",
                        "password", TestDataFactory.PASSWORD, "name", "LayoutUser"),
                Map.class);
        assertEquals(HttpStatus.CREATED, registration.getStatusCode(),
                "registration failed: " + registration.getBody());
        assertNotNull(registration.getBody());
        Map<?, ?> user = (Map<?, ?>) registration.getBody().get("user");
        assertNotNull(user, "registration must return the created user: " + registration.getBody());
        return new Actor(String.valueOf(user.get("id")),
                String.valueOf(registration.getBody().get("accessToken")));
    }

    private UUID newOwnedWorkspace() {
        Actor owner = registerActor("layout-owner");
        return workspaceFixture.createOwnedWorkspace("layout-ws-" + System.nanoTime(), owner.id())
                .getId();
    }

    /**
     * One atom at instance scope, granted the way the production path grants it: a role row, the
     * permission row, the binding row, then {@code PresetGrantMaterializer} (the atom judgement reads
     * materialized {@code source='preset'} grants, not the bare binding) and a cache invalidation.
     * The role name must satisfy ck_roles_name_format (V87).
     */
    private void seedInstanceAtom(String userId, String atom) {
        UUID subject = UUID.fromString(userId);
        UUID roleId = UUID.randomUUID();
        accessRoleRepository.saveAndFlush(new GrantPreset(roleId,
                "TEST_LAYOUT_" + roleId.toString().replace("-", "").substring(0, 10).toUpperCase(),
                "Layout atom role", "test-only role for the instance config read atom (task-120)", false));
        permissionRepository.saveAndFlush(new GrantPresetAtom(roleId, atom,
                PermissionAtomCatalog.WILDCARD));
        roleBindingRepository.saveAndFlush(new GrantPresetBinding(roleId, "user", subject,
                AccessScope.INSTANCE, null, subject));
        materializer.materializeSubject("user", subject, subject, null);
        authzContext.invalidate(subject);
    }

    private record Actor(String id, String token) {
    }
}
