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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * task-886 outward role vocabulary residue gate.
 *
 * <p>{@code task-880} renamed the outward segments {@code /roles -> /presets} and
 * {@code role-bindings -> preset-bindings}. This gate keeps that rename from regressing on the
 * <b>outward</b> faces:</p>
 * <ul>
 *   <li>{@code docs/api/openapi.yaml} and {@code docs/api/inventory*.md};</li>
 *   <li>{@code docs/i18n/**} and {@code spec/**} route spellings;</li>
 *   <li>{@code packages/ui/src/**} and {@code packages/ui/e2e/**} URL text;</li>
 *   <li>{@code @*Mapping("...")} route arguments under CP {@code src/main/java}.</li>
 * </ul>
 *
 * <p><b>Deliberately out of scope</b> (BL-638): internal identifiers {@code roleId}/{@code roleIds}
 * and the {@code AgentRoleBindingsSection.vue} {@code data-testid}. The forbidden spellings are
 * {@code /roles\b} and {@code role-bindings}; a camel-case {@code roleId} or an underscore
 * {@code role_bindings} cannot match, so the gate does not force the component layer to rename
 * what was intentionally left alone.</p>
 *
 * <p><b>Only-shrink</b>: {@link OutwardRoleVocabularyWhitelist} is empty because the rename
 * baseline is zero; any hit fails. A future entry must carry {@code reason + owner + reviewDate}
 * and must be deleted once it stops reproducing.</p>
 *
 * <p>Falsifiability: the synthetic snippets below prove a scanner that matches nothing cannot
 * pass, that a controller {@code @*Mapping} is caught, and that {@code roleId} stays green.</p>
 */
class OutwardRoleVocabularyGuardTest {

    private static final Pattern FORBIDDEN = Pattern.compile("/roles\\b|role-bindings");
    private static final Pattern MAPPING_NAME =
            Pattern.compile("@(?:Get|Post|Put|Patch|Delete|Request)Mapping\\b");
    private static final Path REPO_ROOT = Path.of("..", "..").toAbsolutePath().normalize();
    private static final Path CP_MAIN_JAVA =
            REPO_ROOT.resolve("packages/control-plane/src/main/java");
    private static final List<String> UI_EXTENSIONS =
            List.of(".ts", ".tsx", ".js", ".mjs", ".cjs", ".vue", ".json");
    private static final List<String> TEXT_EXTENSIONS =
            List.of(".md", ".json", ".yaml", ".yml", ".txt");

    @Test
    @DisplayName("no outward role vocabulary outside the only-shrink whitelist")
    void outwardFacesHaveNoUnlistedRoleVocabulary() throws IOException {
        List<Hit> hits = scanAllFaces();
        Map<String, Integer> actual = countByKey(hits);
        Map<String, Integer> allowed = allowedCounts();

        List<String> unlisted = new ArrayList<>();
        List<String> report = new ArrayList<>();
        actual.forEach((key, count) -> {
            int budget = allowed.getOrDefault(key, 0);
            if (count > budget) {
                unlisted.add(key + " actual=" + count + " allowed=" + budget);
            }
        });
        for (Hit hit : hits) {
            String key = key(hit.file(), hit.pattern());
            if (actual.getOrDefault(key, 0) > allowed.getOrDefault(key, 0)) {
                report.add(hit.file() + ":" + hit.line() + ": " + hit.text());
            }
        }
        assertThat(unlisted)
                .as("outward role vocabulary residues (task-886); expected 0, found:\n  %s",
                        String.join("\n  ", report))
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
    @DisplayName("whitelist entries carry reason + owner + reviewDate")
    void whitelistEntriesAreWitnessed() {
        List<String> problems = new ArrayList<>();
        for (OutwardRoleVocabularyWhitelist.Entry entry :
                OutwardRoleVocabularyWhitelist.ENTRIES) {
            if (isBlank(entry.file()) || isBlank(entry.pattern()) || isBlank(entry.reason())) {
                problems.add(entry + " missing file/pattern/reason");
            }
            if (isBlank(entry.owner())) {
                problems.add(entry + " missing owner");
            }
            if (entry.allowed() <= 0) {
                problems.add(entry + " allowed must be a positive integer");
            }
            if (entry.reviewDate() == null
                    || !entry.reviewDate().matches("^\\d{4}-\\d{2}-\\d{2}$")) {
                problems.add(entry + " reviewDate must be yyyy-MM-dd");
            }
        }
        assertThat(problems).as("whitelist entry contract").isEmpty();
    }

    @Test
    @DisplayName("scanner is falsifiable: catches a URL spelling and ignores internal roleId")
    void scannerDetectsUrlSpellingAndIgnoresRoleId() {
        String snippet = """
                const legacyRoles = "/api/v1/roles";
                const legacyBindings = `/api/v1/agent-principals/${id}/role-bindings`;
                const roleId = "internal-only";
                const roleIds = [roleId];
                const current = "/api/v1/presets";
                """;
        List<Hit> hits = scanTextLines("api.ts", snippet);
        assertThat(hits)
                .as("exactly the two outward spellings, never roleId/roleIds")
                .extracting(Hit::pattern)
                .containsExactlyInAnyOrder("/roles", "role-bindings");
    }

    @Test
    @DisplayName("scanner is falsifiable: catches @*Mapping routes but not comment examples")
    void scannerDetectsJavaMappingButIgnoresComments() {
        String snippet = """
                class Sample {
                    // @PutMapping("/roles") in a comment must not count
                    @PutMapping("/{unitId}/role-bindings")
                    void renamed() {
                    }
                }
                """;
        List<Hit> hits = scanJavaMappings("OrgUnitController.java", snippet);
        assertThat(hits).extracting(Hit::pattern).containsExactly("role-bindings");
    }

    // ------------------------------------------------------------------ scanning

    private static List<Hit> scanAllFaces() throws IOException {
        List<Hit> hits = new ArrayList<>();

        Path openapi = REPO_ROOT.resolve("docs/api/openapi.yaml");
        assertThat(Files.isRegularFile(openapi))
                .as("outward face missing: %s", openapi)
                .isTrue();
        hits.addAll(scanTextFile(openapi));

        List<Path> inventory = listFiles(REPO_ROOT.resolve("docs/api"), path -> {
            String name = path.getFileName().toString();
            return name.startsWith("inventory") && name.endsWith(".md");
        });
        assertThat(inventory).as("docs/api/inventory*.md face is empty").isNotEmpty();
        for (Path path : inventory) {
            hits.addAll(scanTextFile(path));
        }

        for (String face : List.of("docs/i18n", "spec")) {
            List<Path> files = listTree(REPO_ROOT.resolve(face), TEXT_EXTENSIONS);
            assertThat(files).as("outward face docs tree is empty: %s", face).isNotEmpty();
            for (Path path : files) {
                hits.addAll(scanTextFile(path));
            }
        }

        for (String face : List.of("packages/ui/src", "packages/ui/e2e")) {
            List<Path> files = listTree(REPO_ROOT.resolve(face), UI_EXTENSIONS);
            assertThat(files).as("outward UI face is empty: %s", face).isNotEmpty();
            for (Path path : files) {
                hits.addAll(scanTextFile(path));
            }
        }

        List<Path> java = listTree(CP_MAIN_JAVA, List.of(".java"));
        assertThat(java).as("CP src/main/java face is empty").isNotEmpty();
        for (Path path : java) {
            hits.addAll(scanJavaMappings(display(path), read(path)));
        }
        return hits;
    }

    private static List<Hit> scanTextFile(Path path) throws IOException {
        return scanTextLines(display(path), read(path));
    }

    private static List<Hit> scanTextLines(String displayFile, String text) {
        List<Hit> hits = new ArrayList<>();
        String[] lines = text.split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            Matcher matcher = FORBIDDEN.matcher(lines[i]);
            while (matcher.find()) {
                hits.add(new Hit(displayFile, i + 1, matcher.group(), lines[i].strip()));
            }
        }
        return hits;
    }

    private static List<Hit> scanJavaMappings(String displayFile, String source) {
        List<Hit> hits = new ArrayList<>();
        String stripped = stripComments(source);
        String[] originalLines = source.split("\n", -1);
        int cursor = 0;
        while (cursor < stripped.length()) {
            Matcher name = MAPPING_NAME.matcher(stripped);
            name.region(cursor, stripped.length());
            if (!name.find()) {
                break;
            }
            int open = stripped.indexOf('(', name.end());
            int close = open < 0 ? -1 : matchingParen(stripped, open);
            if (close < 0) {
                cursor = name.end();
                continue;
            }
            String arguments = stripped.substring(open + 1, close);
            Matcher matcher = FORBIDDEN.matcher(arguments);
            while (matcher.find()) {
                int line = lineOf(stripped, open + 1 + matcher.start());
                String text = line <= originalLines.length
                        ? originalLines[line - 1].strip()
                        : arguments.strip();
                hits.add(new Hit(displayFile, line, matcher.group(), text));
            }
            cursor = close + 1;
        }
        return hits;
    }

    // ------------------------------------------------------------------ helpers

    private record Hit(String file, int line, String pattern, String text) {
    }

    private static Map<String, Integer> allowedCounts() {
        Map<String, Integer> allowed = new LinkedHashMap<>();
        for (OutwardRoleVocabularyWhitelist.Entry entry :
                OutwardRoleVocabularyWhitelist.ENTRIES) {
            allowed.merge(key(entry.file(), entry.pattern()), entry.allowed(), Integer::sum);
        }
        return allowed;
    }

    private static Map<String, Integer> countByKey(List<Hit> hits) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Hit hit : hits) {
            counts.merge(key(hit.file(), hit.pattern()), 1, Integer::sum);
        }
        return counts;
    }

    private static String key(String file, String pattern) {
        return file + "::" + pattern;
    }

    private static List<Path> listFiles(Path dir, java.util.function.Predicate<Path> filter)
            throws IOException {
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        try (Stream<Path> stream = Files.list(dir)) {
            return stream.filter(Files::isRegularFile).filter(filter).sorted().toList();
        }
    }

    private static List<Path> listTree(Path root, List<String> extensions) throws IOException {
        if (!Files.isDirectory(root)) {
            return List.of();
        }
        try (Stream<Path> stream = Files.walk(root)) {
            return stream
                    .filter(Files::isRegularFile)
                    .filter(path -> extensions.stream()
                            .anyMatch(ext -> path.getFileName().toString().endsWith(ext)))
                    .sorted()
                    .toList();
        }
    }

    private static String read(Path path) throws IOException {
        return Files.readString(path, StandardCharsets.UTF_8);
    }

    private static String display(Path path) {
        Path absolute = path.toAbsolutePath().normalize();
        Path relative = absolute.startsWith(REPO_ROOT) ? REPO_ROOT.relativize(absolute) : absolute;
        return relative.toString().replace('\\', '/');
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static int lineOf(String text, int index) {
        int line = 1;
        for (int i = 0; i < index && i < text.length(); i++) {
            if (text.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
    }

    private static int matchingParen(String text, int open) {
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = open; i < text.length(); i++) {
            char c = text.charAt(i);
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (c == '"') {
                    inString = false;
                }
                continue;
            }
            if (c == '"') {
                inString = true;
            } else if (c == '(') {
                depth++;
            } else if (c == ')') {
                depth--;
                if (depth == 0) {
                    return i;
                }
            }
        }
        return -1;
    }

    /** Removes Java line/block comments while keeping newlines and string literals intact. */
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
