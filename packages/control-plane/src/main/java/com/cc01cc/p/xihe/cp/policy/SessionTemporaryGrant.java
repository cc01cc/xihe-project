package com.cc01cc.p.xihe.cp.policy;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * One row of {@code session_temporary_grants} (V180 / task-124 / DSD-1509).
 *
 * <p>A live row ({@code revokedAt == null && expiresAt.isAfter(now)}) is a capability token for
 * exactly one session and one agent principal. {@link GrantIntersectionEvaluator} consumes it as an
 * override of the per-level "does this level hold the atom" test for the pairs it covers; it is
 * deliberately not a sixth level (DSD-1509 ②).</p>
 *
 * <p>The record is immutable and carries the parsed atoms, not the JSONB text, because every
 * consumer (evaluation, listing, audit detail) needs the atoms; the store is the only place that
 * knows the storage shape.</p>
 */
public record SessionTemporaryGrant(
        UUID id,
        UUID sessionId,
        UUID workspaceId,
        UUID principalId,
        List<GrantIntersectionEvaluator.PermissionAtom> atoms,
        UUID grantedByUserId,
        Instant grantedAt,
        Instant expiresAt,
        UUID revokedByUserId,
        Instant revokedAt) {

    public SessionTemporaryGrant {
        atoms = atoms == null ? List.of() : List.copyOf(atoms);
    }

    /** A row still authorizes only while nothing revoked it and the TTL has not run out. */
    public boolean liveAt(Instant now) {
        return revokedAt == null && now != null && expiresAt != null && expiresAt.isAfter(now);
    }

    /** {@code exec@fs:<ws>/src} style rendering used by the audit detail (never a policy input). */
    public String atomLabels() {
        StringBuilder builder = new StringBuilder();
        for (GrantIntersectionEvaluator.PermissionAtom atom : atoms) {
            if (builder.length() > 0) {
                builder.append(',');
            }
            builder.append(atom.actionClass()).append('@').append(atom.resource());
        }
        return builder.toString();
    }
}
