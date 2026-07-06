package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService;
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

    @TempDir
    Path tempDir;

    @Test
    void refresh_agentsMdExists_emitsSourceChangedEvent() throws Exception {
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
    void refresh_agentsMdMissing_returnsEmpty() {
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
}
