package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * PLAN-0628 M1: the <b>single validation seam</b> for skill import (mirrors
 * {@code ContextPolicyValidator}'s "one seam" rule — the CLI, the future UI and any importer all
 * pass through here, so the stored document can never disagree with the wire).
 *
 * <p>Two layers of protection exist on purpose (D28-29): the DDL also rejects an empty body and a
 * whitespace-only description, because a direct insert must not be able to persist what the seam
 * refuses. Neither layer is redundant — a test asserts both independently.</p>
 *
 * <p><b>Why the path rules are duplicated here instead of calling
 * {@code NestedAgentsMdResolver.normalizeTouchedPath}:</b> {@code cp.skill} must not depend on
 * {@code cp.context}, or {@code CpArchitectureTest}'s {@code slices().should().beFreeOfCycles()}
 * fails. The <i>rule family</i> is the same (normalise backslashes, reject absolute / drive prefix /
 * {@code ..} / NUL); keeping the spelling local is what keeps the slice graph acyclic.</p>
 *
 * <p>Item-level problems are returned (the import endpoint reports them in {@code rejected[]} and
 * keeps going); only request-level problems throw.</p>
 */
public final class SkillImportValidator {

    /** Mirrors {@code skills.name} CHECK and the {@code ':'} qualifier rule. */
    public static final Pattern NAME_PATTERN = Pattern.compile("^[a-z0-9][a-z0-9._-]{0,63}$");
    /**
     * PLAN-0628 M3-②: {@code Cc} = every control character (CR, LF, tab, NUL, BEL, ESC…);
     * {@code Zl}/{@code Zp} = the Unicode line and paragraph separators, which break a line without
     * being control characters.
     */
    private static final Pattern DESCRIPTION_CONTROL = Pattern.compile("[\\p{Cc}\\p{Zl}\\p{Zp}]");
    /** D28-16: one request carries at most this many skills (whole-batch refusal). */
    public static final int MAX_SKILLS_PER_REQUEST = 64;
    public static final int MAX_SOURCE_PATH_LENGTH = 512;
    private static final Pattern SHA256_PATTERN = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern DRIVE_PREFIX = Pattern.compile("^[a-zA-Z]:.*");

    public static final String SKILL_NAME_INVALID = "SKILL_NAME_INVALID";
    public static final String SKILL_DESCRIPTION_REQUIRED = "SKILL_DESCRIPTION_REQUIRED";
    public static final String SKILL_DESCRIPTION_TOO_LONG = "SKILL_DESCRIPTION_TOO_LONG";
    /** PLAN-0628 M3-②: a description whose edges {@code strip()} would change. */
    public static final String SKILL_DESCRIPTION_EDGE_WHITESPACE =
            "SKILL_DESCRIPTION_EDGE_WHITESPACE";
    /** PLAN-0628 M3-②: a description that is not on one line (line break / control character). */
    public static final String SKILL_DESCRIPTION_CONTROL_CHARACTER =
            "SKILL_DESCRIPTION_CONTROL_CHARACTER";
    public static final String SKILL_BODY_EMPTY = "SKILL_BODY_EMPTY";
    public static final String SKILL_BODY_TOO_LARGE = "SKILL_BODY_TOO_LARGE";
    public static final String SKILL_ATTACHMENT_INVALID = "SKILL_ATTACHMENT_INVALID";
    public static final String SKILL_SOURCE_PATH_INVALID = "SKILL_SOURCE_PATH_INVALID";
    public static final String SKILL_TRUSTED_FORBIDDEN = "SKILL_TRUSTED_FORBIDDEN";
    public static final String SKILL_IMPORT_TOO_LARGE = "SKILL_IMPORT_TOO_LARGE";

    private SkillImportValidator() {}

    /** One refused item, reported in the response's {@code rejected[]} array. */
    public record Rejection(String sourcePath, String code, String detail) {}

