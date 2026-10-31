package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * PLAN-0585 surface, retired by PLAN-0610 W2 (decision #28).
 *
 * <p>The audited {@code /api/v1/principal-grants/*} write surface stored the two opt-in atoms
 * ({@code CREATE_ACCOUNT}, {@code MANAGE_WORKSPACE_AGENTS}) in a {@code grants.source='direct'} row.
 * V88 narrows {@code ck_grants_source} to the five post-migration values, so that write can no
 * longer succeed; keeping a "guaranteed to fail" writer would surface as a 500 on the next PATCH.
 * The admin grant model is replaced by access-role bindings (W3 API), so both the read and write
 * entries return {@link HttpStatus#GONE} {@code PRINCIPAL_GRANTS_RETIRED} until W3 deletes the
 * routes and W5 removes the UI page.</p>
 *
 * <p>What deliberately stays here: the request/response records the controller still references and
 * {@link #mentionsConstraint(Throwable)} (a pure helper asserted by
 * {@code PrincipalGrantActionCatalogTest}). {@code PrincipalGrantActionCatalog} stays as a
 * read-only vocabulary until W3 removes the surface.</p>
 */
@Service
public class PrincipalGrantAdminService {

    public static final String RETIRED_CODE = "PRINCIPAL_GRANTS_RETIRED";

    public static final String RETIRED_DETAIL =
            "The principal-grants write surface was retired by the PLAN-0610 access-role migration "
                    + "(V88). Use access-role bindings instead; this route is removed in the W3 batch.";

    /** One requested {@code {actionClass, resource?}} atom from the PATCH body (kept for the controller). */
    public record AtomInput(String actionClass, String resource) {}

    /** One manageable atom as returned by the retired read view. */
    public record AtomView(String actionClass, String resource) {}

    /** Retired read view shape (kept so the controller keeps compiling until W3). */
    public record GrantView(String userId, String username, List<AtomView> grants) {}

    /** Retired write result shape. */
    public record GrantMutation(String userId, String username, List<AtomView> grants,
                                boolean changed) {}

    /** GET /api/v1/principal-grants/{username} — retired by V88, removed in W3. */
    public GrantView read(String username) {
        throw retired();
    }

    /** PATCH /api/v1/principal-grants/{username} — retired by V88, removed in W3. */
    public GrantMutation patch(String actorUserId, String username,
                               List<AtomInput> add, List<AtomInput> remove) {
        throw retired();
    }

    /**
     * True when a persistence failure mentions the V65 direct-grant fence. Now only a pure helper
     * for the catalog assertions; the retired surface never reaches a constraint.
     */
    public static boolean mentionsConstraint(Throwable error) {
        return mentionsConstraint(error, "uq_grants_direct_subject");
    }

    /** General form kept for the catalog integration assertions (constraint-name substring match). */
    public static boolean mentionsConstraint(Throwable error, String constraint) {
        Throwable current = error;
        while (current != null) {
            String message = current.getMessage();
            if (message != null && message.contains(constraint)) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private static CpApiException retired() {
        return new CpApiException(HttpStatus.GONE, RETIRED_CODE, RETIRED_DETAIL);
    }
}
