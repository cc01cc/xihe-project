package com.cc01cc.p.xihe.cp.audit;

import static org.assertj.core.api.Assertions.assertThat;

import com.tngtech.archunit.core.domain.JavaCall;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.domain.JavaMethod;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;

/**
 * task-579: the audit write faces of {@link AuditLogger} must be enumerated from the class itself,
 * never from a hand written list, and call sites must be resolved <b>by receiver type</b>.
 *
 * <p>Why the second half matters: grepping {@code ".record(" } counts every unrelated {@code record}
 * method in the tree (measured 2026-11-14: 69 hits, of which almost none target AuditLogger), and
 * grepping a method name twice gave two different numbers for the same method (72 vs 73). ArchUnit
 * resolves the receiver type from bytecode, so this class is both the instrument and the gate.</p>
 */
class AuditEntryPointInventoryTest {

    /** Entry points that write; readers are excluded by name and asserted absent from the report. */
    private static final String[] WRITE_ENTRY_POINTS = {
            "record",
            "recordConfigExport",
            "recordCredentialEvent",
            "recordCredentialRotation",
            "recordAuthEvent",
            "recordDurableChange"
    };

    /**
     * Read faces are declared here on purpose: the point is that <b>every</b> public method of
     * {@link AuditLogger} is accounted for, so a newly added write entry point turns this red
     * instead of silently escaping the inventory.
     */
    /**
     * Where the inventory artefacts go.
     *
     * <p>Derived from this class's own code source ({@code <build>/test-classes}), so it follows
     * {@code -Dxihe.target.dir} / {@code -Dxihe.build.suffix} instead of a hard coded {@code target/}.
     * {@code -Dxihe.audit.inventory.dir=<dir>} overrides it explicitly.</p>
     */
    private static Path outputDirectory() throws java.net.URISyntaxException {
        String override = System.getProperty("xihe.audit.inventory.dir");
        if (override != null && !override.isBlank()) {
            return Path.of(override);
        }
        var location = AuditEntryPointInventoryTest.class.getProtectionDomain().getCodeSource().getLocation();
        Path buildDir = Path.of(location.toURI()).getParent();
        return buildDir != null ? buildDir : Path.of(".");
    }

    private static final String[] NON_WRITE_PUBLIC_METHODS = {
            "getRecentRecords", // read face: query the audit table
            "escapeField"       // task-598: static value escaper (task-575), neither writes nor reads a row
    };

    @Test
    void auditWriteEntryPointsAreEnumeratedFromTheClassNotFromAGrepList()
            throws IOException, java.net.URISyntaxException {
        JavaClasses classes = new ClassFileImporter()
                .withImportOption(new ImportOption.DoNotIncludeTests())
                .importPackages("com.cc01cc.p.xihe.cp");
        JavaClass auditLogger = classes.get(AuditLogger.class);

        Map<String, Integer> callSites = new TreeMap<>();
        Map<String, String> callers = new TreeMap<>();
        for (String entry : WRITE_ENTRY_POINTS) {
            callSites.put(entry, 0);
            callers.put(entry, "");
        }

        // The class is the source of truth for `public`: computed before the call scan so a call to a
        // non-public helper (e.g. the package-private sanitize(), called from its own package's test)
        // cannot be mistaken for an unregistered entry point.
        java.util.Set<String> declaredPublicMethods = new java.util.HashSet<>();
        for (JavaMethod method : auditLogger.getMethods()) {
            if (method.getModifiers().contains(com.tngtech.archunit.core.domain.JavaModifier.PUBLIC)) {
                declaredPublicMethods.add(method.getName());
            }
        }

        // task-598 follow-up (2026-11-18, cp-2): the sentinel above hit its own documented branch --
        // DoNotIncludeTests() now drops the test surface on this toolchain (ArchUnit on Java 25), so the
        // manual location filter was deleted as the in-code instruction says. Main-only scope is trusted
        // to the import option again.

        int foreign = 0;
        java.util.Set<String> foreignNames = new java.util.TreeSet<>();
        for (JavaClass javaClass : classes) {
            if (javaClass.getName().equals(AuditLogger.class.getName())) {
                continue;
            }
            for (JavaCall<?> call : javaClass.getMethodCallsFromSelf()) {
                String owner = call.getTarget().getOwner().getName();
                if (!owner.equals(AuditLogger.class.getName())) {
                    continue;
                }
                String name = call.getTarget().getName();
                if (!callSites.containsKey(name)) {
                    if (java.util.Arrays.asList(NON_WRITE_PUBLIC_METHODS).contains(name)) {
                        continue; // declared non-write face, not a write entry point
                    }
                    if (!declaredPublicMethods.contains(name)) {
                        continue; // task-598: a non-public method cannot be an entry point
                    }
                    foreign++;
                    foreignNames.add(name + " <- " + javaClass.getSimpleName() + ":"
                            + call.getSourceCodeLocation().getLineNumber());
                    continue;
                }
                callSites.merge(name, 1, Integer::sum);
                callers.merge(name, javaClass.getSimpleName() + ":" + call.getSourceCodeLocation().getLineNumber() + ";", String::concat);
            }
        }

        // The class is the source of truth: every declared write method must be in the report, and the
        // report must not contain entry points the class no longer has.
        java.util.Set<String> registered = new java.util.HashSet<>(java.util.Arrays.asList(WRITE_ENTRY_POINTS));
        registered.addAll(java.util.Arrays.asList(NON_WRITE_PUBLIC_METHODS));
        assertThat(declaredPublicMethods).as(
                "every public method of AuditLogger must be registered as a write entry point or as a"
                        + " declared non-write face (task-598: escapeField turned this red for exactly"
                        + " that reason). THIS RED IS CORRECT: it means a new public method escaped the"
                        + " inventory, not that the gate is broken -- register it above")
                .isSubsetOf(registered);
        assertThat(registered).as("registered methods actually exist on AuditLogger")
                .isSubsetOf(declaredPublicMethods);

        StringBuilder json = new StringBuilder("{\n");
        int total = 0;
        for (Map.Entry<String, Integer> e : callSites.entrySet()) {
            total += e.getValue();
            json.append("  \"").append(e.getKey()).append("\": ").append(e.getValue())
                    .append(",\n");
        }
        json.append("  \"_total\": ").append(total).append(",\n");
        json.append("  \"_foreignEntryPoints\": ").append(foreign).append("\n}\n");

        // task-607: the artefacts follow the real build output, never a hard coded target/. Two lanes
        // building into different directories must each read their own file.
        Path outputDir = outputDirectory();
        Files.createDirectories(outputDir);
        Path out = outputDir.resolve("audit-entry-points.json");
        Files.writeString(out, json.toString(), StandardCharsets.UTF_8);
        System.out.println("wrote " + out.toAbsolutePath());
        // Caller detail for the re-classification batches; gitignored build artefact, not evidence.
        Path detail = outputDir.resolve("audit-entry-points-callers.txt");
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : callers.entrySet()) {
            sb.append(e.getKey()).append(" => ").append(e.getValue()).append('\n');
        }
        Files.writeString(detail, sb.toString(), StandardCharsets.UTF_8);
        System.out.println("wrote " + detail.toAbsolutePath());

        assertThat(total).as("total audit call sites resolved by receiver type").isPositive();
        assertThat(foreign).as("calls to AuditLogger methods outside the write entry-point list: %s",
                foreignNames).isZero();
    }
}
