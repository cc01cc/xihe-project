package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.JudgeDecision;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

/**
 * PLAN-0624 M1: write-only in 0624 — the audit table has no read API (v1), so this repository
 * deliberately exposes no finder methods beyond the JPA defaults.
 */
public interface JudgeDecisionRepository extends JpaRepository<JudgeDecision, UUID> {
}
