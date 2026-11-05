package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BL-345 (user ruling 2026-11-06): two memory atoms.
 *
 * <ul>
 *   <li>{@code MEMORY_WRITE} = write <b>any</b> subject: SUPER_ADMIN + workspace administrators
 *       (WS_OWNER) only.</li>
 *   <li>{@code MEMORY_WRITE_SELF} = write a principal the actor <b>owns</b>: default for USER,
 *       ADMIN and every WS_* role; an <b>agent-forbidden</b> atom (human ownership capability).</li>
 * </ul>
 *
 * <p>The database half of the parity contract (scripts/V129 rows == these seeds) is asserted by
 * {@code DefaultSetMigrationParityTest} / {@code AgentPrincipalScopeMigrationTest}; this class is the
 * cheap code-side check.</p>
 */
class MemoryWriteAtomTest {

    private static final String MEMORY_WRITE = ToolFaceRegistry.ACTION_MEMORY_WRITE;
    private static final String MEMORY_WRITE_SELF = ToolFaceRegistry.ACTION_MEMORY_WRITE_SELF;

    private static Set<String> atomsOf(String roleName) {
        return SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(seed -> seed.name().equals(roleName))
                .findFirst()
                .orElseThrow(() -> new AssertionError("role seed missing: " + roleName))
                .atoms().stream()
                .map(SystemAccessRoleCatalog.AtomRef::actionClass)
                .collect(Collectors.toSet());
    }

    @Test
    void bothAtomsAreCataloguedActionAtomsBindableInEitherScope() {
        for (String atomName : List.of(MEMORY_WRITE, MEMORY_WRITE_SELF)) {
            assertTrue(PermissionAtomCatalog.isActionAtom(atomName),
                    atomName + " is a materializable action atom, not a capability");
            PermissionAtomCatalog.Atom atom = PermissionAtomCatalog.atom(atomName);
            assertEquals(PermissionAtomCatalog.SCOPE_CLASS_BOTH, atom.scopeClass(),
                    "memory is isolated by (principal, workspace): workspace-scoped grants are meaningful");
            assertEquals(PermissionAtomCatalog.WILDCARD, atom.canonicalResource());
            assertTrue(ToolFaceRegistry.builtinActionClasses().contains(atomName),
                    "the built-in action vocabulary and the catalog must agree");
        }
        assertEquals(ToolFaceRegistry.builtinActionClasses().size(),
                PermissionAtomCatalog.actionAtoms().size(),
                "adding an atom means both sides, or every evaluation of it fails closed");
    }

    @Test
    void selfIsForbiddenToAgentPrincipalsButMemoryWriteIsNotARoleDefaultForThemEither() {
        assertFalse(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(MEMORY_WRITE_SELF)),
                "an agent principal may never hold 'write my owner's subject' — it is a human capability");
        assertTrue(PermissionAtomCatalog.agentPrincipalForbiddenAtoms().contains(MEMORY_WRITE_SELF));
        assertTrue(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(MEMORY_WRITE)),
                "MEMORY_WRITE is workspace-capability-shaped (owner grants it), not instance administration");
        assertFalse(atomsOf(SystemAccessRoleCatalog.AGENT_USER).contains(MEMORY_WRITE_SELF),
                "the agent default role must not inherit the forbidden self atom");
        assertFalse(atomsOf(SystemAccessRoleCatalog.AGENT_DELEGATOR).contains(MEMORY_WRITE_SELF));
    }

    @Test
    void selfIsDefaultForEveryHumanRole() {
        for (String role : List.of(SystemAccessRoleCatalog.USER, SystemAccessRoleCatalog.ADMIN,
                SystemAccessRoleCatalog.WS_OWNER, SystemAccessRoleCatalog.WS_EDITOR,
                SystemAccessRoleCatalog.WS_VIEWER)) {
            assertTrue(atomsOf(role).contains(MEMORY_WRITE_SELF),
                    role + " must be able to write memory of the principals it owns");
        }
    }

    @Test
    void memoryWriteIsOnlySuperAdminAndWorkspaceAdmin() {
        assertTrue(atomsOf(SystemAccessRoleCatalog.SUPER_ADMIN).contains(MEMORY_WRITE),
                "SUPER_ADMIN holds every action atom");
        assertTrue(atomsOf(SystemAccessRoleCatalog.WS_OWNER).contains(MEMORY_WRITE),
                "ruling B: workspace administrators write any subject");
        for (String role : List.of(SystemAccessRoleCatalog.USER, SystemAccessRoleCatalog.ADMIN,
                SystemAccessRoleCatalog.WS_EDITOR, SystemAccessRoleCatalog.WS_VIEWER,
                SystemAccessRoleCatalog.AGENT_DELEGATOR, SystemAccessRoleCatalog.AGENT_USER)) {
            assertFalse(atomsOf(role).contains(MEMORY_WRITE),
                    role + " must not write arbitrary subjects: SELF is the user-tier atom");
        }
    }
}
