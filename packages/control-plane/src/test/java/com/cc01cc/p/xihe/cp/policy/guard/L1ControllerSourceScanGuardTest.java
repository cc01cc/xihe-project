package com.cc01cc.p.xihe.cp.policy.guard;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * task-837 L1: the HTTP layer must not decide authorization by identity or role name.
 *
 * <p>Scans {@code controller/*.java} for the forbidden spellings ({@code userId.equals(},
 * {@code ownerId.equals(}, {@code "ADMIN"}, {@code "SUPER_ADMIN"}, {@code "WS_OWNER"},
 * {@code WorkspaceRole.}, {@code isAdmin()}, {@code isInstanceAdmin()}). Comments and string
 * literals are lexed properly: a comment explaining what was removed is not a hit, while a
 * forbidden token inside a string literal <b>is</b> (it is still a role-name judgement).</p>
 *
 * <p><b>Whitelist is data, not code</b>: {@link L1ScanWhitelist},
 * every entry carrying {@code reason + owner + reviewDate}. The gate is <b>only-shrink</b>: an entry
 * that no longer reproduces fails (delete it), and an entry whose actual count dropped must be
 * tightened — otherwise "allowed" would silently become a permanent hole. No entry may use
 * {@code owner=task-859}: that delivery must leave zero residues (the card's acceptance).</p>
 *
 * <p>Falsifiability (§3.2): {@link #scannerDetectsCodeAndIgnoresComments()} feeds a synthetic
 * snippet with one real hit and one comment-only mention, so a scanner that silently matches nothing
 * cannot pass this class.</p>
 */
class L1ControllerSourceScanGuardTest {

    private static final Path CONTROLLER_DIR =
            Path.of("src", "main", "java", "com", "cc01cc", "p", "xihe", "cp", "controller");
    private static final List<String> FORBIDDEN = List.of(
            "userId.equals(",
            "ownerId.equals(",
            "\"ADMIN\"",
            "\"SUPER_ADMIN\"",
            "\"WS_OWNER\"",
            "WorkspaceRole.",
            "isAdmin()",
            "isInstanceAdmin()");

    @Test
    @DisplayName("no forbidden role/owner judgement outside the only-shrink whitelist")
    void controllerSourcesHaveNoUnlistedRoleOrOwnerJudgement() throws IOException {
        Map<String, Integer> allowed = allowedCounts();
        Map<String, Integer> actual = scanControllers();

        List<String> unlisted = new ArrayList<>();
        actual.forEach((key, count) -> {
            int budget = allowed.getOrDefault(key, 0);
            if (count > budget) {
                unlisted.add(key + " actual=" + count + " allowed=" + budget);
            }
        });
        assertThat(unlisted)
                .as("forbidden role/owner judgement outside the task-837 whitelist")
                .isEmpty();

        List<String> stale = new ArrayList<>();
        allowed.forEach((key, budget) -> {
            int count = actual.getOrDefault(key, 0);
            if (count != budget) {
                stale.add(key + " whitelist=" + budget + " actual=" + count);
            }
        });
        assertThat(stale)
                .as("whitelist must be tightened or pruned when a residue disappears (only-shrink)")
                .isEmpty();
    }

    @Test
    @DisplayName("whitelist entries carry reason + owner + reviewDate and never owner=task-859")
    void whitelistEntriesAreWitnessedAnd859Free() throws IOException {
        List<String> problems = new ArrayList<>();
        for (L1ScanWhitelist.Entry entry : L1ScanWhitelist.ENTRIES) {
            if (isBlank(entry.file()) || isBlank(entry.pattern()) || isBlank(entry.reason())) {
                problems.add(entry + " missing file/pattern/reason");
            }
            if (isBlank(entry.owner())) {
                problems.add(entry + " missing owner");
            } else if ("task-859".equals(entry.owner())) {
                problems.add(entry + " is owned by task-859, which must leave zero residues");
            }
            if (entry.allowed() <= 0) {
                problems.add(entry + " allowed must be a positive integer");
            }
            if (entry.reviewDate() == null || !entry.reviewDate().matches("^\\d{4}-\\d{2}-\\d{2}$")) {
                problems.add(entry + " reviewDate must be yyyy-MM-dd");
            }
        }
        assertThat(problems).as("whitelist entry contract").isEmpty();
    }

    @Test
    @DisplayName("scanner is falsifiable: detects code hits and ignores comment-only mentions")
    void scannerDetectsCodeAndIgnoresComments() {
        String snippet = """
                class Sample {
                    void a(String userId, String ownerId) {
                        if (userId.equals(ownerId)) { return; }
                    }
                    // userId.equals(ownerId) in a comment must not count
                    /* isAdmin() in a block comment must not count either */
                }
                """;
        assertThat(countInStrippedComments(snippet, "userId.equals("))
                .as("the real call must be detected")
                .isEqualTo(1);
        assertThat(countInStrippedComments(snippet, "isAdmin()"))
                .as("a comment-only mention must not be a hit")
                .isZero();
    }

    // ------------------------------------------------------------------ helpers

    private static Map<String, Integer> allowedCounts() {
        Map<String, Integer> allowed = new LinkedHashMap<>();
        for (L1ScanWhitelist.Entry entry : L1ScanWhitelist.ENTRIES) {
            allowed.merge(key(entry.file(), entry.pattern()), entry.allowed(), Integer::sum);
        }
        return allowed;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static Map<String, Integer> scanControllers() throws IOException {
        assertThat(Files.isDirectory(CONTROLLER_DIR))
                .as("controller source directory missing: %s", CONTROLLER_DIR.toAbsolutePath())
                .isTrue();
        Map<String, Integer> counts = new LinkedHashMap<>();
        try (var files = Files.list(CONTROLLER_DIR)) {
            List<Path> sources = files
                    .filter(path -> path.getFileName().toString().endsWith(".java"))
                    .sorted()
                    .toList();
            assertThat(sources).as("controller sources (a zero-file scan would be a false green)")
                    .isNotEmpty();
            for (Path source : sources) {
                String text = stripComments(Files.readString(source, StandardCharsets.UTF_8));
                for (String pattern : FORBIDDEN) {
                    int count = countOccurrences(text, pattern);
                    if (count > 0) {
                        counts.put(key(source.getFileName().toString(), pattern), count);
                    }
                }
            }
        }
        return counts;
    }

    private static String key(String file, String pattern) {
        return file + "::" + pattern;
    }

    private static int countInStrippedComments(String source, String pattern) {
        return countOccurrences(stripComments(source), pattern);
    }

    private static int countOccurrences(String text, String pattern) {
        int count = 0;
        int index = text.indexOf(pattern);
        while (index >= 0) {
            count++;
            index = text.indexOf(pattern, index + pattern.length());
        }
        return count;
    }

    /**
     * Removes {@code //} and {@code /* *}{@code /} comments while keeping newlines, and leaves string
     * and char literals intact (a forbidden role name inside a literal is still a role-name
     * judgement, so it must be counted).
     */
    static String stripComments(String source) {
        StringBuilder out = new StringBuilder(source.length());
        boolean inLineComment = false;
        boolean inBlockComment = false;
        boolean inString = false;
        boolean inChar = false;
        boolean escaped = false;
        for (int i = 0; i < source.length(); i++) {
            char c = source.charAt(i);
            char next = i + 1 < source.length() ? source.charAt(i + 1) : '\0';
            if (inLineComment) {
                if (c == '\n') {
                    inLineComment = false;
                    out.append(c);
                } else {
                    out.append(' ');
                }
                continue;
            }
            if (inBlockComment) {
                if (c == '*' && next == '/') {
                    inBlockComment = false;
                    out.append("  ");
                    i++;
                } else {
                    out.append(c == '\n' ? '\n' : ' ');
                }
                continue;
            }
            if (inString || inChar) {
                out.append(c);
                if (escaped) {
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (inString && c == '"') {
                    inString = false;
                } else if (inChar && c == '\'') {
                    inChar = false;
                }
                continue;
            }
            if (c == '/' && next == '/') {
                inLineComment = true;
                out.append("  ");
                i++;
            } else if (c == '/' && next == '*') {
                inBlockComment = true;
                out.append("  ");
                i++;
            } else {
                if (c == '"') {
                    inString = true;
                } else if (c == '\'') {
                    inChar = true;
                }
                out.append(c);
            }
        }
        return out.toString();
    }

}
