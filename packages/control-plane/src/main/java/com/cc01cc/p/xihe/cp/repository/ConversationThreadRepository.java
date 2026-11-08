package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ConversationThread;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

/** PLAN-0646 MVP: thread rows only; visibility is decided by the service (no role-name query). */
public interface ConversationThreadRepository extends JpaRepository<ConversationThread, UUID> {
}
