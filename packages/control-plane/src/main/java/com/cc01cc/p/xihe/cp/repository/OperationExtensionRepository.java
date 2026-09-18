package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.OperationExtension;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
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

    /**
     * PLAN-0344 T1.2：job_state 是可变事实（upsert），读改写必须在行锁下串行化，
     * 否则对账回填与工具同步双写会互相覆盖（终态被回退）。
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select e from OperationExtension e where e.itemId = :itemId "
            + "and e.extensionKind = :extensionKind and e.schemaVersion = :schemaVersion")
    Optional<OperationExtension> findForUpdate(@Param("itemId") String itemId,
                                               @Param("extensionKind") String extensionKind,
                                               @Param("schemaVersion") Integer schemaVersion);

    /** 对账/销毁扫描：按 kind + 创建时间收窄候选集（调用方再按 payload 过滤）。 */
    List<OperationExtension> findByExtensionKindAndCreatedAtAfter(
            String extensionKind, Instant createdAt);
}
