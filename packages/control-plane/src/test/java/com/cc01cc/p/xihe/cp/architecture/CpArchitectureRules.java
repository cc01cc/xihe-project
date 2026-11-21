package com.cc01cc.p.xihe.cp.architecture;

import com.cc01cc.p.xihe.cp.chat.ChatRunReadService;
import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaConstructor;
import com.tngtech.archunit.core.domain.JavaModifier;
import com.tngtech.archunit.lang.ArchCondition;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.lang.ConditionEvents;
import com.tngtech.archunit.lang.SimpleConditionEvent;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.repository.Repository;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noMethods;

final class CpArchitectureRules {

    static final DescribedPredicate<JavaClass> CONTROLLERS =
            DescribedPredicate.describe("HTTP controllers", type ->
                    !type.isAnnotation()
                            && (type.isAnnotatedWith("org.springframework.web.bind.annotation.RestController")
                            || type.isAnnotatedWith("org.springframework.stereotype.Controller")
                            || type.isMetaAnnotatedWith("org.springframework.stereotype.Controller")));

    static final DescribedPredicate<JavaClass> REPOSITORIES =
            DescribedPredicate.describe("Spring Data repositories", type ->
                    type.isInterface() && type.isAssignableTo(Repository.class));

    static final DescribedPredicate<JavaClass> APPLICATIONS =
            DescribedPredicate.describe("application services", type ->
                    !type.isAnnotation() && !CONTROLLERS.test(type) && !REPOSITORIES.test(type)
                            && (type.isAnnotatedWith("org.springframework.stereotype.Service")
                            || type.isAnnotatedWith("org.springframework.stereotype.Component")
                            || type.isMetaAnnotatedWith("org.springframework.stereotype.Component")
                            || type.getSimpleName().endsWith("Service")));

    static final DescribedPredicate<JavaClass> PERSISTENCE =
            DescribedPredicate.describe("JPA persistence types and repositories", type ->
                    !type.isAnnotation()
                            && (type.isAnnotatedWith("jakarta.persistence.Entity")
                            || type.isAnnotatedWith("jakarta.persistence.Embeddable")
                            || type.isAnnotatedWith("jakarta.persistence.MappedSuperclass")
                            || type.isAnnotatedWith("jakarta.persistence.Converter")
                            || REPOSITORIES.test(type)));

    static final ArchRule CONTROLLER_TO_CONTROLLER = noClasses().that(CONTROLLERS)
            .should().dependOnClassesThat(CONTROLLERS)
            .as("Controllers must not depend on other Controllers");

    static final ArchRule APPLICATION_TO_CONTROLLER = noClasses().that(APPLICATIONS)
            .should().dependOnClassesThat(CONTROLLERS)
            .as("Application services must not depend on Controllers");

    /**
     * BL-370 (S1, 2026-11-06): the S2 exemptions for DelegationController and
     * RunContextFingerprintController were deleted after their read paths moved into
     * {@code ChatRunReadService}. The rule is unconditional again — no controller may depend on a
     * repository. Adding an exemption requires changing the meta-test in {@code CpArchitectureTest}
     * and a reason in the commit message; it must never become a permanent allowlist.
     */
    /** BL-370 S1: empty on purpose; the meta-test below keeps it empty. */
    static final List<String> CONTROLLER_REPOSITORY_EXEMPTIONS = List.of();

    static final ArchRule CONTROLLER_TO_REPOSITORY = noClasses().that(CONTROLLERS)
            .should().dependOnClassesThat(REPOSITORIES)
            .as("Controllers must not depend on JPA repositories");

    /**
     * BL-370 S1 follow-up: {@code ChatRunReadService} is the shared read gate for controllers. Its
     * 404-before-403 owner check and the callers' {@code SessionService.requireCurrent} must keep
     * their current visibility/ordering; adding {@code @Transactional} here would change which
     * writes are visible between those two checks, silently changing the 403/404 outcome under
     * concurrency. Read methods stay non-transactional (no class-level or method-level annotation).
     */
    static final ArchRule READ_SERVICE_IS_NOT_TRANSACTIONAL = noClasses()
            .that().areAssignableTo(ChatRunReadService.class)
            .should().beAnnotatedWith(org.springframework.transaction.annotation.Transactional.class)
            .as("BL-370: ChatRunReadService must not be @Transactional (owner/session check ordering)");

