package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.PluginBindingAuthorization;
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
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.3: the authorization gate is <b>before</b> the write, proven by the absence of
 * effects rather than by reading the source in order.
 *
 * <p>Why this class exists: {@code PluginBindingService} calls
 * {@code PluginBindingAuthorization.require(...)} as the first statement of create / update / delete /
 * attach / detach. "First statement" is not observable by reading order, and the {@code @Transactional}
 * boundary would roll the writes back even if the gate ran late — so the assertions are chosen to be
 * the things a late gate cannot fake:</p>
 *
 * <ul>
 *   <li><b>Which error the denial is</b> — a denied {@code create} of an already-bound plugin answers
 *       {@code 403 PLUGIN_GRANT_DENIED}, not {@code 409 PLUGIN_CONFLICT}, and a denied create of an
 *       unknown plugin answers 403, not 404. That is the observable form of "the gate runs before the
 *       existence/conflict vocabulary": a gate placed after those checks flips the code and fails
 *       here. (Mutation-checked: moving the gate below the conflict check makes this class red.)</li>
 *   <li><b>The end state</b> — row counts, the session revision high-water, {@code audit_logs} and the
 *       state of the touched row are identical before and after six denied writes. That is the
 *       observable form of "rejection ⇒ zero rows written" the card asks for; it is guaranteed by the
 *       transaction as well, so it is evidence of the outcome, not of the line order.</li>
 * </ul>
 *
 * <p>The denied actor is not synthetic: {@code WS_OWNER} holds {@code plugin:invoke} (V137 seeds the
 * base set) but <b>not</b> {@code plugin:bind}, so a workspace owner is a natural negative case for
 * every binding verb. Where a same-workspace precondition is needed (deny a detach of a row that
 * really exists), the actor is promoted to the instance administrator, the fixture is built, and the
 * grant is then revoked — that keeps the denial inside the workspace where the rows live, which is
 * the only way "zero rows written" means anything.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
class PluginBindingAuthorizationGateTest extends AbstractH2Test {

    private static final ObjectMapper MAPPER = new ObjectMapper();

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

    @Autowired
    private JdbcTemplate jdbc;

    @BeforeEach
    void usePatchCapableClient() {
        restTemplate.setRequestFactory(new JdkClientHttpRequestFactory(HttpClient.newHttpClient()));
    }

    @Test
    void aDeniedWriterLeavesNoRowNoRevisionAndNoAuditEntry() {
        Actor actor = adminActor();
        String pluginId = seedPlugin(true);
        UUID session = seedSession(actor.workspaceId());
        // PLAN-0691 T1.3: the creator of a binding holds that binding's own PLUGIN_BIND row for as
        // long as the binding lives, so the denied subject below cannot also be the creator — that is
        // exactly the behaviour V139 + PluginBindingGrantWriter add. The fixture is therefore built by
        // a second administrator inside the same workspace; `actor` ends up a plain workspace member
        // with no row of their own and is denied on every verb.
        Actor creator = adminActor();
        workspaceFixture.bindWorkspaceRole(actor.workspaceId(), creator.userId(),
                WorkspaceRole.EDITOR);
        authzContext.invalidate(UUID.fromString(creator.userId()));
        String bindingId = createBinding(creator, actor.workspaceId(), pluginId);
        assertEquals(HttpStatus.CREATED, exchange(creator, actor.workspaceId(), HttpMethod.POST,
                "/api/v1/sessions/" + session + "/plugins", Map.of("bindingId", bindingId))
                .getStatusCode(), "fixture: the second administrator may attach");

        revokeInstanceAdmin(actor.userId());

        // Baselines are taken *after* the revoke on purpose: dropping the role binding re-materializes
        // the grant set and that materialization writes its own audit row. Everything from here on is
        // attributable to the denied writes alone.
        long bindingsBefore = count("plugin_bindings");
        long attachmentsBefore = count("session_plugin_bindings");
        long auditBefore = count("audit_logs");
        int revisionBefore = maxRevision(session);
        int activeBefore = activeAttachments(session);
        String stateBefore = bindingState(bindingId);

        // create — twice, to show the gate runs before *both* the duplicate check (409) and the
        // registry lookups (404): a denied actor must not be able to read the error vocabulary.
        assertDenied(actor, HttpMethod.POST, "/api/v1/plugin-bindings", Map.of("pluginId", pluginId));
        assertDenied(actor, HttpMethod.POST, "/api/v1/plugin-bindings",
                Map.of("pluginId", "official.not-installed"));
        // update / delete on a row that really exists in this workspace.
        assertDenied(actor, HttpMethod.PATCH, "/api/v1/plugin-bindings/" + bindingId,
                Map.of("state", "disabled"));
        assertDenied(actor, HttpMethod.DELETE, "/api/v1/plugin-bindings/" + bindingId, null);
        // attach / detach on a session that really exists in this workspace.
        assertDenied(actor, HttpMethod.POST, "/api/v1/sessions/" + session + "/plugins",
                Map.of("bindingId", bindingId));
        assertDenied(actor, HttpMethod.DELETE,
                "/api/v1/sessions/" + session + "/plugins/" + bindingId, null);

        assertEquals(bindingsBefore, count("plugin_bindings"),
                "a denied create or delete must not change the binding row count");
        assertEquals(attachmentsBefore, count("session_plugin_bindings"),
                "a denied attach must not create an attachment row");
        assertEquals(revisionBefore, maxRevision(session),
                "a denied attach must not spend a snapshot revision");
        assertEquals(activeBefore, activeAttachments(session),
                "a denied detach must not clear detached_at");
        assertEquals(auditBefore, count("audit_logs"),
                "a denied write must not leave an audit row behind");
        assertEquals(stateBefore, bindingState(bindingId),
                "a denied patch must not move the state");

        // Positive control: the same call succeeds once the atom is back, so the six 403s above were
        // about the grant and not about a broken fixture or a permanently closed path.
        grantInstanceAdmin(actor.userId());
        assertEquals(HttpStatus.OK, exchange(actor, HttpMethod.PATCH,
                "/api/v1/plugin-bindings/" + bindingId, Map.of("state", "disabled")).getStatusCode());
    }

