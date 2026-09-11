package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.McpStdioServer;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface McpStdioServerRepository extends JpaRepository<McpStdioServer, UUID> {

    List<McpStdioServer> findByWorkspaceIdOrderByNameAsc(String workspaceId);

    Optional<McpStdioServer> findByWorkspaceIdAndName(String workspaceId, String name);
}
