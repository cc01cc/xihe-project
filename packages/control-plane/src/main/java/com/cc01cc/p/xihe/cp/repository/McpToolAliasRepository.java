package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.McpToolAlias;
import com.cc01cc.p.xihe.cp.entity.McpToolAlias.McpToolAliasId;

import java.util.List;
import java.util.UUID;
import java.util.Optional;
import java.util.UUID;

public interface McpToolAliasRepository extends JpaRepository<McpToolAlias, McpToolAliasId> {
    List<McpToolAlias> findByWorkspaceId(UUID workspaceId);

    Optional<McpToolAlias> findByWorkspaceIdAndIssuedName(UUID workspaceId, String issuedName);
}
