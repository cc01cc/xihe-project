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
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

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

    @TempDir
    Path tempDir;

    @Test
    void refreshAgentsMdExistsEmitsSourceChangedEvent() throws Exception {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();

        Workspace ws = new Workspace("test-ws", userId);
        ws.setStoragePath(tempDir.toString());
        ws = workspaceRepository.save(ws);
        String workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        Files.writeString(tempDir.resolve("AGENTS.md"), "You are a helpful assistant.");

        Optional<String> hash = refreshService.refresh(sessionId, workspaceId, userId);

        assertThat(hash).isPresent();
        assertThat(eventStoreService.read(sessionId, 0L))
                .singleElement()
                .satisfies(event -> assertThat(event.getEventType()).isEqualTo("context.source_changed"));
    }

    @Test
    void refreshAgentsMdMissingReturnsEmpty() {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();

        Workspace ws = new Workspace("test-ws", userId);
        ws.setStoragePath(tempDir.toString());
        ws = workspaceRepository.save(ws);
        String workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        Optional<String> hash = refreshService.refresh(sessionId, workspaceId, userId);

        assertThat(hash).isEmpty();
        assertThat(eventStoreService.read(sessionId, 0L)).isEmpty();
    }

    @Test
    void refreshAgentsMdUnchangedDoesNotEmitDuplicateEvent() throws Exception {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();

        Workspace ws = new Workspace("test-ws", userId);
        ws.setStoragePath(tempDir.toString());
        ws = workspaceRepository.save(ws);
        String workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        Files.writeString(tempDir.resolve("AGENTS.md"), "You are a helpful assistant.");

        Optional<String> firstHash = refreshService.refresh(sessionId, workspaceId, userId);
        assertThat(firstHash).isPresent();
        assertThat(eventStoreService.read(sessionId, 0L))
                .singleElement()
                .satisfies(event -> assertThat(event.getEventType()).isEqualTo("context.source_changed"));

        String secondSessionId = UUID.randomUUID().toString();
        Optional<String> secondHash = refreshService.refresh(secondSessionId, workspaceId, userId);
        assertThat(secondHash).isPresent().isEqualTo(firstHash);
        assertThat(eventStoreService.read(secondSessionId, 0L)).isEmpty();
        assertThat(sourceHashRepository.findByWorkspaceIdAndSourceKey(workspaceId, "AGENTS.md"))
                .isPresent()
                .hasValueSatisfying(record -> assertThat(record.getHash()).isEqualTo(firstHash.get()));
    }

    @Test
    void refreshAgentsMdChangedEmitsNewEventAndUpdatesHash() throws Exception {
        String userId = UUID.randomUUID().toString();
        String sessionId = UUID.randomUUID().toString();

        Workspace ws = new Workspace("test-ws", userId);
        ws.setStoragePath(tempDir.toString());
        ws = workspaceRepository.save(ws);
        String workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        Files.writeString(tempDir.resolve("AGENTS.md"), "You are a helpful assistant.");
        Optional<String> firstHash = refreshService.refresh(sessionId, workspaceId, userId);
        assertThat(firstHash).isPresent();

        Files.writeString(tempDir.resolve("AGENTS.md"), "You are a coding assistant.");
        String secondSessionId = UUID.randomUUID().toString();
        Optional<String> secondHash = refreshService.refresh(secondSessionId, workspaceId, userId);
        assertThat(secondHash).isPresent().isNotEqualTo(firstHash);
        assertThat(eventStoreService.read(secondSessionId, 0L))
                .singleElement()
                .satisfies(event -> assertThat(event.getEventType()).isEqualTo("context.source_changed"));
        assertThat(sourceHashRepository.findByWorkspaceIdAndSourceKey(workspaceId, "AGENTS.md"))
                .isPresent()
                .hasValueSatisfying(record -> assertThat(record.getHash()).isEqualTo(secondHash.get()));
    }
}
