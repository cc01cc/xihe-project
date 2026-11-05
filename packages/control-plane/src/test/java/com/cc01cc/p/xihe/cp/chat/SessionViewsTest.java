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
        when(session.getAgentPrincipalId()).thenReturn(PRINCIPAL_ID.toString());
        when(session.getTitle()).thenReturn("child");
        when(session.isArchived()).thenReturn(false);
        when(session.getKind()).thenReturn(Session.KIND_SPAWN);
        when(session.getSpawnedFromSessionId()).thenReturn(PARENT_ID);
        when(session.getSpawnedFromRunId()).thenReturn(RUN_ID);
        when(session.getSpawnedAt()).thenReturn(Instant.parse("2026-11-05T03:00:00Z"));

        Map<String, Object> view = SessionViews.toView(session);

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

        Map<String, Object> view = SessionViews.toView(session);

        for (String field : new String[]{"kind", "spawnedFromSessionId", "spawnedFromRunId", "spawnedAt"}) {
            assertTrue(view.containsKey(field), "detail view must declare lineage key " + field);
            assertEquals(null, view.get(field), "root session lineage must be null: " + field);
        }
    }
}
