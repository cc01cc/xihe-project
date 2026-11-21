package com.cc01cc.p.xihe.cp.architecture;

import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.ChainA;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.ChainB;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.CycleA;
import com.cc01cc.p.xihe.architectureprobe.CpArchitectureProbeFixtures.CycleB;
import com.cc01cc.p.xihe.cp.architecture.CpArchitectureRules.SliceCycleBaselineEntry;
import com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService;
import com.cc01cc.p.xihe.cp.skill.SkillCatalogSourceService;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.lang.EvaluationResult;
import com.tngtech.archunit.library.dependencies.SliceAssignment;
import com.tngtech.archunit.library.dependencies.SliceIdentifier;
import com.tngtech.archunit.library.dependencies.SliceRule;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

/**
 * task-132: proves the slice-cycle gate can actually fail, and that its whitelist is the only thing holding
 * production green.
 *
 * <p>Three readings, each of which the production rule alone cannot give: (1) a cycle is caught when the
 * baseline is empty — the gate is not decoration; (2) the very same cycle is admitted by the matching baseline
 * entry — so {@link CpArchitectureRules#CP_SLICE_CYCLE_BASELINE} is doing real work and its 148 entries are
 * load-bearing, not copy-paste; (3) an acyclic pair stays green under both settings, so the gate is not
 * merely "always red on two slices".</p>
 *
 * <p>The fixtures are the ones {@code CpArchitectureRuleProbeTest:140-154} already uses, via the same
 * {@code sliceCyclesFreeFrom} factory production uses — so the probe exercises the shipped construction, not a
 * hand-built approximation of it. Placed in a new file because that class's {@code :107-115} position
 * assertions are quoted by line number in the project AGENTS.md and must not shift.</p>
 */
class SliceCycleRuleProbeTest {

    /** Same two-slice assignment idiom as the existing cycle probe. */
    private static SliceAssignment twoSlices(Class<?> first, Class<?> second, String firstName, String secondName) {
        return new SliceAssignment() {
            @Override
            public SliceIdentifier getIdentifierOf(JavaClass type) {
                if (type.getName().equals(first.getName())) {
                    return SliceIdentifier.of(firstName);
                }
                if (type.getName().equals(second.getName())) {
                    return SliceIdentifier.of(secondName);
                }
                return SliceIdentifier.ignore();
            }

            @Override
            public String getDescription() { return "explicit slice-cycle probe assignment"; }
        };
    }

    /** The card's required reverse probe: CycleA/CycleB with no baseline must be red, and named. */
    @Test
    void cycleIsCaughtWhenTheBaselineIsEmpty() {
        JavaClasses types = new ClassFileImporter().importClasses(CycleA.class, CycleB.class);
        SliceRule rule = CpArchitectureRules.sliceCyclesFreeFrom(
                twoSlices(CycleA.class, CycleB.class, "probe-a", "probe-b"), List.of());
        EvaluationResult result = rule.evaluate(types);
        System.out.println("task-132 reverse probe - slice cycle, empty baseline (expected red) ->\n"
                + result.getFailureReport());
        assertEquals(1, result.getFailureReport().getDetails().size(), result.getFailureReport()::toString);
        assertThrows(AssertionError.class, () -> rule.check(types));
    }

