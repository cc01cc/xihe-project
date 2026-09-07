package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;
import com.cc01cc.p.xihe.cp.entity.Message;

import java.util.List;

public interface MessageRepository extends JpaRepository<Message, UUID> {
    List<Message> findBySessionIdOrderByCreatedAtAsc(String sessionId);
    long deleteBySessionId(String sessionId);
}
