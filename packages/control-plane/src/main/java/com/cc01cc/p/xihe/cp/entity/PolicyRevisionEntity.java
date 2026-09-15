package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * Single-row durable policy revision counter (PLAN-0328 T1.7): {@code seq} is bumped by every
 * {@code policy_rules} / {@code tool_faces} mutation — including deletes, which the previous
 * {@code max(updated_at)} derivation could not observe.
 *
 * <p>Only {@code id = 1} may exist (V21 CHECK); reads go through a scalar JPQL query in
 * {@code PolicyRevisionRepository} so a bump is visible even inside the bumping transaction.</p>
 */
@Entity
@Table(name = "policy_revision")
public class PolicyRevisionEntity {

    /** The only legal row id (V21 CHECK constraint). */
    public static final short SINGLETON_ID = 1;

    @Id
    @Column(name = "id", nullable = false)
    private Short id;

    @Column(name = "seq", nullable = false)
    private Long seq;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public PolicyRevisionEntity() {
    }

    public PolicyRevisionEntity(Short id, Long seq, Instant updatedAt) {
        this.id = id;
        this.seq = seq;
        this.updatedAt = updatedAt;
    }

    public Short getId() {
        return id;
    }

    public Long getSeq() {
        return seq;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
