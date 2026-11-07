package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T2.2: the executor is actually wired into the binding lifecycle — proven end to end on
 * PostgreSQL through the public HTTP surface, not by reading the service constructor.
 *
 * <p>Why this class exists next to {@link PluginRecordsIndexExecutorTest}: that one proves the
 * primitive, this one proves <b>who calls it</b>. A green primitive with an unwired caller is exactly
 * the failure mode a unit test cannot see, and the two directions the wiring must hold are opposite:</p>
 *
 * <ul>
 *   <li>{@code POST /api/v1/plugin-bindings} creates the manifest's declared indexes, records them as
 *       {@code applied} in {@code plugin_index_declarations}, and audits them under
 *       {@code plugin.install};</li>
 *   <li>{@code DELETE /api/v1/plugin-bindings/{id}} drops them, keeps the ledger (LC-6) and audits the
 *       count.</li>
 * </ul>
 *
 * <p>The fixture seeds the registry row directly (like the other plugin tests) so the case states its
 * own precondition: the manifest is what carries {@code storage.collections[].indexes[]}, and that is
 * the only input the executor reads.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
class PluginRecordsIndexWiringTest extends AbstractIntegrationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String COLLECTION = "contacts";
    private static final String DECLARED_INDEX = "by_email";

    @Autowired
    private PluginRepository plugins;

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

    @Test
    void creatingABindingInstallsTheDeclaredIndexesAndDeletingItSweepsThem() {
        Actor actor = adminActor();
        String pluginId = seedPluginWithDeclaredIndex();

        ResponseEntity<Map> created = exchange(actor, HttpMethod.POST, "/api/v1/plugin-bindings",
                Map.of("pluginId", pluginId));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        UUID bindingId = UUID.fromString(String.valueOf(created.getBody().get("bindingId")));

        // 1. the ledger says applied, and the physical index is the name recomputed from that row
        List<Map<String, Object>> ledger = jdbc.queryForList(
                "SELECT collection, index_name, fields, unique_flag, state, applied_at, error"
                        + " FROM plugin_index_declarations WHERE binding_id = ?", bindingId);
        assertEquals(1, ledger.size(),
                "the manifest declared one index, so the binding must own exactly one ledger row");
        Map<String, Object> row = ledger.get(0);
        assertEquals(COLLECTION, row.get("collection"));
        assertEquals(DECLARED_INDEX, row.get("index_name"));
        assertEquals("applied", row.get("state"), "LC-1: install ends with the index applied");
        assertNotNull(row.get("applied_at"));
        assertNull(row.get("error"));

        String expectedName = PluginIndexNaming.physicalName(bindingId, COLLECTION, DECLARED_INDEX);
        List<String> definitions = jdbc.queryForList("SELECT indexdef FROM pg_indexes"
                + " WHERE schemaname = 'public' AND indexname = ?", String.class, expectedName);
        assertEquals(1, definitions.size(),
                "the binding create must have created " + expectedName + " (recomputed from the"
                        + " ledger row, which is the cleanup path's only input)");
        String definition = definitions.get(0).replaceAll("\\s+", "");
        assertTrue(definition.contains("doc->>'email'"),
                "the installed index must index the declared field: " + definitions.get(0));

        // 2. the audit row is the install face's, and it counts the indexes
        List<String> details = jdbc.queryForList("SELECT details FROM audit_logs"
                        + " WHERE action = ? AND resource_id = ?", String.class,
                PluginIndexDdlExecutor.ACTION, bindingId.toString());
        assertEquals(1, details.size(), "exactly one durable install audit row per binding");
        assertTrue(details.get(0).contains("result=applied"), details.get(0));
        assertTrue(details.get(0).contains("indexes="), details.get(0));

        // 3. delete drops the index and keeps the ledger (LC-6)
        assertEquals(HttpStatus.NO_CONTENT,
                exchange(actor, HttpMethod.DELETE, "/api/v1/plugin-bindings/" + bindingId, null)
                        .getStatusCode());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM pg_indexes WHERE schemaname ="
                + " 'public' AND indexname = ?", Integer.class, expectedName),
                "the uninstall path must drop the binding's indexes");
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM plugin_index_declarations"
                + " WHERE binding_id = ?", Integer.class, bindingId),
                "LC-6: the ledger is permanent — it is what makes the drop recoverable");
        List<String> deleteDetails = jdbc.queryForList("SELECT details FROM audit_logs"
                        + " WHERE action = ? AND resource_id = ?", String.class,
                "plugin.binding.delete", bindingId.toString());
        assertEquals(1, deleteDetails.size());
        assertTrue(deleteDetails.get(0).contains("indexes_dropped=1"), deleteDetails.get(0));
    }

    // ------------------------------------------------------------------ fixtures

    private record Actor(String token, String userId, String workspaceId) {}

    private Actor adminActor() {
        String email = "plugin-index-" + UUID.randomUUID() + "@example.test";
        ResponseEntity<Map> registered = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new HttpEntity<>(Map.of("email", email, "password", "pw-12345678",
                        "name", "Index Tester"), jsonHeaders()), Map.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode(),
                String.valueOf(registered.getBody()));
        Map<?, ?> user = (Map<?, ?>) registered.getBody().get("user");
        UUID userId = UUID.fromString(String.valueOf(user.get("id")));
        String workspaceId = workspaceFixture.ensureOwnedWorkspace(userId).getId().toString();

        AccessRole adminRole = accessRoles.findByName("ADMIN").orElseThrow();
        roleBindings.save(new AccessRoleBinding(adminRole.getId(), AuthzContext.SUBJECT_USER,
                userId, "instance", null, userId));
        roleBindings.flush();
        roleGrantMaterializer.materializeSubject(AuthzContext.SUBJECT_USER, userId, userId, null);
        authzContext.invalidate(userId);

        return new Actor(String.valueOf(registered.getBody().get("accessToken")),
                userId.toString(), workspaceId);
    }

    /** The registry row carries the manifest; {@code storage.collections[].indexes[]} is the input. */
    private String seedPluginWithDeclaredIndex() {
        String pluginId = "official.idx-" + UUID.randomUUID().toString().substring(0, 8);
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.put("manifestVersion", "1");
        manifest.put("id", pluginId);
        manifest.put("version", "1.0.0");
        manifest.put("source", Plugin.SOURCE_BUILTIN);
        manifest.putObject("runtime").put("kind", "mcp-http")
                .put("endpoint", "https://plugins.example.test/mcp");
        manifest.putArray("actions").addObject().put("name", "demo.echo")
                .put("actionClass", "read");
        manifest.putArray("requestedAtoms").add("plugin:invoke");
        manifest.putObject("limits").put("timeoutMs", 5000);
        ArrayNode collections = manifest.putObject("storage").putArray("collections");
        ObjectNode contacts = collections.addObject();
        contacts.put("name", COLLECTION);
        contacts.putArray("fields").add("email");
        ObjectNode declared = contacts.putArray("indexes").addObject();
        declared.put("name", DECLARED_INDEX);
        declared.putArray("fields").add("email");
        manifest.put("digest", PluginManifestValidator.computeDigest(manifest));

        Plugin plugin = new Plugin(pluginId, String.valueOf(manifest.get("digest")), "1.0.0",
                Plugin.SOURCE_BUILTIN, manifest);
        plugin.setCurrent(true);
        plugin.setState(Plugin.STATE_ENABLED);
        plugins.save(plugin);
        return pluginId;
    }

    private ResponseEntity<Map> exchange(Actor actor, HttpMethod method, String path, Object body) {
        HttpHeaders headers = jsonHeaders();
        headers.setBearerAuth(actor.token());
        headers.set("X-Workspace-Id", actor.workspaceId());
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }

    private HttpHeaders jsonHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        return headers;
    }
}
