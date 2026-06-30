package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.Message;

import java.util.List;

public interface MessageRepository extends JpaRepository<Message, String> {
    List<Message> findBySessionIdOrderByCreatedAtAsc(String sessionId);
}
