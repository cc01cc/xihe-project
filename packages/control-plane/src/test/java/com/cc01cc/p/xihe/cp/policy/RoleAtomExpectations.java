package com.cc01cc.p.xihe.cp.policy;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * PLAN-0651 L2 triage (2026-11-05): expected atoms of a built-in role, <b>derived from the code
 * catalog</b>, so a widened default set (e.g. WS_EDITOR 4→7, WS_VIEWER 1→2 in 0651 M2 T2.1) cannot
 * silently re-break unrelated assertions.
 *
 * <p><b>Deliberately not a contract.</b> The single hard-coded snapshot of the default-grant matrix
 * lives in {@link DefaultSetAtomMatrixTest}; that table is the reviewed promise ("we grant exactly
 * these N1–N10 cells") and must never be generated. Everywhere else the question is "does the
 * materialized row set equal what the catalog says for that role?", which is what this helper
 * answers.</p>
 *
 * <p>{@link #materializedAtoms(String)} excludes capability atoms: {@code RoleGrantMaterializer}
 * refuses to write them into {@code grants} (design #23), so a count of materialized rows must not
 * include them.</p>
 */
public final class RoleAtomExpectations {

    private RoleAtomExpectations() {
    }

    /** Every action class declared by the built-in role in {@code SystemAccessRoleCatalog}. */
    public static Set<String> declaredAtoms(String roleName) {
        Set<String> atoms = new LinkedHashSet<>();
        SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(seed -> seed.name().equals(roleName))
                .findFirst()
                .orElseThrow(() -> new AssertionError("built-in role missing from the catalog: " + roleName))
                .atoms()
                .forEach(ref -> atoms.add(ref.actionClass()));
        return atoms;
    }

    /** The atoms the materializer may write into {@code grants} (capability atoms excluded). */
    public static Set<String> materializedAtoms(String roleName) {
        Set<String> atoms = new LinkedHashSet<>();
        for (String atom : declaredAtoms(roleName)) {
            if (!PermissionAtomCatalog.isCapabilityAtom(atom)) {
                atoms.add(atom);
            }
        }
        return atoms;
    }

    /** Number of {@code source='role'} rows one binding of that role materializes. */
    public static int materializedAtomCount(String roleName) {
        return materializedAtoms(roleName).size();
    }
}
