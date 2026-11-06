package com.cc01cc.p.xihe.cp.architecture;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.TreeMap;
import java.util.ArrayDeque;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CpArchitectureTest {

    private static JavaClasses production;

    @BeforeAll
    static void importProductionAndWriteBaseline() throws IOException {
        // ArchUnit 1.5.1's `DoNotIncludeTests` is a hardcoded `.*/target/test-classes/.*` pattern, so it
        // stops filtering as soon as the build output lives elsewhere — e.g. the opt-in
        // `-Dxihe.target.dir=C:/xihe-build/<lane>` isolation (packages/control-plane/AGENTS.md
        // §同 checkout 的两条 lane 并行) puts test classes under `<dir>/test-classes`. Importing them
        // makes this self-check (`assertFalse(production.contain(CpArchitectureTest.class))`) fail and
        // would also feed test fixtures into the rule baseline. Filter by path fragment instead: that
        // is build-dir agnostic and still excludes every test class.
        production = new ClassFileImporter()
                .withImportOption(location -> !location.contains("test-classes"))
                .importPackages("com.cc01cc.p.xihe.cp");
        assertTrue(production.contain("com.cc01cc.p.xihe.cp.context.ContextController"));
        assertTrue(production.contain("com.cc01cc.p.xihe.cp.chat.ChatRunTerminalService"));
        assertTrue(production.contain("com.cc01cc.p.xihe.cp.repository.SessionRepository"));
        assertFalse(production.contain(CpArchitectureTest.class));

        List<Map<String, Object>> rules = new ArrayList<>();
        List<DescribedPredicate<JavaClass>> origins = List.of(CpArchitectureRules.CONTROLLERS,
                CpArchitectureRules.APPLICATIONS, CpArchitectureRules.CONTROLLERS, CpArchitectureRules.PERSISTENCE,
                // PLAN-0470 #27: technical-facility isolation + persistence-below-services.
                DescribedPredicate.describe("crypto facility classes",
                        type -> type.getPackageName().startsWith("com.cc01cc.p.xihe.cp.crypto.")),
                CpArchitectureRules.REPOSITORIES);
        List<DescribedPredicate<JavaClass>> targets = List.of(CpArchitectureRules.CONTROLLERS,
                CpArchitectureRules.CONTROLLERS, CpArchitectureRules.REPOSITORIES, CpArchitectureRules.CONTROLLERS,
                CpArchitectureRules.CP_BUSINESS_PACKAGES, CpArchitectureRules.APPLICATIONS);
        for (int index = 0; index < CpArchitectureRules.ALL.size(); index++) {
            ArchRule rule = CpArchitectureRules.ALL.get(index);
            var origin = origins.get(index);
            var target = targets.get(index);
            var result = rule.evaluate(production);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("rule", rule.getDescription());
            row.put("violationCount", result.getFailureReport().getDetails().size());
            row.put("violations", result.getFailureReport().getDetails().stream().sorted().toList());
            row.put("classPairs", production.stream().filter(origin)
                    .flatMap(type -> type.getDirectDependenciesFromSelf().stream())
                    .filter(dependency -> target.test(dependency.getTargetClass()))
                    .map(dependency -> dependency.getOriginClass().getName() + " -> " + dependency.getTargetClass().getName())
                    .distinct().sorted().toList());
            rules.add(row);
        }
        Map<String, Object> baseline = new LinkedHashMap<>();
        baseline.put("importedProductionClasses", production.size());
        baseline.put("controllers", production.stream().filter(CpArchitectureRules.CONTROLLERS)
                .map(type -> type.getName()).sorted().toList());
        baseline.put("applications", production.stream().filter(CpArchitectureRules.APPLICATIONS)
                .map(type -> type.getName()).sorted().toList());
        baseline.put("repositories", production.stream().filter(CpArchitectureRules.REPOSITORIES)
                .map(type -> type.getName()).sorted().toList());
        baseline.put("rules", rules);
        var ownership = new CpModuleAssignment();
        baseline.put("ownership", production.stream().map(type -> Map.of("type", type.getName(), "owner", ownership.ownerOf(type)))
                .sorted(java.util.Comparator.comparing(row -> row.get("type"))).toList());
        Map<String, Set<String>> ownerGraph = new TreeMap<>();
        for (var type : production) {
            String from = ownership.ownerOf(type);
            ownerGraph.computeIfAbsent(from, key -> new TreeSet<>());
            for (var dependency : type.getDirectDependenciesFromSelf()) {
                String to = ownership.ownerOf(dependency.getTargetClass());
                if (to != null && !from.equals(to)) {
                    ownerGraph.get(from).add(to);
                    ownerGraph.computeIfAbsent(to, key -> new TreeSet<>());
                }
            }
        }
        baseline.put("typeOwnerGraph", ownerGraph);
        baseline.put("stronglyConnectedTypeOwnerComponents", stronglyConnectedOwners(ownerGraph));
        var cycles = slices().assignedFrom(ownership).should().beFreeOfCycles().evaluate(production);
        baseline.put("ownerTypeCycleDiagnostics", cycles.getFailureReport().getDetails());
        baseline.put("cycleDiagnosticsAreTypeDependenciesNotProvenStateWriterCycles", true);
        baseline.put("cycleDetectionLimit", com.tngtech.archunit.ArchConfiguration.get()
                .getPropertyOrDefault("cycles.maxNumberToDetect", "library default"));
        Path report = Path.of("target", "cp-architecture", "baseline.json");
        Files.createDirectories(report.getParent());
        new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(report.toFile(), baseline);
        System.out.println("CP architecture baseline: " + production.size() + " production classes; " + report);
    }

    static List<List<String>> stronglyConnectedOwners(Map<String, Set<String>> graph) {
        Set<String> remaining = new TreeSet<>(graph.keySet());
        List<List<String>> groups = new ArrayList<>();
        while (!remaining.isEmpty()) {
            String first = remaining.iterator().next();
            List<String> component = remaining.stream()
                    .filter(node -> reaches(graph, first, node) && reaches(graph, node, first)).toList();
            remaining.removeAll(component);
            if (component.size() > 1) {
                groups.add(component);
            }
        }
        return groups;
    }

    private static boolean reaches(Map<String, Set<String>> graph, String from, String target) {
        Set<String> seen = new TreeSet<>();
        var pending = new ArrayDeque<String>();
        pending.add(from);
        while (!pending.isEmpty()) {
            String node = pending.removeFirst();
            if (node.equals(target)) {
                return true;
            }
            if (seen.add(node)) {
                pending.addAll(graph.getOrDefault(node, Set.of()));
            }
        }
        return false;
    }

    @Test
    void controllersDoNotDependOnControllers() {
        CpArchitectureRules.CONTROLLER_TO_CONTROLLER.check(production);
    }

    @Test
    void applicationsDoNotDependOnControllers() {
        CpArchitectureRules.APPLICATION_TO_CONTROLLER.check(production);
    }

    @Test
    void controllersDoNotDependOnRepositories() {
        CpArchitectureRules.CONTROLLER_TO_REPOSITORY.check(production);
    }

    /**
     * BL-370: an exemption for a class that no longer exists is a dead hole in the rule. The exact
     * set is asserted so adding one requires a deliberate edit here (plus a reason in the commit);
     * shrinking it is equally deliberate. reviewBy 2026-12-06.
     */
    @Test
    void controllerRepositoryExemptionsStillExistAndAreControllers() throws Exception {
        var expected = java.util.Set.of(
                "com.cc01cc.p.xihe.cp.chat.DelegationController",
                "com.cc01cc.p.xihe.cp.chat.RunContextFingerprintController");
        assertThat(CpArchitectureRules.CONTROLLER_REPOSITORY_EXEMPTIONS)
                .as("BL-370 exemption list may only change deliberately (add: justify in commit)")
                .containsExactlyInAnyOrderElementsOf(expected);
        for (String name : CpArchitectureRules.CONTROLLER_REPOSITORY_EXEMPTIONS) {
            Class<?> type = Class.forName(name);
            assertThat(type.isAnnotationPresent(org.springframework.web.bind.annotation.RestController.class)
                    || type.isAnnotationPresent(org.springframework.stereotype.Controller.class))
                    .as("%s must still be an HTTP controller; otherwise delete its BL-370 exemption", name)
                    .isTrue();
        }
    }

    @Test
    void persistenceDoesNotDependOnControllers() {
        CpArchitectureRules.PERSISTENCE_TO_CONTROLLER.check(production);
    }
}
