package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Evaluates canonical permission atoms by unioning one principal's grants, then intersecting a path. */
@Component
public class GrantIntersectionEvaluator {

    private static final Set<String> ACTION_CLASSES = ToolFaceRegistry.builtinActionClasses();

    /** Reason tokens on {@link MissingLevel}; a closed vocabulary, safe to surface to a requester. */
    public static final String REASON_EMPTY_REQUEST = "empty-request";
    public static final String REASON_EMPTY_PRINCIPAL_PATH = "empty-principal-path";
    public static final String REASON_NO_SUBJECT = "no-subject";
    public static final String REASON_UNKNOWN_ACTION_CLASS = "unknown-action-class";
    public static final String REASON_BLANK_RESOURCE = "blank-resource";
    public static final String REASON_LEVEL_WITHOUT_GRANTS = "level-without-grants";
    public static final String REASON_NO_MATCHING_ATOM = "no-matching-atom";

    /**
     * task-124 / DSD-1509: the label an explanation uses for a pair that a live session temporary
     * grant covered. Such a {@link MatchedGrant} has {@code level == -1} because the token satisfied
     * the pair <b>instead of</b> any level; it is not a sixth level and not a "refused before
     * evaluation" marker (those only appear on {@link MissingLevel}).
     */
    public static final String SESSION_TOKEN_LABEL = "session-token";

    public record PermissionAtom(String actionClass, String resource) {
        public PermissionAtom {
            if (!ACTION_CLASSES.contains(actionClass)) {
                throw new IllegalArgumentException("Unknown actionClass: " + actionClass);
            }
            if (resource == null || resource.isBlank()) {
                resource = "*";
            }
            // PLAN-0496 #2 (I1): credential atoms carry only the canonical resource forms —
            // credential:<uuid> or credential:*; the bare '*' / partial globs are not allowed.
            if (ToolFaceRegistry.isCredentialActionClass(actionClass)
                    && !ToolFaceRegistry.isCanonicalCredentialResource(resource)) {
                throw new IllegalArgumentException(
                        "credential resource must be credential:* or credential:<uuid>: " + resource);
            }
        }
    }

    /**
     * DSD-1497 (task-125): one grant row's atom <b>with its row identity</b>. {@link PermissionAtom}
     * deliberately drops the row (the decision only needs the atom); an explanation must be able to
     * cite which grant authorized, so the attributed twin carries {@code grantId}/{@code grantSource}.
     * Levels built from a bare atom set carry {@code null} identities and simply cite nothing.
     */
    public record GrantAtom(String actionClass, String resource, String grantId, String grantSource) {

        public PermissionAtom toPermissionAtom() {
            return new PermissionAtom(actionClass, resource);
        }
    }

    /** One level of the operation path: a label plus the atoms that level carries. */
    public record PrincipalLevel(String label, List<GrantAtom> atoms) {

        public PrincipalLevel {
            atoms = atoms == null ? List.of() : List.copyOf(atoms);
        }

        public static PrincipalLevel of(String label, Set<PermissionAtom> atoms) {
            if (atoms == null || atoms.isEmpty()) {
                return new PrincipalLevel(label, List.of());
            }
            List<GrantAtom> rows = new ArrayList<>(atoms.size());
            for (PermissionAtom atom : atoms) {
                rows.add(new GrantAtom(atom.actionClass(), atom.resource(), null, null));
            }
            return new PrincipalLevel(label, rows);
        }
    }

    /**
     * One reason a request was refused, at a level. {@code level} is the zero-based index into the
     * principal path; {@code -1} means the refusal happened <b>before</b> any level was evaluated
     * (empty request, empty path, an action class outside the vocabulary, a blank resource) and the
     * reason token names which.
     */
    public record MissingLevel(int level, String levelLabel, String actionClass, String resource, String reason) {}

    /** One grant row that carried a requested atom on a level. */
    public record MatchedGrant(int level, String levelLabel, String actionClass, String resource,
                               String grantId, String grantSource) {}

    /** What one level contributed: how many atoms it holds and whether it covered every requested pair. */
    public record EvaluatedLevel(int level, String label, int atomCount, boolean matched) {}

