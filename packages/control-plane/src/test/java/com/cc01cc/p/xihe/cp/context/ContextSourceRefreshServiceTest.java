package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService;
import com.cc01cc.p.xihe.cp.context.repository.ContextSourceHashRepository;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/** PLAN-0340: per-session first inject + replace semantics (workspace hash must not suppress). */
class ContextSourceRefreshServiceTest extends AbstractH2Test {

    @Autowired
    private ContextSourceRefreshService refreshService;

    @Autowired
    private EventStoreService eventStoreService;

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

    @Test
    void refreshAgentsMdExistsEmitsSourceChangedEvent() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.of("You are a helpful assistant."));

        String status = refreshService.refresh(sessionId, ws.getId().toString(), userId);

        assertThat(status).isEqualTo(ContextSourceRefreshService.STATUS_CREATED);
        assertThat(eventStoreService.read(sessionId, 0L))
                .singleElement()
                .satisfies(event -> assertThat(event.getEventType()).isEqualTo("context.source_changed"));
    }

    @Test
    void refreshAgentsMdMissingReturnsEmptyStatusWithoutEventWhenNeverHadSource() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.empty());

        String status = refreshService.refresh(sessionId, ws.getId().toString(), userId);

        assertThat(status).isEqualTo(ContextSourceRefreshService.STATUS_UNCHANGED);
        assertThat(eventStoreService.read(sessionId, 0L)).isEmpty();
    }

    @Test
    void secondSessionWithSameContentStillGetsFirstInject() {
        String userId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.of("You are a helpful assistant."));

        String firstSessionId = UUID.randomUUID().toString();
        String first = refreshService.refresh(firstSessionId, ws.getId().toString(), userId);
        assertThat(first).isEqualTo(ContextSourceRefreshService.STATUS_CREATED);

        String secondSessionId = UUID.randomUUID().toString();
        String second = refreshService.refresh(secondSessionId, ws.getId().toString(), userId);
        // Workspace hash matches, but session L1 is empty → must inject (I1).
        // Status is updated (workspace row exists); created is also acceptable if row was cleared.
        assertThat(second).isIn(ContextSourceRefreshService.STATUS_CREATED, ContextSourceRefreshService.STATUS_UPDATED);
        assertThat(eventStoreService.read(secondSessionId, 0L))
                .singleElement()
                .satisfies(event -> assertThat(event.getEventType()).isEqualTo("context.source_changed"));
    }

    @Test
    void sameSessionUnchangedDoesNotDuplicateEvent() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.of("You are a helpful assistant."));

        String first = refreshService.refresh(sessionId, ws.getId().toString(), userId);
        assertThat(first).isEqualTo(ContextSourceRefreshService.STATUS_CREATED);
        long afterFirst = eventStoreService.read(sessionId, 0L).size();

        String second = refreshService.refresh(sessionId, ws.getId().toString(), userId);
        assertThat(second).isEqualTo(ContextSourceRefreshService.STATUS_UNCHANGED);
        assertThat(eventStoreService.read(sessionId, 0L)).hasSize((int) afterFirst);
    }

    @Test
    void changedContentEmitsUpdated() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.of("You are a helpful assistant."));
        refreshService.refresh(sessionId, ws.getId().toString(), userId);

        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.of("You are a coding assistant."));
        String status = refreshService.refresh(sessionId, ws.getId().toString(), userId);

        assertThat(status).isEqualTo(ContextSourceRefreshService.STATUS_UPDATED);
    }
}
