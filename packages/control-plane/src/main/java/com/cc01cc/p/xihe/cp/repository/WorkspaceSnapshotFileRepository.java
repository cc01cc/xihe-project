package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceSnapshotFile;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

public interface WorkspaceSnapshotFileRepository extends JpaRepository<WorkspaceSnapshotFile, UUID> {

    List<WorkspaceSnapshotFile> findBySnapshotId(UUID snapshotId);

    @Modifying
    @Transactional
    void deleteBySnapshotId(UUID snapshotId);
}
