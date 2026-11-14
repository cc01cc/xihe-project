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
import java.util.LinkedHashMap;
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
    private static final String[] NON_WRITE_PUBLIC_METHODS = {"getRecentRecords"};

    @Test
    void auditWriteEntryPointsAreEnumeratedFromTheClassNotFromAGrepList() throws IOException {
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

        int foreign = 0;
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
                    if (name.equals("getRecentRecords")) {
                        continue; // read face, not a write entry point
                    }
                    foreign++;
                    continue;
                }
                callSites.merge(name, 1, Integer::sum);
                callers.merge(name, javaClass.getSimpleName() + ":" + call.getSourceCodeLocation().getLineNumber() + ";", String::concat);
            }
        }

        // The class is the source of truth: every declared write method must be in the report, and the
        // report must not contain entry points the class no longer has.
        java.util.Set<String> declaredPublicMethods = new java.util.HashSet<>();
        for (JavaMethod method : auditLogger.getMethods()) {
            if (method.getModifiers().contains(com.tngtech.archunit.core.domain.JavaModifier.PUBLIC)) {
                declaredPublicMethods.add(method.getName());
            }
        }
        java.util.Set<String> registered = new java.util.HashSet<>(java.util.Arrays.asList(WRITE_ENTRY_POINTS));
        registered.addAll(java.util.Arrays.asList(NON_WRITE_PUBLIC_METHODS));
        assertThat(declaredPublicMethods).as(
                "every public method of AuditLogger must be registered as a write entry point or as a"
                        + " declared read face; a new public write method must fail here first")
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

        Path out = Path.of("target", "audit-entry-points.json");
        Files.createDirectories(out.getParent());
        Files.writeString(out, json.toString(), StandardCharsets.UTF_8);
        // Caller detail for the re-classification batches; gitignored target artefact, not evidence.
        Path detail = Path.of("target", "audit-entry-points-callers.txt");
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : callers.entrySet()) {
            sb.append(e.getKey()).append(" => ").append(e.getValue()).append('\n');
        }
        Files.writeString(detail, sb.toString(), StandardCharsets.UTF_8);

        assertThat(total).as("total audit call sites resolved by receiver type").isPositive();
        assertThat(foreign).as("calls to AuditLogger methods outside the write entry-point list").isZero();
    }
}
