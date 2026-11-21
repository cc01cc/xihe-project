package com.cc01cc.p.xihe.cp.policy;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.BadSqlGrammarException;

import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * task-213: an unreadable grant store must not be reported as "the caller holds nothing".
 *
 * <p>Before this card every evaluation read in {@link RequesterAuthority} caught
 * {@code RuntimeException} and returned {@code Set.of()}. The escalation guard reads that empty set
 * as a permissions verdict, so a missing table or column surfaced as
 * {@code 403 PRIVILEGE_ESCALATION} at {@code GrantabilityGuard#assertGrantableRows} - the caller
 * was blamed for a server-side failure, and {@code audit_logs} recorded a grant attempt as
 * "exceeded" with every requested atom listed. The tests below pin the three fixed properties:</p>
 *
 * <ol>
 *   <li>the decision reads ({@code actionPermissions}, {@code actionAtoms}) refuse with
 *       {@code 500 POLICY_EVALUATION_FAILED} and name the failure type;</li>
 *   <li>the audit-only read ({@code atomSources}) still degrades, but says {@code unavailable}
 *       instead of {@code none} - the three-state {@link RequesterAuthority.AtomSourceLookup};</li>
 *   <li>a healthy store still evaluates normally, so this is not "always 500".</li>
 * </ol>
 */
class RequesterAuthorityFailureModeTest {

    private static final UUID SUBJECT = UUID.fromString("11111111-1111-1111-1111-111111111111");
    private static final UUID WORKSPACE = UUID.fromString("22222222-2222-2222-2222-222222222222");

    private final AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
    private final GrantIntersectionEvaluator evaluator = mock(GrantIntersectionEvaluator.class);
    private final AuthzContext authzContext = mock(AuthzContext.class);

    private RequesterAuthority authority;
    private ListAppender<ILoggingEvent> appender;
    private Logger logger;

    @BeforeEach
    void setUp() {
        authority = new RequesterAuthority(grants, evaluator, authzContext,
                OrgUnitGrantsTestFixture.withoutRows());
        appender = new ListAppender<>();
        appender.start();
        logger = (Logger) LoggerFactory.getLogger(RequesterAuthority.class);
        logger.addAppender(appender);
    }

    @AfterEach
    void tearDown() {
        logger.detachAppender(appender);
    }

    @Test
    void actionPermissionsRefusesWithAPolicyEvaluationFailureInsteadOfAnEmptySet() {
        when(grants.findScopedGrants(any(), any(), any(), any())).thenThrow(storeUnreadable());

        CpApiException refusal = assertThrows(CpApiException.class,
                () -> authority.actionPermissions(SUBJECT, WORKSPACE));

        assertEquals(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR, refusal.getStatus());
        assertEquals(RequesterAuthority.POLICY_EVALUATION_FAILED, refusal.getCode());
        assertTrue(refusal.getMessage().contains("BadSqlGrammarException"),
                "the failure type must stay visible: " + refusal.getMessage());
        assertTrue(refusal.getMessage().contains("fail-closed"), refusal.getMessage());
    }

    @Test
    void actionAtomsRefusesInsteadOfReportingThatTheSubjectHoldsNothing() {
        when(grants.findScopedGrants(any(), any(), any(), any())).thenThrow(storeUnreadable());

        // holdsActionAtom is the SpEL entry point of the MANAGE_* gates: before task-213 it turned
        // this failure into "false", i.e. a 403 on every role/binding write.
        CpApiException refusal = assertThrows(CpApiException.class,
                () -> authority.holdsActionAtom(SUBJECT, ToolFaceRegistry.ACTION_MANAGE_ROLES, WORKSPACE));

        assertEquals(RequesterAuthority.POLICY_EVALUATION_FAILED, refusal.getCode());
        assertThrows(CpApiException.class, () -> authority.actionAtoms(SUBJECT, WORKSPACE));
    }

    @Test
    void theFailureLogNamesTheEventAndTheExceptionType() {
        when(grants.findScopedGrants(any(), any(), any(), any())).thenThrow(storeUnreadable());

        assertThrows(CpApiException.class, () -> authority.actionPermissions(SUBJECT, WORKSPACE));

        ILoggingEvent failure = appender.list.stream()
                .filter(event -> event.getFormattedMessage()
                        .contains("event=tool_permission_evaluation_failed"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no failure line: " + appender.list));
        assertEquals(Level.ERROR, failure.getLevel());
        assertTrue(failure.getFormattedMessage().contains("failureType=BadSqlGrammarException"),
                failure.getFormattedMessage());
        assertTrue(failure.getFormattedMessage().contains("decision=fail-closed status=500"),
                failure.getFormattedMessage());
    }

    @Test
    void atomSourceLookupTellsUnavailableApartFromNone() {
        when(grants.findScopedGrants(any(), any(), any(), any())).thenThrow(storeUnreadable());

        RequesterAuthority.AtomSourceLookup lookup =
                authority.atomSourceLookup(SUBJECT, ToolFaceRegistry.ACTION_MANAGE_ROLES, WORKSPACE);

        assertEquals(RequesterAuthority.AtomSourceStatus.UNAVAILABLE, lookup.status());
        assertEquals("BadSqlGrammarException", lookup.failureType());
        assertEquals(Set.of(), lookup.sources());
        // The legacy audit view keeps degrading: an audit-only face must not fail a write.
        assertEquals(Set.of(),
                authority.atomSources(SUBJECT, ToolFaceRegistry.ACTION_MANAGE_ROLES, WORKSPACE));
    }

    @Test
    void atomSourceLookupSaysNoneWhenTheStoreAnswersButHoldsNoRow() {
        RequesterAuthority.AtomSourceLookup lookup =
                authority.atomSourceLookup(SUBJECT, ToolFaceRegistry.ACTION_MANAGE_ROLES, WORKSPACE);

        assertEquals(RequesterAuthority.AtomSourceStatus.NONE, lookup.status());
        assertEquals("-", lookup.failureType());
        assertEquals("none", lookup.sourceField(""));
    }

    @Test
    void theDenyLogStopsCallingAnUnreadableStoreNone() {
        when(grants.findScopedGrants(any(), any(), any(), any())).thenThrow(storeUnreadable());

        authority.logActionAtomDenied(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                SUBJECT, WORKSPACE);

        assertEquals("unavailable", deniedFields().get("source"));
    }

    @Test
    void aHealthyStoreStillEvaluatesAndIsNotTurnedIntoA500() {
        // Build the fixture rows first: stubbing a mock (grant(...)) inside another when(...)
        // argument is an unfinished-stubbing error.
        List<AuthorizationGrant> rows = List.of(grant("role", ToolFaceRegistry.ACTION_MANAGE_ROLES));
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(rows);
        Set<GrantIntersectionEvaluator.PermissionAtom> atoms = Set.of(
                new GrantIntersectionEvaluator.PermissionAtom(
                        ToolFaceRegistry.ACTION_MANAGE_ROLES, "*"));
        when(evaluator.union(any())).thenReturn(atoms);

        Set<GrantIntersectionEvaluator.PermissionAtom> permissions =
                authority.actionPermissions(SUBJECT, WORKSPACE);

        assertFalse(permissions.isEmpty());
        assertTrue(authority.actionAtoms(SUBJECT, WORKSPACE)
                .contains(ToolFaceRegistry.ACTION_MANAGE_ROLES));
        assertEquals(Set.of("role"),
                authority.atomSources(SUBJECT, ToolFaceRegistry.ACTION_MANAGE_ROLES, WORKSPACE));
        assertEquals(RequesterAuthority.AtomSourceStatus.PRESENT,
                authority.atomSourceLookup(SUBJECT, ToolFaceRegistry.ACTION_MANAGE_ROLES, WORKSPACE)
                        .status());
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    /** What {@code OrgUnitGrantRowsRepository} throws when the ltree read hits an unknown table. */
    private static BadSqlGrammarException storeUnreadable() {
        return new BadSqlGrammarException("OrgUnitGrantRowsRepository.rows",
                "select chain.path from org_unit_closure chain", new SQLException("boom", "42S02"));
    }

    private static AuthorizationGrant grant(String source, String actionClass) {
        AuthorizationGrant grant = mock(AuthorizationGrant.class);
        when(grant.getSource()).thenReturn(source);
        when(grant.getPermissions()).thenReturn(new ObjectMapper().valueToTree(
                List.of(Map.of("actionClass", actionClass))));
        return grant;
    }

    private Map<String, String> deniedFields() {
        ILoggingEvent event = appender.list.stream()
                .filter(candidate -> candidate.getFormattedMessage()
                        .contains("event=action_atom_denied"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no action_atom_denied line: " + appender.list));
        Map<String, String> fields = new LinkedHashMap<>();
        for (String part : event.getFormattedMessage().split(" ")) {
            int eq = part.indexOf('=');
            if (eq > 0) {
                fields.put(part.substring(0, eq), part.substring(eq + 1));
            }
        }
        return fields;
    }
}
