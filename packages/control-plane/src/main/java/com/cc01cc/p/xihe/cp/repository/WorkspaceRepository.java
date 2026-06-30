package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.Workspace;

import java.util.List;

public interface WorkspaceRepository extends JpaRepository<Workspace, String> {
    List<Workspace> findByOwnerId(String ownerId);
}