    /**
     * DSD-1497: the answer of the shared kernel, with the trail that produced it.
     *
     * <p>{@code allowed} is the same boolean {@link #allows} returns for the same inputs — it is the
     * kernel's own verdict, not a re-derivation. {@code deepestMissingLevel} is the highest missing
     * level index, or {@code -1} when the request was allowed or refused before level evaluation
     * ({@code missingAtom.reason} then carries the token).</p>
     */
    public record GrantExplanation(boolean allowed, int deepestMissingLevel, MissingLevel missingAtom,
                                   List<MissingLevel> missingLevels, List<MatchedGrant> matchedGrantRefs,
                                   List<EvaluatedLevel> evaluatedLevels) {

        public GrantExplanation {
            missingLevels = missingLevels == null ? List.of() : List.copyOf(missingLevels);
            matchedGrantRefs = matchedGrantRefs == null ? List.of() : List.copyOf(matchedGrantRefs);
            evaluatedLevels = evaluatedLevels == null ? List.of() : List.copyOf(evaluatedLevels);
        }

        /** A refusal that never reached the level scan; no grant row was read. */
        public static GrantExplanation deniedBeforeEvaluation(String reason) {
            MissingLevel miss = new MissingLevel(-1, null, null, null, reason);
            return new GrantExplanation(false, -1, miss, List.of(miss), List.of(), List.of());
        }
    }

    /** Parses an array of {actionClass, resource?} atoms. Missing resource means wildcard. */
    public Set<PermissionAtom> parse(JsonNode permissions) {
        if (permissions == null || !permissions.isArray()) {
            throw new IllegalArgumentException("permissions must be an atom array");
        }
        Set<PermissionAtom> atoms = new LinkedHashSet<>();
        for (JsonNode atom : permissions) {
            if (!atom.isObject()) {
                throw new IllegalArgumentException("permission atom must be an object");
            }
            atom.fieldNames().forEachRemaining(field -> {
                if (!"actionClass".equals(field) && !"resource".equals(field)) {
                    throw new IllegalArgumentException("Unknown permission atom field: " + field);
                }
            });
            JsonNode actionClass = atom.get("actionClass");
            JsonNode resource = atom.get("resource");
            if (actionClass == null || !actionClass.isTextual()
                    || (resource != null && !resource.isTextual())) {
                throw new IllegalArgumentException("permission atom requires string actionClass/resource fields");
            }
            atoms.add(new PermissionAtom(actionClass.asText(), resource == null ? "*" : resource.asText()));
        }
        return Set.copyOf(atoms);
    }

    /** Grant sources add permissions to one principal; source labels do not create precedence. */
    public Set<PermissionAtom> union(Collection<AuthorizationGrant> grants) {
        if (grants == null || grants.isEmpty()) {
            return Set.of();
        }
        Set<PermissionAtom> result = new LinkedHashSet<>();
        for (AuthorizationGrant grant : grants) {
            if (grant == null) {
                throw new IllegalArgumentException("grant must not be null");
            }
            result.addAll(parse(grant.getPermissions()));
        }
        return Set.copyOf(result);
    }

    /**
     * The attributed twin of {@link #union}: identical atoms and identical de-duplication, but each
     * row keeps the grant it came from. {@link #union} stays the decision-side read (a decision never
     * depends on row identity); this one exists so an explanation can cite the rows.
     */
    public List<GrantAtom> unionAttributed(Collection<AuthorizationGrant> grants) {
        if (grants == null || grants.isEmpty()) {
            return List.of();
        }
        Set<GrantAtom> result = new LinkedHashSet<>();
        for (AuthorizationGrant grant : grants) {
            if (grant == null) {
                throw new IllegalArgumentException("grant must not be null");
            }
            String grantId = grant.getId() == null ? null : grant.getId().toString();
            String grantSource = grant.getSource();
            for (PermissionAtom atom : parse(grant.getPermissions())) {
                result.add(new GrantAtom(atom.actionClass(), atom.resource(), grantId, grantSource));
            }
        }
        return List.copyOf(result);
    }

    /** task-521 seam: id -> root scope. Default null => fs: keys fall back (test wiring only). */
    private java.util.function.Function<String, ResourceIdentity.RootScope> scopeResolver = id -> null;

    /** task-521: inject the root-scope resolver (pure-function tests / future wiring). */
    public void useScopeResolver(java.util.function.Function<String, ResourceIdentity.RootScope> resolver) {
        this.scopeResolver = resolver == null ? id -> null : resolver;
    }

    /**
     * Q-d: when both sides are {@code fs:} declaration keys, resolve them to {@code phys:} and
     * compare THERE (never as strings, 501 §10.4 #7). Anything else uses the shared matcher.
     */
    public boolean matchesResource(String grantResource, String requestResource, ToolShape shape) {
        Boolean physical = ResourceIdentity.matchesDeclaration(grantResource, requestResource, scopeResolver);
        if (physical != null) {
            return physical;
        }
        return LayeredPolicyResolver.matches(grantResource, requestResource, shape);
    }

