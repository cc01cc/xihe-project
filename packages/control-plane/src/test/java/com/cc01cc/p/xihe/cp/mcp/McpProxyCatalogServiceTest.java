package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class McpProxyCatalogServiceTest {

    @Test
    void registersOAuthRemoteWithTheFixedServerId() {
        McpStdioServerRepository stdio = mock(McpStdioServerRepository.class);
        McpServerRepository remote = mock(McpServerRepository.class);
        McpToolAliasRepository aliases = mock(McpToolAliasRepository.class);
        when(remote.save(any(McpServer.class))).thenAnswer(invocation -> invocation.getArgument(0));
        McpProxyCatalogService service = new McpProxyCatalogService(stdio, remote, aliases);
        String serverId = UUID.randomUUID().toString();

        service.registerOrValidateRemoteServer("workspace-1", serverId, "https://mcp.example/rpc");

        org.mockito.ArgumentCaptor<McpServer> saved = org.mockito.ArgumentCaptor.forClass(McpServer.class);
        org.mockito.Mockito.verify(remote).save(saved.capture());
        assertEquals(UUID.fromString(serverId), saved.getValue().getId());
        assertEquals("workspace-1", saved.getValue().getWorkspaceId());
        assertEquals(serverId, saved.getValue().getName());
        assertEquals("https://mcp.example/rpc", saved.getValue().getEndpoint());
        assertTrue(saved.getValue().isEnabled());
    }

    @Test
    void updatesOnlyAnEnabledServerOwnedByTheWorkspace() {
        McpStdioServerRepository stdio = mock(McpStdioServerRepository.class);
        McpServerRepository remote = mock(McpServerRepository.class);
        McpToolAliasRepository aliases = mock(McpToolAliasRepository.class);
        McpProxyCatalogService service = new McpProxyCatalogService(stdio, remote, aliases);
        UUID serverId = UUID.randomUUID();
        String rawId = serverId.toString();
        McpServer server = new McpServer("workspace-1", rawId, "https://old.example/rpc");
        server.setId(serverId);
        server.setEnabled(true);
        when(remote.findById(serverId)).thenReturn(Optional.of(server));
        when(remote.save(any(McpServer.class))).thenAnswer(invocation -> invocation.getArgument(0));

        assertTrue(service.isWorkspaceEnabledServer("workspace-1", rawId));
        assertFalse(service.isWorkspaceEnabledServer("workspace-2", rawId));
        service.registerOrValidateRemoteServer("workspace-1", rawId, "https://new.example/rpc");

        assertEquals("https://new.example/rpc", server.getEndpoint());
    }

    @Test
    void rejectsForeignOrDisabledExistingServersWithLegacyCodes() {
        McpStdioServerRepository stdio = mock(McpStdioServerRepository.class);
        McpServerRepository remote = mock(McpServerRepository.class);
        McpToolAliasRepository aliases = mock(McpToolAliasRepository.class);
        McpProxyCatalogService service = new McpProxyCatalogService(stdio, remote, aliases);
        UUID serverId = UUID.randomUUID();
        String rawId = serverId.toString();
        McpServer foreign = new McpServer("workspace-2", rawId, "https://mcp.example/rpc");
        foreign.setId(serverId);
        foreign.setEnabled(true);
        when(remote.findById(serverId)).thenReturn(Optional.of(foreign));
        IllegalArgumentException foreignError = assertThrows(IllegalArgumentException.class,
                () -> service.registerOrValidateRemoteServer("workspace-1", rawId, "https://new.example/rpc"));
        assertEquals("mcp_server_forbidden", foreignError.getMessage());

        foreign.setWorkspaceId("workspace-1");
        foreign.setEnabled(false);
        IllegalArgumentException disabledError = assertThrows(IllegalArgumentException.class,
                () -> service.registerOrValidateRemoteServer("workspace-1", rawId, "https://new.example/rpc"));
        assertEquals("mcp_server_disabled", disabledError.getMessage());
    }
}
