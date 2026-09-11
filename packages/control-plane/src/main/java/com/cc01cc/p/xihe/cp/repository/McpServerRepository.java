package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;
import com.cc01cc.p.xihe.cp.entity.McpServer;

import java.util.List;
import java.util.Optional;

public interface McpServerRepository extends JpaRepository<McpServer, UUID> {
    List<McpServer> findByWorkspaceIdAndEnabledTrue(String workspaceId);

    Optional<McpServer> findByWorkspaceIdAndName(String workspaceId, String name);
}
