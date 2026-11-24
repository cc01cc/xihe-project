package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;

/**
 * task-1015: workspace default materialization must not inherit the manual bind's owner-only rule.
 *
 * <p>Three visibility states on one real PostgreSQL database and the real creation path:</p>
 * <ul>
 *   <li>A-owned principal — visible to the creator A ⇒ materialized;</li>
 *   <li>owner-less principal (shared) — visible to any authorized creator ⇒ materialized;</li>
 *   <li>B-owned principal — invisible to A ⇒ skipped, and creation still succeeds.</li>
 * </ul>
 *
 * <p>The second half is the negative assertion: the SAME A calling the manual
 * {@link AgentPrincipalService#setWorkspaceCap} for B's principal still gets
 * {@code 403 AGENT_PRINCIPAL_OWNER_MISMATCH}. The default path must not widen the human face.</p>
 */
class DefaultAgentOwnerBoundaryIntegrationTest extends AbstractIntegrationTest {

    static WireMockServer runtime = new WireMockServer(wireMockConfig().dynamicPort());

    static {
        runtime.start();
    }

    @DynamicPropertySource
    static void runtimeProbeUrl(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + runtime.port());
    }

    @BeforeAll
    static void stubRuntime() {
        runtime.stubFor(post(urlEqualTo("/internal/v1/runtime/capabilities/direct-attach/probe"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                                + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                                + "\"executionMode\":\"windows-host\",\"available\":true}")));
        runtime.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"ok\"}")));
    }

    @AfterAll
    static void stopRuntime() {
        runtime.stop();
    }

    @Autowired
    private UserRepository users;
    @Autowired
    private AgentPrincipalService agentPrincipalService;
    @Autowired
    private AgentPrincipalRepository agentPrincipals;
    @Autowired
    private WorkspaceService workspaceService;
    @Autowired
    private WorkspaceAgentRepository workspaceAgents;
    @Autowired
    private ConfigService configService;
    @Autowired
    private JdbcTemplate jdbc;

    @TempDir
    Path workspaceRoot;

    @Test
    void aNonOwnerCreatorStillInheritsOnlyThePrincipalsItCanSee() {
        User creator = newUser("task1015-creator");
        User foreign = newUser("task1015-foreign");

        AgentPrincipal visible = newAgent("Task1015Visible");
        AgentPrincipal shared = newAgent("Task1015Shared");
        AgentPrincipal invisible = newAgent("Task1015Invisible");

        // The entity has no owner setter on the create path (D-174 keeps owner NULL), so the fixture
        // writes the exact column the visibility predicate reads.
        assertEquals(1, jdbc.update("UPDATE agent_principals SET owner_user_id = ?::uuid WHERE id = ?::uuid",
                creator.getId().toString(), visible.getId().toString()));
        assertEquals(1, jdbc.update("UPDATE agent_principals SET owner_user_id = ?::uuid WHERE id = ?::uuid",
                foreign.getId().toString(), invisible.getId().toString()));
        assertNull(agentPrincipals.findById(shared.getId()).orElseThrow().getOwnerUserId(),
                "the third principal stays owner-less, i.e. shared");

        setInstanceDefault(List.of(visible.getId(), shared.getId(), invisible.getId()));

        Workspace workspace = createWorkspace("task1015 non-owner create", creator.getId().toString());
        assertNotNull(workspace.getId(), "a skipped default must never block workspace creation");

        List<WorkspaceAgent> bindings = workspaceAgents.findByIdWorkspaceId(workspace.getId());
        assertEquals(2, bindings.size(), "visible + shared land; the foreign-owned one is skipped");
        assertEquals(sortedIds(visible.getId(), shared.getId()), principalIds(bindings));
        for (WorkspaceAgent binding : bindings) {
            assertEquals(WorkspaceAgent.CAP_SOURCE_BASELINE, binding.getCapSource(),
                    "the default path keeps inheriting the role baseline");
        }
        assertEquals(0, jdbc.queryForObject(
                "SELECT count(*) FROM workspace_agents WHERE workspace_id = ?::uuid AND principal_id = ?::uuid",
                Integer.class, workspace.getId().toString(), invisible.getId().toString()),
                "a principal the creator cannot see must not become reachable through creation");

        assertEquals(2, jdbc.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE workspace_id = ?::uuid"
                        + " AND action = 'workspace_agent_bound'"
                        + " AND details LIKE '%\"source\":\"default-materialize\"%'",
                Integer.class, workspace.getId().toString()),
                "both rows must be audited as system materialization, not as a human bind");
    }

    @Test
    void manualBindingStillRefusesAForeignOwnedPrincipal() {
        User creator = newUser("task1015-manual-creator");
        User foreign = newUser("task1015-manual-foreign");

        AgentPrincipal foreignAgent = newAgent("Task1015ManualForeign");
        assertEquals(1, jdbc.update("UPDATE agent_principals SET owner_user_id = ?::uuid WHERE id = ?::uuid",
                foreign.getId().toString(), foreignAgent.getId().toString()));

        Workspace workspace = createWorkspace("task1015 manual", creator.getId().toString());

        CpApiException refused = assertThrows(CpApiException.class,
                () -> agentPrincipalService.setWorkspaceCap(creator.getId().toString(),
                        workspace.getId(), foreignAgent.getId(), null),
                "the human bind face keeps the owner-only rule");
        assertEquals("AGENT_PRINCIPAL_OWNER_MISMATCH", refused.getCode());
        assertEquals(0, jdbc.queryForObject(
                "SELECT count(*) FROM workspace_agents WHERE workspace_id = ?::uuid AND principal_id = ?::uuid",
                Integer.class, workspace.getId().toString(), foreignAgent.getId().toString()),
                "a refused manual bind writes no row");
    }

    private User newUser(String prefix) {
        return users.saveAndFlush(new User(prefix + "-" + UUID.randomUUID() + "@test.com",
                "hash", prefix));
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

    private Workspace createWorkspace(String name, String ownerId) {
        String hostPath;
        try {
            Path child = workspaceRoot.resolve(UUID.randomUUID().toString());
            Files.createDirectories(child);
            hostPath = child.toAbsolutePath().toString();
        } catch (java.io.IOException failure) {
            throw new IllegalStateException("cannot create the test host directory", failure);
        }
        return workspaceService.createWorkspace(name, "task-1015 fixture", ownerId, null, null,
                "direct_attach", hostPath, "windows-host",
                "task1015-" + UUID.randomUUID());
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
