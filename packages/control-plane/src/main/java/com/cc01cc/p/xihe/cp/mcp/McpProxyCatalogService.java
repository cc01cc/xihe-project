package com.cc01cc.p.xihe.cp.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.entity.McpStdioServer;
import com.cc01cc.p.xihe.cp.entity.McpToolAlias;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;
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

    /**
     * PLAN-0470: OAuth binding reads a workspace-scoped enabled remote server
     * through the MCP owner instead of touching {@code McpServerRepository}.
     */
    @Transactional(readOnly = true)
    public boolean isWorkspaceEnabledServer(String workspaceId, String serverId) {
        return remoteServers.findById(UUID.fromString(serverId))
                .filter(server -> workspaceId.equals(server.getWorkspaceId()) && server.isEnabled())
                .isPresent();
    }

    /**
     * PLAN-0470: OAuth start registers the remote server under its fixed id/name.
     * Error messages match the legacy OAuth wire contract verbatim.
     */
    @Transactional
    public void registerOrValidateRemoteServer(String workspaceId, String serverId, String endpoint) {
        UUID id = UUID.fromString(serverId);
        remoteServers.findById(id).ifPresentOrElse(server -> {
            if (!workspaceId.equals(server.getWorkspaceId())) {
                throw new IllegalArgumentException("mcp_server_forbidden");
            }
            if (!server.isEnabled()) {
                throw new IllegalArgumentException("mcp_server_disabled");
            }
            server.setEndpoint(endpoint);
            remoteServers.save(server);
        }, () -> {
            McpServer server = new McpServer(workspaceId, serverId, endpoint);
            server.setId(id);
            server.setEnabled(true);
            remoteServers.save(server);
        });
    }

    public List<StdioServerView> listStdioServers(String workspaceId) {
        return stdioServers.findByWorkspaceIdOrderByNameAsc(workspaceId).stream()
                .map(server -> new StdioServerView(server.getName(), server.isEnabled()))
                .toList();
    }

    public List<StdioConfigView> listStdioConfigs(String workspaceId) {
        return stdioServers.findByWorkspaceIdOrderByNameAsc(workspaceId).stream()
                .map(server -> new StdioConfigView(
                        server.getName(), server.getConfig(), server.getUpdatedAt()))
                .toList();
    }

    public void replaceStdioConfigs(String workspaceId, Map<String, JsonNode> next) {
        List<McpStdioServer> existing = stdioServers.findByWorkspaceIdOrderByNameAsc(workspaceId);
        for (McpStdioServer row : existing) {
            if (!next.containsKey(row.getName())) {
                stdioServers.delete(row);
            }
        }
        for (Map.Entry<String, JsonNode> entry : next.entrySet()) {
            McpStdioServer row = stdioServers.findByWorkspaceIdAndName(workspaceId, entry.getKey())
                    .orElseGet(() -> new McpStdioServer(workspaceId, entry.getKey(), entry.getValue()));
            row.setConfig(entry.getValue());
            stdioServers.save(row);
        }
    }

    public List<RemoteServerConfigView> listEnabledRemoteConfigs(String workspaceId) {
        return remoteServers.findByWorkspaceIdAndEnabledTrue(workspaceId).stream()
                .map(server -> new RemoteServerConfigView(server.getName(), server.getEndpoint()))
                .toList();
    }

    public void saveRemoteEndpoints(String workspaceId, Map<String, String> endpoints) {
        for (Map.Entry<String, String> entry : endpoints.entrySet()) {
            McpServer row = remoteServers.findByWorkspaceIdAndName(workspaceId, entry.getKey())
                    .orElseGet(() -> new McpServer(workspaceId, entry.getKey(), entry.getValue()));
            row.setEndpoint(entry.getValue());
            row.setEnabled(true);
            remoteServers.save(row);
        }
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

    public record StdioConfigView(String name, JsonNode config, Instant updatedAt) {
    }

    public record RemoteServerConfigView(String name, String endpoint) {
    }

    public record RemoteServerView(String id, String endpoint, String authMode) {
    }

    public record ToolAliasView(String workspaceId, String issuedName, String serverId,
                                String backendName, long generation) {
    }
}
