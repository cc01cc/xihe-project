package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;

import java.sql.SQLException;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * task-213, guard-level: what the caller actually sees at the escalation gate.
 *
 * <p>{@code GrantabilityGuard#assertGrantableRows} reads the caller's rows through
 * {@link RequesterAuthority#actionPermissions} and turns "not covered" into
 * {@code 403 PRIVILEGE_ESCALATION}. When the grant store could not be read at all, that used to be
 * the same empty set as "holds nothing", so a broken schema looked like an escalation attempt -
 * <b>403 "Cannot grant atoms the caller does not hold"</b> - and the denial row in
 * {@code audit_logs} listed every requested atom as {@code exceeding}. The two cases must now be
 * distinguishable: unreadable ⇒ {@code 500 POLICY_EVALUATION_FAILED}, genuinely not held ⇒ still
 * {@code 403 PRIVILEGE_ESCALATION} (fail-closed behaviour is unchanged).
 */
class GrantabilityGuardFailureSurfaceTest {

    private static final UUID SUBJECT = UUID.fromString("33333333-3333-3333-3333-333333333333");

    private final AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
    private final GrantIntersectionEvaluator evaluator = mock(GrantIntersectionEvaluator.class);
    private final AuthzContext authzContext = mock(AuthzContext.class);
    private final PlatformTransactionManager transactionManager = mock(PlatformTransactionManager.class);
    private final AuditLogger audit = mock(AuditLogger.class);
    private final GrantPresetBindingRepository bindings = mock(GrantPresetBindingRepository.class);

    private GrantabilityGuard guard;

    @BeforeEach
    void setUp() {
        when(transactionManager.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
        when(bindings.findBySubjectTypeAndSubjectIdAndScopeType(any(), any(), any()))
                .thenReturn(List.of());
        RequesterAuthority requester = new RequesterAuthority(grants, evaluator, authzContext,
                OrgUnitGrantsTestFixture.withoutRows());
        guard = new GrantabilityGuard(requester, authzContext, bindings, audit, transactionManager);
        TenantContext.setUserId(SUBJECT.toString());
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void unreadableGrantStoreIsA500NotAPrivilegeEscalation403() {
        when(grants.findScopedGrants(any(), any(), any(), any())).thenThrow(storeUnreadable());

        CpApiException refusal = assertThrows(CpApiException.class,
                () -> guard.assertGrantable(Set.of(ToolFaceRegistry.ACTION_MANAGE_ROLES), null));

        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, refusal.getStatus(),
                "a broken grant store must not be answered as a permissions verdict: "
                        + refusal.getCode());
        assertEquals(RequesterAuthority.POLICY_EVALUATION_FAILED, refusal.getCode());
    }

    @Test
    void aHealthyStoreThatHoldsNothingStillRefusesWith403PrivilegeEscalation() {
        // Same guard, same request, but the store answers: this is the legitimate deny and it must
        // keep its 403 shape - the fix separates the two causes, it does not stop denying.
        CpApiException refusal = assertThrows(CpApiException.class,
                () -> guard.assertGrantable(Set.of(ToolFaceRegistry.ACTION_MANAGE_ROLES), null));

        assertEquals(HttpStatus.FORBIDDEN, refusal.getStatus());
        assertEquals("PRIVILEGE_ESCALATION", refusal.getCode());
    }

    private static BadSqlGrammarException storeUnreadable() {
        return new BadSqlGrammarException("OrgUnitGrantRowsRepository.rows",
                "select chain.path from org_unit_closure chain", new SQLException("boom", "42S02"));
    }
}
