package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * PLAN-0773 M1-9 (D-1118): the <b>one</b> place that answers "may this role be bound inside an
 * org unit".
 *
 * <p>The rule is a <b>whitelist over role atoms</b>: a role may be bound to an org unit only when
 * its atom set is a subset of the three org-unit governance atoms
 * ({@link #ATOM_MANAGE_ORG_UNITS}, {@link #ATOM_MANAGE_ORG_UNIT_MEMBERS},
 * {@link #ATOM_READ_ORG_UNIT_MEMBERS}). Anything else — most importantly any atom whose
 * {@link PermissionAtomCatalog} scope class is not {@code instance} — is refused.</p>
 *
 * <p>Why a whitelist and not a blacklist (D-1117 was reversed by D-1118):</p>
 *
 * <ol>
 *   <li>a blacklist only excludes the scope classes its author thought of; a fourth class added
 *       later would silently become bindable, while a whitelist defaults to deny;</li>
 *   <li>the failure direction differs: "atom not in the governance set" is refused, whereas
 *       "atom happens to look instance-only" would be allowed — the latter can downgrade an
 *       instance privilege into a subtree;</li>
 *   <li>the design intent is stated in the plan itself: governance roles are made <i>of</i> these
 *       three atoms ({@code M2-3} seeds {@code ORG_LEADER} that way), so "0 roles qualify today"
 *       is a starting point, not a defect to be papered over.</li>
 * </ol>
 *
 * <p><b>Deliberately not a database constraint.</b> The scope class of an atom is owned by
 * {@link PermissionAtomCatalog} in code; writing it into a {@code CHECK} or trigger would create a
 * second copy of the same truth (the exact reason {@code V87} keeps its contract in Java). This
 * class is therefore the single definition, and both sides call it:</p>
 *
 * <ul>
 *   <li><b>write side</b> — {@link #requireGovernanceRole(Collection)} on
 *       {@code PUT /api/v1/org-units/{unitId}/role-bindings} answers {@code 409}
 *       {@value #CODE_FORBIDDEN};</li>
 *   <li><b>evaluation side</b> — {@link #filterGovernanceRoles(Collection, Function)} drops the same
 *       rows while org-unit grants are expanded, so a row that reached the table some other way
 *       (older data, a migration, a direct insert) still cannot escalate.</li>
 * </ul>
 *
 * <p>Both entry points are wired by {@code M2-8c}; M1-9 lands the judgement only, together with
 * its tests, because the table it would validate does not exist yet.</p>
 *
 * <p><b>Who reaches this judgement (scope order):</b> a caller with neither a membership row nor
 * an instance-scope governance atom is a <b>404</b>, never a 403; a caller holding the atom without
 * a membership row is the instance-level holder and sees the whole tree (design §4.2). That order
 * lives in {@code OrgUnitAccess}, the single scope resolver both faces share.</p>
 *
 * @author PLAN-0773 M1-9
 */
public final class OrgUnitGovernancePolicy {

    /** {@code MANAGE_ORG_UNITS}: create, rename, move and delete org units. */
    public static final String ATOM_MANAGE_ORG_UNITS = "MANAGE_ORG_UNITS";

    /** {@code MANAGE_ORG_UNIT_MEMBERS}: add, remove and re-role the members of one org unit. */
    public static final String ATOM_MANAGE_ORG_UNIT_MEMBERS = "MANAGE_ORG_UNIT_MEMBERS";

    /** {@code READ_ORG_UNIT_MEMBERS}: see the member list of one org unit. */
    public static final String ATOM_READ_ORG_UNIT_MEMBERS = "READ_ORG_UNIT_MEMBERS";

    /** The three atoms a governance role is made of — the whitelist, in canonical order. */
    private static final Set<String> GOVERNANCE_ATOMS = Set.of(
            ATOM_MANAGE_ORG_UNITS, ATOM_MANAGE_ORG_UNIT_MEMBERS, ATOM_READ_ORG_UNIT_MEMBERS);

    /** The problem code of a refused org-unit role binding (RFC 9457 {@code code}). */
    public static final String CODE_FORBIDDEN = "ORG_SCOPE_ROLE_FORBIDDEN";

    private OrgUnitGovernancePolicy() {
    }

    /**
     * The whitelist itself, so callers can explain a refusal without duplicating the set.
     *
     * @return the three governance atoms (immutable)
     */
    public static Set<String> governanceAtoms() {
        return GOVERNANCE_ATOMS;
    }

    /**
     * The judgement: {@code true} when the atom set is a subset of the whitelist.
     *
     * <p>An empty (or {@code null}) atom set answers {@code true}: it grants nothing, so it cannot
     * leak anything, and refusing it would be judging intent instead of leak. The escalation that a
     * <i>later</i> role-definition update could smuggle into an already-bound empty role is a
     * different window and belongs to the role-update path ({@code M2-8c} re-checks org-unit
     * bindings there); it is not something this predicate can decide.</p>
     *
     * <p><b>The safety of that allowance is borrowed, and this is where it is borrowed from.</b>
     * Accepting an empty atom set is safe <i>because</i> evaluation re-applies this same predicate
     * to every org-unit binding on every evaluation ({@link #filterGovernanceRoles}, called by
     * {@code OrgUnitGrantExpander}; no cache — {@code M2-10a} forbids one). A role that later
     * gains a non-governance atom therefore cannot smuggle atoms through an org-unit binding,
     * even though the write side let its empty form in. If that evaluation-side filter is ever
     * removed, or made to run once and be cached, this acceptance stops being safe and this
     * predicate alone does not make it safe. Removing the filter is a security change, not a
     * performance change.</p>
     *
     * @param roleAtomNames atom names of the role being bound (may be {@code null})
     * @return whether the role may be bound inside an org unit
     */
    public static boolean isGovernanceRole(Collection<String> roleAtomNames) {
        if (roleAtomNames == null || roleAtomNames.isEmpty()) {
            return true;
        }
        for (String atomName : roleAtomNames) {
            if (!GOVERNANCE_ATOMS.contains(atomName)) {
                return false;
            }
        }
        return true;
    }

    /**
     * The atoms that make a role non-governance, sorted and de-duplicated.
     *
     * @param roleAtomNames atom names of the role
     * @return offending atoms; empty when the role is governance
     */
    public static List<String> offendingAtoms(Collection<String> roleAtomNames) {
        if (roleAtomNames == null || roleAtomNames.isEmpty()) {
            return List.of();
        }
        return roleAtomNames.stream()
                .filter(atom -> !GOVERNANCE_ATOMS.contains(atom))
                .distinct()
                .sorted()
                .toList();
    }

    /**
     * The write-side gate: refuses a non-governance role with {@code 409} and names the atoms.
     *
     * @param roleAtomNames atom names of the role being bound
     */
    public static void requireGovernanceRole(Collection<String> roleAtomNames) {
        requireGovernanceRole(null, roleAtomNames);
    }

    /**
     * The same gate, with the role named in the refusal.
     *
     * <p>{@code M2-8a}'s strict expansion arm hits rows that the write side never saw, so the message
     * must say <i>which</i> role is being refused and <i>which</i> atom put it outside the
     * whitelist; identifying a row by "one of your roles" is not actionable. The judgement is
     * still {@link #offendingAtoms} — this overload only words the refusal, it does not loosen
     * or tighten it, and both arms therefore cannot drift apart.</p>
     *
     * @param roleName      the role being bound, or {@code null} when the caller has no name to give
     * @param roleAtomNames atom names of that role
     */
    public static void requireGovernanceRole(String roleName, Collection<String> roleAtomNames) {
        List<String> offending = offendingAtoms(roleAtomNames);
        if (!offending.isEmpty()) {
            String subject = roleName == null || roleName.isBlank() ? "role" : "role '" + roleName + "'";
            throw new CpApiException(HttpStatus.CONFLICT, CODE_FORBIDDEN,
                    subject + " is not an org-unit governance role; atom(s) outside the whitelist: "
                            + String.join(",", offending));
        }
    }

    /**
     * The evaluation-side twin: keeps only the bindings whose role the write side would accept.
     *
     * <p>Same predicate, not a second implementation. A binding whose atoms cannot be resolved
     * ({@code null} from {@code atomsOf}) is <b>dropped</b>: evaluation fails closed, which is the
     * opposite of the vacuous {@code true} of {@link #isGovernanceRole(Collection)} — an unknown
     * role is not an empty one.</p>
     *
     * @param bindings org-unit role bindings as loaded from the table (may be {@code null})
     * @param atomsOf  resolves the atom names of each binding role
     * @param <T>      binding type; this class deliberately does not own it
     * @return the bindings that survive the predicate, in input order
     */
    public static <T> List<T> filterGovernanceRoles(Collection<T> bindings,
                                                    Function<T, ? extends Collection<String>> atomsOf) {
        List<T> kept = new ArrayList<>();
        if (bindings == null || bindings.isEmpty()) {
            return kept;
        }
        for (T binding : bindings) {
            if (binding == null) {
                continue;
            }
            Collection<String> atoms = atomsOf.apply(binding);
            if (atoms != null && isGovernanceRole(atoms)) {
                kept.add(binding);
            }
        }
        return kept;
    }
}
