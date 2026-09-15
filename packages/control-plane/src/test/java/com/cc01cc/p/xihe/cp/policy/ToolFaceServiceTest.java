package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ToolFaceEntity;
import com.cc01cc.p.xihe.cp.repository.ToolFaceRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/** PLAN-0328 M1 batch 4: tool face classification guardrails and upsert semantics. */
class ToolFaceServiceTest {

    private final ToolFaceRepository repository = mock(ToolFaceRepository.class);
    private final AuditLogger audit = mock(AuditLogger.class);
    private final ToolFaceService service = new ToolFaceService(repository, new PolicyVersion(), audit);

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void listIncludesBuiltinsWithCatalogMetadataAndOmitsUnknownTools() {
        when(repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenReturn(List.of());

        List<ToolFaceService.FaceView> views = service.list("instance", "u1", "ws1", false);

        ToolFaceService.FaceView readFile = views.stream()
                .filter(view -> "read_file".equals(view.tool())).findFirst().orElseThrow();
        assertNull(readFile.id());
        assertEquals("builtin", readFile.scope());
        assertNull(readFile.ownerId());
        assertEquals("read", readFile.actionClass());
        assertEquals("structured", readFile.shape());
        assertFalse(views.stream().anyMatch(view -> "third_party_tool".equals(view.tool())));
        assertEquals(views.stream().map(ToolFaceService.FaceView::tool).sorted().toList(),
                views.stream().map(ToolFaceService.FaceView::tool).toList());
    }

    @Test
    void listWorkspaceUsesWorkspaceFaceOverInstanceFaceAndBuiltin() {
        ToolFaceEntity instance = new ToolFaceEntity(UUID.randomUUID(), "instance", null,
                "read_file", "instance-read", "opaque", "admin");
        ToolFaceEntity workspace = new ToolFaceEntity(UUID.randomUUID(), "workspace", "ws1",
                "read_file", "workspace-read", "interpreter", "owner");
        when(repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance"))
                .thenReturn(List.of(instance));
        when(repository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1"))
                .thenReturn(List.of(workspace));

        List<ToolFaceService.FaceView> views = service.list("workspace", "u1", "ws1", false);

        ToolFaceService.FaceView readFile = views.stream()
                .filter(view -> "read_file".equals(view.tool())).findFirst().orElseThrow();
        assertEquals(workspace.getId(), readFile.id());
        assertEquals("workspace", readFile.scope());
        assertEquals("ws1", readFile.ownerId());
        assertEquals("workspace-read", readFile.actionClass());
        assertEquals("interpreter", readFile.shape());
    }

    @Test
    void instanceScopeRequiresAdmin() {
        assertThrows(CpApiException.class, () -> service.upsert("instance", "u1", "ws1", false,
                new ToolFaceService.FaceInput("mcp__acme__deploy", "exec", "interpreter")));
    }

    @Test
    void workspaceScopeRequiresWorkspaceContext() {
        assertThrows(CpApiException.class, () -> service.upsert("workspace", "u1", null, false,
                new ToolFaceService.FaceInput("mcp__acme__deploy", "exec", "interpreter")));
    }

    @Test
    void rejectsUnknownScopeAndShape() {
        TenantContext.setWorkspaceRole("OWNER");
        assertThrows(CpApiException.class, () -> service.upsert("galaxy", "u1", "ws1", false,
                new ToolFaceService.FaceInput("t", "exec", "interpreter")));
        assertThrows(CpApiException.class, () -> service.upsert("workspace", "u1", "ws1", false,
                new ToolFaceService.FaceInput("t", "exec", "telepathic")));
    }

    @Test
    void workspaceScopeRequiresWorkspaceAdministrator() {
        TenantContext.setWorkspaceRole("MEMBER");
        CpApiException error = assertThrows(CpApiException.class, () -> service.upsert("workspace", "u1", "ws1", false,
                new ToolFaceService.FaceInput("mcp__acme__deploy", "exec", "interpreter")));
        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
    }

    @Test
    void workspaceScopeCannotOverrideBuiltinToolFace() {
        TenantContext.setWorkspaceRole("OWNER");
        CpApiException error = assertThrows(CpApiException.class, () -> service.upsert("workspace", "u1", "ws1", false,
                new ToolFaceService.FaceInput("execute_command", "read", "structured")));
        assertEquals(HttpStatus.FORBIDDEN, error.getStatus());
    }

    @Test
    void instanceAdminMayOverrideBuiltinToolFace() {
        TenantContext.setUserRole("ADMIN");
        when(repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());
        when(repository.save(any(ToolFaceEntity.class))).thenAnswer(inv -> inv.getArgument(0));

        ToolFaceService.FaceView view = service.upsert("instance", "admin", "ws1", true,
                new ToolFaceService.FaceInput("execute_command", "read", "structured"));

        assertEquals("read", view.actionClass());
        assertEquals("instance", view.scope());
    }

    @Test
    void upsertUpdatesExistingRowInsteadOfDuplicating() {
        TenantContext.setWorkspaceRole("OWNER");
        List<ToolFaceEntity> rows = new ArrayList<>();
        rows.add(new ToolFaceEntity(UUID.randomUUID(), "workspace", "ws1", "mcp__acme__deploy",
                "exec", "interpreter", "tester"));
        when(repository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1")).thenReturn(rows);
        when(repository.save(any(ToolFaceEntity.class))).thenAnswer(inv -> inv.getArgument(0));

        ToolFaceService.FaceView view = service.upsert("workspace", "u1", "ws1", false,
                new ToolFaceService.FaceInput("mcp__acme__deploy", "write", "structured"));

        assertEquals(1, rows.size(), "classification must update the existing row");
        assertEquals("write", view.actionClass());
        assertEquals("structured", view.shape());
        assertEquals("ws1", view.ownerId());
        verify(audit).record(null, "mcp__acme__deploy", "tool_face_classified",
                "update scope=workspace tool=mcp__acme__deploy"
                        + " actionClass=exec->write shape=interpreter->structured");
    }

    @Test
    void createsNewFaceWhenToolUnknown() {
        TenantContext.setWorkspaceRole("OWNER");
        when(repository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1")).thenReturn(List.of());
        when(repository.save(any(ToolFaceEntity.class))).thenAnswer(inv -> inv.getArgument(0));

        ToolFaceService.FaceView view = service.upsert("workspace", "u1", "ws1", false,
                new ToolFaceService.FaceInput("mcp__new__tool", "network", "opaque"));

        assertEquals("mcp__new__tool", view.tool());
        assertEquals("network", view.actionClass());
        verify(audit).record(null, "mcp__new__tool", "tool_face_classified",
                "create scope=workspace tool=mcp__new__tool actionClass=network shape=opaque");
    }

    @Test
    void classificationAuditCarriesOnlyBoundedSafeFields() {
        TenantContext.setWorkspaceRole("OWNER");
        when(repository.findByScopeAndOwnerIdOrderByCreatedAtAscIdAsc("workspace", "ws1")).thenReturn(List.of());
        when(repository.save(any(ToolFaceEntity.class))).thenAnswer(inv -> inv.getArgument(0));

        service.upsert("workspace", "u1", "ws1", false,
                new ToolFaceService.FaceInput("mcp__acme__deploy", "network", "opaque"));

        verify(audit).record(null, "mcp__acme__deploy", "tool_face_classified",
                "create scope=workspace tool=mcp__acme__deploy actionClass=network shape=opaque");
        verifyNoMoreInteractions(audit);
    }

    @Test
    void instanceAdminAuditRecordsInstanceScope() {
        TenantContext.setUserRole("ADMIN");
        when(repository.findByScopeAndOwnerIdIsNullOrderByCreatedAtAscIdAsc("instance")).thenReturn(List.of());
        when(repository.save(any(ToolFaceEntity.class))).thenAnswer(inv -> inv.getArgument(0));

        service.upsert("instance", "admin", "ws1", true,
                new ToolFaceService.FaceInput("execute_command", "read", "structured"));

        verify(audit).record(null, "execute_command", "tool_face_classified",
                "create scope=instance tool=execute_command actionClass=read shape=structured");
    }
}
