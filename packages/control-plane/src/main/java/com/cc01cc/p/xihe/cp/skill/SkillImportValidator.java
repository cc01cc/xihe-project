package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.nio.charset.StandardCharsets;
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
    /** D28-16: one request carries at most this many skills (whole-batch refusal). */
    public static final int MAX_SKILLS_PER_REQUEST = 64;
    public static final int MAX_SOURCE_PATH_LENGTH = 512;
    private static final Pattern SHA256_PATTERN = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern DRIVE_PREFIX = Pattern.compile("^[a-zA-Z]:.*");

    public static final String SKILL_NAME_INVALID = "SKILL_NAME_INVALID";
    public static final String SKILL_DESCRIPTION_REQUIRED = "SKILL_DESCRIPTION_REQUIRED";
    public static final String SKILL_DESCRIPTION_TOO_LONG = "SKILL_DESCRIPTION_TOO_LONG";
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
     * @return the normalised relative path, or {@code null} when the input is unsafe
     */
    static String normalizePath(String raw) {
        if (raw == null) {
            return null;
        }
        String path = raw.replace('\\', '/').trim();
        if (path.isEmpty() || path.indexOf('\0') >= 0) {
            return null;
        }
        if (path.startsWith("/") || DRIVE_PREFIX.matcher(path).matches() || path.startsWith("//")) {
            return null;
        }
        for (String segment : path.split("/")) {
            if ("..".equals(segment)) {
                return null;
            }
        }
        return path;
    }

    private static Rejection rejection(SkillImportItem item, String code, String detail) {
        return new Rejection(item.sourcePath(), code, detail);
    }
}
