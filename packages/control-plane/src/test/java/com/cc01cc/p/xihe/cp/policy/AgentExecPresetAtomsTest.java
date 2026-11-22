package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DSD-1500 (Q-93) R2 + R3 / task-116: the <b>agent execution contract</b>, as a hard-coded table.
 *
 * <p>R2 (exec leaves the agent default stack) and R3 (three presets) are one ruling with one
 * failure mode: a future edit quietly puts exec back into a role that every agent carries. The
 * assertion below is therefore written in the direction of that accident — {@code
 * agentDefaultsCannotExecute} fails the moment {@code exec} reappears on either level of the
 * default path ({@code AGENT_USER} instance + {@code WS_EDITOR} workspace), which is exactly the
 * red run recorded in the evidence file.</p>
 *
 * <p>Why hard-coded instead of derived from the catalog: deriving the expectation from
 * {@code presetSeeds()} would compare the catalog with itself (the same reasoning as
 * {@code DefaultSetAtomMatrixTest}). The table is the reviewed contract; the migration side of the
 * same contract is {@code DefaultSetMigrationParityTest} (Flyway-only database).</p>
 */
class AgentExecPresetAtomsTest {

    /** The reviewed contract for every role that matters to an agent's execution story. */
    private static final Map<String, Set<String>> EXPECTED = expected();

    private static Map<String, Set<String>> expected() {
        Map<String, Set<String>> table = new LinkedHashMap<>();
        // R2: the default instance role — base set minus exec.
        table.put(SystemGrantPresetCatalog.AGENT_USER, Set.of(
                ToolFaceRegistry.ACTION_READ,
                ToolFaceRegistry.ACTION_WRITE,
                ToolFaceRegistry.ACTION_DELETE,
                ToolFaceRegistry.ACTION_NETWORK,
                ToolFaceRegistry.ACTION_PLUGIN_INVOKE,
                ToolFaceRegistry.ACTION_TEAM_TASK_MANAGE));
        // R2: the default workspace role — same removal, so the intersection cannot re-admit exec.
        table.put(SystemGrantPresetCatalog.WS_EDITOR, Set.of(
                ToolFaceRegistry.ACTION_READ,
                ToolFaceRegistry.ACTION_WRITE,
                ToolFaceRegistry.ACTION_DELETE,
                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_PLUGIN_INVOKE,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY,
                ToolFaceRegistry.ACTION_WRITE_WORKSPACE_CONTENT,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MCP,
                ToolFaceRegistry.ACTION_TEAM_TASK_MANAGE,
                ToolFaceRegistry.ACTION_SESSION_PERMISSION_CONFIGURE));
        // R3: the three presets.
        table.put(SystemGrantPresetCatalog.AGENT_READER, Set.of(
                ToolFaceRegistry.ACTION_READ,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME));
        table.put(SystemGrantPresetCatalog.AGENT_WORKER, Set.of(
                ToolFaceRegistry.ACTION_READ,
                ToolFaceRegistry.ACTION_WRITE,
                ToolFaceRegistry.ACTION_DELETE));
        table.put(SystemGrantPresetCatalog.WS_RUNNER, Set.of(
                ToolFaceRegistry.ACTION_EXEC,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME));
        return table;
    }

    /** The preset roles that may carry exec, by reviewed ruling — every other preset must not. */
    private static final Set<String> REVIEWED_EXEC_CARRIERS = Set.of(
            SystemGrantPresetCatalog.SUPER_ADMIN,
            SystemGrantPresetCatalog.ADMIN,
            SystemGrantPresetCatalog.USER,
            SystemGrantPresetCatalog.WS_OWNER,
            SystemGrantPresetCatalog.WS_RUNNER);

