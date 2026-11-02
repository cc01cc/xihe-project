package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 M1 (D29-24/34): {@code MEMORY_WRITE} is a real action atom that is <b>default-denied</b>
 * by seed: it exists in the catalog (so an administrator can grant it) and is deliberately absent from
 * USER / ADMIN / workspace role seeds (so no account gets it for free).
 *
 * <p>This unit test is the cheap half of the parity contract; the database half
 * ({@code AgentMemoryServiceTest} + the existing migration tests) asserts the seeded rows.</p>
 */
class MemoryWriteAtomTest {

    private static final String MEMORY_WRITE = ToolFaceRegistry.ACTION_MEMORY_WRITE;

    @Test
    void theAtomIsACataloguedActionAtomBindableInEitherScope() {
        assertTrue(PermissionAtomCatalog.isActionAtom(MEMORY_WRITE),
                "memory writes are materializable action atoms, not capabilities");
        PermissionAtomCatalog.Atom atom = PermissionAtomCatalog.atom(MEMORY_WRITE);
        assertEquals(PermissionAtomCatalog.SCOPE_CLASS_BOTH, atom.scopeClass(),
                "memory is isolated by (principal, workspace): a workspace-scoped binding is meaningful");
        assertEquals(PermissionAtomCatalog.WILDCARD, atom.canonicalResource());
        assertTrue(ToolFaceRegistry.builtinActionClasses().contains(MEMORY_WRITE),
                "the built-in action vocabulary and the catalog must agree");
        assertEquals(ToolFaceRegistry.builtinActionClasses().size(),
                PermissionAtomCatalog.actionAtoms().size(),
                "adding an atom means both sides, or every evaluation of it fails closed");
    }

    @Test
    void noDefaultRoleSeedsItExceptTheSuperAdminRoot() {
        List<SystemAccessRoleCatalog.RoleSeed> seeds = SystemAccessRoleCatalog.roleSeeds();
        for (SystemAccessRoleCatalog.RoleSeed seed : seeds) {
            Set<String> atoms = seed.atoms().stream()
                    .map(SystemAccessRoleCatalog.AtomRef::actionClass)
                    .collect(Collectors.toSet());
            if (SystemAccessRoleCatalog.SUPER_ADMIN.equals(seed.name())) {
                assertTrue(atoms.contains(MEMORY_WRITE),
                        "SUPER_ADMIN is defined as 'every action atom' (and is the instance-owner root)");
            } else {
                assertFalse(atoms.contains(MEMORY_WRITE),
                        seed.name() + " must NOT get MEMORY_WRITE by default: tool memory writes are "
                                + "denied until an administrator grants the atom explicitly");
            }
        }
    }
}
