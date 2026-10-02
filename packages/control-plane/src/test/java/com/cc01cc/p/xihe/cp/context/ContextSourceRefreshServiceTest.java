package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService;
import com.cc01cc.p.xihe.cp.context.repository.ContextSourceHashRepository;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient.SourceRead;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * PLAN-0340: per-session first inject + replace semantics (workspace hash must not suppress).
 *
 * <p>PLAN-0382: readAgents is three-state (content/absent/error); projections
 * assert the frozen {@code l1_status} enum end-to-end, env facts emit with
 * {@code env_status}, and failure states are fail-closed with explicit marks.
 */
class ContextSourceRefreshServiceTest extends AbstractH2Test {

    @Autowired
    private ContextSourceRefreshService refreshService;

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private ContextProjectionService projectionService;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private ContextSourceHashRepository sourceHashRepository;

    @MockitoBean
    private RuntimeContextSourceClient runtimeContextSourceClient;

    private Workspace createWorkspace(String userId) {
        Workspace ws = new Workspace("test-ws", userId);
        ws = workspaceRepository.save(ws);
        workspaceUserRepository.save(new WorkspaceUser(ws.getId().toString(), userId, WorkspaceRole.OWNER));
        return ws;
    }

    /** PLAN-0382 upgraded git-facts response (has observedAt → env_status computable). */
    private void stubFacts(boolean repository) {
        when(runtimeContextSourceClient.readGitFacts(anyString())).thenReturn(Optional.of(Map.of(
                "isRepository", repository,
                "observedAt", "2026-10-01T00:00:00Z",
                "cwd", "/workspace",
                "platform", "linux",
                "shell", "xihe-shell")));
    }

    private List<String> sourceEventTypes(String sessionId) {
        return eventStoreService.read(sessionId, 0L).stream()
                .filter(e -> "context.source_changed".equals(e.getEventType()))
                .map(e -> e.getEventType())
                .toList();
    }

    private String projectedEpochText(String sessionId, String field) {
        ObjectNode context = projectionService.project(sessionId, 0L);
        ObjectNode epoch = (ObjectNode) context.get("epoch");
        if (epoch == null || !epoch.hasNonNull(field)) {
            return null;
        }
        return epoch.get(field).asText();
    }

    private long sourceEventCount(String sessionId) {
        return eventStoreService.read(sessionId, 0L).stream()
                .filter(e -> "context.source_changed".equals(e.getEventType()))
                .count();
    }

