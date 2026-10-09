package com.cc01cc.p.xihe.cp.architecture;

import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.BadController;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.BadEmbeddable;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.BadMetaController;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.BadComposedApplication;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.BadEntity;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.BadRepositoryController;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.BadService;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.GoodController;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.GoodService;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.ProbeEntity;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.ProbeRepository;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.ArrayOwnershipProbe;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.CycleA;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.CycleB;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.ChainA;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.ChainB;
import com.cc01cc.p.xihe.cp.service.UnknownOwnershipProbe;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.entity.User;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.library.dependencies.SliceAssignment;
import com.tngtech.archunit.library.dependencies.SliceIdentifier;
import org.junit.jupiter.api.Test;
import com.cc01cc.p.xihe.cp.CpApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;
import java.util.Map;
import java.util.Set;
import java.util.List;

class CpArchitectureRuleProbeTest {

    @Test
    void legalControllerApplicationRepositoryChainPassesAllRules() {
        var types = new ClassFileImporter().importClasses(GoodController.class, GoodService.class,
                ProbeRepository.class, ProbeEntity.class);
        for (ArchRule rule : CpArchitectureRules.ALL) {
            assertEquals(0, rule.evaluate(types).getFailureReport().getDetails().size(),
                    () -> rule.getDescription() + "\n" + rule.evaluate(types).getFailureReport());
            rule.check(types);
        }
    }

    @Test
    void controllerDependencyIsRejected() {
        assertRejected(CpArchitectureRules.CONTROLLER_TO_CONTROLLER,
                BadController.class, GoodController.class);
    }

    @Test
    void serviceDependencyOnControllerIsRejected() {
        assertRejected(CpArchitectureRules.APPLICATION_TO_CONTROLLER,
                BadService.class, GoodController.class);
    }

    @Test
    void controllerDependencyOnRepositoryIsRejected() {
        assertRejected(CpArchitectureRules.CONTROLLER_TO_REPOSITORY,
                BadRepositoryController.class, ProbeRepository.class);
    }

    @Test
    void entityDependencyOnControllerIsRejected() {
        assertRejected(CpArchitectureRules.PERSISTENCE_TO_CONTROLLER,
                BadEntity.class, GoodController.class);
    }

    @Test
    void embeddableDependencyOnControllerIsRejected() {
        assertRejected(CpArchitectureRules.PERSISTENCE_TO_CONTROLLER,
                BadEmbeddable.class, GoodController.class);
    }

    @Test
    void composedControllerDependencyIsRejected() {
        assertRejected(CpArchitectureRules.CONTROLLER_TO_CONTROLLER,
                BadMetaController.class, GoodController.class);
    }

    @Test
    void composedServiceDependencyOnControllerIsRejected() {
        assertRejected(CpArchitectureRules.APPLICATION_TO_CONTROLLER,
                BadComposedApplication.class, GoodController.class);
    }

    @Test
    void repositoryClassifierRecognizesInheritedSpringDataInterface() {
        var types = new ClassFileImporter().importClasses(ProbeRepository.class);
        assertEquals(1, types.stream().filter(CpArchitectureRules.REPOSITORIES).count());
    }

    @Test
    void probeFixturesAreOutsideProductionComponentScan() {
        var annotation = CpApplication.class.getAnnotation(SpringBootApplication.class);
        assertEquals(0, annotation.scanBasePackages().length);
        assertEquals(0, annotation.scanBasePackageClasses().length);
        String applicationPackage = CpApplication.class.getPackageName();
        assertFalse(GoodController.class.getPackageName().startsWith(applicationPackage));
        assertFalse(ProbeEntity.class.getPackageName().startsWith(applicationPackage));
    }

    @Test
    void mixedPackageClassesUseFrozenCapabilityOwners() {
        var types = new ClassFileImporter().importClasses(WorkspaceService.class, WorkspaceJob.class, User.class);
        var assignment = new CpModuleAssignment();
        assertEquals("workspace", assignment.ownerOf(types.get(WorkspaceService.class)));
        assertEquals("operation", assignment.ownerOf(types.get(WorkspaceJob.class)));
        assertEquals("auth", assignment.ownerOf(types.get(User.class)));
    }

    @Test
    void arrayDependencyUsesItsActualComponentOwner() {
        var types = new ClassFileImporter().importClasses(ArrayOwnershipProbe.class);
        var array = types.get(ArrayOwnershipProbe.class).getField("roles").getRawType();
        assertEquals("chat", new CpModuleAssignment().ownerOf(array));
    }

    @Test
    void unassignedMixedPackageTypeCannotBeSilentlyDropped() {
        var types = new ClassFileImporter().importClasses(UnknownOwnershipProbe.class);
        assertThrows(IllegalArgumentException.class,
                () -> new CpModuleAssignment().ownerOf(types.get(UnknownOwnershipProbe.class)));
    }

    @Test
    void actualBytecodeCycleIsRejected() {
        var types = new ClassFileImporter().importClasses(CycleA.class, CycleB.class);
        var rule = slices().assignedFrom(twoModules(CycleA.class, CycleB.class)).should().beFreeOfCycles();
        assertEquals(1, rule.evaluate(types).getFailureReport().getDetails().size());
        assertThrows(AssertionError.class, () -> rule.check(types));
    }

    @Test
    void actualBytecodeAcyclicChainPasses() {
        var types = new ClassFileImporter().importClasses(ChainA.class, ChainB.class);
        var rule = slices().assignedFrom(twoModules(ChainA.class, ChainB.class)).should().beFreeOfCycles();
        assertEquals(0, rule.evaluate(types).getFailureReport().getDetails().size());
        rule.check(types);
    }

    @Test
    void stronglyConnectedDiagnosticsAreCompleteWithoutEnumeratingEveryCycle() {
        assertEquals(List.of(List.of("a", "b")), CpArchitectureTest.stronglyConnectedOwners(
                Map.of("a", Set.of("b"), "b", Set.of("a", "c"), "c", Set.of())));
        assertEquals(List.of(), CpArchitectureTest.stronglyConnectedOwners(
                Map.of("a", Set.of("b"), "b", Set.of())));
    }

    private static SliceAssignment twoModules(Class<?> first, Class<?> second) {
        return new SliceAssignment() {
            @Override
            public SliceIdentifier getIdentifierOf(JavaClass type) {
                if (type.getName().equals(first.getName())) {
                    return SliceIdentifier.of("first");
                }
                if (type.getName().equals(second.getName())) {
                    return SliceIdentifier.of("second");
                }
                return SliceIdentifier.ignore();
            }

            @Override
            public String getDescription() { return "explicit probe modules"; }
        };
    }

    private static void assertRejected(ArchRule rule, Class<?> origin, Class<?> target) {
        var types = new ClassFileImporter().importClasses(origin, target);
        assertEquals(1, types.stream().filter(type -> type.getName().equals(origin.getName())).count());
        // Each fixture declares exactly one field and one constructor parameter dependency.
        assertEquals(2, rule.evaluate(types).getFailureReport().getDetails().size(),
                () -> rule.getDescription() + "\n" + rule.evaluate(types).getFailureReport());
        assertThrows(AssertionError.class, () -> rule.check(types));
    }

}
