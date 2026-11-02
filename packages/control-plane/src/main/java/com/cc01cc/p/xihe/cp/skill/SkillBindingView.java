package com.cc01cc.p.xihe.cp.skill;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0628 M1: the wire projection of one binding row.
 *
 * <p>Four combinations reach a client ({@code subjectType × scopeType}); {@code scopeId} is null
 * exactly for the instance tier — the "shared with everyone" fifth tier is not expressible in v1
 * because {@code subject_id} is NOT NULL (the {@code role_bindings} shape, V87:44).</p>
 */
public record SkillBindingView(UUID bindingId, UUID skillId, String subjectType, UUID subjectId,
                               String scopeType, UUID scopeId, UUID createdByUserId,
                               Instant createdAt) {

    public static SkillBindingView from(SkillBinding binding) {
        return new SkillBindingView(
                binding.getId(),
                binding.getSkillId(),
                binding.getSubjectType(),
                binding.getSubjectId(),
                binding.getScopeType(),
                binding.getScopeId(),
                binding.getCreatedByUserId(),
                binding.getCreatedAt());
    }
}