    @Test
    void aWorkspaceOwnerHoldsInvokeButNotBind() {
        Actor owner = actor();
        String pluginId = seedPlugin(true);
        long bindingsBefore = count("plugin_bindings");

        ResponseEntity<Map> denied = exchange(owner, HttpMethod.POST, "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId));

        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "WS_OWNER carries plugin:invoke but not plugin:bind (V137)");
        assertEquals(PluginBindingAuthorization.CODE_PLUGIN_GRANT_DENIED,
                denied.getBody().get("code"));
        assertTrue(String.valueOf(denied.getBody().get("detail")).contains("PLUGIN_BIND"),
                "the denial must name the atom it is about: " + denied.getBody().get("detail"));
        assertEquals(bindingsBefore, count("plugin_bindings"),
                "the refused owner must not have created a binding row");
    }

    // ------------------------------------------------------------------ HTTP helpers

    private record Actor(String token, String userId, String workspaceId) {}

    private Actor actor() {
        String email = "plugin-gate-" + UUID.randomUUID() + "@example.test";
        ResponseEntity<Map> registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new HttpEntity<>(Map.of("email", email, "password", "pw-12345678",
                        "name", "Gate Tester"), jsonHeaders()), Map.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode(),
                String.valueOf(registered.getBody()));
        Map<?, ?> user = (Map<?, ?>) registered.getBody().get("user");
        String userId = String.valueOf(user.get("id"));
        String workspaceId = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(userId))
                .getId().toString();
        return new Actor(String.valueOf(registered.getBody().get("accessToken")), userId,
                workspaceId);
    }

    private Actor adminActor() {
        Actor actor = actor();
        grantInstanceAdmin(actor.userId());
        return actor;
    }

    private void grantInstanceAdmin(String userId) {
        UUID subject = UUID.fromString(userId);
        AccessRole adminRole = accessRoles.findByName("ADMIN").orElseThrow();
        roleBindings.save(new AccessRoleBinding(adminRole.getId(), AuthzContext.SUBJECT_USER,
                subject, "instance", null, subject));
        roleBindings.flush();
        roleGrantMaterializer.materializeSubject(AuthzContext.SUBJECT_USER, subject, subject, null);
        authzContext.invalidate(subject);
    }

    /**
     * Drop the instance-scope role binding and re-materialize. The workspace-scope {@code WS_OWNER}
     * binding is untouched on purpose: the tenant interceptor must still admit the request, otherwise
     * the denial would come from membership instead of from the atom and prove nothing.
     */
    private void revokeInstanceAdmin(String userId) {
        UUID subject = UUID.fromString(userId);
        roleBindings.deleteAll(roleBindings.findBySubjectTypeAndSubjectIdAndScopeType(
                AuthzContext.SUBJECT_USER, subject, "instance"));
        roleBindings.flush();
        roleGrantMaterializer.materializeSubject(AuthzContext.SUBJECT_USER, subject, subject, null);
        authzContext.invalidate(subject);
    }

    private void assertDenied(Actor actor, HttpMethod method, String path, Object body) {
        ResponseEntity<Map> response = exchange(actor, method, path, body);
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(),
                method + " " + path + " must be denied: " + response.getBody());
        assertEquals(PluginBindingAuthorization.CODE_PLUGIN_GRANT_DENIED,
                response.getBody().get("code"), method + " " + path);
    }

    private ResponseEntity<Map> exchange(Actor actor, HttpMethod method, String path, Object body) {
        return exchange(actor, actor.workspaceId(), method, path, body);
    }

    private ResponseEntity<Map> exchange(Actor actor, String workspaceId, HttpMethod method,
            String path, Object body) {
        HttpHeaders headers = jsonHeaders();
        headers.setBearerAuth(actor.token());
        headers.set("X-Workspace-Id", workspaceId);
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }

    private static HttpHeaders jsonHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private String createBinding(Actor actor, String workspaceId, String pluginId) {
        ResponseEntity<Map> created = exchange(actor, workspaceId, HttpMethod.POST,
                "/api/v1/plugin-bindings", Map.of("pluginId", pluginId));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        return String.valueOf(created.getBody().get("bindingId"));
    }

    // ------------------------------------------------------------------ row counters

    private long count(String table) {
        Long rows = jdbc.queryForObject("select count(*) from " + table, Long.class);
        return rows == null ? -1 : rows;
    }

    private int maxRevision(UUID session) {
        Integer revision = jdbc.queryForObject(
                "select coalesce(max(revision), 0) from session_plugin_bindings where session_id = ?",
                Integer.class, session);
        return revision == null ? -1 : revision;
    }

    private int activeAttachments(UUID session) {
        Integer rows = jdbc.queryForObject("select count(*) from session_plugin_bindings"
                + " where session_id = ? and detached_at is null", Integer.class, session);
        return rows == null ? -1 : rows;
    }

    private String bindingState(String bindingId) {
        List<String> states = jdbc.queryForList("select state from plugin_bindings where id = ?",
                String.class, UUID.fromString(bindingId));
        assertEquals(1, states.size(), "fixture: the binding row must exist");
        return states.get(0);
    }

    // ------------------------------------------------------------------ fixtures

    private String seedPlugin(boolean enabled) {
        String pluginId = "official.g-" + UUID.randomUUID().toString().substring(0, 8);
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.put("manifestVersion", "1");
        manifest.put("id", pluginId);
        manifest.put("version", "1.0.0");
        manifest.put("source", Plugin.SOURCE_BUILTIN);
        manifest.putObject("runtime").put("kind", "mcp-http")
                .put("endpoint", "https://plugins.example.test/mcp");
        manifest.putArray("actions").addObject().put("name", "demo.echo").put("actionClass", "read");
        manifest.putArray("requestedAtoms").add("plugin:invoke");
        manifest.putObject("limits").put("timeoutMs", 5000);
        manifest.put("digest", PluginManifestValidator.computeDigest(manifest));

        Plugin plugin = new Plugin(pluginId, String.valueOf(manifest.get("digest")), "1.0.0",
                Plugin.SOURCE_BUILTIN, manifest);
        plugin.setCurrent(true);
        if (enabled) {
            plugin.setState(Plugin.STATE_ENABLED);
        }
        plugins.save(plugin);
        return pluginId;
    }

    private UUID seedSession(String workspaceId) {
        var session = new com.cc01cc.p.xihe.cp.entity.Session(workspaceId,
                UUID.randomUUID().toString(), "authorization gate fixture");
        session.setId(UUID.randomUUID());
        sessions.save(session);
        return session.getId();
    }
}
