package com.cc01cc.p.xihe.cp.architecture;

import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.BadAmbiguousConstructorService;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.FqnAutowiredConstructorService;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.NoArgFallbackConstructorService;
import com.cc01cc.p.xihe.cp.audit.CheckpointRevertAudit;
import com.cc01cc.p.xihe.cp.chat.UserQuestionService;
import com.cc01cc.p.xihe.cp.config.EnvOverlayRegistry;
import com.cc01cc.p.xihe.cp.config.FirstRunAccountService;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-123: the {@code @Autowired} gate has to be proven on fixtures, not only on production code.
 *
 * <p>Why a separate class instead of more methods in {@code CpArchitectureRuleProbeTest}: that file's
 * {@code :107-115} assertions are quoted by line number in {@code packages/control-plane/AGENTS.md} and the
 * project AGENTS.md, and the card forbids moving them. Appending above that range would shift it; a new
 * file in the same package keeps every pinned line byte-exact.</p>
 *
 * <p>The three safe forms are asserted twice — once on a fixture, once on a real production class — so the
 * classification is pinned against both a shape nobody can accidentally delete and the code that actually
 * ships.</p>
 */
class AutowiredConstructorRuleProbeTest {

    private static final ArchRule RULE = CpArchitectureRules
            .forProbeSubset(CpArchitectureRules.SPRING_BEAN_WITH_MULTIPLE_CONSTRUCTORS_NEEDS_EXPLICIT_AUTOWIRED);

    /**
     * Negative probe: the task-122 shape must be caught and named. This is the reading that proves the gate
     * is not green merely because {@code FirstRunAccountService} got fixed.
     */
    @Test
    void ambiguousConstructorSetIsRejectedAndNamed() {
        JavaClasses types = new ClassFileImporter()
                .importClasses(BadAmbiguousConstructorService.class, FqnAutowiredConstructorService.class);
        assertEquals(CpArchitectureRules.ConstructorInjectionForm.AMBIGUOUS,
                form(types, BadAmbiguousConstructorService.class.getName()));
        var evaluated = RULE.evaluate(types);
        var details = evaluated.getFailureReport().getDetails();
        // Same reason ArchitectureRuleMatchedCountTest prints matched=<n>: the reading a report cites must be
        // quotable from the build log, not reconstructed afterwards by hand.
        System.out.println("task-123 reverse probe (expected red) ->\n" + evaluated.getFailureReport());
        // Only the bad fixture contributes: the FQN one is selected too (2 constructors) but is safe.
        assertEquals(1, details.size(), () -> RULE.getDescription() + "\n" + evaluated.getFailureReport());
        assertTrue(details.get(0).contains(BadAmbiguousConstructorService.class.getName()), details::toString);
        assertThrows(AssertionError.class, () -> RULE.check(types));
    }

    /**
     * Positive probe on fixtures: the FQN spelling and the public no-arg fallback both pass the rule even
     * though neither carries a short-name {@code @Autowired}.
     */
    @Test
    void fixtureSafeFormsPass() {
        JavaClasses types = new ClassFileImporter().importClasses(
                FqnAutowiredConstructorService.class, NoArgFallbackConstructorService.class);
        assertEquals(CpArchitectureRules.ConstructorInjectionForm.EXPLICIT_AUTOWIRED,
                form(types, FqnAutowiredConstructorService.class.getName()));
        assertEquals(CpArchitectureRules.ConstructorInjectionForm.PUBLIC_NO_ARG_FALLBACK,
                form(types, NoArgFallbackConstructorService.class.getName()));
        RULE.check(types);
    }

    /**
     * Positive probe on production classes, one per safe form. This is also the anti-text-scan evidence:
     * {@code CheckpointRevertAudit} and {@code SessionParticipantService} write the annotation as an FQN and
     * classify as {@code EXPLICIT_AUTOWIRED}, which a regex over the source text would have missed.
     */
    @Test
    void productionSafeFormsClassifyAsDocumented() {
        JavaClasses types = new ClassFileImporter().importClasses(
                UserQuestionService.class, CheckpointRevertAudit.class, SessionParticipantService.class,
                EnvOverlayRegistry.class, FirstRunAccountService.class);
        assertEquals(CpArchitectureRules.ConstructorInjectionForm.EXPLICIT_AUTOWIRED,
                form(types, UserQuestionService.class));
        assertEquals(CpArchitectureRules.ConstructorInjectionForm.EXPLICIT_AUTOWIRED,
                form(types, CheckpointRevertAudit.class));
        assertEquals(CpArchitectureRules.ConstructorInjectionForm.EXPLICIT_AUTOWIRED,
                form(types, SessionParticipantService.class));
        assertEquals(CpArchitectureRules.ConstructorInjectionForm.PUBLIC_NO_ARG_FALLBACK,
                form(types, EnvOverlayRegistry.class));
        // task-122 landed @Autowired here (246d48919 / D-1535); if this ever reads AMBIGUOUS the gate is red
        // on HEAD and the fix regressed, so fail here with the form rather than in the full suite.
        assertEquals(CpArchitectureRules.ConstructorInjectionForm.EXPLICIT_AUTOWIRED,
                form(types, FirstRunAccountService.class));
        RULE.check(types);
    }

    private static CpArchitectureRules.ConstructorInjectionForm form(JavaClasses types, Class<?> type) {
        return form(types, type.getName());
    }

    private static CpArchitectureRules.ConstructorInjectionForm form(JavaClasses types, String name) {
        JavaClass imported = types.get(name);
        assertTrue(CpArchitectureRules.AMBIGUOUS_CTOR_BEAN_CANDIDATES.test(imported),
                () -> name + " is not selected by the rule scope - its constructor count or stereotype "
                        + "annotation changed, so this probe no longer tests what it claims to test");
        return CpArchitectureRules.injectionFormOf(imported);
    }
}