    /**
     * Validates one item.
     *
     * @param callerIsInstanceAdmin only an instance admin may import {@code trusted: true}
     *     (D28-09 rule 1); everyone else gets {@link #SKILL_TRUSTED_FORBIDDEN}
     * @return the first violation, or empty when the item may be written
     */
    public static Optional<Rejection> validate(SkillImportItem item, boolean callerIsInstanceAdmin) {
        Rejection nameViolation = validateName(item);
        if (nameViolation != null) {
            return Optional.of(nameViolation);
        }
        Rejection sourcePathViolation = validateSourcePath(item);
        if (sourcePathViolation != null) {
            return Optional.of(sourcePathViolation);
        }
        Rejection descriptionViolation = validateDescription(item);
        if (descriptionViolation != null) {
            return Optional.of(descriptionViolation);
        }
        Rejection bodyViolation = validateBody(item);
        if (bodyViolation != null) {
            return Optional.of(bodyViolation);
        }
        Rejection attachmentViolation = validateAttachments(item);
        if (attachmentViolation != null) {
            return Optional.of(attachmentViolation);
        }
        if (item.trusted() && !callerIsInstanceAdmin) {
            return Optional.of(rejection(item, SKILL_TRUSTED_FORBIDDEN,
                    "only an instance administrator may import a trusted skill"));
        }
        return Optional.empty();
    }

