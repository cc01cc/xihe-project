package com.cc01cc.p.xihe.cp.skill;

/**
 * PLAN-0628 M1 (D28-21): one entry of the attachment <b>manifest</b> stored in
 * {@code skills.attachments} (jsonb array).
 *
 * <p>Bytes stay in the source tree — this carries only the path, size and hash computed at import
 * time (the only moment they can still be computed).</p>
 *
 * <p><b>Wire-safe by construction</b> (PLAN-0633 C1): every component is a scalar or a plain
 * {@code String}, so projecting the jsonb column into this record keeps Jackson-2 nodes off the
 * response. Never serialise the raw {@code JsonNode} instead.</p>
 *
 * @param path      workspace-relative path inside the skill directory (no {@code ..}, no absolute)
 * @param sizeBytes file size at import time
 * @param sha256    lowercase hex digest
 * @param kind      {@code reference} | {@code script} | {@code asset}
 */
public record SkillAttachmentView(String path, long sizeBytes, String sha256, String kind) {

    public static final String KIND_REFERENCE = "reference";
    public static final String KIND_SCRIPT = "script";
    public static final String KIND_ASSET = "asset";
}
