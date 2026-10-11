package com.cc01cc.p.xihe.cp.scheduled;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0489 T1.2：{@code scheduled_tasks} 的 CAS 条件更新面（0486 §3）。
 *
 * <p>所有状态转移都是条件更新（认领带 {@code status='scheduled' + next_fire_at}
 * 双前置；回写带 {@code status='firing'} 前置），CAS 失败返回 0 由调用方放弃，
 * 杜绝 check-then-act 竞态。JPQL 绕过 {@code @PreUpdate}，每条更新显式刷新
 * {@code updatedAt}（同 {@code ChatRunRepository} 惯例）；firing 超时判定以
 * {@code updatedAt} 为认领时间（firing 期间无其他写者，最小方案）。</p>
 */
public interface ScheduledTaskRepository extends JpaRepository<ScheduledTask, UUID> {

    List<ScheduledTask> findByStatusAndNextFireAtBeforeOrderByNextFireAtAsc(
            String status, Instant before);

    long countByStatusAndNextFireAtBefore(String status, Instant before);

    /**
     * PLAN-0489 §过期扫描：delay_once 超过 expires_at（同轮扫描先于 missed 判定，
     * 0486 §2 优先级）。
     */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'expired', t.updatedAt = CURRENT_INSTANT "
            + "where t.status = 'scheduled' and t.triggerKind = 'delay_once' "
            + "and t.expiresAt is not null and t.expiresAt <= :now")
    int expireDueOnceTasks(@Param("now") Instant now);

    /** overdue 扫描：scheduled 且 next_fire_at 早于宽限期下界 → missed(overdue_grace)。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'missed', t.missedReason = :reason, "
            + "t.missedCount = t.missedCount + 1, t.lastMissedAt = :now, t.updatedAt = CURRENT_INSTANT "
            + "where t.status = :expected and t.nextFireAt < :cutoff")
    int markOverdueMissed(@Param("expected") String expected,
                          @Param("cutoff") Instant cutoff,
                          @Param("reason") String reason,
                          @Param("now") Instant now);

    /** firing 超时（崩溃恢复，0486 B3）：认领后 updated_at 早于 grace 下界 → missed(dispatch_failed)。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'missed', t.missedReason = :reason, "
            + "t.missedCount = t.missedCount + 1, t.lastMissedAt = :now, t.updatedAt = CURRENT_INSTANT "
            + "where t.status = 'firing' and t.updatedAt < :staleBefore")
    int markStaleFiringMissed(@Param("staleBefore") Instant staleBefore,
                              @Param("reason") String reason,
                              @Param("now") Instant now);

    /** 到期认领（0486 B3）：scheduled→firing CAS，next_fire_at 必须仍是认领时读到的值。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'firing', t.updatedAt = CURRENT_INSTANT "
            + "where t.id = :id and t.status = 'scheduled' and t.nextFireAt = :expectedNextFire")
    int claimToFiring(@Param("id") UUID id, @Param("expectedNextFire") Instant expectedNextFire);

    /** 用户处置补跑（rerun）：missed/expired→firing 认领（T1.4 API 使用）。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'firing', t.updatedAt = CURRENT_INSTANT "
            + "where t.id = :id and t.status in :expectedStatuses")
    int claimForRerun(@Param("id") UUID id,
                      @Param("expectedStatuses") Collection<String> expectedStatuses);

    /** firing 成功回写（cron）：重算 next_fire_at，保持 last_run_id 不变（busy 顺延/无新载体）。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'scheduled', t.nextFireAt = :nextFireAt, "
            + "t.updatedAt = CURRENT_INSTANT where t.id = :id and t.status = 'firing'")
    int rescheduleCronFromFiring(@Param("id") UUID id, @Param("nextFireAt") Instant nextFireAt);

    /** firing 成功回写（cron + 新载体）：同上并记录 last_run_id。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'scheduled', t.nextFireAt = :nextFireAt, "
            + "t.lastRunId = :lastRunId, t.updatedAt = CURRENT_INSTANT "
            + "where t.id = :id and t.status = 'firing'")
    int rescheduleCronFromFiringWithRun(@Param("id") UUID id,
                                        @Param("nextFireAt") Instant nextFireAt,
                                        @Param("lastRunId") UUID lastRunId);

    /** firing 成功回写（delay_once）：completed，保持 last_run_id 不变（busy 顺延/无新载体）。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'completed', t.updatedAt = CURRENT_INSTANT "
            + "where t.id = :id and t.status = 'firing'")
    int completeFromFiring(@Param("id") UUID id);

    /** firing 成功回写（delay_once + 新载体）：completed 并记录 last_run_id。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'completed', t.lastRunId = :lastRunId, "
            + "t.updatedAt = CURRENT_INSTANT where t.id = :id and t.status = 'firing'")
    int completeFromFiringWithRun(@Param("id") UUID id, @Param("lastRunId") UUID lastRunId);

    /** 分派失败/目标消失：从 expected 状态（firing 或 scheduled）转 missed 并累计轮次。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'missed', t.missedReason = :reason, "
            + "t.missedCount = t.missedCount + 1, t.lastMissedAt = :now, t.updatedAt = CURRENT_INSTANT "
            + "where t.id = :id and t.status in :expectedStatuses")
    int markMissed(@Param("id") UUID id,
                   @Param("expectedStatuses") Collection<String> expectedStatuses,
                   @Param("reason") String reason,
                   @Param("now") Instant now);

    /** 用户处置推迟（postpone）：missed/expired/scheduled→scheduled，missed 计数清零（0486 §2）。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'scheduled', t.nextFireAt = :at, "
            + "t.missedCount = 0, t.missedReason = null, t.lastMissedAt = null, "
            + "t.updatedAt = CURRENT_INSTANT where t.id = :id and t.status in :expectedStatuses")
    int postponeToScheduled(@Param("id") UUID id,
                            @Param("expectedStatuses") Collection<String> expectedStatuses,
                            @Param("at") Instant at);

    /** 用户处置移除/删除：→ cancelled。 */
    @Modifying
    @Transactional
    @Query("update ScheduledTask t set t.status = 'cancelled', t.cancelReason = :reason, "
            + "t.updatedAt = CURRENT_INSTANT where t.id = :id and t.status in :expectedStatuses")
    int markCancelled(@Param("id") UUID id,
                      @Param("expectedStatuses") Collection<String> expectedStatuses,
                      @Param("reason") String reason);
}