    /**
     * The same cycle with the matching edge whitelisted turns green — which is what makes the 148 production
     * baseline entries an explicit, auditable exemption list rather than an accident of the rule being weak.
     */
    @Test
    void whitelistingTheExactEdgeIsWhatMakesItPass() {
        JavaClasses types = new ClassFileImporter().importClasses(CycleA.class, CycleB.class);
        SliceAssignment assignment = twoSlices(CycleA.class, CycleB.class, "probe-a", "probe-b");
        List<SliceCycleBaselineEntry> baseline = List.of(
                new SliceCycleBaselineEntry("probe-a", Set.of("probe-b"), "2026-12-31"),
                new SliceCycleBaselineEntry("probe-b", Set.of("probe-a"), "2026-12-31"));
        CpArchitectureRules.sliceCyclesFreeFrom(assignment, baseline).check(types);

        // A baseline that names edges which are not in the cycle must not silence it — the exemption is keyed to
        // the actual origin/target pair, not to "this rule has a baseline".
        SliceRule irrelevantBaseline = CpArchitectureRules.sliceCyclesFreeFrom(assignment, List.of(
                new SliceCycleBaselineEntry("probe-a", Set.of("probe-unrelated"), "2026-12-31")));
        assertThrows(AssertionError.class, () -> irrelevantBaseline.check(types));

        // And the mechanism is recorded as measured, because it is what limits the production rule: suppressing
        // ONE of the two directions already makes the 2-cycle disappear, since ignoreDependency removes the edge
        // from the graph rather than excusing a finding. This is exactly why the skill -> context invariant needs
        // its own unconditional ban (SKILL_SLICE_MUST_NOT_DEPEND_ON_CONTEXT_SLICE) instead of a baseline entry.
        CpArchitectureRules.sliceCyclesFreeFrom(assignment, List.of(
                new SliceCycleBaselineEntry("probe-a", Set.of("probe-b"), "2026-12-31"))).check(types);
    }

    /** An acyclic chain is green with or without a baseline, so the gate does not fire on one-way edges. */
    @Test
    void acyclicChainStaysGreen() {
        JavaClasses types = new ClassFileImporter().importClasses(ChainA.class, ChainB.class);
        SliceAssignment assignment = twoSlices(ChainA.class, ChainB.class, "probe-a", "probe-b");
        CpArchitectureRules.sliceCyclesFreeFrom(assignment, List.of()).check(types);
        CpArchitectureRules.sliceCyclesFreeFrom(assignment, List.of(
                new SliceCycleBaselineEntry("probe-a", Set.of("probe-b"), "2026-12-31"))).check(types);
    }

    /**
     * task-132: the production whitelist is load-bearing, and this proves it rather than asserting it in prose.
     *
     * <p>Run the <b>same</b> rule construction against the same production import with an <b>empty</b> baseline:
     * it must be red. If it were green, the 148 baseline entries would be exempting nothing and the shipped
     * gate would be passing for an unrelated reason (the task-617 shape: a rule whose scope does not overlap the
     * thing it claims to check). The red count is also printed, because the card's premise — "stock cycles, if
     * any" — is measured here and not taken on faith.</p>
     */
    @Test
    void theProductionBaselineIsWhatKeepsTheSliceRuleGreen() {
        JavaClasses production = new ClassFileImporter()
                .withImportOption(location -> !location.contains("test-classes"))
                .importPackages("com.cc01cc.p.xihe.cp");
        SliceAssignment assignment = new CpModuleAssignment();
        SliceRule withoutBaseline = CpArchitectureRules.sliceCyclesFreeFrom(assignment, List.of());
        EvaluationResult unsuppressed = withoutBaseline.evaluate(production);
        int reported = unsuppressed.getFailureReport().getDetails().size();
        System.out.println("task-132 - production slice rule with an EMPTY baseline (expected red): reportedCycles="
                + reported + " (ArchUnit detection limit truncates this, so it is a floor)");
        assertTrue(reported > 0, "the whitelist exempts nothing ⇒ the shipped gate would be green by accident");
        assertThrows(AssertionError.class, () -> withoutBaseline.check(production));

        // Same import, real baseline: green. The delta between these two readings is the whitelist's actual work.
        CpArchitectureRules.forFullImport(CpArchitectureRules.CP_SLICE_GRAPH_HAS_NO_CYCLES_OUTSIDE_BASELINE)
                .check(production);
    }

