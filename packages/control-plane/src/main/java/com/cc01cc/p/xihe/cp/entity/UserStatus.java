package com.cc01cc.p.xihe.cp.entity;

/**
 * PLAN-0581: account lifecycle state (spec {@code api-users-contract.md} §3/§4).
 *
 * <p>Only two values exist by design: {@code ACTIVE} can log in and refresh,
 * {@code DISABLED} can do neither even with a valid password. Soft deletion is
 * expressed as {@code deletedAt != null} <b>and</b> {@code DISABLED} (enforced by
 * the {@code ck_users_deleted_status} CHECK), so a row can never be "deleted but
 * still able to log in".
 */
public enum UserStatus {
    ACTIVE,
    DISABLED
}
