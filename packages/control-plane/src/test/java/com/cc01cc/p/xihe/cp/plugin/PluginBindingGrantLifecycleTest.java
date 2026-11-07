package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.policy.PluginBindingAuthorization;
import com.cc01cc.p.xihe.cp.policy.PluginBindingAuthorization.GrantRow;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.fasterxml.jackson.databind.JsonNode;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.http.HttpClient;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.3: the <b>producer</b> of {@code source='plugin_binding'} rows — the half of the gate
 * that did not exist ({@code plugin_binding} was a documented grant source with no issuer).
 *
 * <p>The assertions are built so that a no-op producer cannot pass them:</p>
 * <ul>
 *   <li><b>Positive</b> — after the creator is stripped of the {@code ADMIN} role, the same
 *       {@code PATCH}/{@code DELETE} keeps working. The only remaining {@code PLUGIN_BIND} hold is
 *       the row this class issued, so a 200 is the row being read by the real gate.</li>
 *   <li><b>Non-vacuity</b> — deleting that row through the DB (not through the revoke path) flips the
 *       same call to {@code 403 PLUGIN_GRANT_DENIED}. That proves the 200 above was the row's doing
 *       and not a role that quietly came back.</li>
 *   <li><b>Revocation</b> — after {@code DELETE /plugin-bindings/{id}} the rows of that binding
 *       origin are 0 <i>and</i> the subject's {@code require()} throws 403. Row counting alone would
 *       only prove the result; the 403 proves the path.</li>
 *   <li><b>Grantee stability</b> — an update by a <i>different</i> administrator must not move the
 *       hold to that administrator, so the updater's own {@code PLUGIN_BIND} still comes only from
 *       their role.</li>
 *   <li><b>Same transaction</b> — a rolled-back delete restores the binding <i>and</i> its grant row.
 *       A {@code REQUIRES_NEW} writer would leave the grant deleted while the binding came back,
 *       so this assertion discriminates "joins the caller's transaction" from "commits on its own".</li>
 * </ul>
 *
 * <p>Scope of the claim: this class proves the five behaviours above for the H2 profile through the
 * real HTTP surface. It does not prove concurrency (two simultaneous deletes) and does not prove the
 * migration's constraint widening — that evidence is the {@code V139} run against PostgreSQL.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
class PluginBindingGrantLifecycleTest extends AbstractH2Test {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** The kernel's atom name, taken from its own constant — the gate compares these verbatim. */
    private static final String ACTION_PLUGIN_BIND = ToolFaceRegistry.ACTION_PLUGIN_BIND;

    @Autowired
    private PluginRepository plugins;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.SessionRepository sessions;

    @Autowired
    private PluginBindingService pluginBindingService;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private AccessRoleRepository accessRoles;

    @Autowired
    private AccessRoleBindingRepository roleBindings;

    @Autowired
    private RoleGrantMaterializer roleGrantMaterializer;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private JdbcTemplate jdbc;

    @BeforeEach
    void usePatchCapableClient() {
        restTemplate.setRequestFactory(new JdkClientHttpRequestFactory(HttpClient.newHttpClient()));
    }

    // ------------------------------------------------------------------ create ⇒ issue

    @Test
    void createIssuesOneWorkspaceScopedRowForTheCreatingActor() {
        Actor actor = adminActor();
        String bindingId = createBinding(actor, seedPlugin(true));

        List<AuthorizationGrant> issued = issuedRows(UUID.fromString(bindingId));
        assertEquals(1, issued.size(), "create must issue exactly one grant row");
        AuthorizationGrant row = issued.get(0);
        assertEquals(GrantSources.PLUGIN_BINDING, row.getSource());
        assertEquals(GrantSources.PLUGIN_BINDING, row.getGranterType(),
                "granter_type carries the provenance, and equals the source token by construction");
        assertEquals(UUID.fromString(bindingId), row.getGranterId(),
                "granter_id is the binding that issued the row");
        assertEquals(AuthzContext.SUBJECT_USER, row.getSubjectType());
        assertEquals(UUID.fromString(actor.userId()), row.getSubjectId(),
                "the grantee is the creating actor");
        assertEquals("workspace", row.getScopeType(), "the authorization surface is the workspace");
        assertEquals(UUID.fromString(actor.workspaceId()), row.getScopeId());
        assertEquals(List.of(ACTION_PLUGIN_BIND), actionClasses(row),
                "the row carries the binding atom and nothing else");
        assertEquals("read", row.getReadState());
    }

