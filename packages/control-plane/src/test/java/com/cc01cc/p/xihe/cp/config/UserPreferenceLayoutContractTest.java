package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
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
 * <p>Real stack, no mocks: {@link AbstractH2Test} boots the app on a random port and every call
 * below goes through HTTP, security, ConfigController and ConfigService.</p>
 */
class UserPreferenceLayoutContractTest extends AbstractH2Test {

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

    private ResponseEntity<Map> putPreferences(String token, Map<String, String> body) {
        return restTemplate.exchange(url("/api/v1/config/user/user-preference"), HttpMethod.PUT,
                new HttpEntity<>(body, authHeaders(token)), Map.class);
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
        ResponseEntity<Map> reg = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", "layout-user-" + System.nanoTime() + "@test.com",
                        "password", TestDataFactory.PASSWORD, "name", "LayoutUser"),
                Map.class);
        assertEquals(HttpStatus.CREATED, reg.getStatusCode());
        return (String) reg.getBody().get("accessToken");
    }

    private String adminToken() {
        ResponseEntity<Map> login = restTemplate.postForEntity(
                url("/api/v1/auth/login"),
                Map.of("identifier", "admin@xihe.local", "password", DataSeeder.seededAdminPassword()),
                Map.class);
        assertEquals(HttpStatus.OK, login.getStatusCode());
        return (String) login.getBody().get("accessToken");
    }
}