    static final ArchRule READ_SERVICE_METHODS_ARE_NOT_TRANSACTIONAL = noMethods()
            .that().areDeclaredIn(ChatRunReadService.class)
            .should().beAnnotatedWith(org.springframework.transaction.annotation.Transactional.class)
            .as("BL-370: ChatRunReadService methods must not be @Transactional (owner/session check ordering)");

    static final ArchRule PERSISTENCE_TO_CONTROLLER = noClasses().that(PERSISTENCE)
            .should().dependOnClassesThat(CONTROLLERS)
            .as("Persistence must not depend on HTTP Controllers");

    /**
     * PLAN-0470 #27 (分层单向): every CP package under {@code com.cc01cc.p.xihe.cp}
     * except {@code crypto} counts as a business package. Technical-facility
     * packages must stay lower and may not depend on any of them.
     */
    static final DescribedPredicate<JavaClass> CP_BUSINESS_PACKAGES =
            DescribedPredicate.describe("CP business packages (cp.* except cp.crypto.*)",
                    type -> type.getPackageName().startsWith("com.cc01cc.p.xihe.cp.")
                            && !type.getPackageName().startsWith("com.cc01cc.p.xihe.cp.crypto."));

    /** PLAN-0470 #27 (task-617): the crypto facility predicate, shared with {@link #CLASS_TARGETS}. */
    static final DescribedPredicate<JavaClass> CRYPTO_TECHNICAL_FACILITY =
            DescribedPredicate.describe("crypto technical facility", type -> {
                String packageName = type.getPackageName();
                // Package names have no trailing dot, so the old "startsWith(cp.crypto.)" form matched zero
                // classes (task-617: it only ever fed a baseline row, never the rule itself, so nobody saw it).
                return packageName.equals("com.cc01cc.p.xihe.cp.crypto")
                        || packageName.startsWith("com.cc01cc.p.xihe.cp.crypto.");
            });

    /** BL-370 (task-617): the read gate type, shared with {@link #CLASS_TARGETS}. */
    static final DescribedPredicate<JavaClass> READ_SERVICE_TYPES =
            DescribedPredicate.describe("read services (assignable to ChatRunReadService)",
                    type -> type.isAssignableTo(ChatRunReadService.class));

    /**
     * PLAN-0470 #27: technical facilities (crypto) stay lower — no CP business deps.
     *
     * <p>task-617: no {@code allowEmptyShould(true)} here any more. Emptiness is decided by the caller
     * through {@link #forFullImport} / {@link #forProbeSubset}, so "the rule matched nothing" can never
     * silently count as "the architecture is clean".</p>
     */
    static final ArchRule TECHNICAL_FACILITY_STAYS_LOWER = noClasses().that(CRYPTO_TECHNICAL_FACILITY)
            .should().dependOnClassesThat(CP_BUSINESS_PACKAGES)
            .as("Technical facility packages (crypto) must not depend on CP business packages");

    /** PLAN-0470 #27: persistence stays below services. */
    static final ArchRule REPOSITORY_STAYS_BELOW_SERVICES = noClasses().that(REPOSITORIES)
            .should().dependOnClassesThat(APPLICATIONS)
            .as("JPA repositories must not depend on application services");

    /**
     * task-123: Spring stereotype annotations resolved <b>by FQN through the meta-annotation closure</b>,
     * never by the text written in a source file.
     *
     * <p>{@code isMetaAnnotatedWith(Component)} is the whole set Spring can turn into a bean through
     * constructor injection: {@code @Component} itself plus {@code @Service}, {@code @Repository},
     * {@code @Controller}/{@code @RestController} (via {@code @ControllerAdvice}),
     * {@code @Configuration} and {@code @SpringBootApplication}. That closure is the deliberate scope
     * choice: only component-scanned beans get their injection constructor chosen by
     * {@code AutowiredAnnotationBeanPostProcessor}. Types returned from {@code @Bean} methods are out of
     * scope, because Spring instantiates them itself and their constructor set never has to disambiguate
     * one bean.</p>
     *
     * <p>Why FQN parsing is a hard requirement: {@code CheckpointRevertAudit:52},
     * {@code SessionSnapshotAudit:49} and {@code SessionParticipantService:101} spell the injection
     * constructor as {@code @org.springframework.beans.factory.annotation.Autowired}. A text scan reads
     * those as "no {@code @Autowired}" — measured: a regex sweep produced 9 candidates, most of them
     * false positives. That is exactly why this gate is an ArchUnit rule and not a {@code check-*.mjs}
     * script.</p>
     */
    static final DescribedPredicate<JavaClass> SPRING_BEAN_CANDIDATES =
            DescribedPredicate.describe("Spring bean candidates (@Component stereotype closure)", type ->
                    !type.isAnnotation() && !type.isInterface() && !type.isRecord()
                            && !type.getModifiers().contains(JavaModifier.ABSTRACT)
                            && (type.isAnnotatedWith("org.springframework.stereotype.Component")
                            || type.isMetaAnnotatedWith("org.springframework.stereotype.Component")));

