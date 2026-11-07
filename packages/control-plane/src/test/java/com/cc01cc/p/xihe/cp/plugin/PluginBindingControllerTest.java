package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.test.context.TestPropertySource;

import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.2 L0: binding routes 8–16 of {@code spec/openapi-delta.md} §1 on H2, feature on.
 *
 * <p>What this class owns: the HTTP contract — status codes, {@code code} values, the projections
 * (granted vs requested vs effective atoms), patch/attach/detach idempotency, and the D-65 ③
 * uninstall guard. What it does <b>not</b> own: the DDL. H2 is {@code ddl-auto=create-drop} off the
 * JPA entities, so the composite FK / RESTRICT / CHECK constraints are proven separately on real
 * PostgreSQL by {@code PluginBindingSchemaMigrationTest}.</p>
 *
 * <p>Registry rows are seeded through {@link PluginRepository} instead of the install route so each
 * case states its own precondition (enabled/disabled, builtin/third-party) instead of depending on a
 * package tree; {@code cp.plugin.advisory-lock} is off because H2 has no
 * {@code pg_advisory_xact_lock}.</p>
 *
 * <p>T1.3 authorization: every write path now requires {@code PLUGIN_BIND}, and M1 seeds that atom
 * onto the instance-administrator tier only (V137 — {@code WS_OWNER} deliberately does not carry it,
 * because {@code WS_*} roles are agent-bindable and the atom is agent-forbidden). So the positive
 * cases here act as an instance administrator: a plain workspace owner is the negative case and
 * lives in {@link PluginBindingAuthorizationGateTest}, where the denial is asserted on the rows
 * instead of the status code.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
class PluginBindingControllerTest extends AbstractH2Test {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * The base class builds its template on {@code SimpleClientHttpRequestFactory}, whose
     * {@code HttpURLConnection} rejects PATCH outright. Swap only the request factory so the wire
     * interceptor and the "only 5xx is an error" handler stay in force.
     */
    @BeforeEach
    void usePatchCapableClient() {
        restTemplate.setRequestFactory(new JdkClientHttpRequestFactory(HttpClient.newHttpClient()));
    }

    @Autowired
    private PluginRepository plugins;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.SessionRepository sessions;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private AccessRoleRepository accessRoles;

    @Autowired
    private AccessRoleBindingRepository roleBindings;

    @Autowired
    private RoleGrantMaterializer roleGrantMaterializer;

    @Autowired
    private AuthzContext authzContext;

    // ------------------------------------------------------------------ create / read / revoke

