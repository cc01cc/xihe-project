package com.cc01cc.p.xihe.cp.controller;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0565: public member view (spec §2). {@code role} is the canonical
 * OWNER/EDITOR/VIEWER value; legacy ADMIN/MEMBER rows project as EDITOR.
 */
public record MemberView(
        UUID userId,
        String username,
        String email,
        String name,
        String role,
        Instant createdAt) {
}
