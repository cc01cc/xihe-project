package com.cc01cc.p.xihe.cp.architecture;

import com.cc01cc.p.xihe.cp.chat.ChatRunReadService;
import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.lang.ArchRule;
import org.springframework.data.repository.Repository;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
            TECHNICAL_FACILITY_STAYS_LOWER, REPOSITORY_STAYS_BELOW_SERVICES);

    private CpArchitectureRules() { }
}
