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
 *
 * <p><b>{@code trusted} is a {@link Boolean}, not a primitive</b> (D-1019): the personal layer must
 * refuse a request that carries the member <i>even as {@code false}</i> (P-189-1), and a primitive
 * cannot tell "absent" from "false". {@code null} = the member was absent.</p>
 */
public record SkillImportItem(
        String name,
        String description,
        String body,
        String sourcePath,
        List<SkillAttachmentView> attachments,
        Boolean trusted) {

    public SkillImportItem {
        attachments = attachments == null ? List.of() : List.copyOf(attachments);
    }
}