    /**
     * task-123: the selection of {@link #SPRING_BEAN_WITH_MULTIPLE_CONSTRUCTORS_NEEDS_EXPLICIT_AUTOWIRED}
     * — bean candidates whose constructor set is ambiguous, i.e. exactly the shape needing an explicit
     * {@code @Autowired} or a no-arg fallback. Records and abstract types are excluded in
     * {@link #SPRING_BEAN_CANDIDATES}, and neither exclusion is guesswork:
     * {@code BeanUtils.findPrimaryConstructor} (spring-beans 7.0.10) builds a record's <em>canonical</em>
     * constructor from {@code getRecordComponents()} and
     * {@code AutowiredAnnotationBeanPostProcessor} asks it first, so a record never has more than one
     * candidate to disambiguate; abstract types are never instantiated by Spring at all. Measured on this
     * tree: of 409 stereotype-annotated production classes, zero records and zero abstract classes carry
     * more than one constructor, so today neither exclusion costs the gate any coverage.
     */
    static final DescribedPredicate<JavaClass> AMBIGUOUS_CTOR_BEAN_CANDIDATES =
            DescribedPredicate.describe("Spring bean candidates with more than one instantiable constructor",
                    type -> SPRING_BEAN_CANDIDATES.test(type) && type.getConstructors().size() > 1);

    /**
     * task-123: annotation membership resolved by <b>type</b>, so the FQN-quoted spellings count and a
     * mention inside a comment never does.
     */
    static final DescribedPredicate<JavaConstructor> AUTOWIRED_CONSTRUCTOR =
            DescribedPredicate.describe("is annotated with @Autowired",
                    constructor -> constructor.isAnnotatedWith(Autowired.class));

    /** The four shapes Spring can resolve plus the one it cannot — see {@link #injectionFormOf}. */
    enum ConstructorInjectionForm {
        SINGLE_CANDIDATE,
        EXPLICIT_AUTOWIRED,
        PUBLIC_NO_ARG_FALLBACK,
        AMBIGUOUS
    }

    /**
     * task-123: classify a class the way Spring's {@code AutowiredAnnotationBeanPostProcessor} chooses its
     * injection constructor. One classifier is shared by the gate below and by the census row in
     * {@code CpArchitectureTest}, so a reported form can never drift from the form being enforced.
     *
     * <p>{@link ConstructorInjectionForm#EXPLICIT_AUTOWIRED} covers both the short-name and the fully
     * qualified spelling, because the annotation is resolved by type
     * ({@link #AUTOWIRED_CONSTRUCTOR}). Two {@code @Autowired} constructors are {@code AMBIGUOUS}, not safe
     * — "exactly one" is the requirement.</p>
     */
    static ConstructorInjectionForm injectionFormOf(JavaClass type) {
        if (type.getConstructors().size() <= 1) {
            return ConstructorInjectionForm.SINGLE_CANDIDATE;
        }
        long autowired = type.getConstructors().stream().filter(AUTOWIRED_CONSTRUCTOR).count();
        if (autowired == 1L) {
            return ConstructorInjectionForm.EXPLICIT_AUTOWIRED;
        }
        if (autowired > 1L) {
            return ConstructorInjectionForm.AMBIGUOUS;
        }
        boolean publicNoArg = type.getConstructors().stream()
                .anyMatch(constructor -> constructor.getRawParameterTypes().isEmpty()
                        && constructor.getModifiers().contains(JavaModifier.PUBLIC));
        return publicNoArg ? ConstructorInjectionForm.PUBLIC_NO_ARG_FALLBACK
                : ConstructorInjectionForm.AMBIGUOUS;
    }

