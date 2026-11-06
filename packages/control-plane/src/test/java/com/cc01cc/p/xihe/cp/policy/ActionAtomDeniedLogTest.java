package com.cc01cc.p.xihe.cp.policy;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0651 T1.5 (proposal B, Lead-approved 2026-11-06): the B3 field contract of the canonical
 * {@code [POLICY] event=action_atom_denied} deny stream. Four closed fields — a
 * {@link PermissionAtomCatalog} atom (or {@code -}), uuid subject and workspace ({@code -} when
 * absent), and the {@link GrantSources#EVALUATION_SOURCES} rows carrying the atom ({@code none}
 * when the subject holds it from no source). B4: nothing beyond the four fields — no names, no
 * resource strings, never audit_logs.
 */
class ActionAtomDeniedLogTest {

    private final AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
    private final GrantIntersectionEvaluator evaluator = mock(GrantIntersectionEvaluator.class);
    private final AuthzContext authzContext = mock(AuthzContext.class);

    private RequesterAuthority authority;
    private ListAppender<ILoggingEvent> appender;
    private Logger logger;

    @BeforeEach
    void setUp() {
        authority = new RequesterAuthority(grants, evaluator, authzContext);
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
    void denialWithoutAnyGrantLogsNone() {
        // Mockito's default for findScopedGrants is an empty list: the subject holds nothing.
        authority.logActionAtomDenied(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                UUID.randomUUID(), UUID.randomUUID());

        Map<String, String> fields = deniedFields();
        assertEquals("MANAGE_WORKSPACE_MEMBERS", fields.get("atom"));
        assertEquals("none", fields.get("source"));
    }

    @Test
    void roleSourcedGrantIsNamedAsTheSource() {
        AuthorizationGrant roleGrant = grant("role", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS);
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(List.of(roleGrant));

        authority.logActionAtomDenied(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                UUID.randomUUID(), UUID.randomUUID());

        assertEquals("role", deniedFields().get("source"));
    }

    @Test
    void sourcesFromDistinctRowsAreJoined() {
        AuthorizationGrant roleGrant = grant("role", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS);
        AuthorizationGrant spawnGrant = grant("spawn", ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS);
        when(grants.findScopedGrants(any(), any(), any(), any()))
                .thenReturn(List.of(roleGrant, spawnGrant));

        authority.logActionAtomDenied(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                UUID.randomUUID(), UUID.randomUUID());

        assertEquals("role,spawn", deniedFields().get("source"));
    }

    @Test
    void unknownAtomAndMissingSubjectAndWorkspaceAreMasked() {
        authority.logActionAtomDenied("not-a-catalog-atom", null, null);

        Map<String, String> fields = deniedFields();
        assertEquals("-", fields.get("atom"));
        assertEquals("-", fields.get("subject"));
        assertEquals("-", fields.get("workspaceId"));
        assertEquals("none", fields.get("source"));
    }

    @Test
    void sourceLookupFailureStaysFailOpenToNone() {
        when(grants.findScopedGrants(any(), any(), any(), any()))
                .thenThrow(new IllegalStateException("db down"));

        authority.logActionAtomDenied(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                UUID.randomUUID(), UUID.randomUUID());

        assertEquals("none", deniedFields().get("source"));
    }

    @Test
    void theLineIsOneWarnRowWithTheClosedFieldSet() {
        authority.logActionAtomDenied(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                UUID.randomUUID(), null);

        ILoggingEvent event = deniedEvent();
        assertEquals(ch.qos.logback.classic.Level.WARN, event.getLevel());
        // Exactly [POLICY] + event + the four B3 fields — no resource or content fields (B4).
        assertEquals("[POLICY] event=action_atom_denied atom=MANAGE_WORKSPACE_MEMBERS subject="
                        + event.getFormattedMessage().split("subject=")[1].split(" ")[0]
                        + " workspaceId=- source=none",
                event.getFormattedMessage());
        assertEquals(5, fieldMap(event.getFormattedMessage()).size());
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    /** A grant row whose source carries exactly {@code actionClass} (what atomSources reads). */
    private static AuthorizationGrant grant(String source, String actionClass) {
        AuthorizationGrant grant = mock(AuthorizationGrant.class);
        when(grant.getSource()).thenReturn(source);
        when(grant.getPermissions()).thenReturn(new ObjectMapper().valueToTree(
                List.of(Map.of("actionClass", actionClass))));
        return grant;
    }

    private ILoggingEvent deniedEvent() {
        return appender.list.stream()
                .filter(event -> event.getFormattedMessage().contains("event=action_atom_denied"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no action_atom_denied line: " + appender.list));
    }

    private Map<String, String> deniedFields() {
        return fieldMap(deniedEvent().getFormattedMessage());
    }

    private static Map<String, String> fieldMap(String line) {
        Map<String, String> fields = new LinkedHashMap<>();
        for (String part : line.split(" ")) {
            int eq = part.indexOf('=');
            if (eq > 0) {
                fields.put(part.substring(0, eq), part.substring(eq + 1));
            }
        }
        return fields;
    }
}
