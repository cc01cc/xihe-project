package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M1: the import validation seam.
 *
 * <p><b>D28-29 dual protection:</b> a whitespace-only description is refused <i>here</i> and by the
 * V101 CHECK. Both are asserted independently — {@code SkillCatalogMigrationTest} proves a direct
 * insert cannot persist blank data, and this test proves the seam refuses it before the DB is
 * touched. Neither replaces the other.</p>
 */
class SkillImportValidatorTest {

    private static final String HASH = "d".repeat(64);

    private static SkillImportItem item(String name, String description, String body,
                                        String sourcePath, List<SkillAttachmentView> attachments,
                                        boolean trusted) {
        return new SkillImportItem(name, description, body, sourcePath, attachments, trusted);
    }

    private static SkillImportItem valid() {
        return item("git-commit-guard", "review before commit", "run the checklist",
                ".agents/skills/git-commit-guard/SKILL.md", List.of(), false);
    }

    private static String code(Optional<SkillImportValidator.Rejection> rejection) {
        assertTrue(rejection.isPresent(), "expected a rejection");
        return rejection.get().code();
    }

    @Test
    void aValidItemIsAccepted() {
        assertTrue(SkillImportValidator.validate(valid(), false).isEmpty());
    }

    /** D28-29: the validator refuses blank descriptions on its own (the DDL refuses them too). */
    @Test
    void blankDescriptionIsRejectedByTheValidatorToo() {
        assertEquals(SkillImportValidator.SKILL_DESCRIPTION_REQUIRED,
                code(SkillImportValidator.validate(
                        item("blank-desc", "   ", "body", ".agents/skills/blank-desc/SKILL.md",
                                List.of(), false), false)));
        assertEquals(SkillImportValidator.SKILL_DESCRIPTION_REQUIRED,
                code(SkillImportValidator.validate(
                        item("null-desc", null, "body", ".agents/skills/null-desc/SKILL.md",
                                List.of(), false), false)));
    }

    /**
     * PLAN-0628 M3-② (裁定 A): surrounding whitespace is <b>refused</b>, never trimmed — the stored
     * value must equal the submitted value (and the description is part of {@code content_hash},
     * which a silent trim would change behind the caller's back).
     */
    @Test
    void surroundingWhitespaceIsRefusedInsteadOfTrimmed() {
        // Non-control whitespace only: a tab would be refused as a control character instead, and
        // that ordering is itself part of the contract (see the next test).
        for (String dirty : List.of(" padded", "padded ", " padded ", "\u3000padded")) {
            assertEquals(SkillImportValidator.SKILL_DESCRIPTION_EDGE_WHITESPACE,
                    code(SkillImportValidator.validate(
                            item("dirty-desc", dirty, "body",
                                    ".agents/skills/dirty-desc/SKILL.md", List.of(), false), false)),
                    "[" + dirty + "]");
        }
        // Interior whitespace is untouched by the renderer, so it stays legal: this seam refuses
        // only what the listing would not survive byte-for-byte.
        assertTrue(SkillImportValidator.validate(
                item("inner-space", "two  spaces inside", "body",
                        ".agents/skills/inner-space/SKILL.md", List.of(), false), false).isEmpty());
    }

    /**
     * PLAN-0628 M3-② (裁定 C): a line break (or any control character) is refused. One listing item
     * is one prompt line — a break inside a description makes the model read one binding as two
     * skills, which is a semantic corruption rather than a formatting nit.
     */
    @Test
    void descriptionsMustStayOnOneLine() {
        for (String dirty : List.of("one\ntwo", "one\r\ntwo", "one\rtwo", "one\u2028two",
                "one\u2029two", "tab\tinside", "bell\u0007", "nul\u0000")) {
            assertEquals(SkillImportValidator.SKILL_DESCRIPTION_CONTROL_CHARACTER,
                    code(SkillImportValidator.validate(
                            item("multi-line", dirty, "body",
                                    ".agents/skills/multi-line/SKILL.md", List.of(), false), false)),
                    dirty.replace("\n", "\\n").replace("\r", "\\r"));
        }
        assertTrue(SkillImportValidator.validate(
                item("one-line", "Extract action items from a meeting transcript", "body",
                        ".agents/skills/one-line/SKILL.md", List.of(), false), false).isEmpty());
    }

    @Test
    void descriptionLengthIsCountedInCodePoints() {
        assertEquals(SkillImportValidator.SKILL_DESCRIPTION_TOO_LONG,
                code(SkillImportValidator.validate(
                        item("long-desc", "x".repeat(1025), "body",
                                ".agents/skills/long-desc/SKILL.md", List.of(), false), false)));
        // 1024 CJK code points is exactly the limit even though it is 3072 UTF-8 bytes.
        assertTrue(SkillImportValidator.validate(
                item("max-desc", "写".repeat(1024), "body",
                        ".agents/skills/max-desc/SKILL.md", List.of(), false), false).isEmpty());
    }