    /**
     * task-123: Spring's own criterion, quoted from {@code cp/chat/UserQuestionService.java:126-128} —
     * with more than one candidate it falls back to <b>"no-arg or explicit annotation"</b>. That gives
     * four safe forms and one violation (calibrated by the task-122 nine-class audit, Lead 2026-11-22):
     *
     * <ol>
     *   <li>constructor count &le; 1 — safe, single candidate; not selected by
     *       {@link #AMBIGUOUS_CTOR_BEAN_CANDIDATES}.</li>
     *   <li>multiple + exactly one {@code @Autowired}, short name — safe
     *       ({@code UserQuestionService}, {@code LoginAttemptService}).</li>
     *   <li>multiple + exactly one {@code @Autowired} written as an FQN — safe, but only because the
     *       annotation is parsed by type; see {@link #AUTOWIRED_CONSTRUCTOR}.</li>
     *   <li>multiple + a public no-arg constructor + <b>no</b> {@code @Autowired} — safe.
     *       <b>This exemption is deliberate, not a missing case.</b> Spring's documented fallback takes
     *       the no-arg constructor, so the bean starts: {@code EnvOverlayRegistry:47},
     *       {@code ResourceGovernor:88}, {@code SessionPolicyState:67},
     *       {@code ScheduledTaskContracts:87}, {@code BuildVersion:32}, {@code RequestQueue:34}.
     *       Flagging these would make the gate red on six classes that work, which is how a gate loses
     *       its credibility.</li>
     *   <li>multiple + no public no-arg + no {@code @Autowired} — <b>the violation this gate exists to
     *       catch.</b> {@code FirstRunAccountService} had exactly this shape and it stopped the context
     *       in all 44 {@code @SpringBootTest} files (task-122, fixed in {@code 246d48919} / D-1535).</li>
     * </ol>
     *
     * <p>"exactly one" is intentional: two {@code @Autowired} constructors are ambiguous too.</p>
     */
    static final ArchCondition<JavaClass> HAVE_EXPLICIT_AUTOWIRED_OR_PUBLIC_NO_ARG_CONSTRUCTOR =
            new ArchCondition<JavaClass>("declare exactly one @Autowired constructor, or expose a public "
                    + "no-arg constructor for Spring's documented no-arg fallback") {
                @Override
                public void check(JavaClass type, ConditionEvents events) {
                    if (injectionFormOf(type) != ConstructorInjectionForm.AMBIGUOUS) {
                        return;
                    }
                    long autowired = type.getConstructors().stream().filter(AUTOWIRED_CONSTRUCTOR).count();
                    String reason = autowired == 0L
                            ? "no @Autowired constructor and no public no-arg fallback"
                            : autowired + " constructors annotated @Autowired (must be exactly one)";
                    String message = String.format("%s declares %d constructors with %s - Spring cannot choose"
                                    + " an injection constructor (add @Autowired to exactly one of them)",
                            type.getName(), type.getConstructors().size(), reason);
                    events.add(SimpleConditionEvent.violated(type, message));
                }
            };

    /** task-123 gate — semantics in {@link #HAVE_EXPLICIT_AUTOWIRED_OR_PUBLIC_NO_ARG_CONSTRUCTOR}. */
    static final ArchRule SPRING_BEAN_WITH_MULTIPLE_CONSTRUCTORS_NEEDS_EXPLICIT_AUTOWIRED =
            classes().that(AMBIGUOUS_CTOR_BEAN_CANDIDATES)
                    .should(HAVE_EXPLICIT_AUTOWIRED_OR_PUBLIC_NO_ARG_CONSTRUCTOR)
                    .as("Spring bean candidates with multiple constructors must declare exactly one @Autowired"
                            + " constructor, or expose a public no-arg constructor (task-122 / D-1535)");
    /**
     * Which {@code that()} predicate each class-level rule selects.
     *
     * <p>task-617: the source of the {@code matched=<n>} readout. Before this map the predicates were
     * re-typed positionally in {@code CpArchitectureTest}, so a reordering of {@link #ALL} silently paired
     * a rule with the wrong origin predicate.</p>
     */
    static final Map<ArchRule, DescribedPredicate<JavaClass>> CLASS_TARGETS = classTargets();

