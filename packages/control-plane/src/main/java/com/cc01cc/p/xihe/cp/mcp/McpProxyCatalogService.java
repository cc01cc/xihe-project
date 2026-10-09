package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.entity.McpToolAlias;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** MCP-owned persistence operations for proxy server and sticky-alias metadata. */
@Service
public class McpProxyCatalogService {

    private final McpStdioServerRepository stdioServers;
    private final McpServerRepository remoteServers;
    private final McpToolAliasRepository aliases;

    public McpProxyCatalogService(McpStdioServerRepository stdioServers,
                                  McpServerRepository remoteServers,
                                  McpToolAliasRepository aliases) {
        this.stdioServers = stdioServers;
        this.remoteServers = remoteServers;
        this.aliases = aliases;
    }

    public List<StdioServerView> listStdioServers(String workspaceId) {
        return stdioServers.findByWorkspaceIdOrderByNameAsc(workspaceId).stream()
                .map(server -> new StdioServerView(server.getName(), server.isEnabled()))
                .toList();
    }

    public List<RemoteServerView> listEnabledRemoteServers(String workspaceId) {
        return remoteServers.findByWorkspaceIdAndEnabledTrue(workspaceId).stream()
                .map(McpProxyCatalogService::toRemoteServerView)
                .toList();
    }

    public Optional<RemoteServerView> findEnabledRemoteServer(String workspaceId, String serverId) {
        return remoteServers.findById(UUID.fromString(serverId))
                .filter(server -> workspaceId.equals(server.getWorkspaceId()) && server.isEnabled())
                .map(McpProxyCatalogService::toRemoteServerView);
    }

    public List<ToolAliasView> listAliases(String workspaceId) {
        return aliases.findByWorkspaceId(UUID.fromString(workspaceId)).stream()
                .map(McpProxyCatalogService::toToolAliasView)
                .toList();
    }

    public Optional<ToolAliasView> findAliasByIssuedName(String workspaceId, String issuedName) {
        return aliases.findByWorkspaceIdAndIssuedName(UUID.fromString(workspaceId), issuedName)
                .map(McpProxyCatalogService::toToolAliasView);
    }

    public void saveAlias(ToolAliasView alias) {
        aliases.save(new McpToolAlias(alias.workspaceId(), alias.issuedName(), alias.serverId(),
                alias.backendName(), alias.generation()));
    }

    private static RemoteServerView toRemoteServerView(McpServer server) {
        return new RemoteServerView(server.getId().toString(), server.getEndpoint(), server.getAuthMode());
    }

    private static ToolAliasView toToolAliasView(McpToolAlias alias) {
        return new ToolAliasView(alias.getWorkspaceId().toString(), alias.getIssuedName(),
                alias.getServerId().toString(), alias.getBackendName(), alias.getGeneration());
    }

    public record StdioServerView(String name, boolean enabled) {
    }

    public record RemoteServerView(String id, String endpoint, String authMode) {
    }

    public record ToolAliasView(String workspaceId, String issuedName, String serverId,
                                String backendName, long generation) {
    }
}