    @Test
    void agentDefaultsCannotExecute() {
        // R2 in one assertion pair: the two levels of a fresh agent's principal path. A reviewer who
        // re-adds exec to either role gets this red with the role named, not "some matrix mismatch".
        Set<String> instanceDefault = codeAtomsOf(SystemGrantPresetCatalog.AGENT_USER);
        Set<String> workspaceDefault = codeAtomsOf(SystemGrantPresetCatalog.WS_EDITOR);
        assertFalse(instanceDefault.contains(ToolFaceRegistry.ACTION_EXEC),
                "DSD-1500 R2: the agent default INSTANCE role (AGENT_USER) must not carry exec — "
                        + "exec there means default-stack host command execution (job_host_adapter.rs "
                        + "documents no sandbox/policy)");
        assertFalse(workspaceDefault.contains(ToolFaceRegistry.ACTION_EXEC),
                "DSD-1500 R2: the agent default WORKSPACE role (WS_EDITOR) must not carry exec — "
                        + "GrantIntersectionEvaluator.allows intersects every level, so one level "
                        + "holding exec is enough to keep the default stack executable");

        Set<String> union = new LinkedHashSet<>(instanceDefault);
        union.addAll(workspaceDefault);
        assertFalse(union.contains(ToolFaceRegistry.ACTION_EXEC),
                "the default agent path (AGENT_USER ∪ WS_EDITOR, the task-116 invariant) must not "
                        + "contain exec; adding exec back to either role makes this test fail: " + union);
    }

    @Test
    void humansKeepTheirExecBecauseTheAgentSetIsASeparateList() {
        // The reason BASE_ATOMS was not edited: USER/ADMIN/SUPER_ADMIN inherit it.
        for (String humanRole : List.of(SystemGrantPresetCatalog.USER,
                SystemGrantPresetCatalog.ADMIN,
                SystemGrantPresetCatalog.SUPER_ADMIN)) {
            assertTrue(codeAtomsOf(humanRole).contains(ToolFaceRegistry.ACTION_EXEC),
                    "R2 removes exec from the AGENT default only — the human role must keep it: "
                            + humanRole);
        }
    }

    @Test
    void onlyTheReviewedPresetsCarryExec() {
        Set<String> actual = new LinkedHashSet<>();
        for (SystemGrantPresetCatalog.PresetSeed seed : SystemGrantPresetCatalog.presetSeeds()) {
            for (SystemGrantPresetCatalog.AtomRef atom : seed.atoms()) {
                if (ToolFaceRegistry.ACTION_EXEC.equals(atom.actionClass())) {
                    actual.add(seed.name());
                }
            }
        }
        assertEquals(REVIEWED_EXEC_CARRIERS, actual,
                "exec carriers must be exactly the reviewed set — a new role that carries exec, or a "
                        + "preset that silently gained it, fails here");
    }

    @Test
    void thePresetAtomsAreExactlyTheReviewedOnes() {
        for (Map.Entry<String, Set<String>> role : EXPECTED.entrySet()) {
            assertEquals(role.getValue(), codeAtomsOf(role.getKey()),
                    "preset atom set drifted from the reviewed contract: " + role.getKey());
            // Every preset is meant to be bindable to an agent principal (workspace-domain atoms).
            assertTrue(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(role.getValue()
                            .toArray(String[]::new))),
                    "a preset an agent cannot be bound to is not a preset: " + role.getKey());
        }
    }

    @Test
    void thePresetsHaveTheirOwnFixedIdsInTheV87Space() {
        assertEquals(UUID.fromString("00000000-0000-4000-8000-000000000009"),
                SystemGrantPresetCatalog.AGENT_READER_ID);
        assertEquals(UUID.fromString("00000000-0000-4000-8000-000000000010"),
                SystemGrantPresetCatalog.AGENT_WORKER_ID);
        assertEquals(UUID.fromString("00000000-0000-4000-8000-000000000011"),
                SystemGrantPresetCatalog.WS_RUNNER_ID);
        Set<UUID> ids = new LinkedHashSet<>();
        SystemGrantPresetCatalog.presetSeeds().forEach(seed -> ids.add(seed.id()));
        assertEquals(SystemGrantPresetCatalog.presetSeeds().size(), ids.size(),
                "role ids stay unique — V179 inserts by id, a duplicate would collide on (id)");
    }

    /** The atoms a built-in role carries according to the code catalog (seed order preserved). */
    private static Set<String> codeAtomsOf(String roleName) {
        Set<String> atoms = new LinkedHashSet<>();
        SystemGrantPresetCatalog.presetSeeds().stream()
                .filter(seed -> seed.name().equals(roleName))
                .findFirst()
                .orElseThrow(() -> new AssertionError("role seed missing: " + roleName))
                .atoms()
                .forEach(ref -> atoms.add(ref.actionClass()));
        return atoms;
    }
}
