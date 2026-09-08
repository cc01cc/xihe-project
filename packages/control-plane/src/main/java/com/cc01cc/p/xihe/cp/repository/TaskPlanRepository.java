package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.TaskPlan;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface TaskPlanRepository extends JpaRepository<TaskPlan, UUID> {

    List<TaskPlan> findByRunId(UUID runId);

    List<TaskPlan> findBySessionIdAndState(UUID sessionId, String state);
}
