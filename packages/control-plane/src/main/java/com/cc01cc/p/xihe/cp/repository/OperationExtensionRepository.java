package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.OperationExtension;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OperationExtensionRepository extends JpaRepository<OperationExtension, UUID> {

    List<OperationExtension> findByItemId(String itemId);

    List<OperationExtension> findByAttemptId(String attemptId);

    Optional<OperationExtension> findByItemIdAndExtensionKindAndSchemaVersion(
            String itemId, String extensionKind, Integer schemaVersion);

    Optional<OperationExtension> findByAttemptIdAndExtensionKindAndSchemaVersion(
            String attemptId, String extensionKind, Integer schemaVersion);

    Optional<OperationExtension> findFirstByItemIdAndExtensionKindOrderBySchemaVersionDesc(
            String itemId, String extensionKind);

    Optional<OperationExtension> findFirstByAttemptIdAndExtensionKindOrderBySchemaVersionDesc(
            String attemptId, String extensionKind);
}