    /**
     * Ruling 6's guard rail, at the kernel: adding {@code plugin_binding} to the evaluation set must
     * not widen <i>which atom</i> a row authorizes, nor revive the retired {@code default}/{@code direct}
     * sources. A row of that source carrying {@code PLUGIN_BIND} grants {@code PLUGIN_BIND} only.
     */
    @Test
    void aBindingRowAuthorizesOnlyTheBindAtomAndOnlyFromAnEvaluatedSource() {
        String bind = PluginBindingAuthorization
                .requiredAtom(PluginBindingAuthorization.Op.BIND_TO_WORKSPACE);
        List<GrantRow> held = List.of(new GrantRow(bind, GrantSources.PLUGIN_BINDING, null));

        assertTrue(PluginBindingAuthorization.evaluate(held, bind).allowed(),
                "a plugin_binding row must authorize the atom it carries");
        for (String other : List.of(ToolFaceRegistry.ACTION_PLUGIN_MANAGE,
                ToolFaceRegistry.ACTION_PLUGIN_INVOKE, ToolFaceRegistry.ACTION_PLUGIN_DATA)) {
            assertFalse(PluginBindingAuthorization.evaluate(held, other).allowed(),
                    "a plugin_binding row must not authorize " + other);
        }
        // Same atom, retired sources: still inert (GrantSources.EVALUATION_SOURCES is the second gate).
        for (String inert : List.of(GrantSources.DEFAULT, GrantSources.DIRECT)) {
            assertFalse(PluginBindingAuthorization
                            .evaluate(List.of(new GrantRow(bind, inert, null)), bind).allowed(),
                    "source " + inert + " must stay inert");
        }
    }

    // ------------------------------------------------------------------ the row is what the gate reads

