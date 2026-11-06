package com.cc01cc.p.xihe.cp.architecture;

import com.cc01cc.p.xihe.cp.chat.ChatRunReadService;
import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.lang.ArchRule;
import org.springframework.data.repository.Repository;

import java.util.List;

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

    /** PLAN-0470 #27: technical facilities (crypto) stay lower — no CP business deps. */
    static final ArchRule TECHNICAL_FACILITY_STAYS_LOWER = noClasses()
            .that().resideInAPackage("com.cc01cc.p.xihe.cp.crypto..")
            .should().dependOnClassesThat(CP_BUSINESS_PACKAGES)
            // allowEmptyShould: probe subsets may not contain any crypto class;
            // the production import always contains EnvelopeEncryptionService.
            .allowEmptyShould(true)
            .as("Technical facility packages (crypto) must not depend on CP business packages");

    /** PLAN-0470 #27: persistence stays below services. */
    static final ArchRule REPOSITORY_STAYS_BELOW_SERVICES = noClasses().that(REPOSITORIES)
            .should().dependOnClassesThat(APPLICATIONS)
            .allowEmptyShould(true)
            .as("JPA repositories must not depend on application services");

    static final List<ArchRule> ALL = List.of(CONTROLLER_TO_CONTROLLER, APPLICATION_TO_CONTROLLER,
            CONTROLLER_TO_REPOSITORY, PERSISTENCE_TO_CONTROLLER,
            TECHNICAL_FACILITY_STAYS_LOWER, REPOSITORY_STAYS_BELOW_SERVICES);

    private CpArchitectureRules() { }
}
