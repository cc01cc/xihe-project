package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.TaskItem;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface TaskItemRepository extends JpaRepository<TaskItem, UUID> {

    List<TaskItem> findByTaskPlanIdOrderByPosition(UUID taskPlanId);

    List<TaskItem> findByTaskPlanIdAndStatus(UUID taskPlanId, String status);
}
