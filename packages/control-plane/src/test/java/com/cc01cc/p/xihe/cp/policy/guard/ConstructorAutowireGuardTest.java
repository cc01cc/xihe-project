package com.cc01cc.p.xihe.cp.policy.guard;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * task-868: a Spring bean with two or more constructors and no {@code @Autowired} makes Spring fall
 * back to a no-argument constructor; the bean cannot be created and every {@code @SpringBootTest}
 * context dies. task-859 introduced exactly that in {@code WorkspaceController} (a four-argument
 * constructor plus a three-argument test seam), and the repository already documented the rule in
 * {@code chat/UserQuestionService}: "The {@code @Autowired} is required because the clock seam below
 * adds a second constructor". A rule that only lives in comments was missed once — so it is scanned
 * here.
 *
 * <p>Scope (the card's): {@code src/main/java/**}{@code /controller/*.java} and
 * {@code .../service/*.java}. For each file, constructors are counted on comment-stripped source;
 * a file with {@code >= 2} constructors and no {@code @Autowired} fails unless whitelisted.</p>
 *
 * <p>Falsifiability (§3.2): {@link #scannerFlagsTwoConstructorsWithoutAutowired()} feeds synthetic
 * sources — a two-constructor class without the annotation must be flagged, the same class with
 * {@code @Autowired} must not, and a single-constructor class must not — so a scanner that matches
 * nothing cannot pass this class. The card also requires a live counterproof (a temporary offending
 * class in the real tree); that reading is recorded in
 * {@code internal/A03-xihe/evidence/2026-11-23-cp-boot-fix/README.md}.</p>
 */
class ConstructorAutowireGuardTest {

    private static final Path MAIN_JAVA = Path.of("src", "main", "java");

    @Test
    @DisplayName("no bean under controller/ or service/ has >=2 constructors without @Autowired")
    void scannedBeansHaveNoUnlistedAmbiguousConstructor() throws IOException {
        ScanResult scan = scan();

        assertThat(scan.controllerSources())
                .as("scanned controller/service sources (a zero-file scan would be a false green)")
                .isGreaterThan(0);
        assertThat(scan.serviceSources() + scan.controllerSources())
                .as("scanned controller/service sources (a zero-file scan would be a false green)")
                .isGreaterThan(0);
        assertThat(scan.serviceSources())
                .as("service/ sources must be present so the scan cannot silently skip the bug class")
                .isGreaterThan(0);

        List<String> unlisted = new ArrayList<>();
        for (String violation : scan.violations()) {
            String fileName = violation.substring(violation.indexOf('/') + 1, violation.indexOf(" ctors="));
            if (!whitelisted(fileName)) {
                unlisted.add(violation);
            }
        }
        assertThat(unlisted)
                .as("two or more constructors and no @Autowired — Spring would look for a no-arg "
                        + "constructor and fail the whole context (add @Autowired or delete the seam)")
                .isEmpty();

        List<String> stale = new ArrayList<>();
        for (ConstructorAutowireWhitelist.Entry entry : ConstructorAutowireWhitelist.ENTRIES) {
            boolean reproduces = scan.scannedFileNames().contains(entry.file());
            if (!reproduces) {
                stale.add(entry.file());
            }
        }
        assertThat(stale)
                .as("whitelist must be pruned when the offending shape disappears (only-shrink)")
                .isEmpty();
    }

    @Test
    @DisplayName("whitelist entries carry reason + owner + reviewDate and never owner=task-868")
    void whitelistEntriesAreWitnessed() {
        List<String> problems = new ArrayList<>();
        for (ConstructorAutowireWhitelist.Entry entry : ConstructorAutowireWhitelist.ENTRIES) {
            if (isBlank(entry.file())) {
                problems.add(entry + " missing file");
            }
            if (isBlank(entry.reason())) {
                problems.add(entry + " missing reason");
            }
            if (isBlank(entry.owner())) {
                problems.add(entry + " missing owner");
            } else if ("task-868".equals(entry.owner())) {
                problems.add(entry + " is owned by task-868, which must leave zero hits");
            }
            if (entry.reviewDate() == null || !entry.reviewDate().matches("^\\d{4}-\\d{2}-\\d{2}$")) {
                problems.add(entry + " reviewDate must be yyyy-MM-dd");
            }
        }
        assertThat(problems).as("whitelist entry contract").isEmpty();
    }

    @Test
    @DisplayName("scanner is falsifiable: flags 2 constructors without @Autowired, not the @Autowired twin")
    void scannerFlagsTwoConstructorsWithoutAutowired() {
        String twoConstructors = """
                class Sample {
                    Sample(String a) { }
                    Sample(String a, String b) { }
                }
                """;
        assertThat(violates(twoConstructors, "Sample"))
                .as("two constructors and no @Autowired must be flagged")
                .isTrue();

        String annotated = """
                class Sample {
                    @org.springframework.beans.factory.annotation.Autowired
                    Sample(String a) { }
                    Sample(String a, String b) { }
                }
                """;
        assertThat(violates(annotated, "Sample"))
                .as("one @Autowired constructor makes the choice explicit")
                .isFalse();

        String single = """
                class Sample {
                    Sample(String a) { }
                }
                """;
        assertThat(violates(single, "Sample"))
                .as("a single constructor needs no annotation")
                .isFalse();

        String commentOnly = """
                class Sample {
                    // Sample(String a) { }
                    Sample(String a, String b) { }
                }
                """;
        assertThat(constructorCount(commentOnly, "Sample"))
                .as("a constructor mentioned only in a comment is not a declaration")
                .isEqualTo(1);
    }

    // ------------------------------------------------------------------ helpers

    /** Counts of scanned sources plus one {@code scope/file ctors=n} line per violation. */
    private record ScanResult(int controllerSources, int serviceSources,
                              List<String> violations, Set<String> scannedFileNames) {
    }

    private static ScanResult scan() throws IOException {
        assertThat(Files.isDirectory(MAIN_JAVA))
                .as("main source root missing: %s", MAIN_JAVA.toAbsolutePath())
                .isTrue();
        int controllerSources = 0;
        int serviceSources = 0;
        List<String> violations = new ArrayList<>();
        Set<String> scannedFileNames = new java.util.LinkedHashSet<>();
        try (Stream<Path> walk = Files.walk(MAIN_JAVA)) {
            for (Path path : walk.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".java"))
                    .toList()) {
                String scope = scopeOf(path);
                if (scope == null) {
                    continue;
                }
                if ("controller".equals(scope)) {
                    controllerSources++;
                } else {
                    serviceSources++;
                }
                String fileName = path.getFileName().toString();
                scannedFileNames.add(fileName);
                String simple = simpleName(path.getFileName().toString());
                if (violates(read(path), simple)) {
                    violations.add(scope + "/" + fileName + " ctors="
                            + constructorCount(read(path), simple));
                }
            }
        }
        return new ScanResult(controllerSources, serviceSources, violations, scannedFileNames);
    }

    /** Only direct children of a directory literally named {@code controller} or {@code service}. */
    private static String scopeOf(Path path) {
        Path parent = path.getParent();
        if (parent == null || parent.getFileName() == null) {
            return null;
        }
        String dir = parent.getFileName().toString();
        return ("controller".equals(dir) || "service".equals(dir)) ? dir : null;
    }

    private static boolean whitelisted(String fileName) {
        return ConstructorAutowireWhitelist.ENTRIES.stream()
                .anyMatch(entry -> fileName.equals(entry.file()));
    }

    private static String read(Path path) throws IOException {
        return Files.readString(path, StandardCharsets.UTF_8);
    }

    private static boolean violates(String source, String simpleName) {
        return constructorCount(source, simpleName) >= 2 && !hasAutowired(source);
    }

    static int constructorCount(String source, String simpleName) {
        String text = L1ControllerSourceScanGuardTest.stripComments(source);
        Matcher matcher = Pattern.compile("\\b" + Pattern.quote(simpleName) + "\\s*\\(").matcher(text);
        int count = 0;
        while (matcher.find()) {
            String before = text.substring(Math.max(0, matcher.start() - 32), matcher.start());
            if (before.matches("(?s).*\\bnew\\s+$") || before.matches("(?s).*\\.\\s*$")) {
                continue; // a call/instantiation, not a declaration
            }
            count++;
        }
        return count;
    }

    static boolean hasAutowired(String source) {
        return L1ControllerSourceScanGuardTest.stripComments(source).matches("(?s).*\\bAutowired\\b.*");
    }

    private static String simpleName(String fileName) {
        return fileName.endsWith(".java")
                ? fileName.substring(0, fileName.length() - ".java".length())
                : fileName;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
