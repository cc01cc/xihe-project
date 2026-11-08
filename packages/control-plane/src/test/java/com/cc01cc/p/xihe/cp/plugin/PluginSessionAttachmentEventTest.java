package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/**
 * PLAN-0691 T1.6a: session attach/detach announce exactly one {@code plugin_binding} event, the
 * session's {@code catalogVersion} advances once per catalog change, and the frozen snapshot an
 * in-flight run was admitted with does not move underneath it.
 *
 * <p><b>What this class is evidence for.</b> Three obligations the card separates, all on real
 * HTTP + real persistence (H2 here follows the {@code PluginBindingControllerTest} choice: the JPA
 * mapping is what these assertions are about, and the PostgreSQL DDL constraints are proven in
 * {@code PluginBindingSchemaMigrationTest}):</p>
 * <ol>
 *   <li><b>Event</b> — one kind-only {@code plugin_binding} per real change (attach / detach), none
 *       for an idempotent repeat, published after commit, in catalog order. The event carries no
 *       per-binding payload because the 9-field envelope has no slot for it (T1.6b's cross-wire
 *       decision); the UI consumes it as "re-read the attached set" and parses no body.</li>
 *   <li><b>catalogVersion</b> — the per-session high-water {@code max(revision)}. {@code revision} is
 *       the session catalog sequence value an attachment was admitted at, and <b>every</b> change
 *       takes the next value of that sequence (fresh attach 1, detach 2, re-attach 3 — and a second
 *       binding attached into the same session takes 2, not another 1), so the value the
 *       {@code PluginAttachResult} returns moves once per catalog change without a second counter
 *       column and therefore without a migration (ruling: zero-migration T1.6a).</li>
 *   <li><b>Freeze</b> — an attachment's {@code snapshot}/{@code revision} is the record of what a
 *       run was admitted with. A later attach or detach of <i>another</i> binding changes the
 *       session's catalogVersion but must leave the existing row's frozen view identical. The run
 *       side that reads these snapshots is T2.1; this class proves the seam it will read from is
 *       stable, and says so instead of pretending a run-side assertion exists.</li>
 * </ol>
 *
 * <p><b>Not asserted here (and why)</b>: SSE delivery to a browser (the manager's own unit tests
 * cover publish/whitelist, and this class asserts the publish call itself); the envelope's payload
 * shape (deliberately unchanged); a run-side catalog snapshot (no such column/field exists yet —
 * that is T1.6b's input).</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
class PluginSessionAttachmentEventTest extends AbstractH2Test {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Autowired
    private PluginRepository plugins;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private SessionPluginBindingRepository attachments;

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

    @MockitoSpyBean
    private WorkspaceEventManager events;

    @MockitoSpyBean
    private AuditLogger auditLogger;

    @BeforeEach
    void usePatchCapableClient() {
        restTemplate.setRequestFactory(new JdkClientHttpRequestFactory(HttpClient.newHttpClient()));
    }

    @Test
    void attachPublishesOneKindOnlyCatalogEvent() {
        Actor actor = adminActor();
        String bindingId = createBinding(actor, seedPlugin(Plugin.SOURCE_BUILTIN, true));
        UUID session = seedSession(actor.workspaceId());
        String workspace = actor.workspaceId();

        long sequenceBefore = events.currentSequence(workspace);
        ResponseEntity<Map> attached = attach(actor, session, bindingId);

        assertEquals(HttpStatus.CREATED, attached.getStatusCode(), String.valueOf(attached.getBody()));
        assertEquals(1, attached.getBody().get("revision"));
        assertEquals(1, attached.getBody().get("catalogVersion"),
                "the first catalog change of the session is catalogVersion 1");
        assertEquals(true, attached.getBody().get("effectiveNextTurn"),
                "S4: an attach takes effect next turn, not in the run already executing");

        ArgumentCaptor<String> reason = ArgumentCaptor.forClass(String.class);
        verify(events, times(1)).publishPluginBindingChanged(eq(workspace), reason.capture());
        assertEquals("attach", reason.getValue());
        assertEquals(sequenceBefore + 1, events.currentSequence(workspace),
                "exactly one event: the workspace stream advances by one");
    }

    @Test
    void detachPublishesOneEventAndBumpsCatalogVersion() {
        Actor actor = adminActor();
        String bindingId = createBinding(actor, seedPlugin(Plugin.SOURCE_BUILTIN, true));
        UUID session = seedSession(actor.workspaceId());
        String workspace = actor.workspaceId();

        attach(actor, session, bindingId);
        assertEquals(1, maxRevision(session));

        ResponseEntity<Map> detached = detach(actor, session, bindingId);
        assertEquals(HttpStatus.NO_CONTENT, detached.getStatusCode());

        assertEquals(2, maxRevision(session),
                "T1.6: a detach is a catalog change and spends one revision (the pre-T1.6 skeleton"
                        + " left it at 1, which made catalogVersion stand still on detach)");
        verify(events).publishPluginBindingChanged(eq(workspace), eq("detach"));
        verify(auditLogger).recordDurableChange(any(), eq(workspace),
                eq("plugin.binding.detach"), any(), any(),
                contains("catalogVersion=2"));
    }

    @Test
    void anIdempotentRepeatPublishesNothingAndSpendsNoRevision() {
        Actor actor = adminActor();
        String bindingId = createBinding(actor, seedPlugin(Plugin.SOURCE_BUILTIN, true));
        UUID session = seedSession(actor.workspaceId());
        String workspace = actor.workspaceId();

        attach(actor, session, bindingId);
        long afterFirstAttach = events.currentSequence(workspace);
        attach(actor, session, bindingId);

        assertEquals(1, maxRevision(session), "a repeated attach must not spend a revision");
        assertEquals(afterFirstAttach, events.currentSequence(workspace),
                "idempotent attach must not announce a catalog change that did not happen");

        detach(actor, session, bindingId);
        long afterDetach = events.currentSequence(workspace);
        assertEquals(2, maxRevision(session));
        detach(actor, session, bindingId);

        assertEquals(2, maxRevision(session),
                "the second DELETE is a no-op: detaching an already-detached pair must not bump"
                        + " again (otherwise every retry would inflate catalogVersion)");
        assertEquals(afterDetach, events.currentSequence(workspace));
    }

    @Test
    void reattachAfterDetachReportsTheNextCatalogVersion() {
        Actor actor = adminActor();
        String bindingId = createBinding(actor, seedPlugin(Plugin.SOURCE_BUILTIN, true));
        UUID session = seedSession(actor.workspaceId());
        String workspace = actor.workspaceId();

        assertEquals(1, attach(actor, session, bindingId).getBody().get("catalogVersion"));
        detach(actor, session, bindingId);
        ResponseEntity<Map> reattached = attach(actor, session, bindingId);

        assertEquals(3, reattached.getBody().get("revision"),
                "revision: attach=1, detach bumps to 2, re-attach bumps to 3");
        assertEquals(3, reattached.getBody().get("catalogVersion"),
                "catalogVersion is the session high-water mark, so it follows the same sequence");

        ArgumentCaptor<String> reasons = ArgumentCaptor.forClass(String.class);
        verify(events, times(3)).publishPluginBindingChanged(eq(workspace), reasons.capture());
        assertEquals(List.of("attach", "detach", "attach"), reasons.getAllValues(),
                "events follow catalog order attach → detach → attach");
    }

    /**
     * The freeze seam T2.1 will read: an attachment row is the frozen answer to "what was this run
     * admitted with". Attaching a <b>second</b> binding moves the session's catalogVersion, and must
     * not rewrite the first row's snapshot or revision — that is what makes "this run still sees the
     * old catalog" true without a run-side column.
     */
    @Test
    void aLaterCatalogChangeLeavesTheExistingFrozenSnapshotIntact() {
        Actor actor = adminActor();
        String pluginA = seedPlugin(Plugin.SOURCE_BUILTIN, true);
        String pluginB = seedPlugin(Plugin.SOURCE_BUILTIN, true);
        String bindingA = createBinding(actor, pluginA);
        String bindingB = createBinding(actor, pluginB);
        UUID session = seedSession(actor.workspaceId());

        attach(actor, session, bindingA);
        Map<?, ?> frozen = item(listAttached(actor, session), bindingA);
        int frozenRevision = (Integer) frozen.get("revision");
        String frozenDigest = String.valueOf(frozen.get("digest"));

        ResponseEntity<Map> second = attach(actor, session, bindingB);
        assertEquals(2, second.getBody().get("revision"),
                "the second binding takes the next session sequence value, not a fresh 1");
        assertEquals(2, second.getBody().get("catalogVersion"),
                "the session catalog moved to 2 with the second attach");

        Map<?, ?> afterSecond = item(listAttached(actor, session), bindingA);
        assertEquals(frozenRevision, afterSecond.get("revision"),
                "the frozen row of binding A keeps its revision: a catalog change elsewhere does not"
                        + " re-admit an earlier run with a different snapshot");
        assertEquals(frozenDigest, String.valueOf(afterSecond.get("digest")),
                "and its snapshot still names the same plugin version/digest");

        detach(actor, session, bindingB);
        Map<?, ?> afterDetach = item(listAttached(actor, session), bindingA);
        assertEquals(frozenRevision, afterDetach.get("revision"));
        assertEquals(frozenDigest, String.valueOf(afterDetach.get("digest")));
        assertTrue(maxRevision(session) >= 3,
                "attach A=1, attach B=2, detach B=3: the session sequence advanced, A's row did not");
    }

    // ------------------------------------------------------------------ helpers

    /** A registered principal plus a workspace it owns (PLAN-0614 recipe). */
    private record Actor(String token, String userId, String workspaceId) {}

    private Actor actor() {
        String email = "session-attach-" + UUID.randomUUID() + "@example.test";
        ResponseEntity<Map> registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new HttpEntity<>(Map.of("email", email, "password", "pw-12345678",
                        "name", "Attach Tester"), jsonHeaders()), Map.class);
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

    /** M1: {@code PLUGIN_BIND} is on the instance-administrator tier (V137), reached really. */
    private Actor adminActor() {
        Actor actor = actor();
        UUID subject = UUID.fromString(actor.userId());
        AccessRole adminRole = accessRoles.findByName("ADMIN").orElseThrow();
        roleBindings.save(new AccessRoleBinding(adminRole.getId(), AuthzContext.SUBJECT_USER,
                subject, "instance", null, subject));
        roleBindings.flush();
        roleGrantMaterializer.materializeSubject(AuthzContext.SUBJECT_USER, subject, subject, null);
        authzContext.invalidate(subject);
        return actor;
    }

    private ResponseEntity<Map> exchange(Actor actor, HttpMethod method, String path, Object body) {
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

    private String createBinding(Actor actor, String pluginId) {
        ResponseEntity<Map> created = exchange(actor, HttpMethod.POST, "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        return String.valueOf(created.getBody().get("bindingId"));
    }

    private ResponseEntity<Map> attach(Actor actor, UUID session, String bindingId) {
        return exchange(actor, HttpMethod.POST, "/api/v1/sessions/" + session + "/plugins",
                Map.of("bindingId", bindingId));
    }

    private ResponseEntity<Map> detach(Actor actor, UUID session, String bindingId) {
        return exchange(actor, HttpMethod.DELETE,
                "/api/v1/sessions/" + session + "/plugins/" + bindingId, null);
    }

    private List<?> listAttached(Actor actor, UUID session) {
        ResponseEntity<Map> listed = exchange(actor, HttpMethod.GET,
                "/api/v1/sessions/" + session + "/plugins", null);
        assertEquals(HttpStatus.OK, listed.getStatusCode(), String.valueOf(listed.getBody()));
        return (List<?>) listed.getBody().get("items");
    }

    private static Map<?, ?> item(List<?> items, String bindingId) {
        return items.stream().map(Map.class::cast)
                .filter(item -> bindingId.equals(String.valueOf(item.get("bindingId"))))
                .findFirst().orElseThrow(() -> new AssertionError("binding " + bindingId
                        + " is not in the attached list: " + items));
    }

    private int maxRevision(UUID session) {
        return attachments.maxRevision(session);
    }

    private String seedPlugin(String source, boolean enabled) {
        String pluginId = "official.s-" + UUID.randomUUID().toString().substring(0, 8);
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.put("manifestVersion", "1");
        manifest.put("id", pluginId);
        manifest.put("version", "1.0.0");
        manifest.put("source", source);
        manifest.putObject("runtime").put("kind", "mcp-http")
                .put("endpoint", "https://plugins.example.test/mcp");
        manifest.putArray("actions").addObject().put("name", "demo.echo")
                .put("actionClass", "read");
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
                UUID.randomUUID().toString(), "attach fixture");
        session.setId(UUID.randomUUID());
        sessions.save(session);
        return session.getId();
    }
}
