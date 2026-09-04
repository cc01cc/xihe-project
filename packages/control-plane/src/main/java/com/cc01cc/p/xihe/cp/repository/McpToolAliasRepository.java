package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.McpToolAlias;
import com.cc01cc.p.xihe.cp.entity.McpToolAlias.McpToolAliasId;

import java.util.List;
import java.util.Optional;

public interface McpToolAliasRepository extends JpaRepository<McpToolAlias, McpToolAliasId> {
    List<McpToolAlias> findByWorkspaceId(String workspaceId);

    Optional<McpToolAlias> findByWorkspaceIdAndIssuedName(String workspaceId, String issuedName);
}