    @Test
    void refreshAgentsMdExistsEmitsSourceChangedEvent() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("You are a helpful assistant."));
        stubFacts(false);

        String status = refreshService.refresh(sessionId, ws.getId().toString(), userId);

        assertThat(status).isEqualTo(ContextSourceRefreshService.STATUS_CREATED);
        assertThat(sourceEventCount(sessionId)).isEqualTo(1);
        // PLAN-0382: content read projects l1_status=ok end-to-end.
        assertThat(projectedEpochText(sessionId, "l1_status")).isEqualTo("ok");
        // Env facts recorded with the frozen status enum (non-repo here).
        assertThat(projectedEpochText(sessionId, "env_status")).isEqualTo("not_repository");
        assertThat(projectedEpochText(sessionId, "env_platform")).isEqualTo("linux");
    }

    @Test
    void refreshAgentsAbsentFileEmitsMissingState() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.absent());
        stubFacts(false);

        String status = refreshService.refresh(sessionId, ws.getId().toString(), userId);

        // spec §3: found:false is a legal absence — recorded as missing, not an error.
        assertThat(status).isEqualTo(ContextSourceRefreshService.L1_MISSING);
        assertThat(sourceEventCount(sessionId)).isEqualTo(1);
        assertThat(projectedEpochText(sessionId, "l1_status")).isEqualTo("missing");
        assertThat(projectedEpochText(sessionId, "source_hash")).isEmpty();
    }

    @Test
    void absentTwiceDoesNotDuplicateMissingEvent() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.absent());
        stubFacts(false);

        refreshService.refresh(sessionId, ws.getId().toString(), userId);
        refreshService.refresh(sessionId, ws.getId().toString(), userId);

        // l1 double rule: (hash empty, status=missing) already projected → skip.
        assertThat(sourceEventCount(sessionId)).isEqualTo(1);
    }

    @Test
    void transportFailureEmitsUnavailableFailClosed() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("Injected rules."));
        stubFacts(false);
        refreshService.refresh(sessionId, ws.getId().toString(), userId);
        assertThat(projectedEpochText(sessionId, "l1_status")).isEqualTo("ok");

        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.error(null)); // transport
        String status = refreshService.refresh(sessionId, ws.getId().toString(), userId);

        // Q2=A fail-closed: slot emptied + explicit status, no stale L1.
        assertThat(status).isEqualTo(ContextSourceRefreshService.L1_UNAVAILABLE);
        assertThat(projectedEpochText(sessionId, "l1_status")).isEqualTo("unavailable");
        assertThat(projectedEpochText(sessionId, "source_hash")).isEmpty();
        assertThat(projectedEpochText(sessionId, "l1_rendered")).isEmpty();
    }

    @Test
    void http4xxFailureEmitsFailedStatus() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.error(404)); // 4xx → failed per wire table
        stubFacts(false);

        String status = refreshService.refresh(sessionId, ws.getId().toString(), userId);

        assertThat(status).isEqualTo(ContextSourceRefreshService.L1_FAILED);
        assertThat(projectedEpochText(sessionId, "l1_status")).isEqualTo("failed");
    }

    @Test
    void markSourceUnavailableClosesFailOpenBypass() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("Injected rules."));
        stubFacts(false);
        refreshService.refresh(sessionId, ws.getId().toString(), userId);

        // T0.5/B6: ChatController catch path records the failure state explicitly.
        refreshService.markSourceUnavailable(sessionId, ws.getId().toString(), userId);

        assertThat(projectedEpochText(sessionId, "l1_status")).isEqualTo("unavailable");
        assertThat(projectedEpochText(sessionId, "l1_rendered")).isEmpty();
    }

    @Test
    void secondSessionWithSameContentStillGetsFirstInject() {
        String userId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("You are a helpful assistant."));
        stubFacts(false);

        String firstSessionId = UUID.randomUUID().toString();
        String first = refreshService.refresh(firstSessionId, ws.getId().toString(), userId);
        assertThat(first).isEqualTo(ContextSourceRefreshService.STATUS_CREATED);

        String secondSessionId = UUID.randomUUID().toString();
        String second = refreshService.refresh(secondSessionId, ws.getId().toString(), userId);
        // Workspace hash matches, but session L1 is empty → must inject (I1).
        assertThat(second).isIn(ContextSourceRefreshService.STATUS_CREATED, ContextSourceRefreshService.STATUS_UPDATED);
        assertThat(sourceEventCount(secondSessionId)).isEqualTo(1);
    }

    @Test
    void sameSessionUnchangedDoesNotDuplicateEvent() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("You are a helpful assistant."));
        stubFacts(false);

        String first = refreshService.refresh(sessionId, ws.getId().toString(), userId);
        assertThat(first).isEqualTo(ContextSourceRefreshService.STATUS_CREATED);
        long afterFirst = sourceEventCount(sessionId);

        String second = refreshService.refresh(sessionId, ws.getId().toString(), userId);
        assertThat(second).isEqualTo(ContextSourceRefreshService.STATUS_UNCHANGED);
        assertThat(sourceEventCount(sessionId)).isEqualTo(afterFirst);
    }

    @Test
    void changedContentEmitsUpdated() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("You are a helpful assistant."));
        stubFacts(false);
        refreshService.refresh(sessionId, ws.getId().toString(), userId);

        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("You are a coding assistant."));
        String status = refreshService.refresh(sessionId, ws.getId().toString(), userId);

        assertThat(status).isEqualTo(ContextSourceRefreshService.STATUS_UPDATED);
    }

    @Test
    void repeatedFactsDoNotDuplicateEnvEvent() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("Rules."));
        stubFacts(false);

        refreshService.refresh(sessionId, ws.getId().toString(), userId);
        long envEvents = eventStoreService.read(sessionId, 0L).stream()
                .filter(e -> "context.env_updated".equals(e.getEventType()))
                .count();
        assertThat(envEvents).isEqualTo(1);

        refreshService.refresh(sessionId, ws.getId().toString(), userId);
        long envAfterSecond = eventStoreService.read(sessionId, 0L).stream()
                .filter(e -> "context.env_updated".equals(e.getEventType()))
                .count();
        // idempotency double rule: identical value-set + status → no second event.
        assertThat(envAfterSecond).isEqualTo(envEvents);
    }

    @Test
    void envRecoversToOkAfterRuntimeReturns() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("Rules."));
        stubFacts(true);
        refreshService.refresh(sessionId, ws.getId().toString(), userId);
        assertThat(projectedEpochText(sessionId, "env_status")).isEqualTo("ok");

        when(runtimeContextSourceClient.readGitFacts(anyString())).thenReturn(Optional.empty());
        refreshService.refresh(sessionId, ws.getId().toString(), userId);
        assertThat(projectedEpochText(sessionId, "env_status")).isEqualTo("unavailable");

        // T3.4: Runtime comes back → status recovers (idempotent flip-back).
        stubFacts(true);
        refreshService.refresh(sessionId, ws.getId().toString(), userId);
        assertThat(projectedEpochText(sessionId, "env_status")).isEqualTo("ok");
    }

    @Test
    void projectionRebuildIsDeterministic() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("Rules."));
        stubFacts(false);
        refreshService.refresh(sessionId, ws.getId().toString(), userId);

        // T3.4: projection rebuild (event replay) is deterministic for the
        // epoch/env/source state — metadata.updated_at is a per-call clock
        // (pre-existing design), so compare the epoch subtree only.
        String first = projectionService.project(sessionId, 0L).get("epoch").toString();
        String second = projectionService.project(sessionId, 0L).get("epoch").toString();
        assertThat(second).isEqualTo(first);
    }

    @Test
    void runtimeUnreachableKeepsLastKnownGoodEnvAndFlipsStatus() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(SourceRead.content("Rules."));
        stubFacts(true);
        refreshService.refresh(sessionId, ws.getId().toString(), userId);
        assertThat(projectedEpochText(sessionId, "env_status")).isEqualTo("ok");
        String lkgBranch = projectedEpochText(sessionId, "env_branch");

        // Runtime unreachable on the next refresh: values preserved, status flips.
        when(runtimeContextSourceClient.readGitFacts(anyString())).thenReturn(Optional.empty());
        refreshService.refresh(sessionId, ws.getId().toString(), userId);

        assertThat(projectedEpochText(sessionId, "env_status")).isEqualTo("unavailable");
        assertThat(projectedEpochText(sessionId, "env_branch")).isEqualTo(lkgBranch);
        assertThat(projectedEpochText(sessionId, "env_platform")).isEqualTo("linux");
    }
}
