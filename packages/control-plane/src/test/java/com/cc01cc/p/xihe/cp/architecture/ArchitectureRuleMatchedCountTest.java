package com.cc01cc.p.xihe.cp.architecture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.BadController;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.GoodController;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.ProbeEntity;
import com.cc01cc.p.xihe.cp.chat.ChatRunReadService;
import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * task-617: a green architecture gate must be distinguishable from "the rule checked nothing".
 *
 * <p>ArchUnit lets a rule pass when its {@code that()} clause selects no class at all
 * ({@code allowEmptyShould(true)}). Two rules here carried that flag unconditionally, so the suite was
 * green whether the production type graph was compliant or a rename had emptied the rule target set.
 * Same family as task-598 (a silently over-counting instrument) and task-611 (a shard partition nobody
 * verified): nothing errors, only the numbers stop meaning what the green suggests.</p>
 *
 * <p>Split by path, one fixture each:</p>
 * <ul>
 *   <li><b>full import</b> - {@link CpArchitectureRules#forFullImport}: every rule must select at least
 *       one production class, and the count is printed as {@code matched=<n>} so the reading is quotable.</li>
 *   <li><b>probe subset</b> - {@link CpArchitectureRules#forProbeSubset}: a fixture set legitimately has
 *       no crypto class or repository, so emptiness is tolerated <i>there only</i>.</li>
 * </ul>
 *
 * <p>Which path a rule runs on is an explicit call in the caller, no longer a flag buried in the rule.</p>
 */
class ArchitectureRuleMatchedCountTest {

    @Test
    void everyClassLevelRuleReportsHowManyProductionClassesItSelects() {
        JavaClasses production = production();
        assertThat(production).as("production import is not empty").isNotEmpty();

        Map<String, Long> matched = new LinkedHashMap<>();
        for (Map.Entry<ArchRule, DescribedPredicate<JavaClass>> entry
                : CpArchitectureRules.CLASS_TARGETS.entrySet()) {
            String description = entry.getKey().getDescription();
            long count = production.stream().filter(entry.getValue()).count();
            matched.put(description, count);
            System.out.println("archunit rule matched: " + description + " matched=" + count);
            assertThat(count).as("rule [%s] selects 0 production classes; a green gate would then mean"
                    + " \"nothing was checked\", not \"everything is compliant\". Fix the rule scope or"
                    + " state in the class comment why 0 is correct", description).isPositive();
        }
        for (ArchRule rule : CpArchitectureRules.ALL) {
            assertThat(matched.keySet()).as("class-level rule [%s] has a recorded target predicate",
                    rule.getDescription()).contains(rule.getDescription());
        }
    }

    @Test
    void theMethodLevelRuleAlsoReportsItsMatchedMethods() {
        JavaClasses production = production();
        long methods = production.get(ChatRunReadService.class).getMethods().size();
        System.out.println("archunit rule matched: "
                + CpArchitectureRules.READ_SERVICE_METHODS_ARE_NOT_TRANSACTIONAL.getDescription()
                + " matched=" + methods);
        assertThat(methods).as("the method-level @Transactional rule selects 0 methods, which would make"
                + " it a green no-op").isPositive();
    }

    @Test
    void fullImportPathIsRedAndNamesTheRuleWhenTheSelectionIsEmpty() {
        // A subset with no controller at all: the CONTROLLERS rule selects nothing here.
        JavaClasses noControllers = new ClassFileImporter().importClasses(ProbeEntity.class);
        ArchRule strict = CpArchitectureRules.forFullImport(CpArchitectureRules.CONTROLLER_TO_CONTROLLER);
        AssertionError error = assertThrows(AssertionError.class, () -> strict.check(noControllers),
                "the strict form must not pass on an empty selection");
        assertThat(error.getMessage())
                .as("the failure must name the rule, not just say assertion failed")
                .contains(CpArchitectureRules.CONTROLLER_TO_CONTROLLER.getDescription());
    }

    @Test
    void probeSubsetPathToleratesAnEmptySelectionButStillCatchesViolations() {
        JavaClasses noControllers = new ClassFileImporter().importClasses(ProbeEntity.class);
        CpArchitectureRules.forProbeSubset(CpArchitectureRules.CONTROLLER_TO_CONTROLLER).check(noControllers);

        // Emptiness is tolerated; a real violation is not, otherwise "permissive" would mean "disabled".
        JavaClasses violating = new ClassFileImporter().importClasses(BadController.class, GoodController.class);
        ArchRule permissive = CpArchitectureRules.forProbeSubset(CpArchitectureRules.CONTROLLER_TO_CONTROLLER);
        AssertionError error = assertThrows(AssertionError.class, () -> permissive.check(violating),
                "the permissive form only relaxes emptiness, not the should-clause");
        assertThat(error.getMessage()).contains(CpArchitectureRules.CONTROLLER_TO_CONTROLLER.getDescription());
    }

    /** Same import as CpArchitectureTest; see its comment for the build-dir-agnostic test-class filter. */
    private static JavaClasses production() {
        return new ClassFileImporter()
                .withImportOption(location -> !location.contains("test-classes"))
                .importPackages("com.cc01cc.p.xihe.cp");
    }
}
