package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.chat.ChatBindingTestSupport;
import com.cc01cc.p.xihe.cp.chat.ChatSubmissionService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.6b on real PostgreSQL + real admission: the session plugin catalog frozen when a Run
 * is admitted, plus the V143 column itself.
 *
 * <p><b>Why this class exists next to {@code PluginRunCatalogSnapshotTest}.</b> The H2 lane proves
 * the Java lifecycle only (it builds the schema from JPA entities and does not run Flyway —
 * {@code application-h2.properties}, DEV-022). This class runs the real Flyway chain on PostgreSQL
 * 17 through {@link AbstractIntegrationTest}'s per-class cloned template DB, so it is the only place
 * this card can claim: (a) V143 applied, (b) {@code chat_runs.plugin_snapshot} exists as
 * {@code jsonb NOT NULL DEFAULT '{}'}, (c) the real {@code ChatSubmissionService} admission writes
 * the frozen document, and (d) a later attach does not move it while the next Run sees the change.</p>
 *
 * <p><b>T2.1 boundary.</b> No {@code tools/list} filtering is asserted here — that is T2.1's card.
 * What is asserted is the precondition it will consume: {@code catalogVersion} copied from the same
 * high-water mark the attach API reports, plus {@code snapshotForRun}/{@code contains} answering the
 * frozen provenance triple.</p>
 */
