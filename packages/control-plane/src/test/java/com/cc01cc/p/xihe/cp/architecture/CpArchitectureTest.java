package com.cc01cc.p.xihe.cp.architecture;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
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

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CpArchitectureTest {

    private static JavaClasses production;

    @BeforeAll
    static void importProductionAndWriteBaseline() throws IOException {
        production = new ClassFileImporter().withImportOption(new ImportOption.DoNotIncludeTests())
                .importPackages("com.cc01cc.p.xihe.cp");
        assertTrue(production.contain("com.cc01cc.p.xihe.cp.context.ContextController"));
        assertTrue(production.contain("com.cc01cc.p.xihe.cp.chat.ChatRunTerminalService"));
        assertTrue(production.contain("com.cc01cc.p.xihe.cp.repository.SessionRepository"));
        assertFalse(production.contain(CpArchitectureTest.class));

        List<Map<String, Object>> rules = new ArrayList<>();
        List<DescribedPredicate<JavaClass>> origins = List.of(CpArchitectureRules.CONTROLLERS,
                CpArchitectureRules.APPLICATIONS, CpArchitectureRules.CONTROLLERS, CpArchitectureRules.PERSISTENCE);
        List<DescribedPredicate<JavaClass>> targets = List.of(CpArchitectureRules.CONTROLLERS,
                CpArchitectureRules.CONTROLLERS, CpArchitectureRules.REPOSITORIES, CpArchitectureRules.CONTROLLERS);
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

    @Test
    void persistenceDoesNotDependOnControllers() {
        CpArchitectureRules.PERSISTENCE_TO_CONTROLLER.check(production);
    }
}
