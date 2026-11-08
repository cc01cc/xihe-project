package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;

import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0691 T1.6a / D-66: with {@code cp.plugin.enabled=false} (the shipped default) the session
 * attach/detach routes must look like a build that never had them — <b>404</b>, not a 403 and not a
 * successful no-op.
 *
 * <p>The "on" half of the two-state pair lives in {@code PluginSessionAttachmentEventTest}
 * ({@code attach} answers 201/CREATED there); this class is the shipped-default half. Both parts are
 * asserted on the same wire (real HTTP through the real security chain), because
 * {@code @ConditionalOnProperty} removes the controller while the security chain still has to let
 * the request reach the dispatcher for the 404 to be its answer.</p>
 *
 * <p><b>Known gap, recorded rather than hidden</b>: an <i>anonymous</i> request to these
 * {@code /api/v1/**} routes answers 401 before the dispatcher, because the chain's user-principal
 * rule runs first. That is accepted (it does not reveal that the route exists); making anonymous
 * calls answer 404 too would need a feature-off {@code permitAll} rule in
 * {@code config/SecurityConfig}, which is a security-surface change outside this card (T1.6b input).
 * The assertion below therefore sends a <b>valid user token</b> and pins the 404 the flag promises.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=false",
        "cp.plugin.advisory-lock=false"
})
class PluginSessionAttachmentFeatureOffTest extends AbstractH2Test {

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

    @Test
    void sessionPluginRoutesAreNotFoundWhenTheFeatureIsOff() {
        Actor actor = adminActor();
        UUID session = UUID.randomUUID();

        assertEquals(HttpStatus.NOT_FOUND, exchange(actor, HttpMethod.GET,
                "/api/v1/sessions/" + session + "/plugins", null).getStatusCode(),
                "D-66: a flagged-off session plugin surface must answer 404, not 403");
        assertEquals(HttpStatus.NOT_FOUND, exchange(actor, HttpMethod.POST,
                "/api/v1/sessions/" + session + "/plugins",
                Map.of("bindingId", UUID.randomUUID().toString())).getStatusCode(),
                "attaching onto a session must not exist while the flag is off");
        assertEquals(HttpStatus.NOT_FOUND, exchange(actor, HttpMethod.DELETE,
                "/api/v1/sessions/" + session + "/plugins/" + UUID.randomUUID(), null).getStatusCode(),
                "detaching must not exist either — no silent 204 that would look like success");
    }

    @Test
    void theWholePluginSurfaceIsAbsentNotJustTheSessionRoutes() {
        Actor actor = adminActor();

        assertEquals(HttpStatus.NOT_FOUND, exchange(actor, HttpMethod.GET,
                "/api/v1/plugin-bindings", null).getStatusCode(),
                "the catalog/binding surface is behind the same flag");
        assertEquals(HttpStatus.NOT_FOUND, exchange(actor, HttpMethod.GET,
                "/api/v1/plugins", null).getStatusCode());
    }

    @Test
    void anAnonymousCallIsUnauthorizedNotAnExistenceProbe() {
        // Recorded behaviour, not a promise of D-66: the /api/v1 user-principal rule answers before the
        // dispatcher, so an anonymous call is 401. It does not disclose that the route exists.
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Workspace-Id", "00000000-0000-0000-0000-000000000000");
        ResponseEntity<String> anonymous = restTemplate.exchange(
                url("/api/v1/sessions/" + UUID.randomUUID() + "/plugins"), HttpMethod.POST,
                new HttpEntity<>(Map.of("bindingId", UUID.randomUUID().toString()), headers),
                String.class);
        assertEquals(HttpStatus.UNAUTHORIZED, anonymous.getStatusCode(),
                "documented gap: anonymous sees 401; only a valid user token reaches the 404 above");
    }

    /** The other /api/v1 surfaces keep working, so the 404s are specific to the flagged-off plugin. */
    @Test
    void otherApiSurfacesAreUnaffected() {
        Actor actor = adminActor();
        HttpHeaders headers = jsonHeaders();
        headers.setBearerAuth(actor.token());
        headers.set("X-Workspace-Id", actor.workspaceId());
        ResponseEntity<String> response = restTemplate.exchange(url("/api/v1/workspaces"),
                HttpMethod.GET, new HttpEntity<>(null, headers), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(),
                "the flag must not disturb unrelated user surfaces");
    }

    // ------------------------------------------------------------------ helpers

    private record Actor(String token, String userId, String workspaceId) {}

    private Actor actor() {
        String email = "attach-off-" + UUID.randomUUID() + "@example.test";
        ResponseEntity<Map> registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new HttpEntity<>(Map.of("email", email, "password", "pw-12345678",
                        "name", "Off Tester"), jsonHeaders()), Map.class);
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

    /** A user token is enough to pass the chain; the plugin flag, not the atom, is what is tested. */
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
}