@TestPropertySource(properties = {
        "cp.plugin.enabled=true",
        "cp.plugin.advisory-lock=false"
})
class PluginRunSnapshotAdmissionTest extends AbstractIntegrationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String VERSION = "1.0.0";

    @Autowired
    private UserRepository users;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private AgentPrincipalRepository agentPrincipals;

    @Autowired
    private WorkspaceAgentRepository workspaceAgents;

    @Autowired
    private ProviderConnectionRepository providerConnections;

    @Autowired
    private ApiRequestTemplateService apiRequestTemplates;

    @Autowired
    private BranchPathService branchPathService;

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private ChatRunRepository runs;

    @Autowired
    private PluginRepository plugins;

    @Autowired
    private PluginBindingRepository bindings;

    @Autowired
    private SessionPluginBindingRepository attachments;

    @Autowired
    private PluginRunCatalogSnapshotService snapshots;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void admissionFreezesTheSessionCatalogIntoTheRunRow() {
        Fixture fixture = fixture();
        String bindingA = attach(fixture, fixture.pluginA(), 1);
        String bindingB = attach(fixture, fixture.pluginB(), 2);
        assertEquals(2, attachments.maxRevision(fixture.sessionId()),
                "the fixture's catalog high-water mark is what the attach API would report");

        String runId = submit(fixture);

        ChatRun run = runs.findById(UUID.fromString(runId)).orElseThrow();
        JsonNode frozen = run.getPluginSnapshot();
        assertEquals(2, frozen.path("catalogVersion").asInt(),
                "the Run is admitted with the catalogVersion the attach API reports (T1.6b carries"
                        + " the number end to end; T2.1 filters tools/list by it)");
        assertEquals("admission", frozen.path("snapshotSource").asText());
        assertEquals(2, frozen.path("items").size(), "both attached bindings are frozen");
        assertEquals(List.of(bindingA, bindingB),
                List.of(frozen.path("items").get(0).path("bindingId").asText(),
                        frozen.path("items").get(1).path("bindingId").asText()));

        String rawJson = jdbcTemplate.queryForObject(
                "SELECT plugin_snapshot::text FROM chat_runs WHERE id = CAST(? AS UUID)",
                String.class, runId);
        JsonNode stored = readTree(rawJson);
        assertEquals(2, stored.path("catalogVersion").asInt(),
                "the frozen document really lives in the PostgreSQL jsonb column (V143), not only"
                        + " in the JPA entity");
        assertTrue(stored.toString().contains(bindingA), "the column carries binding A");
        assertTrue(stored.toString().contains(bindingB), "the column carries binding B");

        PluginRunCatalogSnapshotService.PluginRunSnapshot snapshot =
                snapshots.snapshotForRun(runId).orElseThrow();
        assertEquals(2, snapshot.catalogVersion());
        assertTrue(snapshot.contains(fixture.pluginA(), VERSION, digest(fixture.pluginA())),
                "T2.1's predicate licenses binding A's provenance for this Run");
        assertTrue(snapshot.contains(fixture.pluginB(), VERSION, digest(fixture.pluginB())));
        assertFalse(snapshot.contains(fixture.pluginC(), VERSION, digest(fixture.pluginC())),
                "and does not license a binding that was never attached");
    }

    @Test
    void anAttachAfterAdmissionLeavesTheInFlightRunUntouchedAndTheNextRunSeesIt() {
        Fixture fixture = fixture();
        attach(fixture, fixture.pluginA(), 1);
        String firstRunId = submit(fixture);
        assertEquals(1, snapshots.snapshotForRun(firstRunId).orElseThrow().items().size());

        String bindingC = attach(fixture, fixture.pluginC(), 2);

        ChatRun reread = runs.findById(UUID.fromString(firstRunId)).orElseThrow();
        assertEquals(1, reread.getPluginSnapshot().path("catalogVersion").asInt(),
                "D-62: an attach while this Run is in flight must not move its frozen catalog");
        assertEquals(1, snapshots.snapshotForRun(firstRunId).orElseThrow().items().size());
        assertFalse(snapshots.snapshotForRun(firstRunId).orElseThrow()
                .contains(fixture.pluginC(), VERSION, digest(fixture.pluginC())),
                "the newly attached binding is not part of the in-flight Run's tool face");

        String secondRunId = submit(fixture);
        PluginRunCatalogSnapshotService.PluginRunSnapshot second =
                snapshots.snapshotForRun(secondRunId).orElseThrow();
        assertEquals(2, second.catalogVersion(), "the next Run is admitted with the new catalog");
        assertEquals(2, second.items().size());
        assertEquals(bindingC, second.items().get(1).bindingId().toString(),
                "and its frozen item is the binding attached during the previous Run");
    }

    @Test
    void theMigrationAddedTheNotCapturedDefaultAndKeptItJsonb() {
        Map<String, Object> column = jdbcTemplate.queryForMap(
                "SELECT data_type, is_nullable, column_default FROM information_schema.columns"
                        + " WHERE table_name = 'chat_runs' AND column_name = 'plugin_snapshot'");
        assertEquals(3, column.size(), "the V143 column must exist and expose its shape");
        assertEquals("jsonb", column.get("data_type"), "T1.6b: jsonb, like the other run snapshots");
        assertEquals("NO", column.get("is_nullable"), "a Run always has an answer: {} when not captured");
        assertTrue(String.valueOf(column.get("column_default")).contains("{}"),
                "the shipped default is {} (not captured), so legacy rows need no backfill: "
                        + column.get("column_default"));
    }

    // ------------------------------------------------------------------ fixtures

    private static final class Fixture {
        private final String userId;
        private final UUID workspaceId;
        private final UUID sessionId;

        private Fixture(String userId, UUID workspaceId, UUID sessionId) {
            this.userId = userId;
            this.workspaceId = workspaceId;
            this.sessionId = sessionId;
        }

        String userId() {
            return userId;
        }

        UUID workspaceId() {
            return workspaceId;
        }

        UUID sessionId() {
            return sessionId;
        }

        String pluginA() {
            return "official.a-" + sessionId.toString().substring(0, 6);
        }

        String pluginB() {
            return "official.b-" + sessionId.toString().substring(0, 6);
        }

        String pluginC() {
            return "official.c-" + sessionId.toString().substring(0, 6);
        }
    }

    private Fixture fixture() {
        User user = users.save(new User("plugin-admission-" + UUID.randomUUID() + "@test.com",
                "hash", "Plugin Admission"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Plugin Admission Workspace",
                user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(),
                WorkspaceRole.OWNER);
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Plugin snapshot principal");
        principal.setCreatedByUserId(user.getId().toString());
        ObjectNode templateSnapshot = MAPPER.createObjectNode();
        templateSnapshot.set("permissions", MAPPER.createArrayNode());
        principal.setTemplateSnapshot(templateSnapshot);
        AgentPrincipal savedPrincipal = agentPrincipals.saveAndFlush(principal);
        workspaceAgents.saveAndFlush(new WorkspaceAgent(savedPrincipal.getId().toString(),
                workspace.getId().toString(), MAPPER.createArrayNode()));

        Session session = new Session(workspace.getId().toString(), user.getId().toString(),
                "Plugin snapshot session");
        session.setId(UUID.randomUUID());
        ChatBindingTestSupport.bindNewChatConnection(session, providerConnections,
                apiRequestTemplates, user.getId().toString());
        if (session.getAgentPermissionsSnapshot() == null) {
            session.setAgentPermissionsSnapshot(MAPPER.createArrayNode());
        }
        Session savedSession = sessions.saveAndFlush(session);
        bindPrimaryParticipant(savedSession.getId().toString(), savedPrincipal.getId().toString());

        Fixture fixture = new Fixture(user.getId().toString(), workspace.getId(), savedSession.getId());
        seedPlugin(fixture.pluginA());
        seedPlugin(fixture.pluginB());
        seedPlugin(fixture.pluginC());
        return fixture;
    }

    private void seedPlugin(String pluginId) {
        ObjectNode manifest = MAPPER.createObjectNode();
        manifest.put("manifestVersion", "1");
        manifest.put("id", pluginId);
        manifest.put("version", VERSION);
        manifest.put("digest", digest(pluginId));
        manifest.putArray("actions").addObject().put("name", "demo.echo").put("actionClass", "read");
        manifest.putArray("requestedAtoms").add("plugin:invoke");
        Plugin plugin = new Plugin(pluginId, digest(pluginId), VERSION, Plugin.SOURCE_BUILTIN, manifest);
        plugin.setCurrent(true);
        plugin.setState(Plugin.STATE_ENABLED);
        plugins.saveAndFlush(plugin);
    }

    private String attach(Fixture fixture, String pluginId, int revision) {
        Plugin plugin = plugins.findAll().stream()
                .filter(row -> pluginId.equals(row.getId()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("seed plugin missing: " + pluginId));
        PluginBinding binding = new PluginBinding(fixture.workspaceId(), plugin,
                PluginBindingState.ENABLED, MAPPER.createArrayNode(), PluginBinding.GRANT_SOURCE_DEFAULT);
        bindings.saveAndFlush(binding);
        ObjectNode snapshot = MAPPER.createObjectNode();
        snapshot.put("bindingId", binding.getId().toString());
        snapshot.put("pluginId", pluginId);
        snapshot.put("version", VERSION);
        snapshot.put("digest", digest(pluginId));
        snapshot.put("state", "enabled");
        attachments.saveAndFlush(new SessionPluginBinding(fixture.sessionId(), binding.getId(),
                snapshot, revision));
        return binding.getId().toString();
    }

    private String submit(Fixture fixture) {
        String sessionId = fixture.sessionId().toString();
        String branchId = branchPathService.ensureRootBranchId(sessionId);
        String runId = UUID.randomUUID().toString();
        submissionService.create(runId, sessionId, fixture.userId(),
                fixture.workspaceId().toString(), branchId, "idem-" + runId, "request-hash",
                "provider", "model", "none", null, null, "lease-owner",
                UUID.randomUUID().toString(), "plugin snapshot admission", "[]", List.of());
        return runId;
    }

    private static String digest(String pluginId) {
        return "sha256:" + pluginId;
    }

    private static JsonNode readTree(String raw) {
        try {
            return MAPPER.readTree(raw);
        } catch (com.fasterxml.jackson.core.JsonProcessingException notJson) {
            throw new AssertionError("chat_runs.plugin_snapshot is not JSON: " + raw, notJson);
        }
    }
}
