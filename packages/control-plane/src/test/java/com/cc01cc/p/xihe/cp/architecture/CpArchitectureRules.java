package com.cc01cc.p.xihe.cp.architecture;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.lang.ArchRule;
import org.springframework.data.repository.Repository;

import java.util.List;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

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
     * BL-370 (S2, 2026-11-06): named, time-boxed exemptions so the rule can run again.
     *
     * <p>Before this, the whole class never executed: an unassigned production type made ArchUnit's
     * import throw, so "1 error" actually meant <b>zero coverage</b>. Restoring the check is more
     * valuable than a clean-but-dead rule, so exactly these two controllers are exempt until their
     * read paths move into services (S1, reviewBy 2026-12-06):
     * <ul>
     *   <li>{@code DelegationController} — spawn() reads the session's latest run for provenance;</li>
     *   <li>{@code RunContextFingerprintController} — requireRun()/viewOf() read run + attempt state.</li>
     * </ul>
     * The list may only shrink. Adding an entry requires editing this list, the meta-test in
     * {@code CpArchitectureTest} and a reason in the commit message.
     */
    static final List<String> CONTROLLER_REPOSITORY_EXEMPTIONS = List.of(
            "com.cc01cc.p.xihe.cp.chat.DelegationController",
            "com.cc01cc.p.xihe.cp.chat.RunContextFingerprintController");

    private static final DescribedPredicate<JavaClass> EXEMPT_CONTROLLER_REPOSITORY =
            DescribedPredicate.describe("BL-370 exempt controllers", type ->
                    CONTROLLER_REPOSITORY_EXEMPTIONS.contains(type.getName()));

    static final ArchRule CONTROLLER_TO_REPOSITORY = noClasses()
            .that(CONTROLLERS.and(DescribedPredicate.not(EXEMPT_CONTROLLER_REPOSITORY)))
            .should().dependOnClassesThat(REPOSITORIES)
            .as("Controllers must not depend on JPA repositories (BL-370 exemptions are time-boxed)");

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
