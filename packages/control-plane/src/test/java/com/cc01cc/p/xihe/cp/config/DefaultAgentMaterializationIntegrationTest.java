package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.WorkspacelessDefaultRoster;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * task-932 (D-1922 / 根源1): a default <b>set</b> is materialized, never read through.
 *
 * <p>The four readings the card demands, each against a real PostgreSQL database and the real
 * creation path (not a hand-built fixture row):</p>
 * <ol>
 *   <li>creating a workspace writes {@code workspace_agents} rows with {@code cap_source='baseline'};</li>
 *   <li>re-running the pass never duplicates a row and never rewrites an existing local one;</li>
 *   <li>the reverse proof — editing the upper default leaves an already-created workspace untouched,
 *       while the next workspace is born with the new set;</li>
 *   <li>a missing or disabled default principal is skipped with a WARN and the create still succeeds.</li>
 * </ol>
 *
 * <p>The runtime is the same local stub the first-run seed tests use: {@code createWorkspace} asks it
 * one question (direct-attach capability), and the stub answers {@code available:true}.</p>
 */
class DefaultAgentMaterializationIntegrationTest extends AbstractIntegrationTest {

    private static final FirstRunSeedProbeStub PROBE =
            FirstRunSeedProbeStub.reportingAvailability(true, "windows-mxc");

    @DynamicPropertySource
    static void runtimeProbeUrl(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", PROBE::baseUrl);
    }

    @AfterAll
    static void stopProbe() {
        PROBE.stop();
    }

    @Autowired
    private UserRepository users;
    @Autowired
    private WorkspaceService workspaceService;
    @Autowired
    private AgentPrincipalService agentPrincipalService;
    @Autowired
    private AgentPrincipalRepository agentPrincipals;
    @Autowired
    private WorkspaceAgentRepository workspaceAgents;
    @Autowired
    private ConfigService configService;
    @Autowired
    private JdbcTemplate jdbc;

    @TempDir
    Path workspaceRoot;

    @Test
    void creatingAWorkspaceMaterializesTheDefaultAgentSet() {
        AgentPrincipal lead = newAgent("Task932LeadCreate");
        AgentPrincipal worker = newAgent("Task932WorkerCreate");
        setInstanceDefault(List.of(lead.getId(), worker.getId()));

        Workspace workspace = createWorkspace("task932 create");

        List<WorkspaceAgent> bindings = workspaceAgents.findByIdWorkspaceId(workspace.getId());
        assertEquals(2, bindings.size(), "the two default agents must be materialized on create");
        assertEquals(sortedIds(lead.getId(), worker.getId()), principalIds(bindings),
                "both configured principals must land, whatever order the config listed them in");
        for (WorkspaceAgent binding : bindings) {
            assertEquals(WorkspaceAgent.CAP_SOURCE_BASELINE, binding.getCapSource(),
                    "an omitted permissions array is the role baseline, recorded as cap_source=baseline");
            assertNotNull(binding.getPermissionsSnapshot(),
                    "the baseline is frozen into the row; an empty JSON array is still a value");
        }
        assertEquals(2, jdbc.queryForObject(
                "SELECT count(*) FROM workspace_agents WHERE workspace_id = ?::uuid AND cap_source = 'baseline'",
                Integer.class, workspace.getId().toString()),
                "the DB reading must agree with the repository reading");
    }

    @Test
    void reRunningThePassNeverDuplicatesAndNeverOverwritesALocalRow() {
        AgentPrincipal lead = newAgent("Task932LeadIdem");
        setInstanceDefault(List.of(lead.getId()));

        Workspace workspace = createWorkspace("task932 idem");
        assertEquals(1, workspaceAgents.findByIdWorkspaceId(workspace.getId()).size());

        // 1) Re-running the pass: the row already exists, so nothing is written.
        assertEquals(0, workspaceService.materializeDefaultAgents(workspace.getId(), adminId()),
                "a second pass writes nothing");
        assertEquals(1, workspaceAgents.findByIdWorkspaceId(workspace.getId()).size(),
                "idempotent: no duplicate row");

        // 2) The local row is the source of truth: narrowing its cap must survive a later pass.
        jdbc.update("UPDATE workspace_agents SET cap_source = 'explicit', permissions_snapshot = '[]'::jsonb"
                + " WHERE workspace_id = ?::uuid AND principal_id = ?::uuid",
                workspace.getId().toString(), lead.getId().toString());
        assertEquals(0, workspaceService.materializeDefaultAgents(workspace.getId(), adminId()),
                "an existing local row is never re-derived");
        assertEquals("explicit", jdbc.queryForObject(
                "SELECT cap_source FROM workspace_agents WHERE workspace_id = ?::uuid AND principal_id = ?::uuid",
                String.class, workspace.getId().toString(), lead.getId().toString()),
                "the operator's explicit cap must not be overwritten by the baseline");
    }

