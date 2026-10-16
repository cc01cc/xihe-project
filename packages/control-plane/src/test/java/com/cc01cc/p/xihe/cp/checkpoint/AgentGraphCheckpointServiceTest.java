package com.cc01cc.p.xihe.cp.checkpoint;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.time.OffsetDateTime;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AgentGraphCheckpointServiceTest {

    @Mock private JdbcTemplate jdbc;
    @Mock private SessionRepository sessions;
    @Mock private BranchPathService branchPathService;
    @Mock private ContextService contextService;

    @Test
    void createLineageBindsOnlyTheVerifiedActiveSessionOwner() {
        UUID sessionId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID branchId = UUID.randomUUID();
        UUID probeId = UUID.randomUUID();
        Session session = new Session(workspaceId.toString(), userId.toString(), "probe");
        session.setId(sessionId);
        when(sessions.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                sessionId, userId.toString(), workspaceId.toString())).thenReturn(Optional.of(session));
        when(branchPathService.ensureRootBranchId(sessionId.toString())).thenReturn(branchId.toString());
        when(jdbc.queryForObject(anyString(), eq(Integer.class), any(Object[].class))).thenReturn(1);
        when(jdbc.queryForObject(anyString(), eq(OffsetDateTime.class), any(UUID.class)))
                .thenReturn(OffsetDateTime.parse("2026-10-14T00:00:00Z"));
        when(jdbc.update(anyString(), any(Object[].class))).thenReturn(1);

        AgentGraphCheckpointService service = new AgentGraphCheckpointService(
                jdbc, sessions, new ObjectMapper(), branchPathService, contextService);
        ReflectionTestUtils.setField(service, "checkpointProbeFlag", "1");
        AgentGraphCheckpointService.LineageView result = service.createLineage(
                new AgentGraphCheckpointService.LineageRequest(
                        sessionId.toString(), userId.toString(), workspaceId.toString(),
                        null, probeId.toString(), "0.1.0"));

        assertEquals(sessionId.toString(), result.sessionId());
        assertEquals(branchId.toString(), result.branchId());
        assertEquals(probeId.toString(), result.probeId());
        assertEquals(userId.toString(), result.userId());
        assertEquals(workspaceId.toString(), result.workspaceId());
        assertEquals("0.1.0", result.producerVersion());
        assertEquals(1, result.schemaVersion());
        verify(jdbc).update(anyString(), any(Object[].class));
    }

    @Test
    void createLineageFailsClosedForWrongSessionOwner() {
        UUID sessionId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        when(sessions.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                sessionId, userId.toString(), workspaceId.toString())).thenReturn(Optional.empty());

        AgentGraphCheckpointService service = new AgentGraphCheckpointService(
                jdbc, sessions, new ObjectMapper(), branchPathService, contextService);
        assertThrows(CpApiException.class, () -> service.createLineage(
                new AgentGraphCheckpointService.LineageRequest(
                        sessionId.toString(), userId.toString(), workspaceId.toString(),
                        null, null, "0.1.0")));
        verify(jdbc, never()).update(anyString(), any(Object[].class));
    }

    @Test
    void getLineageRejectsAThreadFromASiblingBranchOfTheSameSession() {
        UUID sessionId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID sourceRunId = UUID.randomUUID();
        UUID lineageBranchId = UUID.randomUUID();
        UUID currentRunBranchId = UUID.randomUUID();
        UUID lineageId = UUID.randomUUID();
        UUID threadId = UUID.randomUUID();
        Session session = new Session(workspaceId.toString(), userId.toString(), "probe");
        session.setId(sessionId);
        when(sessions.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                sessionId, userId.toString(), workspaceId.toString())).thenReturn(Optional.of(session));
        when(jdbc.queryForObject(anyString(), eq(Integer.class), any(Object[].class))).thenReturn(1);
        when(jdbc.query(anyString(), any(RowMapper.class), any(Object[].class)))
                .thenReturn(List.of(new AgentGraphCheckpointService.Scope(
                        lineageId, threadId, sessionId, userId, workspaceId, lineageBranchId, sourceRunId, null,
                        1, "2026-10-14T00:00:00Z", "0.1.0")))
                .thenReturn(List.of(currentRunBranchId));

        AgentGraphCheckpointService service = new AgentGraphCheckpointService(
                jdbc, sessions, new ObjectMapper(), branchPathService, contextService);
        assertThrows(CpApiException.class, () -> service.getLineage(
                threadId.toString(), new AgentGraphCheckpointService.LineageLookupRequest(
                        sessionId.toString(), userId.toString(), workspaceId.toString(), sourceRunId.toString(), null)));
    }

    @Test
    void createLineageRereadsTheWinnerAfterConcurrentUniqueKeyConflict() {
        UUID sessionId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID branchId = UUID.randomUUID();
        UUID lineageId = UUID.randomUUID();
        UUID threadId = UUID.randomUUID();
        UUID probeId = UUID.randomUUID();
        Session session = new Session(workspaceId.toString(), userId.toString(), "probe");
        session.setId(sessionId);
        when(sessions.findByIdAndUserIdAndWorkspaceIdAndArchivedFalse(
                sessionId, userId.toString(), workspaceId.toString())).thenReturn(Optional.of(session));
        when(branchPathService.ensureRootBranchId(sessionId.toString())).thenReturn(branchId.toString());
        when(jdbc.queryForObject(anyString(), eq(Integer.class), any(Object[].class))).thenReturn(1);
        AgentGraphCheckpointService.LineageView winner = new AgentGraphCheckpointService.LineageView(
                lineageId.toString(), threadId.toString(), sessionId.toString(), null,
                probeId.toString(), branchId.toString(),
                userId.toString(), workspaceId.toString(), 1, "2026-10-14T00:00:00Z", "0.1.0");
        when(jdbc.query(anyString(), any(RowMapper.class), any(Object[].class)))
                .thenReturn(List.of(), List.of(winner));
        when(jdbc.update(anyString(), any(Object[].class))).thenReturn(0);

        AgentGraphCheckpointService service = new AgentGraphCheckpointService(
                jdbc, sessions, new ObjectMapper(), branchPathService, contextService);
        ReflectionTestUtils.setField(service, "checkpointProbeFlag", "1");
        AgentGraphCheckpointService.LineageView result = service.createLineage(
                new AgentGraphCheckpointService.LineageRequest(
                        sessionId.toString(), userId.toString(), workspaceId.toString(),
                        null, probeId.toString(), "0.1.0"));

        assertEquals(threadId.toString(), result.threadId());
        assertEquals(lineageId.toString(), result.lineageId());
        verify(jdbc, times(1)).update(anyString(), any(Object[].class));
    }

    @Test
    void metadataAndNamespaceRespectTheSaverAllowlistAndDefault() {
        assertEquals("", AgentGraphCheckpointService.checkpointNamespace(""));
        assertEquals(Map.of("source", "fork", "step", 3L),
                AgentGraphCheckpointService.normalizeMetadata(Map.of(
                        "source", "fork", "step", 3, "writes", Map.of("content", "secret"))));
    }

    @Test
    void checkpointListingBindsOnlyPresentFiltersAndKeepsLatestFirstContract() {
        AgentGraphCheckpointService service = new AgentGraphCheckpointService(
                jdbc, sessions, new ObjectMapper(), branchPathService, contextService);
        UUID lineageId = UUID.randomUUID();
        UUID threadId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID branchId = UUID.randomUUID();
        AgentGraphCheckpointService.Scope scope = new AgentGraphCheckpointService.Scope(
                lineageId, threadId, sessionId, userId, workspaceId, branchId, null, null,
                1, "2026-10-14T00:00:00Z", "0.1.0");
        List<AgentGraphCheckpointService.CheckpointRow> latestFirst = List.of(
                new AgentGraphCheckpointService.CheckpointRow(
                        lineageId, threadId, "", "0002", "0001", "json", new byte[]{2}, "{}",
                        "2026-10-14T00:00:02Z"),
                new AgentGraphCheckpointService.CheckpointRow(
                        lineageId, threadId, "", "0001", null, "json", new byte[]{1}, "{}",
                        "2026-10-14T00:00:01Z"));
        when(jdbc.query(anyString(), any(RowMapper.class), any(Object[].class))).thenReturn(latestFirst);

        List<AgentGraphCheckpointService.CheckpointRow> result =
                service.listRows(scope, "", "0003", 10, "fork", 4);

        ArgumentCaptor<String> sql = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<Object[]> bindArgs = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).query(sql.capture(), any(RowMapper.class), bindArgs.capture());
        assertEquals(List.of("0002", "0001"), result.stream()
                .map(AgentGraphCheckpointService.CheckpointRow::checkpointId).toList());
        assertEquals(true, sql.getValue().contains("(c.created_at, c.checkpoint_id) <"));
        assertEquals(true, sql.getValue().contains("cursor.checkpoint_id = ?"));
        assertEquals(true, sql.getValue().contains("c.metadata->>'source' = ?"));
        assertEquals(true, sql.getValue().contains("(c.metadata->>'step')::bigint = ?"));
        assertEquals(true, sql.getValue().contains("ORDER BY c.created_at DESC, c.checkpoint_id DESC LIMIT ?"));
        assertArrayEquals(new Object[]{lineageId, threadId, "", "0003", "fork", 4, 10}, bindArgs.getValue());
    }
}
