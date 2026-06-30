package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.McpServer;

import java.util.List;

public interface McpServerRepository extends JpaRepository<McpServer, String> {
    List<McpServer> findByWorkspaceIdAndEnabledTrue(String workspaceId);
}
