package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * PLAN-0691 T1.3 (M1): the plugin binding face at the atom layer.
 *
 * <p>Covers the four things the policy side owes: (1) the atoms are in the catalog with the spec's
 * scope classes and agent-principal flags, (2) the default grant set is "builtin only", (3) the gate
 * runs <b>before</b> the binding transaction — a denial must not leave a committed binding behind,
 * and (4) every allow is attributable to one {@link GrantSources} value.</p>
 */
class PluginBindingAuthorizationTest {

    private static final int ACTION_ATOM_COUNT = 33;

    @Test
    void pluginAtomsJoinTheCatalogWithTheSpecifiedScopes() {
        List<String> atoms = PluginBindingAuthorization.pluginAtoms();
        assertEquals(4, atoms.size());
        // 29 before PLAN-0691 + the four plugin atoms; SkillReadFaceTest and
        // P0ManagementAtomSeedMigrationTest freeze the same number from the other two directions.
        assertEquals(ACTION_ATOM_COUNT, PermissionAtomCatalog.actionAtoms().size());
        assertEquals(ACTION_ATOM_COUNT, ToolFaceRegistry.builtinActionClasses().size());

        for (String atom : atoms) {
            assertTrue(PermissionAtomCatalog.actionAtoms().contains(atom), atom);
            assertTrue(ToolFaceRegistry.builtinActionClasses().contains(atom), atom);
            assertTrue(PermissionAtomCatalog.isActionAtom(atom), atom);
            // One catalog, one naming convention (UPPER_SNAKE); the spec's `plugin:*` spelling is
            // the external wording, never the stored atom name.
            assertEquals(atom.toUpperCase(Locale.ROOT), atom, atom);
            assertFalse(atom.contains(":"), atom);
        }

        assertEquals(PermissionAtomCatalog.SCOPE_CLASS_INSTANCE,
                PermissionAtomCatalog.scopeClassOf(ToolFaceRegistry.ACTION_PLUGIN_MANAGE));
        assertEquals(PermissionAtomCatalog.SCOPE_CLASS_INSTANCE,
                PermissionAtomCatalog.scopeClassOf(ToolFaceRegistry.ACTION_PLUGIN_DATA));
        assertEquals(PermissionAtomCatalog.SCOPE_CLASS_BOTH,
                PermissionAtomCatalog.scopeClassOf(ToolFaceRegistry.ACTION_PLUGIN_BIND));
        assertEquals(PermissionAtomCatalog.SCOPE_CLASS_BOTH,
                PermissionAtomCatalog.scopeClassOf(ToolFaceRegistry.ACTION_PLUGIN_INVOKE));

        Set<String> forbidden = PermissionAtomCatalog.agentPrincipalForbiddenAtoms();
        assertTrue(forbidden.contains(ToolFaceRegistry.ACTION_PLUGIN_MANAGE));
        assertTrue(forbidden.contains(ToolFaceRegistry.ACTION_PLUGIN_BIND));
        assertTrue(forbidden.contains(ToolFaceRegistry.ACTION_PLUGIN_DATA));
        // Invocation is the one plugin verb an agent principal may hold: a builtin plugin is in the
        // default set, and an agent that could not hold it could never use one.
        assertFalse(forbidden.contains(ToolFaceRegistry.ACTION_PLUGIN_INVOKE));
    }

    @Test
    void builtinPluginIsInvokableByDefaultAndThirdPartyNeedsAGrant() {
        assertEquals(List.of(ToolFaceRegistry.ACTION_PLUGIN_INVOKE),
                PluginBindingAuthorization.defaultAtoms(
                        PluginBindingAuthorization.PluginSource.BUILTIN));
        assertTrue(PluginBindingAuthorization.defaultAtoms(
                PluginBindingAuthorization.PluginSource.THIRD_PARTY).isEmpty());
    }

    /**
     * The ordering contract: authorization is evaluated before the binding row is written. A denial
     * therefore leaves the write counter at zero — the same defect family as the {@code --plan-only}
     * incident, where an effect had already happened before the request was rejected.
     */
    @Test
    void pluginBindingAuthorizationIsEvaluatedBeforeTheBindingTransaction() {
        List<PluginBindingAuthorization.GrantRow> held = List.of(
                new PluginBindingAuthorization.GrantRow(
                        ToolFaceRegistry.ACTION_PLUGIN_INVOKE, GrantSources.PLUGIN_BINDING, "b-1"));
        int[] committedBindings = {0};

        CpApiException denied = assertThrows(CpApiException.class,
                () -> gateThenBind(held, PluginBindingAuthorization.Op.BIND_TO_WORKSPACE,
                        committedBindings));

        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals(PluginBindingAuthorization.CODE_PLUGIN_GRANT_DENIED, denied.getCode());
        assertEquals(0, committedBindings[0],
                "the binding must not be written when the gate denies");

        // Holding PLUGIN_INVOKE (the default) is not PLUGIN_BIND: install ≠ grant, invoke ≠ bind.
        assertFalse(PluginBindingAuthorization.evaluate(held,
                ToolFaceRegistry.ACTION_PLUGIN_BIND).allowed());
    }

    @Test
    void matchedSourceIsAuditedAndRetiredSourcesCannotAuthorize() {
        PluginBindingAuthorization.Decision viaRole = PluginBindingAuthorization.evaluate(
                List.of(new PluginBindingAuthorization.GrantRow(
                        ToolFaceRegistry.ACTION_PLUGIN_INVOKE, GrantSources.ROLE, null)),
                ToolFaceRegistry.ACTION_PLUGIN_INVOKE);
        assertTrue(viaRole.allowed());
        assertEquals(GrantSources.ROLE, viaRole.matchedSource());

        PluginBindingAuthorization.Decision viaBinding = PluginBindingAuthorization.evaluate(
                List.of(new PluginBindingAuthorization.GrantRow(
                        ToolFaceRegistry.ACTION_PLUGIN_INVOKE, GrantSources.PLUGIN_BINDING, "b-9")),
                ToolFaceRegistry.ACTION_PLUGIN_INVOKE);
        assertTrue(viaBinding.allowed());
        assertEquals(GrantSources.PLUGIN_BINDING, viaBinding.matchedSource());

        // A row from the retired legacy source is inert, not an authorization (GrantSources V88).
        PluginBindingAuthorization.Decision viaRetired = PluginBindingAuthorization.evaluate(
                List.of(new PluginBindingAuthorization.GrantRow(
                        ToolFaceRegistry.ACTION_PLUGIN_INVOKE, GrantSources.DEFAULT, null)),
                ToolFaceRegistry.ACTION_PLUGIN_INVOKE);
        assertFalse(viaRetired.allowed());
        assertNull(viaRetired.matchedSource());

        // The spec spelling `plugin:manage` is not an atom name; asking for it is a caller bug.
        assertThrows(IllegalArgumentException.class, () -> PluginBindingAuthorization.evaluate(
                List.of(), "plugin:manage"));
    }

    /** Stand-in for the binding write path: gate first, commit second, never the other way. */
    private static void gateThenBind(List<PluginBindingAuthorization.GrantRow> held,
                                     PluginBindingAuthorization.Op op, int[] committedBindings) {
        PluginBindingAuthorization.require(held, PluginBindingAuthorization.requiredAtom(op));
        committedBindings[0]++;
    }
}
