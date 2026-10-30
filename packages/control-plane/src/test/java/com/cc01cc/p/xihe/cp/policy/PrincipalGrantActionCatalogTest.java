package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0585: unit coverage for the pieces the HTTP contract cannot reach without a live database —
 * the action/resource catalog rules and the narrowed 409 classification (only the V65
 * {@code uq_grants_direct_subject} race maps to {@code DIRECT_GRANT_CONFLICT}).
 */
class PrincipalGrantActionCatalogTest {

    @Test
    void createAccountIsInstanceWideAndDefaultsToWildcard() {
        assertEquals("*", PrincipalGrantActionCatalog
                .requireManageable("CREATE_ACCOUNT", null).resource());
        assertEquals("*", PrincipalGrantActionCatalog
                .requireManageable("CREATE_ACCOUNT", " * ").resource());
    }

    @Test
    void manageWorkspaceAgentsRequiresAConcreteWorkspaceUuid() {
        UUID workspaceId = UUID.randomUUID();
        GrantIntersectionEvaluator.PermissionAtom atom = PrincipalGrantActionCatalog
                .requireManageable("MANAGE_WORKSPACE_AGENTS", workspaceId.toString().toUpperCase());
        assertEquals(workspaceId.toString(), atom.resource(), "canonical lowercase uuid");

        assertCode("INVALID_GRANT_RESOURCE",
                () -> PrincipalGrantActionCatalog.requireManageable("MANAGE_WORKSPACE_AGENTS", "*"));
        assertCode("INVALID_GRANT_RESOURCE",
                () -> PrincipalGrantActionCatalog.requireManageable("MANAGE_WORKSPACE_AGENTS", " "));
        // UUID#fromString tolerates shorthand; the surface must not store it.
        assertCode("INVALID_GRANT_RESOURCE",
                () -> PrincipalGrantActionCatalog.requireManageable("MANAGE_WORKSPACE_AGENTS",
                        "1-2-3-4-5"));
    }

    @Test
    void createAccountRejectsAnyNarrowerResource() {
        assertCode("INVALID_GRANT_RESOURCE",
                () -> PrincipalGrantActionCatalog.requireManageable("CREATE_ACCOUNT",
                        UUID.randomUUID().toString()));
    }

    @Test
    void onlyTheTwoFrozenActionClassesAreManageable() {
        assertTrue(PrincipalGrantActionCatalog.manageable("CREATE_ACCOUNT"));
        assertTrue(PrincipalGrantActionCatalog.manageable("MANAGE_WORKSPACE_AGENTS"));
        assertFalse(PrincipalGrantActionCatalog.manageable("CREATE_TEMPLATE"));
        assertCode("UNMANAGEABLE_ACTION_CLASS",
                () -> PrincipalGrantActionCatalog.requireManageable("CREATE_TEMPLATE", null));
        assertCode("UNKNOWN_ACTION_CLASS",
                () -> PrincipalGrantActionCatalog.requireManageable("NOT_AN_ACTION", null));
        assertCode("INVALID_REQUEST",
                () -> PrincipalGrantActionCatalog.requireManageable(" ", null));
    }

    @Test
    void conflictClassificationOnlyMatchesTheDirectGrantIndex() {
        assertTrue(PrincipalGrantAdminService.mentionsConstraint(new DataIntegrityViolationException(
                        "ERROR: duplicate key value violates unique constraint \"uq_grants_direct_subject\""),
                "uq_grants_direct_subject"));
        assertTrue(PrincipalGrantAdminService.mentionsConstraint(new DataIntegrityViolationException(
                        "prepared statement failed",
                        new IllegalStateException("caused by uq_grants_direct_subject")),
                "uq_grants_direct_subject"));
        // Any other integrity failure must keep its normal (500) mapping.
        assertFalse(PrincipalGrantAdminService.mentionsConstraint(new DataIntegrityViolationException(
                        "ERROR: insert or update on table \"grants\" violates foreign key constraint "
                                + "\"fk_grants_subject\""),
                "uq_grants_direct_subject"));
        assertFalse(PrincipalGrantAdminService.mentionsConstraint(
                new DataIntegrityViolationException((String) null), "uq_grants_direct_subject"));
    }

    private static void assertCode(String code, Runnable action) {
        CpApiException failure = assertThrows(CpApiException.class, action::run);
        assertEquals(code, failure.getCode(), failure.getMessage());
    }
}
