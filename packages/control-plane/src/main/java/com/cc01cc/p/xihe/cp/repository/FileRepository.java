package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.File;

import java.util.List;

public interface FileRepository extends JpaRepository<File, String> {
    List<File> findByUserId(String userId);
    List<File> findByWorkspaceId(String workspaceId);
}
