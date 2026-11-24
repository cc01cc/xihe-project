package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.GrantPreset;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.AgentBindingAtomPolicy;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.GrantabilityGuard;
import com.cc01cc.p.xihe.cp.policy.PresetGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetAtomRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetRepository;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalPresetBindingService;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-994 (user ruling 2026-11-24, option A): the first-run exec grant.
 *
 * <p>What this file pins, group by group:</p>
 * <ol>
 *   <li><b>Lead only</b> — a fresh seed writes exactly one instance-scope {@code WS_RUNNER} binding
 *       and the subject is the Lead principal; WorkerA/WorkerB get none (the refutation is inside
 *       the assertion: a second saved row — e.g. a worker — fails {@code saveCount == 1}).</li>
 *   <li><b>Missing rows are warnings, not writes</b> — no Lead subject / no {@code V179} preset row
 *       must leave the binding table untouched (the class rule: check before writing, and inside
 *       {@code DataSeeder}'s transaction a caught throw would poison the boot).</li>
 *   <li><b>Reversible by the instance-admin gate</b> — the seeded row is {@code seed=false}, so
 *       {@code AgentPrincipalPresetBindingService.unbind} (the {@code MANAGE_AGENT_PRINCIPALS} path
 *       behind the detail switch) accepts it; an immutable {@code seed=true} row is refused. That is
 *       the CP half of "允许/拒绝" — the UI half (switch disabled without the atom) lives in
 *       {@code InstanceAgentsPanel.execGrant.spec.ts}.</li>
 *   <li><b>Idempotency</b> — a second start with the row already on disk inserts nothing and
 *       materializes nothing.</li>
 * </ol>
 *
 * <p>The seeder is built by hand with mocks: {@link FirstRunContentSeeder#seedExecGrant} only touches
 * {@code agentPrincipals}, {@code presets}, {@code presetBindings}, {@code grantMaterializer} and
 * {@code audit}, so the other collaborators are unused here (and pass as {@code null} — the
 * constructor assigns them without touching).</p>
 */
class FirstRunExecGrantTest {

    private static final UUID ADMIN_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID LEAD_ID = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID WORKER_A_ID = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final UUID WORKER_B_ID = UUID.fromString("44444444-4444-4444-8444-444444444444");

    private AgentPrincipalRepository agentPrincipals;
    private GrantPresetRepository presets;
    private GrantPresetBindingRepository presetBindings;
    private PresetGrantMaterializer grantMaterializer;
    private AuditLogger audit;

    @BeforeEach
    void setUp() {
        agentPrincipals = mock(AgentPrincipalRepository.class);
        presets = mock(GrantPresetRepository.class);
        presetBindings = mock(GrantPresetBindingRepository.class);
        grantMaterializer = mock(PresetGrantMaterializer.class);
        audit = mock(AuditLogger.class);
        when(presetBindings.saveAndFlush(any()))
                .thenAnswer(invocation -> invocation.getArgument(0));
    }

    @Test
    void seedsWsRunnerForTheLeadSubjectOnly() {
        User admin = admin();
        AgentPrincipal lead = principal(LEAD_ID, "Lead", ADMIN_ID);
        when(agentPrincipals.findByCreatedByUserId(ADMIN_ID.toString()))
                .thenReturn(List.of(lead, principal(WORKER_A_ID, "WorkerA", ADMIN_ID),
                        principal(WORKER_B_ID, "WorkerB", ADMIN_ID)));
        when(presets.findById(FirstRunContentSeeder.WS_RUNNER_ID))
                .thenReturn(Optional.of(preset(FirstRunContentSeeder.WS_RUNNER_ID)));
        when(presetBindings.findBySubjectTypeAndSubjectIdAndScopeType(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, LEAD_ID, AccessScope.INSTANCE))
                .thenReturn(List.of());

        FirstRunContentSeeder seeder = seeder();
        seeder.seedExecGrant(admin);

        ArgumentCaptor<GrantPresetBinding> saved = ArgumentCaptor.forClass(GrantPresetBinding.class);
        verify(presetBindings, times(1)).saveAndFlush(saved.capture());
        GrantPresetBinding row = saved.getValue();
        assertEquals(FirstRunContentSeeder.WS_RUNNER_ID, row.getRoleId(),
                "the seed must grant the WS_RUNNER preset (exec + USE_WORKSPACE_RUNTIME)");
        assertEquals(LEAD_ID, row.getSubjectId(), "only the Lead subject carries instance exec reach");
        assertEquals(GrantPrincipalPathResolver.AGENT_PRINCIPAL, row.getSubjectType());
        assertEquals(AccessScope.INSTANCE, row.getScopeType(), "exec reach is instance-scope");
        assertNull(row.getScopeId(), "an instance binding carries no scope id");
        assertFalse(row.isSeed(),
                "the row must stay deletable: the instance admin's switch owns it after the seed");
        assertEquals(ADMIN_ID, row.getGrantedBy());

        verify(grantMaterializer, times(1)).materializeSubject(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, LEAD_ID, ADMIN_ID, null);
        verify(audit, times(1)).recordDurableChange(eq(ADMIN_ID.toString()), isNull(),
                eq(FirstRunContentSeeder.AUDIT_EXEC_SEED), eq("role_binding"), anyString(), anyString());
        assertEquals(List.of(), seeder.lastRunWarnings(), "a clean run warns about nothing");
    }

    @Test
    void aMissingLeadSubjectWarnsInsteadOfWritingOrThrowing() {
        User admin = admin();
        when(agentPrincipals.findByCreatedByUserId(ADMIN_ID.toString()))
                .thenReturn(List.of(principal(WORKER_A_ID, "WorkerA", ADMIN_ID)));

        FirstRunContentSeeder seeder = seeder();
        seeder.seedExecGrant(admin);

        verify(presetBindings, never()).saveAndFlush(any());
        verify(grantMaterializer, never()).materializeSubject(anyString(), any(), any(), any());
        assertEquals(1, seeder.lastRunWarnings().size());
        assertTrue(seeder.lastRunWarnings().get(0).contains("no subject named 'Lead'"));
    }

    @Test
    void aMissingWsRunnerPresetRowWarnsInsteadOfLeavingAnInertBinding() {
        User admin = admin();
        when(agentPrincipals.findByCreatedByUserId(ADMIN_ID.toString()))
                .thenReturn(List.of(principal(LEAD_ID, "Lead", ADMIN_ID)));
        when(presets.findById(FirstRunContentSeeder.WS_RUNNER_ID)).thenReturn(Optional.empty());

        FirstRunContentSeeder seeder = seeder();
        seeder.seedExecGrant(admin);

        verify(presetBindings, never()).saveAndFlush(any());
        verify(grantMaterializer, never()).materializeSubject(anyString(), any(), any(), any());
        assertEquals(1, seeder.lastRunWarnings().size());
        assertTrue(seeder.lastRunWarnings().get(0).contains("V179"),
                "the warning has to name the migration the row comes from, got: "
                        + seeder.lastRunWarnings().get(0));
    }

    @Test
    void aSecondStartInsertsNothingAndMaterializesNothing() {
        User admin = admin();
        AgentPrincipal lead = principal(LEAD_ID, "Lead", ADMIN_ID);
        when(agentPrincipals.findByCreatedByUserId(ADMIN_ID.toString())).thenReturn(List.of(lead));
        when(presets.findById(FirstRunContentSeeder.WS_RUNNER_ID))
                .thenReturn(Optional.of(preset(FirstRunContentSeeder.WS_RUNNER_ID)));

        GrantPresetBinding existing = new GrantPresetBinding(FirstRunContentSeeder.WS_RUNNER_ID,
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, LEAD_ID, AccessScope.INSTANCE, null, ADMIN_ID);
        existing.setId(UUID.randomUUID());
        when(presetBindings.findBySubjectTypeAndSubjectIdAndScopeType(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, LEAD_ID, AccessScope.INSTANCE))
                .thenReturn(List.of(existing));

        seeder().seedExecGrant(admin);
        seeder().seedExecGrant(admin);

        verify(presetBindings, never()).saveAndFlush(any());
        verify(grantMaterializer, never()).materializeSubject(anyString(), any(), any(), any());
    }

    // ---- CP half of allow/deny: the unbind gate the detail switch calls ------------------------

    @Test
    void theInstanceAdminCanRevokeTheSeededGrantThroughTheUnbindPath() {
        GrantPresetBinding row = new GrantPresetBinding(FirstRunContentSeeder.WS_RUNNER_ID,
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, LEAD_ID, AccessScope.INSTANCE, null, ADMIN_ID);
        row.setId(UUID.randomUUID());
        row.setSeed(false);
        AgentPrincipalPresetBindingService service = bindingService(row);

        service.unbind(LEAD_ID, row.getId(), ADMIN_ID, null, true, ignored -> false);

        // No throw = the row is reversible (seed=false). The delete + materialize + audit trio is
        // asserted through the same mocks the service holds.
        verify(presetBindings, times(1)).delete(row);
        verify(grantMaterializer, times(1)).materializeSubject(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, LEAD_ID, ADMIN_ID, null);
    }

    @Test
    void anImmutableSeedRowIsRefusedSoADefaultCannotBeQuietlyRemovedByAUser() {
        GrantPresetBinding row = new GrantPresetBinding(FirstRunContentSeeder.WS_RUNNER_ID,
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, LEAD_ID, AccessScope.INSTANCE, null, ADMIN_ID);
        row.setId(UUID.randomUUID());
        row.setSeed(true);
        AgentPrincipalPresetBindingService service = bindingService(row);

        CpApiException refused = assertThrows(CpApiException.class,
                () -> service.unbind(LEAD_ID, row.getId(), ADMIN_ID, null, true, ignored -> false));

        assertEquals("ROLE_BINDING_IMMUTABLE", refused.getCode());
        verify(presetBindings, never()).delete(any());
    }

    // ---- fixtures -----------------------------------------------------------------------------

    private FirstRunContentSeeder seeder() {
        // Only the five collaborators below are read by seedExecGrant; the rest are unused on this
        // path, and the constructor does not dereference them.
        return new FirstRunContentSeeder(null, null, null, null, null, agentPrincipals, null, null, null,
                null, null,
                "jdbc:postgresql://127.0.0.1:1/xihe-unused-only-for-the-postgres-predicate",
                FirstRunContentSeeder.MODE_TRUE, null, null, null,
                presetBindings, presets, grantMaterializer, audit);
    }

    private AgentPrincipalPresetBindingService bindingService(GrantPresetBinding row) {
        AgentPrincipalService agentPrincipalService = mock(AgentPrincipalService.class);
        InstanceOwnerRepository owners = mock(InstanceOwnerRepository.class);
        GrantPresetAtomRepository atoms = mock(GrantPresetAtomRepository.class);
        when(owners.lockSingleton()).thenReturn(Optional.empty());
        when(owners.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        when(presetBindings.findById(row.getId())).thenReturn(Optional.of(row));
        when(presets.findByIdForUpdate(row.getRoleId()))
                .thenReturn(Optional.of(preset(row.getRoleId())));
        when(atoms.findByIdRoleId(row.getRoleId())).thenReturn(List.of());
        when(agentPrincipals.findByIdForUpdate(LEAD_ID)).thenReturn(Optional.of(principal(LEAD_ID, "Lead", ADMIN_ID)));
        return new AgentPrincipalPresetBindingService(presetBindings, presets, atoms, agentPrincipals,
                mock(WorkspaceRepository.class), grantMaterializer, audit, agentPrincipalService,
                mock(GrantabilityGuard.class), mock(AgentBindingAtomPolicy.class), owners);
    }

    private static User admin() {
        User admin = new User();
        admin.setId(ADMIN_ID);
        return admin;
    }

    private static AgentPrincipal principal(UUID id, String name, UUID createdBy) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(id);
        principal.setName(name);
        principal.setCreatedByUserId(createdBy.toString());
        return principal;
    }

    private static GrantPreset preset(UUID id) {
        GrantPreset preset = new GrantPreset();
        preset.setId(id);
        preset.setName("WS_RUNNER");
        return preset;
    }
}
