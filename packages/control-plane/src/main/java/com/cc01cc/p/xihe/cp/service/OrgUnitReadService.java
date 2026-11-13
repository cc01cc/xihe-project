package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.controller.OrgUnitWireView;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0773 M2-11 (batch A): who may see which org-unit nodes and members.
 *
 * <p>The two gates and their <b>order</b> are the whole content of this class (design §4.1/§4.3,
 * `tasks.md` M2-11 判据③):</p>
 *
 * <ol>
 *   <li><b>Scope</b> — resolved first, and it is what answers `404`. A caller with no membership row
 *       and no instance-scope `READ_ORG_UNIT_MEMBERS` is told the unit does not exist, for any unit
 *       id, existing or not. That is not politeness: a 403 there would confirm existence to a
 *       non-member, which is exactly the leak the ruling forbids.</li>
 *   <li><b>Atom</b> — only then `READ_ORG_UNIT_MEMBERS`. A member without it is refused with 403;
 *       had the atom gate run first (as a `@PreAuthorize` would), every non-member would get 403
 *       too and the 404 above could never be produced.</li>
 * </ol>
 *
 * <p>Two visibility shapes fall out: a <b>member</b> sees the subtree of its own unit
 * (`path <@ own.path`); an <b>instance-level reader</b> (atom, no membership) sees the whole tree.
 * The second shape is not a back door — design §4.2 grants the instance admin the atoms at
 * instance scope, and there is no other way to hold `READ_ORG_UNIT_MEMBERS` without a membership
 * row today (`org_unit_role_bindings` is M1-9 and absent).</p>
 *
 * <p>No caching (M2-10a): every call re-reads the membership row, so a move changes what a caller
 * sees on the next request. A memoized scope here would be the exact bug G2 exists to prevent.</p>
 */
@Service
public class OrgUnitReadService {

    /** The read atom of design §4.2. A separate "read the tree" atom was not invented: M2-2 froze
     *  the atom set, and a tree node carries no member detail to justify a second atom. */
    public static final String READ_ATOM = ToolFaceRegistry.ACTION_READ_ORG_UNIT_MEMBERS;

    private final OrgUnitReadRepository units;
    private final OrgUnitAccess access;

    public OrgUnitReadService(OrgUnitReadRepository units, OrgUnitAccess access) {
        this.units = units;
        this.access = access;
    }

    /** Tree top, lazy-loaded children, or a name search inside the caller's visible subtree. */
    @Transactional(readOnly = true)
    public OrgUnitWireView.NodeList list(String parentIdValue, String q) {
        OrgUnitAccess.Scope scope = access.resolve(READ_ATOM);
        if (q != null && !q.isBlank()) {
            List<OrgUnitReadRepository.UnitRow> hits = units.searchByName(q.trim(), scope.path());
            return new OrgUnitWireView.NodeList(nodes(hits, scope));
        }
        UUID parentId = OrgUnitAccess.parseUuid(parentIdValue, "INVALID_ORG_UNIT_ID");
        if (parentId == null) {
            List<OrgUnitReadRepository.UnitRow> top = scope.path() == null
                    ? units.findChildren(null)
                    : List.of(units.findUnit(scope.unitId()).orElseThrow(OrgUnitAccess::notFound));
            return new OrgUnitWireView.NodeList(nodes(top, scope));
        }
        OrgUnitReadRepository.UnitRow parent = units.findUnit(parentId)
                .orElseThrow(OrgUnitAccess::notFound);
        scope.requireWithin(parent.path());
        return new OrgUnitWireView.NodeList(nodes(units.findChildren(parentId), scope));
    }

    /** Members of one unit, or of its whole subtree when `includeDescendants` is true. */
    @Transactional(readOnly = true)
    public OrgUnitWireView.MemberList members(String unitIdValue, boolean includeDescendants) {
        OrgUnitAccess.Scope scope = access.resolve(READ_ATOM);
        UUID unitId = OrgUnitAccess.parseUuid(unitIdValue, "INVALID_ORG_UNIT_ID");
        if (unitId == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ORG_UNIT_ID",
                    "unitId must be a UUID");
        }
        OrgUnitReadRepository.UnitRow unit = units.findUnit(unitId)
                .orElseThrow(OrgUnitAccess::notFound);
        scope.requireWithin(unit.path());
        List<OrgUnitWireView.Member> members = units.findMembers(unit.id(), unit.path(), includeDescendants)
                .stream()
                .map(m -> new OrgUnitWireView.Member(
                        m.memberKind(), m.memberId(), m.orgUnitId(), m.displayName()))
                .toList();
        return new OrgUnitWireView.MemberList(members);
    }

    private List<OrgUnitWireView.Node> nodes(List<OrgUnitReadRepository.UnitRow> rows,
                                            OrgUnitAccess.Scope scope) {
        if (rows.isEmpty()) {
            return List.of();
        }
        Set<UUID> parents = units.parentsOf(rows.stream().map(OrgUnitReadRepository.UnitRow::id).toList());
        return rows.stream()
                .filter(row -> scope.path() == null || OrgUnitAccess.within(row.path(), scope.path()))
                .map(row -> new OrgUnitWireView.Node(
                        row.id(), row.name(), row.parentId(), row.depth(), parents.contains(row.id())))
                .toList();
    }

}
