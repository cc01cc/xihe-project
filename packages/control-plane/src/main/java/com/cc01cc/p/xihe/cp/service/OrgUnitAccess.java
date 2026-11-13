package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.repository.OrgUnitReadRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0773 M2-11: the one place that answers "may this caller see/touch this org unit", shared by
 * the read endpoints (batch A) and the write endpoints (batch B).
 *
 * <p><b>The order is the judgement</b>, and it is the same on both faces:</p>
 *
 * <ol>
 *   <li><b>Scope first, and it is what answers 404.</b> A caller with neither a membership row nor
 *       the required atom is told the unit does not exist — for any unit id, existing or not. A 403
 *       here would confirm existence to a non-member, which is the leak {@code design.md} §4.3
 *       forbids.</li>
 *   <li><b>Atom second.</b> A member without the atom is refused 403. Had the atom gate been a
 *       {@code @PreAuthorize} on the controller (the obvious place), it would run before this
 *       method, every non-member would get 403, and <b>the 404 could never be produced</b> — the
 *       spec's two codes would collapse into one dead code. That is why the gate lives here.</li>
 * </ol>
 *
 * <p>This class exists so the write face cannot drift into its own ordering: batch B reuses it with
 * {@code MANAGE_ORG_UNITS} instead of copying the sequence (a copy is what would eventually answer
 * 403 where the read face answers 404).</p>
 *
 * <p>No caching (M2-10a): every call re-reads the membership row, so a move changes authority on the
 * next request.</p>
 */
@Component
public class OrgUnitAccess {

    private final OrgUnitReadRepository units;
    private final RequesterAuthority authority;

    public OrgUnitAccess(OrgUnitReadRepository units, RequesterAuthority authority) {
        this.units = units;
        this.authority = authority;
    }

    /**
     * Resolve the caller's scope for an operation requiring {@code atom}.
     *
     * @throws CpApiException 401 when unauthenticated, 404 when the caller has no visibility at all,
     *     403 when the caller is a member but does not hold {@code atom}
     */
    public Scope resolve(String atom) {
        UUID caller = authority.currentSubjectId();
        if (caller == null) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED",
                    "authentication required");
        }
        Optional<OrgUnitReadRepository.MembershipRow> membership = units.findHumanMembership(caller);
        if (membership.isEmpty()) {
            if (authority.holdsActionAtom(atom)) {
                return new Scope(null, null);
            }
            throw notFound();
        }
        if (!authority.holdsActionAtom(atom)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    atom + " is required for this org-unit operation");
        }
        return new Scope(membership.get().orgUnitId(), membership.get().path());
    }

    /** The request's actor id as the audit stream wants it (a string), or null when anonymous. */
    public String currentActorId() {
        UUID caller = authority.currentSubjectId();
        return caller == null ? null : caller.toString();
    }

    public static CpApiException notFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "ORG_UNIT_NOT_FOUND", "org unit not found");
    }

    /** ltree {@code <@} semantics in memory: equal, or a dotted descendant of the scope path. */
    public static boolean within(String path, String scopePath) {
        return path.equals(scopePath) || path.startsWith(scopePath + ".");
    }

    public static UUID parseUuid(String value, String code) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, code, code + ": " + value);
        }
    }

    /**
     * The caller's visibility: {@code path} null means the whole tree. A member's scope is its own
     * unit's subtree (descendant-or-self, so the unit itself is inside it).
     */
    public record Scope(UUID unitId, String path) {

        public void requireWithin(String targetPath) {
            if (path != null && !OrgUnitAccess.within(targetPath, path)) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "org unit is outside the caller's governance scope");
            }
        }

        public boolean wholeTree() {
            return path == null;
        }
    }
}