    /** Whole-batch refusal: too many items cannot be reported per item. */
    public static void requireBatchSize(int size) {
        if (size > MAX_SKILLS_PER_REQUEST) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, SKILL_IMPORT_TOO_LARGE,
                    "a single import carries at most " + MAX_SKILLS_PER_REQUEST + " skills");
        }
    }

    private static Rejection validateName(SkillImportItem item) {
        String name = item.name();
        if (name == null || !NAME_PATTERN.matcher(name).matches()) {
            return rejection(item, SKILL_NAME_INVALID,
                    "name must match ^[a-z0-9][a-z0-9._-]{0,63}$ (no ':' qualifier separator)");
        }
        // The source directory name is the same identity: <...>/<dir>/SKILL.md with <dir> == name.
        String sourcePath = normalizePath(item.sourcePath());
        if (sourcePath != null) {
            String[] segments = sourcePath.split("/");
            boolean skillFile = segments.length >= 2 && "SKILL.md".equals(segments[segments.length - 1]);
            if (skillFile) {
                String directory = segments[segments.length - 2];
                if (!directory.equals(name)) {
                    return rejection(item, SKILL_NAME_INVALID,
                            "source directory '" + directory + "' must equal the skill name '" + name + "'");
                }
            }
        }
        return null;
    }

    private static Rejection validateSourcePath(SkillImportItem item) {
        String raw = item.sourcePath();
        if (raw == null || raw.isBlank()) {
            return rejection(item, SKILL_SOURCE_PATH_INVALID, "sourcePath is required");
        }
        if (raw.length() > MAX_SOURCE_PATH_LENGTH) {
            return rejection(item, SKILL_SOURCE_PATH_INVALID,
                    "sourcePath must be at most " + MAX_SOURCE_PATH_LENGTH + " characters");
        }
        if (normalizePath(raw) == null) {
            return rejection(item, SKILL_SOURCE_PATH_INVALID,
                    "sourcePath must be a relative path inside the skill tree");
        }
        return null;
    }

    /**
     * PLAN-0628 M3-②: the description must be exactly what the listing will render, one item per
     * line.
     *
     * <p><b>Reject, do not trim</b> (the deliberate choice, second option of the裁定): silently
     * trimming would make "what the importer stored" differ from "what the caller sent", and the
     * caller has no way to see that — the next {@code unchanged}/{@code updated} answer would then
     * describe a document they never wrote. The listing renderer still normalises
     * ({@link SkillCatalogSourceService} — historical rows exist), but a <i>new</i> write must be
     * clean rather than quietly corrected. Note also that {@code content_hash} covers the
     * description: a silent trim would change the hash of a document the caller believes is
     * byte-identical.</p>
     *
     * <p><b>Why a line break is a refusal and not a formatting nit:</b> one listing item is one
     * prompt line. The Agent joins rendered items with {@code "\n"}, so a description containing a
     * break puts half of it on the next line, where the model reads it as <b>a second skill</b>
     * (with a name it can try to load). Splitting one binding into two hallucinated ones is a
     * semantic corruption of the listing, so CR/LF and every other control character (NUL/BEL/ESC
     * also reach logs and the prompt) are refused outright. The V101 CHECK only bounds the trimmed
     * <i>length</i>; it cannot express this rule, hence the second layer lives in the seam.</p>
     */
    private static Rejection validateDescription(SkillImportItem item) {
        String description = item.description();
        if (description == null || description.isBlank()) {
            return rejection(item, SKILL_DESCRIPTION_REQUIRED, "description is required");
        }
        int codePoints = description.codePointCount(0, description.length());
        if (codePoints > Skill.MAX_DESCRIPTION_LENGTH) {
            return rejection(item, SKILL_DESCRIPTION_TOO_LONG,
                    "description must be at most " + Skill.MAX_DESCRIPTION_LENGTH + " characters");
        }
        if (DESCRIPTION_CONTROL.matcher(description).find()) {
            return rejection(item, SKILL_DESCRIPTION_CONTROL_CHARACTER,
                    "description must be on one line: line breaks and control characters are"
                            + " refused because one listing item must stay one prompt line");
        }
        if (!description.equals(description.strip())) {
            return rejection(item, SKILL_DESCRIPTION_EDGE_WHITESPACE,
                    "description must not begin or end with whitespace (it is not trimmed for"
                            + " you: the stored value must equal the submitted value)");
        }
        return null;
    }

    private static Rejection validateBody(SkillImportItem item) {
        String body = item.body();
        if (body == null || body.isBlank()) {
            return rejection(item, SKILL_BODY_EMPTY, "body is required (frontmatter removed)");
        }
        int bytes = body.getBytes(StandardCharsets.UTF_8).length;
        if (bytes > Skill.MAX_BODY_BYTES) {
            return rejection(item, SKILL_BODY_TOO_LARGE,
                    "body must be at most " + Skill.MAX_BODY_BYTES + " bytes");
        }
        return null;
    }

    private static Rejection validateAttachments(SkillImportItem item) {
        List<SkillAttachmentView> attachments = item.attachments();
        for (SkillAttachmentView attachment : attachments) {
            if (attachment == null) {
                return rejection(item, SKILL_ATTACHMENT_INVALID, "attachment entry is null");
            }
            if (attachment.sha256() == null || !SHA256_PATTERN.matcher(attachment.sha256()).matches()) {
                return rejection(item, SKILL_ATTACHMENT_INVALID,
                        "attachment sha256 must be 64 lowercase hex characters");
            }
            if (attachment.sizeBytes() < 0) {
                return rejection(item, SKILL_ATTACHMENT_INVALID, "attachment sizeBytes must be >= 0");
            }
            if (normalizePath(attachment.path()) == null) {
                return rejection(item, SKILL_ATTACHMENT_INVALID,
                        "attachment path must be relative and must not contain '..'");
            }
            String kind = attachment.kind();
            if (kind != null && !List.of(SkillAttachmentView.KIND_REFERENCE,
                    SkillAttachmentView.KIND_SCRIPT, SkillAttachmentView.KIND_ASSET).contains(kind)) {
                return rejection(item, SKILL_ATTACHMENT_INVALID,
                        "attachment kind must be reference|script|asset");
            }
        }
        return null;
    }

    /**
     * The path rule family shared with {@code NestedAgentsMdResolver.normalizeTouchedPath}
     * (deliberately duplicated, see class javadoc).
     *
     * <p><b>Kept behaviourally identical, and parity-tested</b>
     * ({@code cp.context.service.PathRuleParityTest}): the same normalisation (strip, backslashes to
     * slashes, drop empty and {@code .} segments) and the same refusals (NUL, absolute, UNC, drive
     * prefix, {@code ..}). "Local spelling" is only allowed to differ in <i>placement</i>, not in
     * meaning — that test is the tripwire for the day it drifts.</p>
     *
     * <p>One intentional convention difference: where the nested resolver returns {@code ""} for
     * "nothing was given" (it has an optional input), this returns {@code null}, because a skill's
     * {@code sourcePath} is required — both callers see "no usable path".</p>
     *
     * @return the normalised relative path, or {@code null} when the input is unsafe or empty
     */
    public static String normalizePath(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String path = raw.strip().replace('\\', '/');
        if (path.indexOf('\u0000') >= 0 || path.startsWith("/") || path.startsWith("//")) {
            return null;
        }
        if (DRIVE_PREFIX.matcher(path).matches()) {
            return null;
        }
        List<String> parts = new ArrayList<>();
        for (String part : path.split("/+")) {
            if (part.isEmpty() || ".".equals(part)) {
                continue;
            }
            if ("..".equals(part)) {
                return null;
            }
            parts.add(part);
        }
        String joined = String.join("/", parts);
        return joined.isEmpty() ? null : joined;
    }

    private static Rejection rejection(SkillImportItem item, String code, String detail) {
        return new Rejection(item.sourcePath(), code, detail);
    }
}
