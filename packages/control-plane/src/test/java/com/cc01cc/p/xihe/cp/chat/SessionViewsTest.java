package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.Session;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0668 M2: the single-session detail view must carry the same delegation lineage as the list
 * projection (SessionSummary). The contract declares the fields on Session as optional; this pins
 * that the detail does not silently drop them again.
 *
 * <p>PLAN-0689 A2c: the view's {@code agentPrincipalId} is the PRIMARY participant principal handed
 * in by the caller, not the {@code sessions.agent_principal_id} column (the column is dropped in
 * A7). A Session without a PRIMARY renders the field as null — display class, no exception.</p>
 */
class SessionViewsTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID PARENT_ID = UUID.randomUUID();
    private static final UUID RUN_ID = UUID.randomUUID();
    private static final UUID PRINCIPAL_ID = UUID.randomUUID();

    @Test
    void detailViewCarriesSpawnLineage() {
        Session session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn("workspace-1");
        when(session.getTitle()).thenReturn("child");
        when(session.isArchived()).thenReturn(false);
        when(session.getKind()).thenReturn(Session.KIND_SPAWN);
        when(session.getSpawnedFromSessionId()).thenReturn(PARENT_ID);
        when(session.getSpawnedFromRunId()).thenReturn(RUN_ID);
        when(session.getSpawnedAt()).thenReturn(Instant.parse("2026-11-05T03:00:00Z"));

        Map<String, Object> view = SessionViews.toView(session, PRINCIPAL_ID);

        assertEquals(PRINCIPAL_ID.toString(), view.get("agentPrincipalId"),
                "PLAN-0689 A2c: the view renders the PRIMARY participant principal");
        assertEquals(Session.KIND_SPAWN, view.get("kind"));
        assertEquals(PARENT_ID, view.get("spawnedFromSessionId"));
        assertEquals(RUN_ID, view.get("spawnedFromRunId"));
        assertEquals("2026-11-05T03:00:00Z", view.get("spawnedAt"));
        assertEquals(false, view.get("archived"));
    }

    @Test
    void rootSessionStillEmitsLineageKeysAsNull() {
        Session session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn("workspace-1");
        when(session.isArchived()).thenReturn(false);

        Map<String, Object> view = SessionViews.toView(session, null);

        for (String field : new String[]{"kind", "spawnedFromSessionId", "spawnedFromRunId", "spawnedAt",
                "agentPrincipalId"}) {
            assertTrue(view.containsKey(field), "detail view must declare lineage key " + field);
            assertEquals(null, view.get(field), "root session lineage must be null: " + field);
        }
    }
}
