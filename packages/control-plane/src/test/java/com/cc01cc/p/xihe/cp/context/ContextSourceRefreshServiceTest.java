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
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

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
        workspaceUserRepository.save(new WorkspaceUser(ws.getId(), userId, WorkspaceRole.OWNER));
        return ws;
    }

    @Test
    void refreshAgentsMdExistsEmitsSourceChangedEvent() throws Exception {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.of("You are a helpful assistant."));

        Optional<String> hash = refreshService.refresh(sessionId, ws.getId(), userId);

        assertThat(hash).isPresent();
        assertThat(eventStoreService.read(sessionId, 0L))
                .singleElement()
                .satisfies(event -> assertThat(event.getEventType()).isEqualTo("context.source_changed"));
    }

    @Test
    void refreshAgentsMdMissingReturnsEmpty() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.empty());

        Optional<String> hash = refreshService.refresh(sessionId, ws.getId(), userId);

        assertThat(hash).isEmpty();
        assertThat(eventStoreService.read(sessionId, 0L)).isEmpty();
    }

    @Test
    void refreshAgentsMdUnchangedDoesNotEmitDuplicateEvent() {
        String userId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.of("You are a helpful assistant."));

        String firstSessionId = UUID.randomUUID().toString();
        Optional<String> firstHash = refreshService.refresh(firstSessionId, ws.getId(), userId);
        assertThat(firstHash).isPresent();
        assertThat(eventStoreService.read(firstSessionId, 0L))
                .singleElement()
                .satisfies(event -> assertThat(event.getEventType()).isEqualTo("context.source_changed"));

        String secondSessionId = UUID.randomUUID().toString();
        Optional<String> secondHash = refreshService.refresh(secondSessionId, ws.getId(), userId);
        assertThat(secondHash).isPresent().isEqualTo(firstHash);
        assertThat(eventStoreService.read(secondSessionId, 0L)).isEmpty();
        assertThat(sourceHashRepository.findByWorkspaceIdAndSourceKey(ws.getId(), "AGENTS.md"))
                .isPresent()
                .hasValueSatisfying(record -> assertThat(record.getHash()).isEqualTo(firstHash.get()));
    }

    @Test
    void refreshAgentsMdChangedEmitsNewEventAndUpdatesHash() {
        String userId = UUID.randomUUID().toString();
        Workspace ws = createWorkspace(userId);
        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.of("You are a helpful assistant."));

        String firstSessionId = UUID.randomUUID().toString();
        Optional<String> firstHash = refreshService.refresh(firstSessionId, ws.getId(), userId);
        assertThat(firstHash).isPresent();

        when(runtimeContextSourceClient.readAgents(anyString()))
                .thenReturn(Optional.of("You are a coding assistant."));
        String secondSessionId = UUID.randomUUID().toString();
        Optional<String> secondHash = refreshService.refresh(secondSessionId, ws.getId(), userId);
        assertThat(secondHash).isPresent().isNotEqualTo(firstHash);
        assertThat(eventStoreService.read(secondSessionId, 0L))
                .singleElement()
                .satisfies(event -> assertThat(event.getEventType()).isEqualTo("context.source_changed"));
        assertThat(sourceHashRepository.findByWorkspaceIdAndSourceKey(ws.getId(), "AGENTS.md"))
                .isPresent()
                .hasValueSatisfying(record -> assertThat(record.getHash()).isEqualTo(secondHash.get()));
    }
}