    /** Every requested atom must be granted by every principal in the operation path. */
    public boolean allows(PolicyRequest request, List<Set<PermissionAtom>> principalPath) {
        return allows(request, principalPath, List.of());
    }

    /**
     * task-124 / DSD-1509 ②: the same intersection, with a live session temporary grant as the
     * <b>one explicit exception</b> to "every level holds the atom".
     *
     * <p>For a requested {@code (actionClass, resource)} pair that a token atom covers — same action
     * class and a resource match through {@link #matchesResource(String, String, ToolShape)}, so the
     * {@code fs:} declaration-key rules still apply — the per-level scan is skipped: the token
     * <i>replaces</i> the holding test instead of adding a level. Pairs it does not cover are
     * intersected across every level exactly as before, so a token can never widen an atom beyond the
     * pairs it lists and can never relax resource matching.</p>
     *
     * <p>The token list must already be restricted to the request's own session and the resolved leaf
     * principal (DSD-1509 G3, done by {@link SessionTemporaryGrantStore#tokenAtoms}); this method
     * trusts its inputs and only compares atoms.</p>
     */
    public boolean allows(PolicyRequest request, List<Set<PermissionAtom>> principalPath,
                          List<GrantAtom> sessionTokens) {
        if (principalPath == null) {
            return false;
        }
        List<PrincipalLevel> levels = new ArrayList<>(principalPath.size());
        for (int index = 0; index < principalPath.size(); index++) {
            levels.add(PrincipalLevel.of("level-" + index, principalPath.get(index)));
        }
        return decide(request, levels, sessionTokens, false).allowed();
    }

    /**
     * DSD-1497: the <b>same</b> kernel as {@link #allows}, with the trail recorded. The boolean in the
     * result is produced by the identical guard clauses and the identical action/resource/level scan,
     * so an explanation can never disagree with the decision it explains.
     */
    public GrantExplanation explain(PolicyRequest request, List<PrincipalLevel> principalPath) {
        return explain(request, principalPath, List.of());
    }

    /**
     * The attributed twin of {@link #allows(PolicyRequest, List, List)}: identical kernel, plus the
     * trail. A pair covered by a token appears in {@code matchedGrantRefs} as a
     * {@link #SESSION_TOKEN_LABEL} entry carrying the temporary row's id and
     * {@link GrantSources#SESSION_TEMP}, so task-125's explanation can say "allowed by a session
     * token" instead of naming a level that does not hold the atom.
     */
    public GrantExplanation explain(PolicyRequest request, List<PrincipalLevel> principalPath,
                                    List<GrantAtom> sessionTokens) {
        return decide(request, principalPath, sessionTokens, true);
    }