    @Test
    void editingTheUpperDefaultNeverRewritesAnExistingWorkspace() {
        AgentPrincipal first = newAgent("Task932First");
        AgentPrincipal second = newAgent("Task932Second");
        setInstanceDefault(List.of(first.getId()));

        Workspace before = createWorkspace("task932 reverse before");
        assertEquals(List.of(first.getId()),
                principalIds(workspaceAgents.findByIdWorkspaceId(before.getId())));

        // The upper default changes AFTER the first workspace exists.
        setInstanceDefault(List.of(second.getId()));
        assertEquals(List.of(first.getId()),
                principalIds(workspaceAgents.findByIdWorkspaceId(before.getId())),
                "THE reverse proof: an upper-layer edit must never rewrite an existing workspace");

        // …and only the workspace created after the edit inherits it.
        Workspace after = createWorkspace("task932 reverse after");
        assertEquals(List.of(second.getId()),
                principalIds(workspaceAgents.findByIdWorkspaceId(after.getId())),
                "forward-only: the new workspace takes the new default");
    }

    @Test
    void aMissingOrDisabledDefaultPrincipalIsSkippedAndCreationStillSucceeds() {
        AgentPrincipal healthy = newAgent("Task932Healthy");
        AgentPrincipal retired = newAgent("Task932Retired");
        // The service's own disable path is workspace-gated (by design); the fixture only needs the
        // row state the materialization checks, so it flips that column directly.
        assertEquals(1, jdbc.update("UPDATE agent_principals SET disabled_at = now() WHERE id = ?::uuid",
                retired.getId().toString()), "the fixture must really disable the principal");
        UUID neverExisted = UUID.randomUUID();
        setInstanceDefault(List.of(healthy.getId(), retired.getId(), neverExisted));

        Workspace workspace = createWorkspace("task932 skip");
        assertNotNull(workspace.getId(), "a bad default must never block creating the workspace");
        assertEquals(List.of(healthy.getId()),
                principalIds(workspaceAgents.findByIdWorkspaceId(workspace.getId())),
                "only the existing, enabled principal lands; the other two are skipped");
    }

    private String adminId() {
        return users.findByEmail("admin@xihe.local")
                .orElseThrow(() -> new AssertionError("the seeded admin must exist in this lane"))
                .getId().toString();
    }

    private AgentPrincipal newAgent(String name) {
        return agentPrincipalService.createPrincipalFromTemplate(adminId(), name, null,
                null, null, null, null, null, null, null);
    }

    private void setInstanceDefault(List<UUID> principalIds) {
        StringBuilder value = new StringBuilder("[");
        for (int i = 0; i < principalIds.size(); i++) {
            if (i > 0) {
                value.append(',');
            }
            value.append("{\"principalKind\":\"AGENT\",\"principalId\":\"")
                    .append(principalIds.get(i)).append("\"}");
        }
        value.append(']');
        configService.putLayer("instance", WorkspacelessDefaultRoster.DOMAIN,
                java.util.Map.of(WorkspacelessDefaultRoster.KEY, value.toString()),
                "admin", null, null);
    }

    private Workspace createWorkspace(String name) {
        String hostPath;
        try {
            Path child = workspaceRoot.resolve(UUID.randomUUID().toString());
            Files.createDirectories(child);
            hostPath = child.toAbsolutePath().toString();
        } catch (java.io.IOException failure) {
            throw new IllegalStateException("cannot create the test host directory", failure);
        }
        return workspaceService.createWorkspace(name, "task-932 fixture", adminId(), null, null,
                FirstRunContentSeeder.WORKSPACE_STORAGE_MODE, hostPath,
                FirstRunContentSeeder.WORKSPACE_EXECUTION_MODE,
                "task932-" + UUID.randomUUID());
    }

    private static List<UUID> principalIds(List<WorkspaceAgent> bindings) {
        List<UUID> ids = new ArrayList<>();
        for (WorkspaceAgent binding : bindings) {
            ids.add(binding.getId().getPrincipalId());
        }
        ids.sort(java.util.Comparator.comparing(UUID::toString));
        return ids;
    }

    private static List<UUID> sortedIds(UUID... ids) {
        List<UUID> list = new ArrayList<>(List.of(ids));
        list.sort(java.util.Comparator.comparing(UUID::toString));
        return list;
    }
}