    @Test
    void builtinBindingStartsWithTheDefaultInvokeGrant() {
        Actor actor = adminActor();
        String pluginId = seedPlugin(Plugin.SOURCE_BUILTIN, true);

        ResponseEntity<Map> created = exchange(actor, HttpMethod.POST, "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        Map<?, ?> view = created.getBody();
        assertNotNull(view);
        assertEquals(pluginId, view.get("pluginId"));
        assertEquals("enabled", view.get("state"), "an enabled plugin yields an enabled binding");
        assertEquals("builtin", view.get("source"));
        assertEquals(actor.workspaceId(), String.valueOf(view.get("workspaceId")));
        assertEquals(List.of("plugin:invoke"), view.get("grantedAtoms"),
                "B-4: builtin bindings default to the workspace default atom set");
        assertEquals(List.of("plugin:invoke"), view.get("effectiveAtoms"));
        assertNull(view.get("manifest"), "the jsonb node must not reach the wire");
        assertNull(view.get("grantedAtomsNode"));

        String bindingId = String.valueOf(view.get("bindingId"));

        ResponseEntity<Map> listed = exchange(actor, HttpMethod.GET, "/api/v1/plugin-bindings",
                null);
        assertEquals(HttpStatus.OK, listed.getStatusCode());
        List<?> items = (List<?>) listed.getBody().get("items");
        assertTrue(items.stream().anyMatch(item -> bindingId.equals(((Map<?, ?>) item)
                .get("bindingId"))), "the created binding must be listed");

        ResponseEntity<Map> filtered = exchange(actor, HttpMethod.GET,
                "/api/v1/plugin-bindings?state=disabled", null);
        assertEquals(HttpStatus.OK, filtered.getStatusCode());
        assertTrue(((List<?>) filtered.getBody().get("items")).isEmpty(),
                "an enabled binding must not answer the disabled filter");

        ResponseEntity<Map> fetched = exchange(actor, HttpMethod.GET,
                "/api/v1/plugin-bindings/" + bindingId, null);
        assertEquals(HttpStatus.OK, fetched.getStatusCode());
        assertEquals(bindingId, String.valueOf(fetched.getBody().get("bindingId")));

        ResponseEntity<Map> revoked = exchange(actor, HttpMethod.DELETE,
                "/api/v1/plugin-bindings/" + bindingId, null);
        assertEquals(HttpStatus.NO_CONTENT, revoked.getStatusCode());

        ResponseEntity<Map> gone = exchange(actor, HttpMethod.GET,
                "/api/v1/plugin-bindings/" + bindingId, null);
        assertEquals(HttpStatus.NOT_FOUND, gone.getStatusCode());
        assertEquals("PLUGIN_NOT_FOUND", gone.getBody().get("code"));
    }

    @Test
    void disabledPluginYieldsAPendingBindingThatCannotAttach() {
        Actor actor = adminActor();
        String pluginId = seedPlugin(Plugin.SOURCE_BUILTIN, false);
        UUID session = seedSession(actor.workspaceId());

        ResponseEntity<Map> created = exchange(actor, HttpMethod.POST, "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        assertEquals("pending", created.getBody().get("state"));
        String bindingId = String.valueOf(created.getBody().get("bindingId"));

        ResponseEntity<Map> attach = exchange(actor, HttpMethod.POST,
                "/api/v1/sessions/" + session + "/plugins", Map.of("bindingId", bindingId));
        assertEquals(HttpStatus.CONFLICT, attach.getStatusCode());
        assertEquals("PLUGIN_CONFLICT", attach.getBody().get("code"));
        assertTrue(String.valueOf(attach.getBody().get("detail")).contains("pending"));

        // Enabling the binding while the plugin is still disabled is the same conflict.
        ResponseEntity<Map> enable = exchange(actor, HttpMethod.PATCH,
                "/api/v1/plugin-bindings/" + bindingId, Map.of("state", "enabled"));
        assertEquals(HttpStatus.CONFLICT, enable.getStatusCode());
        assertEquals("PLUGIN_CONFLICT", enable.getBody().get("code"));
    }

    @Test
    void thirdPartyBindingRequiresAnExplicitGrant() {
        Actor actor = adminActor();
        String pluginId = seedPlugin(Plugin.SOURCE_THIRD_PARTY, true);

        ResponseEntity<Map> denied = exchange(actor, HttpMethod.POST, "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode());
        assertEquals("PLUGIN_GRANT_DENIED", denied.getBody().get("code"));

        ResponseEntity<Map> granted = exchange(actor, HttpMethod.POST, "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId, "grantedAtoms", List.of("plugin:invoke")));
        assertEquals(HttpStatus.CREATED, granted.getStatusCode(), String.valueOf(granted.getBody()));
        assertEquals(List.of("plugin:invoke"), granted.getBody().get("grantedAtoms"));

        String bindingId = String.valueOf(granted.getBody().get("bindingId"));
        ResponseEntity<Map> authorization = exchange(actor, HttpMethod.GET,
                "/api/v1/plugin-bindings/" + bindingId + "/authorization", null);
        assertEquals(HttpStatus.OK, authorization.getStatusCode());
        Map<?, ?> summary = authorization.getBody();
        assertEquals(List.of("plugin:invoke"), summary.get("requestedAtoms"));
        assertEquals(List.of("plugin:invoke"), summary.get("grantedAtoms"));
        assertEquals(List.of("plugin:invoke"), summary.get("effectiveAtoms"));
        List<?> sources = (List<?>) summary.get("sources");
        assertEquals(1, sources.size());
        assertEquals("plugin_binding", ((Map<?, ?>) sources.get(0)).get("source"),
                "an explicit grant must be attributable, not silently defaulted");
    }

    @Test
    void unknownPluginAndUnknownBindingAnswerNotFound() {
        Actor actor = adminActor();

        ResponseEntity<Map> unknownPlugin = exchange(actor, HttpMethod.POST,
                "/api/v1/plugin-bindings", Map.of("pluginId", "official.not-installed"));
        assertEquals(HttpStatus.NOT_FOUND, unknownPlugin.getStatusCode());
        assertEquals("PLUGIN_NOT_FOUND", unknownPlugin.getBody().get("code"));

        ResponseEntity<Map> unknownBinding = exchange(actor, HttpMethod.GET,
                "/api/v1/plugin-bindings/" + UUID.randomUUID(), null);
        assertEquals(HttpStatus.NOT_FOUND, unknownBinding.getStatusCode());

        ResponseEntity<Map> malformed = exchange(actor, HttpMethod.GET,
                "/api/v1/plugin-bindings/not-a-uuid", null);
        assertEquals(HttpStatus.NOT_FOUND, malformed.getStatusCode());
    }

    @Test
    void duplicateBindingAndForeignWorkspaceAreRefused() {
        Actor owner = adminActor();
        String pluginId = seedPlugin(Plugin.SOURCE_BUILTIN, true);
        ResponseEntity<Map> created = exchange(owner, HttpMethod.POST, "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        String bindingId = String.valueOf(created.getBody().get("bindingId"));

        ResponseEntity<Map> duplicate = exchange(owner, HttpMethod.POST,
                "/api/v1/plugin-bindings", Map.of("pluginId", pluginId));
        assertEquals(HttpStatus.CONFLICT, duplicate.getStatusCode());
        assertEquals("PLUGIN_CONFLICT", duplicate.getBody().get("code"));

        // The interceptor only lets a member address its own workspace; the service must still refuse
        // to disclose a binding that lives elsewhere (403 before existence, §4 PLUGIN_GRANT_DENIED).
        Actor stranger = actor();
        ResponseEntity<Map> foreign = exchange(stranger, HttpMethod.GET,
                "/api/v1/plugin-bindings/" + bindingId, null);
        assertEquals(HttpStatus.FORBIDDEN, foreign.getStatusCode());
        assertEquals("PLUGIN_GRANT_DENIED", foreign.getBody().get("code"));
    }

    @Test
    void patchMovesStateOnlyWithinTheOperatorHalfOfTheMachine() {
        Actor actor = adminActor();
        String pluginId = seedPlugin(Plugin.SOURCE_BUILTIN, true);
        String bindingId = String.valueOf(exchange(actor, HttpMethod.POST,
                "/api/v1/plugin-bindings", Map.of("pluginId", pluginId))
                .getBody().get("bindingId"));

        ResponseEntity<Map> disabled = exchange(actor, HttpMethod.PATCH,
                "/api/v1/plugin-bindings/" + bindingId, Map.of("state", "disabled"));
        assertEquals(HttpStatus.OK, disabled.getStatusCode(), String.valueOf(disabled.getBody()));
        assertEquals("disabled", disabled.getBody().get("state"));

        ResponseEntity<Map> enabled = exchange(actor, HttpMethod.PATCH,
                "/api/v1/plugin-bindings/" + bindingId, Map.of("state", "enabled"));
        assertEquals(HttpStatus.OK, enabled.getStatusCode());
        assertEquals("enabled", enabled.getBody().get("state"));

        // CP-owned states are not operator-writable: they are reached through attach/degrade flows,
        // so a direct write is a client error, not a silent acceptance.
        for (String cpOwned : List.of("pending", "degraded", "suspended")) {
            ResponseEntity<Map> rejected = exchange(actor, HttpMethod.PATCH,
                    "/api/v1/plugin-bindings/" + bindingId, Map.of("state", cpOwned));
            assertEquals(HttpStatus.BAD_REQUEST, rejected.getStatusCode(), cpOwned);
            assertEquals("INVALID_REQUEST", rejected.getBody().get("code"));
        }

        ResponseEntity<Map> empty = exchange(actor, HttpMethod.PATCH,
                "/api/v1/plugin-bindings/" + bindingId, Map.of());
        assertEquals(HttpStatus.BAD_REQUEST, empty.getStatusCode());
        assertEquals("INVALID_REQUEST", empty.getBody().get("code"));
    }

    @Test
    void atomsOutsideTheManifestAreRefused() {
        Actor actor = adminActor();
        String pluginId = seedPlugin(Plugin.SOURCE_BUILTIN, true);

        ResponseEntity<Map> undeclared = exchange(actor, HttpMethod.POST,
                "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId, "grantedAtoms", List.of("plugin:admin")));
        assertEquals(HttpStatusCode.valueOf(422), undeclared.getStatusCode());
        assertEquals(PluginManifestValidator.ERROR_CODE, undeclared.getBody().get("code"));

        ResponseEntity<Map> blank = exchange(actor, HttpMethod.POST,
                "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId, "grantedAtoms", List.of(" ")));
        assertEquals(HttpStatusCode.valueOf(422), blank.getStatusCode());
    }

    // ------------------------------------------------------------------ D-65 ③ uninstall guard

    @Test
    void uninstallIsRefusedWhileThePluginIsBound() {
        Actor actor = adminActor();
        String pluginId = seedPlugin(Plugin.SOURCE_BUILTIN, true);
        String bindingId = String.valueOf(exchange(actor, HttpMethod.POST,
                "/api/v1/plugin-bindings", Map.of("pluginId", pluginId))
                .getBody().get("bindingId"));

        ResponseEntity<Map> blocked = exchange(actor, HttpMethod.DELETE,
                "/api/v1/plugins/" + pluginId, null);
        assertEquals(HttpStatus.CONFLICT, blocked.getStatusCode());
        assertEquals("PLUGIN_CONFLICT", blocked.getBody().get("code"));
        assertTrue(String.valueOf(blocked.getBody().get("detail")).contains("still bound"));
        assertEquals(1, plugins.countVersions(pluginId), "a refused uninstall must not delete rows");

        assertEquals(HttpStatus.NO_CONTENT, exchange(actor, HttpMethod.DELETE,
                "/api/v1/plugin-bindings/" + bindingId, null).getStatusCode());
        assertEquals(HttpStatus.NO_CONTENT, exchange(actor, HttpMethod.DELETE,
                "/api/v1/plugins/" + pluginId, null).getStatusCode());
        assertEquals(0, plugins.countVersions(pluginId));
    }

    // ------------------------------------------------------------------ session attach / detach

    @Test
    void attachIsIdempotentAndDetachReleasesTheSnapshot() {
        Actor actor = adminActor();
        String pluginId = seedPlugin(Plugin.SOURCE_BUILTIN, true);
        String bindingId = String.valueOf(exchange(actor, HttpMethod.POST,
                "/api/v1/plugin-bindings", Map.of("pluginId", pluginId))
                .getBody().get("bindingId"));
        UUID session = seedSession(actor.workspaceId());

        ResponseEntity<Map> first = exchange(actor, HttpMethod.POST,
                "/api/v1/sessions/" + session + "/plugins", Map.of("bindingId", bindingId));
        assertEquals(HttpStatus.CREATED, first.getStatusCode(), String.valueOf(first.getBody()));
        assertEquals(1, first.getBody().get("revision"));
        assertEquals(1, first.getBody().get("catalogVersion"));
        assertEquals(true, first.getBody().get("effectiveNextTurn"));

        ResponseEntity<Map> again = exchange(actor, HttpMethod.POST,
                "/api/v1/sessions/" + session + "/plugins", Map.of("bindingId", bindingId));
        assertEquals(HttpStatus.CREATED, again.getStatusCode());
        assertEquals(1, again.getBody().get("revision"),
                "a repeated attach must not spend a revision: the snapshot did not move");

        ResponseEntity<Map> listed = exchange(actor, HttpMethod.GET,
                "/api/v1/sessions/" + session + "/plugins", null);
        assertEquals(HttpStatus.OK, listed.getStatusCode());
        List<?> items = (List<?>) listed.getBody().get("items");
        assertEquals(1, items.size());
        Map<?, ?> item = (Map<?, ?>) items.get(0);
        assertEquals(pluginId, item.get("pluginId"));
        assertEquals("1.0.0", item.get("version"));
        assertEquals("enabled", item.get("state"));
        assertEquals(plugins.findCurrentById(pluginId).orElseThrow().getDigest(), item.get("digest"));
        assertNull(item.get("snapshot"), "the frozen node stays server-side");

        assertEquals(HttpStatus.NO_CONTENT, exchange(actor, HttpMethod.DELETE,
                "/api/v1/sessions/" + session + "/plugins/" + bindingId, null).getStatusCode());
        assertEquals(HttpStatus.NO_CONTENT, exchange(actor, HttpMethod.DELETE,
                "/api/v1/sessions/" + session + "/plugins/" + bindingId, null).getStatusCode(),
                "detaching an already-detached binding is a no-op");
        assertEquals(0, ((List<?>) exchange(actor, HttpMethod.GET,
                "/api/v1/sessions/" + session + "/plugins", null).getBody().get("items")).size());

        ResponseEntity<Map> reattached = exchange(actor, HttpMethod.POST,
                "/api/v1/sessions/" + session + "/plugins", Map.of("bindingId", bindingId));
        assertEquals(HttpStatus.CREATED, reattached.getStatusCode());
        assertEquals(2, reattached.getBody().get("revision"),
                "re-attaching a detached pair is a new snapshot revision");
    }

    @Test
    void attachRefusesAForeignSession() {
        Actor owner = adminActor();
        String pluginId = seedPlugin(Plugin.SOURCE_BUILTIN, true);
        String bindingId = String.valueOf(exchange(owner, HttpMethod.POST,
                "/api/v1/plugin-bindings", Map.of("pluginId", pluginId))
                .getBody().get("bindingId"));
        UUID foreignSession = seedSession(owner.workspaceId());

        // The stranger holds PLUGIN_BIND (M1: instance-admin tier), so its request reaches the session
        // lookup and the "not an existence oracle" rule is what answers.
        Actor stranger = adminActor();
        ResponseEntity<Map> attach = exchange(stranger, HttpMethod.POST,
                "/api/v1/sessions/" + foreignSession + "/plugins", Map.of("bindingId", bindingId));
        assertEquals(HttpStatus.NOT_FOUND, attach.getStatusCode(),
                "a session in another workspace must not be an existence oracle");

        // T1.3 ordering: without the atom the same call never reaches that lookup at all.
        Actor ownerWithoutBind = actor();
        ResponseEntity<Map> denied = exchange(ownerWithoutBind, HttpMethod.POST,
                "/api/v1/sessions/" + foreignSession + "/plugins", Map.of("bindingId", bindingId));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "the atom gate answers before the session lookup");
        assertEquals("PLUGIN_GRANT_DENIED", denied.getBody().get("code"));
    }

    // ------------------------------------------------------------------ helpers

    /**
     * A registered principal plus a workspace it owns. Registration no longer creates a default
     * workspace (PLAN-0614), so the actor's workspace is created through the shared fixture, which
     * also writes the WS_OWNER binding the tenant interceptor checks.
     */
    private record Actor(String token, String userId, String workspaceId) {}

    private Actor actor() {
        String email = "plugin-binding-" + UUID.randomUUID() + "@example.test";
        ResponseEntity<Map> registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new HttpEntity<>(Map.of("email", email, "password", "pw-12345678",
                        "name", "Binding Tester"), jsonHeaders()), Map.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode(),
                String.valueOf(registered.getBody()));
        Map<?, ?> user = (Map<?, ?>) registered.getBody().get("user");
        String userId = String.valueOf(user.get("id"));
        String workspaceId = workspaceFixture
                .ensureOwnedWorkspace(UUID.fromString(userId))
                .getId().toString();
        return new Actor(String.valueOf(registered.getBody().get("accessToken")), userId,
                workspaceId);
    }

    /**
     * An actor that holds {@code PLUGIN_BIND}: the same registration + owned-workspace fixture, plus
     * the instance-administrator role binding and a grant materialization. This is the real M1 path
     * (V137 seeds the atom on ADMIN/SUPER_ADMIN, and the workspace tier is served from the instance
     * tier), not a test-only shortcut — the grant row is exactly what a delegated administrator gets.
     */
    private Actor adminActor() {
        Actor actor = actor();
        grantInstanceAdmin(actor.userId());
        return actor;
    }

    /** Bind the ADMIN role at instance scope and materialize it into {@code grants}. */
    private void grantInstanceAdmin(String userId) {
        UUID subject = UUID.fromString(userId);
        AccessRole adminRole = accessRoles.findByName("ADMIN").orElseThrow();
        roleBindings.save(new AccessRoleBinding(adminRole.getId(), AuthzContext.SUBJECT_USER,
                subject, "instance", null, subject));
        roleBindings.flush();
        roleGrantMaterializer.materializeSubject(AuthzContext.SUBJECT_USER, subject, subject, null);
        authzContext.invalidate(subject);
    }

    private ResponseEntity<Map> exchange(Actor actor, HttpMethod method, String path,
            Object body) {
        HttpHeaders headers = jsonHeaders();
        headers.setBearerAuth(actor.token());
        headers.set("X-Workspace-Id", actor.workspaceId());
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }

    private static HttpHeaders jsonHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private String seedPlugin(String source, boolean enabled) {
        // audit_logs.resource_id is varchar(36): a longer id would break the audit row instead of
        // the behaviour under test, so keep the fixture id realistic in length.
        String pluginId = "official.b-" + UUID.randomUUID().toString().substring(0, 8);
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.put("manifestVersion", "1");
        manifest.put("id", pluginId);
        manifest.put("version", "1.0.0");
        manifest.put("source", source);
        manifest.putObject("runtime").put("kind", "mcp-http")
                .put("endpoint", "https://plugins.example.test/mcp");
        manifest.putArray("actions").addObject().put("name", "demo.echo").put("actionClass",
                "read");
        manifest.putArray("requestedAtoms").add("plugin:invoke");
        manifest.putObject("limits").put("timeoutMs", 5000);
        manifest.put("digest", PluginManifestValidator.computeDigest(manifest));

        Plugin plugin = new Plugin(pluginId, String.valueOf(manifest.get("digest")), "1.0.0",
                source, manifest);
        plugin.setCurrent(true);
        if (enabled) {
            plugin.setState(Plugin.STATE_ENABLED);
        }
        plugins.save(plugin);
        return pluginId;
    }

    private UUID seedSession(String workspaceId) {
        var session = new com.cc01cc.p.xihe.cp.entity.Session(workspaceId,
                UUID.randomUUID().toString(), "binding fixture");
        session.setId(UUID.randomUUID());
        sessions.save(session);
        return session.getId();
    }
}