    /**
     * task-132 requirement 2: the baseline may only shrink. The count is pinned to the measured
     * cycle-closing edge total, so a new whitelisted edge needs a deliberate edit here plus the review date.
     */
    @Test
    void sliceCycleBaselineOnlyEverShrinks() {
        Set<String> edges = CpArchitectureRules.sliceCycleBaselineEdges();
        assertEquals(CpArchitectureRules.SLICE_CYCLE_BASELINE_EDGE_COUNT, edges.size(),
                "the slice-cycle baseline grew; new exemptions require a Lead decision, and removed ones"
                        + " must update SLICE_CYCLE_BASELINE_EDGE_COUNT in the same commit");
        assertTrue(CpArchitectureRules.CP_SLICE_CYCLE_BASELINE.stream()
                        .allMatch(item -> item.reviewBy().equals(CpArchitectureRules.SLICE_CYCLE_REVIEW_BY)),
                "every entry must carry the shared review deadline");
        // skill -> context is the edge the SkillImportValidator javadoc has been warning about; if it ever
        // lands in the baseline, that comment's promise has been bought off and this assertion is the tripwire.
        assertTrue(!edges.contains("skill->context"),
                "skill->context must never be whitelisted - it is the edge this card exists to keep banned");
    }

    /**
     * The baseline must match reality: every whitelisted edge has to exist in the current production graph,
     * otherwise the list rots into entries that exempt nothing (task-617's "green because nothing matched").
     */
    @Test
    void everyBaselineEdgeStillExistsInTheProductionSliceGraph() {
        JavaClasses production = new ClassFileImporter()
                .withImportOption(location -> !location.contains("test-classes"))
                .importPackages("com.cc01cc.p.xihe.cp");
        Set<String> live = liveOwnerEdges(production);
        Set<String> baseline = CpArchitectureRules.sliceCycleBaselineEdges();
        Set<String> stale = new java.util.TreeSet<>(baseline);
        stale.removeAll(live);
        assertTrue(stale.isEmpty(), () -> "slice-cycle baseline entries that no longer exist in the graph,"
                + " i.e. exemptions for nothing - delete them and lower SLICE_CYCLE_BASELINE_EDGE_COUNT: " + stale);
        assertTrue(live.containsAll(baseline));
    }

    /** A fixture class must never be mistaken for an owned production slice member. */
    @Test
    void probeFixturesAreNotAttributedToAnySlice() {
        // The architectureprobe package deliberately lives outside com.cc01cc.p.xihe.cp, so the ownership
        // matrix returns null for it. If a fixture ever became "owned", negative probes would stop being
        // inert and could leak into production scans.
        JavaClasses types = new ClassFileImporter().importClasses(CycleA.class, CycleB.class, ChainA.class,
                ChainB.class);
        assertEquals(0, types.stream().filter(CpArchitectureRules.CP_SLICE_OWNED_CLASSES).count(),
                "fixtures must stay outside the ownership matrix, exactly as the architectureprobe package"
                        + " contract requires");
    }

    private static Set<String> liveOwnerEdges(JavaClasses production) {
        var ownership = new CpModuleAssignment();
        Set<String> edges = new java.util.TreeSet<>();
        for (JavaClass type : production) {
            String from = ownership.ownerOf(type);
            if (from == null) {
                continue;
            }
            for (var dependency : type.getDirectDependenciesFromSelf()) {
                String to = ownership.ownerOf(dependency.getTargetClass());
                if (to != null && !to.equals(from)) {
                    edges.add(from + "->" + to);
                }
            }
        }
        return edges;
    }

    /** Kept for the rule's production wiring: the shipped rule must be the same construction as the probes. */
    @Test
    void productionRuleIsTheFactoryAppliedToTheRealBaseline() {
        ArchRule shipped = CpArchitectureRules.CP_SLICE_GRAPH_HAS_NO_CYCLES_OUTSIDE_BASELINE;
        assertTrue(shipped.getDescription().contains("task-132"), shipped.getDescription());
        assertTrue(CpArchitectureRules.ALL.contains(shipped), "the slice rule must be in ALL");
        assertTrue(CpArchitectureRules.CLASS_TARGETS.containsKey(shipped),
                "the slice rule must have a recorded target predicate, else matched=<n> cannot be reported");
    }

