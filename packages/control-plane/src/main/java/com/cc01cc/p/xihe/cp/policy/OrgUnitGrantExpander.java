package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * PLAN-0773 M2-8a: expands <b>one</b> org-unit member into the governance grants that member
 * holds through its own unit <i>and every ancestor unit</i> — as in-memory
 * {@link AuthorizationGrant} rows that are <b>never persisted</b>.
 *
 * <p>The pipeline this class implements is the one in {@code design.md} §4.1.1 (the 43A landing
 * point), in that order:</p>
 *
 * <pre>
 * member → org_unit_members (which unit)            -- case 2 when there is no row
 *        → org_units.path prefixes (self + all ancestors)   -- union, NOT the nearest level only
 *        → org_unit_role_bindings on those units             -- case 4 when empty
 *        → role atoms + permission array
 *        → AuthorizationGrant(scopeType='instance')          -- in memory, id stays null
 * </pre>
 *
 * <p><b>Why the output is {@code instance}</b> (§4.1.1): a group grant has no location; it only
 * adds atoms to a <i>subject</i>. The evaluator understands exactly two scopes
 * ({@code AccessScope}), so the only legal projection is {@code instance}. That projection is also
 * the security boundary: an {@code instance} row applies to <b>every</b> workspace the user can
 * reach, which is why a role allowed here must be a governance role — see the judgement below.</p>
 *
 * <p><b>The judgement is not re-implemented here.</b> Non-governance roles are handled with
 * {@link OrgUnitGovernancePolicy#filterGovernanceRoles} (evaluation side) and
 * {@link OrgUnitGovernancePolicy#requireGovernanceRole} (strict side) — the same single definition
 * {@code M2-8c} wires into the write side ({@code D-1118}: atoms must be a subset of
 * {@code MANAGE_ORG_UNITS} / {@code MANAGE_ORG_UNIT_MEMBERS} / {@code READ_ORG_UNIT_MEMBERS}).
 * A second copy of that whitelist here would be a copy that nobody updates and that therefore
 * <i>lets things through</i> — the failure direction this whole plan exists to avoid.</p>
 *
 * <p><b>Ancestor direction (ltree semantics, measured not guessed).</b> {@code path} is a
 * materialised ltree ({@code V163}); in ltree {@code B <@ A} means "B is a descendant-or-self of
 * A", so {@code 'a.b' <@ 'a.b.c'} is <b>false</b> and {@code 'a.b.c' <@ 'a.b'} is true. The chain
 * for a member of {@code a.b.c} is therefore {@code {a, a.b, a.b.c}} — the <b>prefixes</b> of its
 * own path, which is what {@link #ancestorPaths} returns. Writing this the other way round
 * ("include descendants") would hand a member of {@code a.b} the bindings of {@code a.b.c}.</p>
 *
 * <p><b>Evidence level, stated up front.</b> This card is deliberately DB-free: the three row sets
 * are handed in already loaded (see {@link Rows}), so the tests are function-level and there is no
 * table access here at all. Loading the rows by unit chain — and wiring the result into
 * {@code GrantIntersectionEvaluator.union} at the four read points — is {@code M2-8b}; the write
 * side plus the {@code 409} on the endpoint is {@code M2-8c}.</p>
 *
 * @author PLAN-0773 M2-8a
 */
public final class OrgUnitGrantExpander {

    /** {@code source} label on expanded rows. In-memory only — never written to {@code grants}. */
    public static final String SOURCE = "org_unit";

    /** {@code granter_type} label: the granting body is the unit the binding sits on. */
    public static final String GRANTER_ORG_UNIT = "org_unit";

    /** The only scope type an expanded row may carry (§4.1.1: no third scope, ever). */
    public static final String SCOPE_INSTANCE = "instance";

    /** {@code org_unit_members.member_kind} of a human account ({@code V164} CHECK vocabulary). */
    public static final String MEMBER_HUMAN = "human";

    /** {@code org_unit_members.member_kind} of an agent principal ({@code V164} CHECK vocabulary). */
    public static final String MEMBER_AGENT_PRINCIPAL = "agent_principal";

    /** A role with no permission rows grants nothing; {@code union(...)} requires an array, not null. */
    private static final JsonNode NO_PERMISSIONS = JsonNodeFactory.instance.arrayNode();

    /**
     * What to do with a binding whose role is not a governance role (card case 5 — both arms, not
     * one of them).
     */
    public enum NonGovernanceRolePolicy {
        /** Drop the binding; the row never reaches evaluation (the default, and the safe one). */
        FILTER,
        /** Refuse the whole expansion with the write side's own {@code 409} (same code, same atoms). */
        STRICT
    }

    /** The {@code org_units} columns this expander needs: identity plus the materialised path. */
    public record UnitRow(UUID id, String path) {
    }

    /** An {@code org_unit_members} row; its primary key is {@code (member_kind, member_id)}. */
    public record MembershipRow(String memberKind, UUID memberId, UUID orgUnitId) {
    }

    /** An {@code org_unit_role_bindings} row joined with its role's atoms and permission array. */
    public record RoleBindingRow(UUID orgUnitId, UUID roleId, String roleName, List<String> atoms,
                                 JsonNode permissions) {
    }

    /** The three row sets, already loaded. Keeping them as plain rows is what makes this card DB-free. */
    public record Rows(List<UnitRow> units, List<MembershipRow> members, List<RoleBindingRow> bindings) {
    }

    /** The member to expand for, keyed exactly as {@code org_unit_members} keys members. */
    public record MemberRef(String memberKind, UUID memberId) {
    }

    /**
     * Expands with the safe default: non-governance bindings are dropped.
     *
     * @param member the member to expand for
     * @param rows   the loaded rows
     * @return one in-memory grant per accepted binding, in input order; empty when the member has
     *         no unit or no binding sits on its chain
     */
    public List<AuthorizationGrant> expand(MemberRef member, Rows rows) {
        return expand(member, rows, NonGovernanceRolePolicy.FILTER);
    }

    /**
     * The expansion itself.
     *
     * @param member the member to expand for
     * @param rows   the loaded rows ({@code null} lists are read as empty)
     * @param policy {@link NonGovernanceRolePolicy#FILTER} or {@link NonGovernanceRolePolicy#STRICT}
     * @return in-memory grants, {@code id} always {@code null} (see {@link #toGrant})
     * @throws com.cc01cc.p.xihe.cp.config.CpApiException on a non-governance role in {@code STRICT}
     * @throws IllegalStateException when the rows contradict themselves (a membership without its
     *                              unit row, a path without its ancestor rows, unresolvable atoms in
     *                              {@code STRICT}) — fail closed rather than silently under-grant
     */
    public List<AuthorizationGrant> expand(MemberRef member, Rows rows, NonGovernanceRolePolicy policy) {
        Objects.requireNonNull(member, "member");
        Objects.requireNonNull(member.memberKind(), "member.memberKind");
        Objects.requireNonNull(member.memberId(), "member.memberId");
        NonGovernanceRolePolicy effective = policy == null ? NonGovernanceRolePolicy.FILTER : policy;
        Rows input = rows == null ? new Rows(List.of(), List.of(), List.of()) : rows;

        Map<UUID, UnitRow> unitsById = new LinkedHashMap<>();
        Map<String, UnitRow> unitsByPath = new LinkedHashMap<>();
        for (UnitRow unit : nullSafe(input.units())) {
            if (unit == null) {
                continue;
            }
            unitsById.put(unit.id(), unit);
            unitsByPath.put(unit.path(), unit);
        }

        LinkedHashSet<UUID> ownUnitIds = new LinkedHashSet<>();
        for (MembershipRow membership : nullSafe(input.members())) {
            if (membership != null
                    && member.memberKind().equals(membership.memberKind())
                    && member.memberId().equals(membership.memberId())) {
                ownUnitIds.add(membership.orgUnitId());
            }
        }
        if (ownUnitIds.isEmpty()) {
            return List.of();
        }

        LinkedHashSet<UUID> chainUnitIds = new LinkedHashSet<>();
        for (UUID ownUnitId : ownUnitIds) {
            UnitRow own = unitsById.get(ownUnitId);
            if (own == null) {
                throw new IllegalStateException(
                        "org_unit_members points at a unit with no org_units row: " + ownUnitId);
            }
            for (String ancestorPath : ancestorPaths(own.path())) {
                UnitRow ancestor = unitsByPath.get(ancestorPath);
                if (ancestor == null) {
                    throw new IllegalStateException("org_units.path is not fully materialised: missing row '"
                            + ancestorPath + "' while expanding '" + own.path() + "'");
                }
                chainUnitIds.add(ancestor.id());
            }
        }

        Map<String, RoleBindingRow> chainBindings = new LinkedHashMap<>();
        for (RoleBindingRow binding : nullSafe(input.bindings())) {
            if (binding == null || !chainUnitIds.contains(binding.orgUnitId())) {
                continue;
            }
            chainBindings.putIfAbsent(binding.orgUnitId() + "|" + binding.roleId(), binding);
        }
        if (chainBindings.isEmpty()) {
            return List.of();
        }

        List<RoleBindingRow> accepted = effective == NonGovernanceRolePolicy.STRICT
                ? requireGovernanceBindings(chainBindings.values())
                : OrgUnitGovernancePolicy.filterGovernanceRoles(chainBindings.values(), RoleBindingRow::atoms);
        return accepted.stream().map(binding -> toGrant(binding, member)).toList();
    }

    /**
     * Expands a materialised ltree path into its ancestor chain, <b>self included</b>, root first.
     *
     * <p>ltree's {@code <@} is "is a descendant-or-self of", so the chain of {@code a.b.c} is
     * {@code [a, a.b, a.b.c]} and never contains {@code a.b.c.x}. Labels cannot contain
     * {@code .} (that is the ltree separator), so splitting is exact — no escaping to think about.</p>
     *
     * @param path a materialised ltree path such as {@code a.b.c}
     * @return every prefix of {@code path} at label boundaries, root first
     * @throws IllegalArgumentException when the path is blank or has an empty label
     */
    public static List<String> ancestorPaths(String path) {
        if (path == null || path.isBlank()) {
            throw new IllegalArgumentException("org unit path must not be blank");
        }
        String[] labels = path.split("\\.");
        List<String> chain = new ArrayList<>(labels.length);
        StringBuilder prefix = new StringBuilder();
        for (String label : labels) {
            if (label.isBlank()) {
                throw new IllegalArgumentException("org unit path has an empty ltree label: " + path);
            }
            if (prefix.length() > 0) {
                prefix.append('.');
            }
            prefix.append(label);
            chain.add(prefix.toString());
        }
        return chain;
    }

    /**
     * The strict arm: every binding on the chain must pass the <b>same</b> judgement the write side
     * uses, and the refusal names the role and the offending atoms.
     */
    private static List<RoleBindingRow> requireGovernanceBindings(Iterable<RoleBindingRow> bindings) {
        List<RoleBindingRow> accepted = new ArrayList<>();
        for (RoleBindingRow binding : bindings) {
            if (binding.atoms() == null) {
                // An unknown role is not an empty one (same stance as filterGovernanceRoles): refuse.
                throw new IllegalStateException("role atoms could not be resolved for role '"
                        + binding.roleName() + "' bound to org unit " + binding.orgUnitId()
                        + "; refusing to expand instead of guessing");
            }
            OrgUnitGovernancePolicy.requireGovernanceRole(binding.roleName(), binding.atoms());
            accepted.add(binding);
        }
        return accepted;
    }

    /**
     * Builds the in-memory row. {@code id} and {@code createdAt} stay {@code null} on purpose:
     * {@code AuthorizationGrant.onCreate()} fills them at {@code @PrePersist}, so a {@code null} id
     * is the witness that this row never went through JPA (the card's "未落库" assertion).
     */
    private static AuthorizationGrant toGrant(RoleBindingRow binding, MemberRef member) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setSubjectType(subjectTypeOf(member.memberKind()));
        grant.setSubjectId(member.memberId());
        grant.setGranterType(GRANTER_ORG_UNIT);
        grant.setGranterId(binding.orgUnitId());
        grant.setSource(SOURCE);
        grant.setRoleName(binding.roleName());
        grant.setPermissions(binding.permissions() == null ? NO_PERMISSIONS : binding.permissions());
        grant.setScopeType(SCOPE_INSTANCE);
        grant.setScopeId(null);
        return grant;
    }

    /**
     * {@code org_unit_members.member_kind} to {@code grants.subject_type}. The two vocabularies are
     * different words for the same thing (a human belongs to {@code users}, so its grant subject
     * type is {@code user}); the constants are taken from their existing owners rather than spelled
     * again here.
     */
    private static String subjectTypeOf(String memberKind) {
        return switch (memberKind) {
            case MEMBER_HUMAN -> GrantPrincipalPathResolver.USER;
            case MEMBER_AGENT_PRINCIPAL -> GrantPrincipalPathResolver.AGENT_PRINCIPAL;
            default -> throw new IllegalArgumentException("unknown org_unit_members.member_kind: '"
                    + memberKind + "' (V164 CHECK allows only '" + MEMBER_HUMAN + "', '"
                    + MEMBER_AGENT_PRINCIPAL + "')");
        };
    }

    private static <T> List<T> nullSafe(List<T> rows) {
        return rows == null ? List.of() : rows;
    }
}