    private GrantExplanation decide(PolicyRequest request, List<PrincipalLevel> levels,
                                    List<GrantAtom> sessionTokens, boolean record) {
        if (request == null || request.actionClasses().isEmpty() || request.resources().isEmpty()) {
            return record
                    ? GrantExplanation.deniedBeforeEvaluation(REASON_EMPTY_REQUEST)
                    : new GrantExplanation(false, -1, null, List.of(), List.of(), List.of());
        }
        int levelCount = levels == null ? 0 : levels.size();
        if (levelCount == 0) {
            return record
                    ? GrantExplanation.deniedBeforeEvaluation(REASON_EMPTY_PRINCIPAL_PATH)
                    : new GrantExplanation(false, -1, null, List.of(), List.of(), List.of());
        }
        List<MissingLevel> missing = new ArrayList<>();
        List<MatchedGrant> matched = new ArrayList<>();
        Set<String> matchedKeys = new LinkedHashSet<>();
        String[] labels = new String[levelCount];
        int[] atomCounts = new int[levelCount];
        boolean[] levelMatched = new boolean[levelCount];
        boolean evaluatedAnyPair = false;
        for (int index = 0; index < levelCount; index++) {
            PrincipalLevel level = levels.get(index);
            labels[index] = level == null ? null : level.label();
            atomCounts[index] = level == null ? 0 : level.atoms().size();
            levelMatched[index] = true;
        }
        for (String actionClass : request.actionClasses()) {
            boolean known = ACTION_CLASSES.contains(actionClass);
            for (String resource : request.resources()) {
                if (!known) {
                    if (record) {
                        missing.add(new MissingLevel(-1, null, actionClass, resource, REASON_UNKNOWN_ACTION_CLASS));
                    }
                    for (int index = 0; index < levelCount; index++) {
                        levelMatched[index] = false;
                    }
                    continue;
                }
                if (resource == null || resource.isBlank()) {
                    if (record) {
                        missing.add(new MissingLevel(-1, null, actionClass, resource, REASON_BLANK_RESOURCE));
                    }
                    for (int index = 0; index < levelCount; index++) {
                        levelMatched[index] = false;
                    }
                    continue;
                }
                // DSD-1509 ②: a live session temporary grant covers this pair, so the levels do not
                // have to hold it. Scoped to exactly this pair — nothing else is relaxed.
                GrantAtom sessionToken = matchingSessionToken(
                        sessionTokens, actionClass, resource, request.shape());
                if (sessionToken != null) {
                    if (record) {
                        String key = "-1|" + actionClass + "|" + resource + "|"
                                + sessionToken.grantId() + "|" + sessionToken.grantSource();
                        if (matchedKeys.add(key)) {
                            matched.add(new MatchedGrant(-1, SESSION_TOKEN_LABEL, actionClass, resource,
                                    sessionToken.grantId(), sessionToken.grantSource()));
                        }
                    }
                    continue;
                }
                evaluatedAnyPair = true;
                for (int index = 0; index < levelCount; index++) {
                    PrincipalLevel level = levels.get(index);
                    List<GrantAtom> atoms = level == null ? List.of() : level.atoms();
                    boolean hit = false;
                    for (GrantAtom atom : atoms) {
                        if (!actionClass.equals(atom.actionClass())) {
                            continue;
                        }
                        if (!matchesResource(atom.resource(), resource, request.shape())) {
                            continue;
                        }
                        hit = true;
                        if (record) {
                            String key = index + "|" + actionClass + "|" + resource + "|"
                                    + atom.grantId() + "|" + atom.grantSource();
                            if (matchedKeys.add(key)) {
                                matched.add(new MatchedGrant(index, labels[index], actionClass, resource,
                                        atom.grantId(), atom.grantSource()));
                            }
                        }
                    }
                    if (!hit) {
                        levelMatched[index] = false;
                        if (record) {
                            missing.add(new MissingLevel(index, labels[index], actionClass, resource,
                                    atoms.isEmpty() ? REASON_LEVEL_WITHOUT_GRANTS : REASON_NO_MATCHING_ATOM));
                        }
                    }
                }
            }
        }
        boolean allowed = true;
        for (int index = 0; index < levelCount; index++) {
            if (!levelMatched[index]) {
                allowed = false;
            }
        }
        if (!record) {
            return new GrantExplanation(allowed, -1, null, List.of(), List.of(), List.of());
        }
        // DSD-1497: a pair refused by the vocabulary pre-check never reaches a level, so no level was
        // evaluated -- reporting them as evaluated (matched=false) reads as "we looked and found
        // nothing", which is the opposite of what happened.
        List<EvaluatedLevel> evaluated = new ArrayList<>(evaluatedAnyPair ? levelCount : 0);
        if (evaluatedAnyPair) {
            for (int index = 0; index < levelCount; index++) {
                evaluated.add(new EvaluatedLevel(index, labels[index], atomCounts[index], levelMatched[index]));
            }
        }
        int deepest = -1;
        MissingLevel deepestMiss = null;
        for (MissingLevel miss : missing) {
            if (miss.level() >= 0 && miss.level() >= deepest) {
                deepest = miss.level();
                deepestMiss = miss;
            }
        }
        if (deepestMiss == null && !missing.isEmpty()) {
            deepestMiss = missing.get(0);
        }
        return new GrantExplanation(allowed, deepest, deepestMiss, missing, matched, evaluated);
    }

    /**
     * The first token atom that covers the pair, or {@code null}. Matching goes through
     * {@link #matchesResource}, so {@code fs:} declaration keys keep their physical-key semantics and a
     * {@code *} token stays a wildcard only to the extent the standing matcher says so.
     */
    private GrantAtom matchingSessionToken(List<GrantAtom> sessionTokens, String actionClass,
                                           String resource, ToolShape shape) {
        if (sessionTokens == null || sessionTokens.isEmpty()) {
            return null;
        }
        for (GrantAtom token : sessionTokens) {
            if (token == null || !actionClass.equals(token.actionClass())) {
                continue;
            }
            if (matchesResource(token.resource(), resource, shape)) {
                return token;
            }
        }
        return null;
    }
}