    /**
     * task-132: the direction ban is <b>directional</b>, and it fires on a real dependency.
     *
     * <p>Two readings the production run alone cannot give: banning {@code chain-a -> chain-b} is red while
     * banning {@code chain-b -> chain-a} is green, so the rule is not "red on any two slices that touch"; and
     * the red reading proves the <b>should</b>-side selector is alive. That matters because in production the
     * target slice matches 51 classes but currently <b>zero</b> dependencies from the origin slice, so nothing
     * in the green suite would reveal a target predicate that selected nothing (task-617's failure shape, this
     * time on the should side).</p>
     *
     * <p>Fixtures are classified by the probe's own assignment: {@link CpModuleAssignment} deliberately returns
     * null for the architectureprobe package, which is what keeps negative probes from becoming runtime beans.</p>
     */
    @Test
    void directionBanIsDirectionalAndFiresOnARealDependency() {
        JavaClasses chain = new ClassFileImporter().importClasses(ChainA.class, ChainB.class);
        SliceAssignment assignment = twoSlices(ChainA.class, ChainB.class, "chain-a", "chain-b");

        ArchRule bannedDirection = noClasses()
                .that(CpArchitectureRules.assignedToSlice(assignment, "chain-a"))
                .should().dependOnClassesThat(CpArchitectureRules.assignedToSlice(assignment, "chain-b"));
        EvaluationResult result = bannedDirection.evaluate(chain);
        System.out.println("task-132 reverse probe - slice direction ban (expected red) ->\n"
                + result.getFailureReport());
        assertEquals(1, result.getFailureReport().getDetails().size(), result.getFailureReport()::toString);
        assertThrows(AssertionError.class, () -> bannedDirection.check(chain));

        noClasses().that(CpArchitectureRules.assignedToSlice(assignment, "chain-b"))
                .should().dependOnClassesThat(CpArchitectureRules.assignedToSlice(assignment, "chain-a"))
                .check(chain);
    }

    /**
     * task-132: both selectors of the shipped ban are non-empty, and owner attribution really reaches the
     * mixed packages.
     *
     * <p>{@code ContextTemplateSourceService} lives in {@code cp.service} yet belongs to the context slice, and
     * it is the class holding today's {@code context -> skill} edge. A predicate built from
     * {@code getPackageName().startsWith("cp.context")} would select the 45 classes physically in that package
     * and silently drop the 6 that {@link CpModuleAssignment} assigns to the slice from {@code cp.service} —
     * including this one, so the dependency direction this card is about would be invisible to the gate.</p>
     */
    @Test
    void productionSelectorsAreNonEmptyAndAttributeTheMixedPackages() {
        JavaClasses production = new ClassFileImporter()
                .withImportOption(location -> !location.contains("test-classes"))
                .importPackages("com.cc01cc.p.xihe.cp");
        long skill = production.stream().filter(CpArchitectureRules.ownedBySlice("skill")).count();
        long context = production.stream().filter(CpArchitectureRules.ownedBySlice("context")).count();
        System.out.println("task-132 direction-ban selectors: skill=" + skill + " context=" + context);
        assertTrue(skill > 0, "the origin selector matches nothing, so the ban is a green no-op");
        assertTrue(context > 0, "the target selector matches nothing, so the ban can never fire");
        assertTrue(CpArchitectureRules.ownedBySlice("context").test(
                        production.get(ContextTemplateSourceService.class)),
                "a cp.service class owned by the context slice must be selected by owner, not by package prefix");
        assertTrue(CpArchitectureRules.ownedBySlice("skill").test(
                production.get(SkillCatalogSourceService.class)));
    }
}
