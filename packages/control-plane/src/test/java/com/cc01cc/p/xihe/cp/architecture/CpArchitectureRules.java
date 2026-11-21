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
import com.tngtech.archunit.library.dependencies.SliceAssignment;
import com.tngtech.archunit.library.dependencies.SliceIdentifier;
import com.tngtech.archunit.library.dependencies.SliceRule;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.repository.Repository;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noMethods;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

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
     * task-132: everything the slice rules actually look at, i.e. the classes {@link CpModuleAssignment}
     * resolves to an owner. Used as this rule's {@link #CLASS_TARGETS} entry so
     * {@code ArchitectureRuleMatchedCountTest} can assert the selection is non-empty: a slice gate whose
     * assignment matched no class would be a green no-op, which is the failure task-617 was written about.
     */
    static final DescribedPredicate<JavaClass> CP_SLICE_OWNED_CLASSES =
            DescribedPredicate.describe("classes owned by a CP capability slice",
                    type -> new CpModuleAssignment().ownerOf(type) != null);

    /**
     * task-132: one slice edge of the CP capability ownership graph, expressed as a pair of predicates so it
     * can be used on both sides of {@code that(...).should().dependOnClassesThat(...)} — the same idiom as
     * {@link #CONTROLLERS}/{@link #APPLICATIONS}.
     *
     * <p>Attribution goes through {@link CpModuleAssignment}, i.e. the <b>frozen ownership matrix</b>, not the
     * package name. Measured: 6 of the 51 context-owned production classes sit outside {@code cp.context} (all
     * of them in {@code cp.service} — {@code ContextTemplateService} and {@code ContextTemplateSourceService}
     * plus their nested types), and it is precisely {@code ContextTemplateSourceService} that holds today's
     * {@code context -> skill} edge. A {@code getPackageName().startsWith("cp.context")} predicate would treat
     * those 6 classes as if they belonged to no slice, so a {@code cp.skill} class depending on the one class
     * that actually joins the two slices would be green (same reasoning task-617 records for the crypto
     * predicate, where a wrong prefix test matched zero classes and nobody noticed).</p>
     */
    static DescribedPredicate<JavaClass> ownedBySlice(String owner) {
        return ownedBySlice(owner, new CpModuleAssignment());
    }

    /**
     * task-132: overload taking the assignment explicitly, so a probe can pin the classifier it tested.
     */
    static DescribedPredicate<JavaClass> ownedBySlice(String owner, CpModuleAssignment assignment) {
        return DescribedPredicate.describe("is owned by slice " + owner,
                type -> owner.equals(assignment.ownerOf(type)));
    }

    /**
     * task-132: the invariant {@code cp/skill/SkillImportValidator}'s javadoc has been claiming since
     * PLAN-0628 — {@code cp.skill} must not depend on {@code cp.context}, because the path-rule family is
     * deliberately duplicated locally rather than imported.
     *
     * <p>Until now the claim was a <b>prose-only gate</b>: {@code CpArchitectureTest} computed
     * {@code slices().should().beFreeOfCycles()} with {@code evaluate(...)} and wrote the details into
     * {@code baseline.json} without asserting on them, and no slice rule was in {@link #ALL}. A reader of the
     * comment therefore believed a violation would fail the build. It would not (task-124 census, item 1;
     * reproduced independently by Lead 2026-11-22).</p>
     *
     * <p>Why this direction ban and not a general {@code beFreeOfCycles} assertion: measured on the same
     * production import, the owner graph is <b>one 23-slice strongly-connected component</b> — 148 of its 181
     * edges close a cycle, 43 pairs are mutually dependent, and ArchUnit's own diagnostics stop at the
     * detection limit (100 entries reported, so even the count of existing cycles is a floor, not a total).
     * An unconditional acyclicity rule is therefore red on HEAD by construction, which is why the graph rule
     * ({@link #CP_SLICE_GRAPH_HAS_NO_CYCLES_OUTSIDE_BASELINE}) carries an explicit whitelist. That whitelist
     * alone would <b>not</b> protect this invariant: {@code ignoreDependency} removes an edge from the cycle
     * graph, so a new {@code skill -> context} edge completes only cycles whose other side
     * ({@code context -> skill}) is already suppressed — the graph rule would stay green on precisely the edge
     * the javadoc warns about (measured: once the 148 edges are suppressed, {@code context} does not reach
     * {@code skill} at all, so the new edge closes no cycle in the graph the rule still sees). A direct ban
     * cannot be bought off that way, so it is asserted
     * here independently: zero violations today, and the only way to keep it green is not to add the
     * dependency. The claim being guarded has been in the source since {@code cc050e11e} (2026-11-02,
     * PLAN-0628).</p>
     */
    /**
     * task-132: the ban as a factory over both slice names, so a probe can run the identical construction
     * against two fixture slices and watch the <b>should</b> side fire.
     *
     * <p>Without that, {@code ownedBySlice("context")} — the predicate the whole rule exists to reject — would
     * only ever be exercised by the production graph, where it matches 51 classes and 0 dependencies. That is
     * the task-617 failure shape exactly: a selector that matches nothing on the target side makes a green gate
     * mean "nothing was tested", and it was caught here only because the probe made the two sides observable
     * separately.</p>
     */
    static ArchRule sliceMustNotDependOnSlice(String from, String to) {
        return noClasses().that(ownedBySlice(from))
                .should().dependOnClassesThat(ownedBySlice(to));
    }

    static final ArchRule SKILL_SLICE_MUST_NOT_DEPEND_ON_CONTEXT_SLICE =
            sliceMustNotDependOnSlice("skill", "context")
                    .as("Slice skill must not depend on slice context (SkillImportValidator keeps its path rules"
                            + " local; the reverse edge context -> skill already exists, so this direction is the"
                            + " one that can stay free)");

    /**
     * task-132: the review deadline every whitelisted slice edge carries. Shared on purpose: the whole
     * baseline is one decision with one date, so a per-entry date could only ever be copy-pasted, and a
     * copy-pasted deadline is decoration rather than accountability.
     */
    static final String SLICE_CYCLE_REVIEW_BY = "2026-12-31";

    /** task-132: one whitelisted slice edge (origin slice -> target slice) plus its review deadline. */
    record SliceCycleBaselineEntry(String from, Set<String> to, String reviewBy) { }

    /**
     * task-132: explicit baseline of the slice edges that already close a cycle today, keyed by owner slice
     * through {@link CpModuleAssignment} (never by package prefix).
     *
     * <p>Measured on the same production import as {@code CpArchitectureTest} (1440 classes, 34 slices,
     * 181 owner edges): <b>23 of those slices form a single strongly-connected component</b>, and 148 of the
     * 181 edges lie inside it, i.e. every one of them is cycle-closing. ArchUnit's own diagnostics stop at its
     * detection limit (exactly 100 reported entries), so even "how many cycles are there" is only a floor.</p>
     *
     * <p>That measurement is why this baseline exists and why the card's premise ("if stock cycles exist, list
     * them") is a much bigger number than it looks: an unconditional {@code beFreeOfCycles} is red on HEAD by
     * construction. Suppressing these 148 edges is still a real gate, and the honest way to say so is about
     * what it catches: it bans <b>new</b> cycles that are not already exempt. It is not the rule that keeps the
     * {@code SkillImportValidator} promise — see the next paragraph for why it cannot, and
     * {@link #SKILL_SLICE_MUST_NOT_DEPEND_ON_CONTEXT_SLICE} for the ban that does.</p>
     *
     * <p>What this rule does and does not catch, stated so nobody has to re-derive it: {@code ignoreDependency}
     * removes an edge from the cycle graph, so this rule can only fail on a cycle <b>all of whose edges are
     * outside the baseline</b> — it bans new fully-unlisted cycles. It cannot guard the specific edge the
     * {@code SkillImportValidator} javadoc warns about: measured after suppression, {@code context} no longer
     * reaches {@code skill}, so a new {@code skill -> context} edge closes no cycle the rule still sees. That
     * is why {@link #SKILL_SLICE_MUST_NOT_DEPEND_ON_CONTEXT_SLICE} exists as a separate, unconditional ban,
     * and the pair (not either one alone) is what makes the prose claim true. Both properties, plus the fact
     * that {@code skill->context} must never enter the baseline, are asserted in
     * {@code SliceCycleRuleProbeTest}.</p>
     *
     * <p>Shrink-only, enforced twice in {@code SliceCycleRuleProbeTest}: the flattened edge count must equal
     * {@link #SLICE_CYCLE_BASELINE_EDGE_COUNT} (so adding an exemption is a deliberate edit, and deleting an
     * already-fixed edge must lower the number in the same commit), and every baseline entry must still exist
     * as a live owner edge in the production graph (so the list cannot rot into exemptions for edges nobody has
     * — the task-617 "green because nothing matched" failure shape).</p>
     */
    static final List<SliceCycleBaselineEntry> CP_SLICE_CYCLE_BASELINE = List.of(
            entry("audit", "chat", "config", "mcp", "operation", "policy", "workspace"),
            entry("auth", "audit", "config", "policy", "telemetry", "workspace"),
            entry("chat", "audit", "auth", "checkpoint", "config", "context", "event", "files", "mcp",
                    "operation", "plugin", "policy", "principal", "provider", "runtime", "scheduled", "skill",
                    "status", "usage", "workspace"),
            entry("checkpoint", "audit", "chat", "config", "context", "runtime", "workspace"),
            entry("config", "audit", "auth", "chat", "context", "files", "mcp", "plugin", "policy",
                    "principal", "provider", "workspace"),
            entry("context", "chat", "config", "policy", "principal", "provider", "runtime", "skill", "usage"),
            entry("credentials", "audit", "config", "policy"),
            entry("event", "config", "workspace"),
            entry("files", "chat", "config", "policy", "provider", "runtime", "workspace"),
            entry("importjob", "config", "runtime", "workspace"),
            entry("mcp", "audit", "chat", "config", "credentials", "operation", "plugin", "policy", "principal",
                    "runtime", "skill", "status", "workspace"),
            entry("operation", "config", "runtime", "workspace"),
            entry("plugin", "audit", "chat", "config", "event", "mcp", "policy"),
            entry("policy", "audit", "auth", "chat", "config", "credentials", "mcp", "principal", "provider",
                    "workspace"),
            entry("principal", "audit", "auth", "chat", "config", "credentials", "policy", "provider", "skill",
                    "workspace"),
            entry("provider", "auth", "chat", "config", "context", "credentials", "policy", "workspace"),
            entry("runtime", "config", "event", "importjob", "workspace"),
            entry("scheduled", "audit", "auth", "chat", "config", "event", "operation", "policy", "principal",
                    "workspace"),
            entry("skill", "auth", "chat", "config", "policy", "principal", "workspace"),
            entry("status", "files"),
            entry("telemetry", "config"),
            entry("usage", "chat", "config", "context"),
            entry("workspace", "audit", "auth", "chat", "config", "event", "operation", "policy", "principal",
                    "runtime"));

    private static SliceCycleBaselineEntry entry(String from, String... to) {
        return new SliceCycleBaselineEntry(from, Set.of(to), SLICE_CYCLE_REVIEW_BY);
    }

    /** Flattened {@code from -> to} pairs of {@link #CP_SLICE_CYCLE_BASELINE}, for counting and reporting. */
    static Set<String> sliceCycleBaselineEdges() {
        Set<String> edges = new LinkedHashSet<>();
        for (SliceCycleBaselineEntry item : CP_SLICE_CYCLE_BASELINE) {
            for (String to : item.to().stream().sorted().toList()) {
                edges.add(item.from() + "->" + to);
            }
        }
        return Collections.unmodifiableSet(edges);
    }

    /** task-132: the whitelisted edge count, i.e. the ceiling the shrink-only test enforces. */
    static final int SLICE_CYCLE_BASELINE_EDGE_COUNT = 148;

    /**
     * task-132: build the slice-cycle rule for an arbitrary assignment and baseline. Extracted as a factory so
     * the reverse probe can run the <b>same</b> construction against fixtures with an empty baseline — a rule
     * nobody has seen fail is not a gate (task-123 §5 of the orchestration doc: 门要能证伪).
     */
    static SliceRule sliceCyclesFreeFrom(SliceAssignment assignment, List<SliceCycleBaselineEntry> baseline) {
        SliceRule rule = slices().assignedFrom(assignment).should().beFreeOfCycles();
        for (SliceCycleBaselineEntry item : baseline) {
            for (String to : item.to()) {
                rule = rule.ignoreDependency(assignedToSlice(assignment, item.from()),
                        assignedToSlice(assignment, to));
            }
        }
        return rule;
    }

    /**
     * task-132: the exemption predicate must be derived from the <b>same</b> assignment the rule is built on.
     *
     * <p>This is the bug the reverse probe caught. Reusing {@link #ownedBySlice(String)} here looked equivalent
     * and was not: it classifies through {@link CpModuleAssignment}, so for any other assignment it returns
     * false for every class, {@code ignoreDependency} suppresses nothing, and a baseline can be silently inert
     * while the rule still reads green on the fixtures it was supposed to exempt. Same shape as task-617's
     * crypto prefix that matched zero classes — a gate whose exemption matches nothing is decoration.</p>
     */
    static DescribedPredicate<JavaClass> assignedToSlice(SliceAssignment assignment, String slice) {
        return DescribedPredicate.describe("is assigned to slice " + slice,
                type -> SliceIdentifier.of(slice).equals(assignment.getIdentifierOf(type)));
    }

    /**
     * task-132: the production gate. See {@link #CP_SLICE_CYCLE_BASELINE} for what is whitelisted and why the
     * remaining assertion is still worth having.
     */
    static final ArchRule CP_SLICE_GRAPH_HAS_NO_CYCLES_OUTSIDE_BASELINE =
            sliceCyclesFreeFrom(new CpModuleAssignment(), CP_SLICE_CYCLE_BASELINE)
                    .as("CP capability slices must stay free of cycles outside the explicit task-132 baseline"
                            + " (a new cycle whose edges are all outside the baseline is a build failure;"
                            + " the skill -> context edge is banned by"
                            + " SKILL_SLICE_MUST_NOT_DEPEND_ON_CONTEXT_SLICE, not by this rule)");

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
        // task-132: a slice rule has no single that() class predicate, so its matched=<n> counts the classes
        // the ownership assignment resolves at all.
        targets.put(CP_SLICE_GRAPH_HAS_NO_CYCLES_OUTSIDE_BASELINE, CP_SLICE_OWNED_CLASSES);
        // task-132: the direct ban, attributed by owner, not by package prefix.
        targets.put(SKILL_SLICE_MUST_NOT_DEPEND_ON_CONTEXT_SLICE, ownedBySlice("skill"));
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
        targets.put(SKILL_SLICE_MUST_NOT_DEPEND_ON_CONTEXT_SLICE, ownedBySlice("context"));
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
            SPRING_BEAN_WITH_MULTIPLE_CONSTRUCTORS_NEEDS_EXPLICIT_AUTOWIRED,
            CP_SLICE_GRAPH_HAS_NO_CYCLES_OUTSIDE_BASELINE,
            SKILL_SLICE_MUST_NOT_DEPEND_ON_CONTEXT_SLICE);

    private CpArchitectureRules() { }
}