    @Test
    void theIssuedRowAloneSatisfiesTheWriteGate() {
        Actor actor = adminActor();
        String bindingId = createBinding(actor, seedPlugin(true));

        revokeInstanceAdmin(actor.userId());
        assertNotEquals(0, countGrantRows(UUID.fromString(bindingId)),
                "precondition: the issued row survives the role change");
        assertEquals(HttpStatus.OK, patch(actor, bindingId, "disabled").getStatusCode(),
                "with only the plugin_binding row left, the same subject must still pass the gate");

        // Non-vacuity: remove the row behind the producer's back and the identical call is denied.
        jdbc.update("delete from grants where source = ? and granter_id = ?",
                GrantSources.PLUGIN_BINDING, UUID.fromString(bindingId));
        ResponseEntity<Map> denied = patch(actor, bindingId, "enabled");
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "without the row the same subject is denied — the 200 above was the row's doing");
        assertEquals(PluginBindingAuthorization.CODE_PLUGIN_GRANT_DENIED,
                denied.getBody().get("code"));
    }

    // ------------------------------------------------------------------ delete ⇒ revoke

    @Test
    void deleteRevokesTheRowsAndTheSameCallThenAnswers403() {
        Actor actor = adminActor();
        String bindingId = createBinding(actor, seedPlugin(true));
        revokeInstanceAdmin(actor.userId());

        // Still allowed, and it is the issued row that allows it (see the test above for the proof).
        assertEquals(HttpStatus.OK, patch(actor, bindingId, "disabled").getStatusCode(),
                "fixture: the creator manages the binding through the issued row");

        assertEquals(HttpStatus.NO_CONTENT,
                exchange(actor, HttpMethod.DELETE, "/api/v1/plugin-bindings/" + bindingId, null)
                        .getStatusCode(), "the delete itself must be authorized by the issued row");

        assertEquals(0, countGrantRows(UUID.fromString(bindingId)),
                "delete ⇒ every row of that binding origin is gone");
        assertEquals(0, countBindingRows(UUID.fromString(bindingId)), "the binding row is gone too");

        ResponseEntity<Map> after = patch(actor, bindingId, "enabled");
        assertEquals(HttpStatus.FORBIDDEN, after.getStatusCode(),
                "after the delete the subject's require() must throw, not just the table be empty");
        assertEquals(PluginBindingAuthorization.CODE_PLUGIN_GRANT_DENIED, after.getBody().get("code"));
        assertTrue(String.valueOf(after.getBody().get("detail")).contains("PLUGIN_BIND"),
                "the denial must name the atom: " + after.getBody().get("detail"));
    }

    // ------------------------------------------------------------------ update ⇒ replace in place

    @Test
    void updateKeepsOneRowAndDoesNotMoveAuthorityToTheUpdater() {
        String pluginId = seedPlugin(true);
        Actor creator = adminActor();
        String bindingId = createBinding(creator, pluginId);

        Actor otherAdmin = adminActor();
        // The binding lives in the creator's workspace, so the second administrator must be a member
        // of that workspace — their PLUGIN_BIND comes from the instance ADMIN role either way.
        workspaceFixture.bindWorkspaceRole(creator.workspaceId(), otherAdmin.userId(),
                WorkspaceRole.EDITOR);
        authzContext.invalidate(UUID.fromString(otherAdmin.userId()));
        assertEquals(HttpStatus.OK, patchIn(otherAdmin, creator.workspaceId(), bindingId, "disabled")
                        .getStatusCode(),
                "a second administrator may update the binding (they hold the atom from their role)");
        assertEquals(1, countGrantRows(UUID.fromString(bindingId)),
                "update must replace, not add: still exactly one row for this binding");
        assertEquals(UUID.fromString(creator.userId()), issuedRows(UUID.fromString(bindingId))
                .get(0).getSubjectId(), "update must not move the hold to the updating actor");

        // The updater's authority was their role; strip it and the hold they never received is gone.
        revokeInstanceAdmin(otherAdmin.userId());
        assertEquals(HttpStatus.FORBIDDEN,
                patchIn(otherAdmin, creator.workspaceId(), bindingId, "enabled").getStatusCode(),
                "the updater never received a plugin_binding row of their own");

        // The row keeps answering for the creator, and a later update by them repairs nothing.
        revokeInstanceAdmin(creator.userId());
        assertEquals(HttpStatus.OK, patch(creator, bindingId, "enabled").getStatusCode(),
                "the creator still holds the binding through the row issued at create");
        assertEquals(1, countGrantRows(UUID.fromString(bindingId)), "still one row after the update");
    }

    // ------------------------------------------------------------------ detach ⇒ leave grants alone

    @Test
    void detachDoesNotRevokeTheWorkspaceHold() {
        Actor actor = adminActor();
        String bindingId = createBinding(actor, seedPlugin(true));
        UUID session = seedSession(actor.workspaceId());
        assertEquals(HttpStatus.CREATED, exchange(actor, HttpMethod.POST,
                "/api/v1/sessions/" + session + "/plugins", Map.of("bindingId", bindingId))
                .getStatusCode(), "fixture: attach succeeds");

        revokeInstanceAdmin(actor.userId());
        assertEquals(HttpStatus.NO_CONTENT, exchange(actor, HttpMethod.DELETE,
                "/api/v1/sessions/" + session + "/plugins/" + bindingId, null).getStatusCode(),
                "the detach is authorized by the issued row");

        assertEquals(1, countGrantRows(UUID.fromString(bindingId)),
                "detach must not revoke anything: no per-session authority was ever issued");
        assertEquals(HttpStatus.OK, patch(actor, bindingId, "disabled").getStatusCode(),
                "the reverse assertion: after the detach the workspace hold still passes the gate");
    }

    // ------------------------------------------------------------------ same transaction

    @Test
    void aRolledBackDeleteRestoresTheBindingAndItsGrant() {
        Actor actor = adminActor();
        String bindingId = createBinding(actor, seedPlugin(true));
        revokeInstanceAdmin(actor.userId());

        TransactionTemplate template = new TransactionTemplate(transactionManager);
        template.executeWithoutResult(status -> {
            pluginBindingService.delete(actor.workspaceId(), bindingId, actor.userId());
            status.setRollbackOnly();
        });

        assertEquals(1, countBindingRows(UUID.fromString(bindingId)),
                "rollback must bring the binding row back");
        assertEquals(1, countGrantRows(UUID.fromString(bindingId)),
                "rollback must bring the grant row back too — a REQUIRES_NEW writer would not");
        assertEquals(HttpStatus.OK, patch(actor, bindingId, "disabled").getStatusCode(),
                "the restored row still authorizes, so it is a live row and not a residue");
    }

    // ------------------------------------------------------------------ grant row helpers

    private List<AuthorizationGrant> issuedRows(UUID bindingId) {
        List<AuthorizationGrant> rows = new ArrayList<>();
        for (AuthorizationGrant grant : grantRepository.findBySubjectTypeAndSubjectId(
                AuthzContext.SUBJECT_USER, subjectOf(bindingId))) {
            if (GrantSources.PLUGIN_BINDING.equals(grant.getSource())
                    && bindingId.equals(grant.getGranterId())) {
                rows.add(grant);
            }
        }
        return rows;
    }

    /** The workspace-scoped rows a binding issued, counting every subject (0 proves the revoke). */
    private int countGrantRows(UUID bindingId) {
        Integer rows = jdbc.queryForObject(
                "select count(*) from grants where source = ? and granter_id = ?", Integer.class,
                GrantSources.PLUGIN_BINDING, bindingId);
        return rows == null ? -1 : rows;
    }

    private int countBindingRows(UUID bindingId) {
        Integer rows = jdbc.queryForObject("select count(*) from plugin_bindings where id = ?",
                Integer.class, bindingId);
        return rows == null ? -1 : rows;
    }

    private UUID subjectOf(UUID bindingId) {
        return UUID.fromString(jdbc.queryForObject(
                "select subject_id from grants where source = ? and granter_id = ?", String.class,
                GrantSources.PLUGIN_BINDING, bindingId));
    }

    private static List<String> actionClasses(AuthorizationGrant row) {
        List<String> atoms = new ArrayList<>();
        JsonNode permissions = row.getPermissions();
        if (permissions != null && permissions.isArray()) {
            for (JsonNode permission : permissions) {
                atoms.add(permission.path("actionClass").asText(null));
            }
        }
        return atoms;
    }

    // ------------------------------------------------------------------ HTTP helpers

    private record Actor(String token, String userId, String workspaceId) {}

    private Actor actor() {
        String email = "plugin-grant-" + UUID.randomUUID() + "@example.test";
        ResponseEntity<Map> registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new HttpEntity<>(Map.of("email", email, "password", "pw-12345678",
                        "name", "Grant Tester"), jsonHeaders()), Map.class);
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

    private void revokeInstanceAdmin(String userId) {
        UUID subject = UUID.fromString(userId);
        roleBindings.deleteAll(roleBindings.findBySubjectTypeAndSubjectIdAndScopeType(
                AuthzContext.SUBJECT_USER, subject, "instance"));
        roleBindings.flush();
        roleGrantMaterializer.materializeSubject(AuthzContext.SUBJECT_USER, subject, subject, null);
        authzContext.invalidate(subject);
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

    private ResponseEntity<Map> patch(Actor actor, String bindingId, String state) {
        return exchange(actor, HttpMethod.PATCH, "/api/v1/plugin-bindings/" + bindingId,
                Map.of("state", state));
    }

    private ResponseEntity<Map> patchIn(Actor actor, String workspaceId, String bindingId,
            String state) {
        return exchange(actor, workspaceId, HttpMethod.PATCH,
                "/api/v1/plugin-bindings/" + bindingId, Map.of("state", state));
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
                UUID.randomUUID().toString(), "plugin grant lifecycle fixture");
        session.setId(UUID.randomUUID());
        sessions.save(session);
        return session.getId();
    }
}