    @Test
    void nameMustMatchThePatternAndTheSourceDirectory() {
        for (String bad : List.of("Git-Commit", "with:colon", "-leading", "a".repeat(65), "")) {
            assertEquals(SkillImportValidator.SKILL_NAME_INVALID,
                    code(SkillImportValidator.validate(
                            item(bad, "d", "b", null, List.of(), false), false)), bad);
        }
        // Directory/name mismatch: the listing display name is derived from name, so they must agree.
        assertEquals(SkillImportValidator.SKILL_NAME_INVALID,
                code(SkillImportValidator.validate(
                        item("real-name", "d", "b", ".agents/skills/other-name/SKILL.md",
                                List.of(), false), false)));
    }

    @Test
    void bodyBounds() {
        assertEquals(SkillImportValidator.SKILL_BODY_EMPTY,
                code(SkillImportValidator.validate(
                        item("blank-body", "d", "   ", ".agents/skills/blank-body/SKILL.md",
                                List.of(), false), false)));
        assertEquals(SkillImportValidator.SKILL_BODY_TOO_LARGE,
                code(SkillImportValidator.validate(
                        item("huge-body", "d", "x".repeat(Skill.MAX_BODY_BYTES + 1),
                                ".agents/skills/huge-body/SKILL.md", List.of(), false), false)));
    }

    @Test
    void sourcePathMustBeRelativeAndBounded() {
        for (String bad : List.of("/abs/SKILL.md", "C:/win/SKILL.md", "C:\\win\\SKILL.md",
                "../escape/SKILL.md", "a/../../b/SKILL.md", "   ")) {
            assertEquals(SkillImportValidator.SKILL_SOURCE_PATH_INVALID,
                    code(SkillImportValidator.validate(
                            item("path-case", "d", "b", bad, List.of(), false), false)), bad);
        }
        assertEquals(SkillImportValidator.SKILL_SOURCE_PATH_INVALID,
                code(SkillImportValidator.validate(
                        item("long-path", "d", "b", "a/" + "x".repeat(512),
                                List.of(), false), false)));
    }

    @Test
    void attachmentManifestIsChecked() {
        String path = ".agents/skills/att/SKILL.md";
        List<SkillAttachmentView> badHash = List.of(new SkillAttachmentView("references/a.md", 1, "xyz",
                SkillAttachmentView.KIND_REFERENCE));
        assertEquals(SkillImportValidator.SKILL_ATTACHMENT_INVALID,
                code(SkillImportValidator.validate(item("att", "d", "b", path, badHash, false), false)));

        List<SkillAttachmentView> negative = List.of(new SkillAttachmentView("references/a.md", -1, HASH,
                SkillAttachmentView.KIND_REFERENCE));
        assertEquals(SkillImportValidator.SKILL_ATTACHMENT_INVALID,
                code(SkillImportValidator.validate(item("att", "d", "b", path, negative, false), false)));

        List<SkillAttachmentView> escape = List.of(new SkillAttachmentView("../a.md", 1, HASH,
                SkillAttachmentView.KIND_REFERENCE));
        assertEquals(SkillImportValidator.SKILL_ATTACHMENT_INVALID,
                code(SkillImportValidator.validate(item("att", "d", "b", path, escape, false), false)));

        List<SkillAttachmentView> badKind = List.of(new SkillAttachmentView("references/a.md", 1, HASH,
                "binary"));
        assertEquals(SkillImportValidator.SKILL_ATTACHMENT_INVALID,
                code(SkillImportValidator.validate(item("att", "d", "b", path, badKind, false), false)));

        List<SkillAttachmentView> fine = List.of(new SkillAttachmentView("references/a.md", 1, HASH,
                SkillAttachmentView.KIND_REFERENCE));
        assertTrue(SkillImportValidator.validate(item("att", "d", "b", path, fine, false), false).isEmpty());
    }

    @Test
    void trustedRequiresInstanceAdmin() {
        SkillImportItem trusted = item("trusted-one", "d", "b",
                ".agents/skills/trusted-one/SKILL.md", List.of(), true);
        assertEquals(SkillImportValidator.SKILL_TRUSTED_FORBIDDEN,
                code(SkillImportValidator.validate(trusted, false)));
        assertTrue(SkillImportValidator.validate(trusted, true).isEmpty());
    }

    @Test
    void batchSizeIsRefusedAsAWhole() {
        SkillImportValidator.requireBatchSize(SkillImportValidator.MAX_SKILLS_PER_REQUEST);
        CpApiException tooLarge = assertThrows(CpApiException.class,
                () -> SkillImportValidator.requireBatchSize(SkillImportValidator.MAX_SKILLS_PER_REQUEST + 1));
        assertEquals(SkillImportValidator.SKILL_IMPORT_TOO_LARGE, tooLarge.getCode());
    }

    @Test
    void pathNormalizationIsTheSharedRuleFamily() {
        assertEquals("a/b/SKILL.md", SkillImportValidator.normalizePath("a\\b\\SKILL.md"));
        for (String unsafe : List.of("", "/abs", "C:/x", "a/../b", "a/" + (char) 0 + "b", "\\\\srv\\share")) {
            assertNull(SkillImportValidator.normalizePath(unsafe), unsafe);
        }
    }
}
