package com.cc01cc.p.xihe.cp.skill;

import java.util.List;

/**
 * PLAN-0628 M1: one skill as it arrives on {@code POST /api/v1/skills/import}.
 *
 * <p>Deliberately absent (server-computed, never read from a request — V99 discipline):
 * {@code contentHash}, {@code bodyTokensEst}, {@code oversize}, {@code version},
 * {@code createdByUserId}. The DTO physically cannot carry them, so a forged value is a
 * deserialisation error rather than a silent override.</p>
 *
 * <p>{@code attachments} is typed (not a raw node) so the wire layer owns shape errors
 * ("not an array") and this record only carries the manifest. {@code trusted} is honoured only for
 * an instance admin — see {@code SkillImportValidator#validate}.</p>
 */
public record SkillImportItem(
        String name,
        String description,
        String body,
        String sourcePath,
        List<SkillAttachmentView> attachments,
        boolean trusted) {

    public SkillImportItem {
        attachments = attachments == null ? List.of() : List.copyOf(attachments);
    }
}