    private static Map<ArchRule, DescribedPredicate<JavaClass>> classTargets() {
        Map<ArchRule, DescribedPredicate<JavaClass>> targets = new LinkedHashMap<>();
        targets.put(CONTROLLER_TO_CONTROLLER, CONTROLLERS);
        targets.put(APPLICATION_TO_CONTROLLER, APPLICATIONS);
        targets.put(CONTROLLER_TO_REPOSITORY, CONTROLLERS);
        targets.put(PERSISTENCE_TO_CONTROLLER, PERSISTENCE);
        targets.put(TECHNICAL_FACILITY_STAYS_LOWER, CRYPTO_TECHNICAL_FACILITY);
        targets.put(REPOSITORY_STAYS_BELOW_SERVICES, REPOSITORIES);
        targets.put(READ_SERVICE_IS_NOT_TRANSACTIONAL, READ_SERVICE_TYPES);
        // task-123: the selection below is the rule's own that() predicate, so matched=<n> reports exactly
        // how many production classes the gate looked at.
        targets.put(SPRING_BEAN_WITH_MULTIPLE_CONSTRUCTORS_NEEDS_EXPLICIT_AUTOWIRED,
                AMBIGUOUS_CTOR_BEAN_CANDIDATES);
        return Collections.unmodifiableMap(targets);
    }

    /**
     * Which {@code should()}-side predicate each dependency rule looks at, i.e. the second half of the
     * {@code origin -> target} pairs written to the baseline report.
     *
     * <p>task-123: this used to be a positional {@code List} inside {@code CpArchitectureTest}, which meant
     * appending a rule to {@link #ALL} either threw {@code IndexOutOfBoundsException} or, worse, paired the
     * new rule with a stale predicate. It is keyed by rule for the same reason {@link #CLASS_TARGETS} is.</p>
     *
     * <p>Rules without an entry here are not dependency rules at all — {@link
     * #SPRING_BEAN_WITH_MULTIPLE_CONSTRUCTORS_NEEDS_EXPLICIT_AUTOWIRED} inspects a class's own constructor
     * set, so there is no target class to pair. The report records those rows with an explicit note instead
     * of an empty pair list, so "no pairs" never reads as "no dependencies checked".</p>
     */
    static final Map<ArchRule, DescribedPredicate<JavaClass>> DEPENDENCY_TARGETS = dependencyTargets();

    private static Map<ArchRule, DescribedPredicate<JavaClass>> dependencyTargets() {
        Map<ArchRule, DescribedPredicate<JavaClass>> targets = new LinkedHashMap<>();
        targets.put(CONTROLLER_TO_CONTROLLER, CONTROLLERS);
        targets.put(APPLICATION_TO_CONTROLLER, CONTROLLERS);
        targets.put(CONTROLLER_TO_REPOSITORY, REPOSITORIES);
        targets.put(PERSISTENCE_TO_CONTROLLER, CONTROLLERS);
        targets.put(TECHNICAL_FACILITY_STAYS_LOWER, CP_BUSINESS_PACKAGES);
        targets.put(REPOSITORY_STAYS_BELOW_SERVICES, APPLICATIONS);
        return Collections.unmodifiableMap(targets);
    }

    /**
     * Strict form: for the full production import every rule must select at least one class.
     *
     * <p>ArchUnit's failure for an empty selection reads "Rule failed to check any classes" and is a real
     * red, not a pass — that is the whole point of task-617 (a green gate used to be indistinguishable
     * from "nothing was checked").</p>
     */
    static ArchRule forFullImport(ArchRule rule) {
        return rule.allowEmptyShould(false);
    }

    /**
     * Permissive form, for probe subsets only: a fixture set legitimately contains no crypto class, no
     * repository, etc. The permissive form is only ever reached from {@code CpArchitectureRuleProbeTest};
     * it must never be applied to the production import.
     */
    static ArchRule forProbeSubset(ArchRule rule) {
        return rule.allowEmptyShould(true);
    }

    /**
     * Class-level rules checked against the production import (task-617).
     *
     * <p>Read as: every entry is also a key of {@link #CLASS_TARGETS}. The method-level rule
     * {@link #READ_SERVICE_METHODS_ARE_NOT_TRANSACTIONAL} is deliberately not here — it has no class
     * predicate, so it gets its own check in {@code CpArchitectureTest}.</p>
     */
    static final List<ArchRule> ALL = List.of(CONTROLLER_TO_CONTROLLER, APPLICATION_TO_CONTROLLER,
            CONTROLLER_TO_REPOSITORY, PERSISTENCE_TO_CONTROLLER,
            TECHNICAL_FACILITY_STAYS_LOWER, REPOSITORY_STAYS_BELOW_SERVICES,
            SPRING_BEAN_WITH_MULTIPLE_CONSTRUCTORS_NEEDS_EXPLICIT_AUTOWIRED);

    private CpArchitectureRules() { }
}
