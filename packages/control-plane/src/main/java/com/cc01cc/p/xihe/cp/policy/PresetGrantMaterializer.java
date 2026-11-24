package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.GrantPresetAtom;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetAtomRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0610 T1.5 / task-933 R39: materializes 「主体 × 作用域」 preset bindings into
 * {@code grants(source='assigned')} rows carrying {@code origin_preset_id}.
 *
 * <p>Replaces {@code GrantDefaultService}'s hard-coded default sets. R39 (D-1926, user ruling
 * 2026-11-23) demotes the preset to a <b>read-only template</b>: a binding imports the preset's
 * atoms once and every subject may then fine-tune independently; editing a preset never rewrites
 * its holders here (the old automatic {@code materializeSubject} pass on every binding change was
 * exactly the binding R39 forbids — 「改预设内容 ⇒ 已导入主体权限不变」 is what
 * {@code PresetAsTemplateTest} pins). The result is written as one {@code grants} row per atom
 * carrying the same {@code scope_type/scope_id} as the binding plus the {@code origin_preset_id}
 * it came from (design #14). Evaluation then stays a one-hop read
 * ({@code AuthorizationGrantRepository#findScopedGrants}).</p>
 *
 * <p>Invariants enforced here:</p>
 *
 * <ul>
 *   <li><b>Capability atoms are never materialized</b> (design #23): they are filtered out and
 *       resolved at authentication time by {@link AuthzContext}.</li>
 *   <li><b>Scope compatibility is validated, not dropped</b> (decision #12): an atom whose
 *       {@code scope_class} does not fit the binding scope fails with
 *       {@code 400 ROLE_SCOPE_MISMATCH}; a corrupt row can never be silently ignored.</li>
 *   <li><b>Atom shape is validated</b> through
 *       {@link GrantIntersectionEvaluator.PermissionAtom}, so an unknown action class or a
 *       non-canonical credential resource fails closed instead of poisoning every evaluation.</li>
 *   <li><b>One row per atom</b> (round-2 P1-2), guarded by {@code uq_grants_role_atom} (its V186
 *       predicate reads {@code source='assigned'}).</li>
 *   <li><b>Reconciliation is per import group</b> (task-933): a row is only deleted when its own
 *       {@code origin_preset_id} group is still bound and no longer carries the atom. A row with a
 *       {@code NULL} origin (manual / migration-unattributable legacy rows) is local work and is
 *       never removed by a group rewrite — that is what keeps 「导入后每个主体可独立微调」true: a
 *       later binding change cannot resurrect an atom the subject deleted, and cannot wipe one it
 *       added.</li>
 *   <li>Only {@code source='assigned'} rows of this subject are reconciled — {@code spawn},
 *       {@code template}, {@code credential_binding} and the frozen {@code agent_default}
 *       snapshot are owner-written and never touched (P1-1). {@code source='preset'} rows are
 *       historical (V186 converted every persisted one; the CHECK no longer accepts the value).</li>
 * </ul>
 *
 * <p>Single transaction: the binding write, the materialization and the caller's
 * {@code users.token_version} bump commit or roll back together (I4). Row locks are the caller's
 * responsibility ({@code AuthUserLockService} for a user subject); the unique index is the last
 * line of defence against a concurrent duplicate.</p>
 */
@Service
public class PresetGrantMaterializer {

    private static final Logger logger = LoggerFactory.getLogger(PresetGrantMaterializer.class);

    /**
     * task-933: new writes carry {@link GrantSources#ASSIGNED}; the historical {@code preset}
     * value ({@link GrantSources#PRESET}) stays in the provenance vocabulary only — nothing
     * writes it anymore (V186 converted every persisted row), so the materializer exports the
     * write value here and never the retired one.
     */
    public static final String SOURCE_ASSIGNED = GrantSources.ASSIGNED;

    private static final String READ_STATE_READ = "read";

    /**
     * task-933: sentinel key for the {@code NULL} origin group. {@code Map.entry} rejects null,
     * and a group key may never collide with a real binding id — a random id generated once per
     * class load cannot equal a persisted UUID (collision probability ~0, and a collision would
     * only merge two import groups for one reconcile pass, never widen an authority).
     */
    private static final UUID UNATTRIBUTED_ORIGIN = new UUID(0L, -1L);

    /** Counts of one reconciliation run; a no-op run returns all zeros and writes no audit row. */
    public record Result(int created, int deleted, int scopes) {

        public boolean changed() {
            return created > 0 || deleted > 0;
        }
    }

    private final GrantPresetBindingRepository bindingRepository;
    private final GrantPresetAtomRepository permissionRepository;
    private final AuthorizationGrantRepository grantRepository;
    private final UserRepository userRepository;
    private final GrantIntersectionEvaluator evaluator;
    private final AuthzContext authzContext;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;

    public PresetGrantMaterializer(GrantPresetBindingRepository bindingRepository,
                                 GrantPresetAtomRepository permissionRepository,
                                 AuthorizationGrantRepository grantRepository,
                                 UserRepository userRepository,
                                 GrantIntersectionEvaluator evaluator,
                                 AuthzContext authzContext,
                                 AuditLogger auditLogger,
                                 ObjectMapper objectMapper) {
        this.bindingRepository = bindingRepository;
        this.permissionRepository = permissionRepository;
        this.grantRepository = grantRepository;
        this.userRepository = userRepository;
        this.evaluator = evaluator;
        this.authzContext = authzContext;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
    }

    /**
     * <b>Import hook</b> (task-933 / R39): applies every preset bound to the subject — once per
     * preset, each carrying its {@code origin_preset_id} — and reconciles only those import groups.
     * Editing a preset later does NOT come back through here (the automatic per-edit reconcile
     * this card retired); {@link #materializePreset} is the explicit replay face.
     */
    @Transactional
    public Result materializeSubject(String subjectType, UUID subjectId, UUID actorUserId,
                                     String auditWorkspaceId) {
        if (subjectType == null || subjectId == null) {
            throw new IllegalArgumentException("subjectType and subjectId are required");
        }
        List<GrantPresetBinding> bindings = bindingRepository
                .findBySubjectTypeAndSubjectId(subjectType, subjectId);

        Result result = reconcile(subjectType, subjectId,
                desiredByScopeAndOrigin(bindings), actorUserId, auditWorkspaceId);
        if (AuthzContext.SUBJECT_USER.equals(subjectType)) {
            invalidateNowAndAfterCompletion(subjectId);
        }
        return result;
    }

    /**
     * task-933: the import-group desired set of one subject — {@code (scope, atom) -> the set of
     * import-group ids that imported it}. Extracted from {@link #materializeSubject} so the
     * 「与预设对比」 face reads exactly the set a replay would write, without touching the write
     * path (pair it with {@link #desiredPresetSet}, which answers the same shape for the preset). An empty scope key is dropped:
     * a scope with no desired atom has nothing to display against.
     *
     * <p>The import group is the <b>preset id</b>, not the {@code grant_preset_bindings} row id.
     * V87's {@code uq_role_bindings} allows one binding per (role, subject, scope), so a preset id
     * is already a unique group key per scope, and the two views then coincide. Choosing it is what
     * makes {@code grants.origin_preset_id} mean what its name says: a display face can resolve the
     * cited template, and an unbind/rebind of the same preset keeps attributing the same row
     * instead of stranding it as unattributed local work (which would be a revoke the product
     * silently never performs).</p>
     */
    public Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>>
            desiredByScopeAndOrigin(List<GrantPresetBinding> bindings) {
        Set<UUID> roleIds = new LinkedHashSet<>();
        Map<AccessScope, Map<UUID, Set<UUID>>> grouped = new LinkedHashMap<>();
        for (GrantPresetBinding binding : bindings) {
            AccessScope scope = bindingScope(binding);
            roleIds.add(binding.getRoleId());
            grouped.computeIfAbsent(scope, ignored -> new LinkedHashMap<>())
                    .computeIfAbsent(binding.getRoleId(), ignored -> new LinkedHashSet<>())
                    .add(binding.getRoleId());
        }
        return desiredOf(roleIds, grouped);
    }

    /**
     * task-933 ④ (治理面「与预设对比」): the preset's OWN desired set — {@code (scope, atom) ->
     * the import-group (preset) ids that would import it}. Reading the preset's atoms through exactly the same
     * {@link #materializableAtom} projection a replay uses, so a compare never displays a set the
     * replay would not write. An orphaned scope key (a binding whose row is gone) is dropped.
     */
    public Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>>
            desiredPresetSet(UUID presetId) {
        if (presetId == null) {
            throw new IllegalArgumentException("presetId is required");
        }
        Set<UUID> roleIds = new LinkedHashSet<>();
        Map<AccessScope, Map<UUID, Set<UUID>>> grouped = new LinkedHashMap<>();
        for (GrantPresetBinding binding : bindingRepository.findByRoleId(presetId)) {
            roleIds.add(presetId);
            grouped.computeIfAbsent(bindingScope(binding), ignored -> new LinkedHashMap<>())
                    .computeIfAbsent(presetId, ignored -> new LinkedHashSet<>())
                    .add(presetId);
        }
        return desiredOf(roleIds, grouped);
    }

    /**
     * task-933 ③ (治理面「批量重放」): replay one preset onto EVERY subject bound to it, in one
     * governance transaction. This is the explicit face the R39 retired the automatic hook for:
     * a preset EDIT never calls it (「改预设内容 ⇒ 已导入主体权限不变」); only an operator does.
     * Each holder realigns within its OWN import groups (the per-holder
     * {@link #materializeSubject} pass behind {@link #materializePreset}).
     */
    @Transactional
    public int replayPresetToAll(UUID presetId, UUID actorUserId, String auditWorkspaceId) {
        if (presetId == null) {
            throw new IllegalArgumentException("presetId is required");
        }
        return materializePreset(presetId, actorUserId, auditWorkspaceId);
    }

    /**
     * The shared projection core: role ids + the {@code scope -> (roleId -> binding ids)} view
     * of an import set, projected through {@link #materializableAtom} exactly like the write
     * path. Both {@link #desiredByScopeAndOrigin} and {@link #desiredPresetSet} run through it
     * so a compare can never disagree with a replay.
     */
    private Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>>
            desiredOf(Set<UUID> roleIds, Map<AccessScope, Map<UUID, Set<UUID>>> grouped) {
        Map<UUID, List<GrantPresetAtom>> permissionsByRole = new HashMap<>();
        if (!roleIds.isEmpty()) {
            for (GrantPresetAtom permission : permissionRepository.findByIdRoleIdIn(roleIds)) {
                permissionsByRole.computeIfAbsent(permission.roleId(), ignored -> new ArrayList<>())
                        .add(permission);
            }
        }

        // (atom, originGroupId) — the import group is part of the identity: the same atom imported
        // from two presets stays two rows (per-group reconcile, V186 key) so one group's rewrite
        // never deletes another group's local fine-tune.
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>>> desired =
                new LinkedHashMap<>();
        for (Map.Entry<AccessScope, Map<UUID, Set<UUID>>> entry : grouped.entrySet()) {
            Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>> byAtom =
                    new LinkedHashMap<>();
            for (Map.Entry<UUID, Set<UUID>> group : entry.getValue().entrySet()) {
                for (GrantPresetAtom permission
                        : permissionsByRole.getOrDefault(group.getKey(), List.of())) {
                    GrantIntersectionEvaluator.PermissionAtom atom =
                            materializableAtom(permission, entry.getKey());
                    if (atom == null) {
                        continue;
                    }
                    for (UUID groupId : group.getValue()) {
                        byAtom.computeIfAbsent(atom, ignored -> new LinkedHashSet<>())
                                .add(groupId);
                    }
                }
            }
            if (!byAtom.isEmpty()) {
                desired.put(entry.getKey(), byAtom);
            }
        }
        return desired;
    }

    /**
     * T4.3 (I5): reconcile a subject whose <b>binding rows</b> changed outside a role edit — the
     * owner transfer rewrites the two instance-tier bindings and must also move the epoch, exactly
     * like a tier change does (design §3.4: 「角色/绑定变更 → 同事务重算 + token_version+1」).
     *
     * <p>{@link #materializeSubject} deliberately does not bump (a plain re-materialization is not
     * an authorization change); the transfer is, so it asks for both in one call and keeps the
     * ordering rule of round-4 P1-1: materialize first, then bump, all inside the caller's
     * transaction so a rollback leaves the epoch alone.</p>
     */
    @Transactional
    public Result materializeSubjectWithEpochBump(String subjectType, UUID subjectId,
                                                  UUID actorUserId, String auditWorkspaceId) {
        Result result = materializeSubject(subjectType, subjectId, actorUserId, auditWorkspaceId);
        if (AuthzContext.SUBJECT_USER.equals(subjectType)) {
            bumpUserEpoch(subjectId);
        }
        return result;
    }

    /**
     * task-996 (governance realign): materialize and bump the epoch <b>only when</b> the set
     * actually changed.
     *
     * <p>{@link #materializeSubjectWithEpochBump} always bumps because its caller (an owner
     * transfer) is an authorization change by definition. A governance replay is different: a
     * subject already in sync must stay logged in, so a no-op realign writes no rows, logs no
     * audit line and leaves {@code users.token_version} alone.</p>
     */
    @Transactional
    public Result materializeSubjectAndBumpIfChanged(String subjectType, UUID subjectId,
                                                     UUID actorUserId, String auditWorkspaceId) {
        Result result = materializeSubject(subjectType, subjectId, actorUserId, auditWorkspaceId);
        if (result.changed() && AuthzContext.SUBJECT_USER.equals(subjectType)) {
            bumpUserEpoch(subjectId);
        }
        return result;
    }

    /**
     * Replays one preset onto every subject bound to it — an <b>explicit governance act</b>
     * (the 「重新对齐」 face), not an edit hook.
     *
     * <p>task-933 / R39: a preset edit no longer rewrites its holders automatically (the old
     * per-edit reconcile was exactly the binding R39 forbids). Replaying is a deliberate act: it
     * brings every holder back to the preset's current set <b>within each holder's own import
     * groups</b> (the {@code materializeSubject} pass) — locally added atoms survive, atoms the
     * holder deleted come back, and every
     * touched <b>user</b> subject gets a {@code users.token_version} bump (I4) because a replay IS
     * an authorization change. The bump happens only when the subject's set actually changed, so a
     * no-op replay does not log anybody out.</p>
     */
    @Transactional
    public int materializePreset(UUID roleId, UUID actorUserId, String auditWorkspaceId) {
        if (roleId == null) {
            throw new IllegalArgumentException("roleId is required");
        }
        int materialized = 0;
        Set<String> seen = new HashSet<>();
        List<UUID> changedUserSubjects = new ArrayList<>();
        for (GrantPresetBinding binding : bindingRepository.findByRoleId(roleId)) {
            String key = binding.getSubjectType() + "|" + binding.getSubjectId();
            if (!seen.add(key)) {
                continue;
            }
            Result result = materializeSubject(binding.getSubjectType(), binding.getSubjectId(),
                    actorUserId, auditWorkspaceId);
            if (result.changed() && AuthzContext.SUBJECT_USER.equals(binding.getSubjectType())) {
                changedUserSubjects.add(binding.getSubjectId());
            }
            materialized++;
        }
        bumpUserEpochs(changedUserSubjects);
        return materialized;
    }

    /**
     * PLAN-0610 W1c-2 (round-4 P1-1): bumps the epoch of every affected user in one
     * <b>globally ordered</b> pass.
     *
     * <p>Bumping inside the binding loop took {@code SELECT … FOR UPDATE} locks in
     * {@code findByRoleId}'s return order, so two concurrent role edits over intersecting holder
     * sets ({@code R1={A,B}}, {@code R2={B,A}}) could form an ABBA cycle — PostgreSQL then aborts
     * one of them with {@code 40P01} and nothing maps that to a retryable error. Sorting by
     * {@link UUID#compareTo} (a total order that every process computes identically: signed
     * most-significant-long first) gives all materializer transactions the same lock order, which
     * removes the cycle. Any future multi-row {@code users} lock MUST use this same comparator.</p>
     *
     * <p><b>Why not one bulk {@code UPDATE users … WHERE id IN (:ids)}:</b> it is safe today
     * ({@code User} carries no {@code @Version}), but it would (a) bypass {@code
     * User#bumpTokenVersion}, the single place that encodes the epoch contract, and silently
     * desynchronize an optimistic-lock column if one is added later; (b) drop the per-user
     * {@code preset_materialization_epoch_bump} log line (the only trace of a bump — bumps are not
     * written to {@code audit_logs}); and (c) still leave us iterating the id set for the per-subject
     * capability-cache invalidation, so the round-trip saving is the only gain. Sorted row locks keep
     * the entity semantics and give a provable order instead.</p>
     */
    private void bumpUserEpochs(Collection<UUID> subjectIds) {
        if (subjectIds == null || subjectIds.isEmpty()) {
            return;
        }
        List<UUID> ordered = new ArrayList<>(new LinkedHashSet<>(subjectIds));
        ordered.sort(UUID::compareTo);
        for (UUID subjectId : ordered) {
            bumpUserEpoch(subjectId);
        }
    }

    /**
     * I4: the epoch bump that makes an already-issued access token stop working on its next request.
     * Joins the caller's transaction (the binding/role write), so a rollback leaves the epoch alone.
     */
    private void bumpUserEpoch(UUID subjectId) {
        userRepository.findByIdForUpdate(subjectId).ifPresent(user -> {
            user.bumpTokenVersion();
            userRepository.save(user);
            logger.info("[POLICY] event=preset_materialization_epoch_bump userId={} tokenVersion={}",
                    subjectId, user.getTokenVersion());
        });
    }

    /**
     * PLAN-0610 W1c (round-3 P1-2) + W1c-2 (round-4 P1-2): invalidate the capability cache
     * <b>twice</b>, for two different reasons.
     *
     * <ol>
     *   <li><b>Immediately</b> — a same-transaction reader must not see the pre-change snapshot.
     *       Today nothing reads capabilities inside the write transaction, but the W3 surfaces that
     *       will ({@code GET /api/v1/me/permissions} and the effective-capability echo of
     *       {@code PUT /api/v1/bindings}) would otherwise answer from the cache filled before the
     *       write.</li>
     *   <li><b>After the transaction completes</b> — a concurrent request can still re-fill the cache
     *       from the pre-commit state between the immediate invalidation and the commit; without the
     *       second invalidation that entry survives for the whole TTL
     *       ({@code cp.capability-cache-ttl-ms}, 30s), the opposite of the 「不超过一次 lookup」
     *       contract in {@link AuthzContext}. {@code afterCompletion} also covers rollback, where
     *       clearing is harmless and a mid-transaction fill must not be trusted.</li>
     * </ol>
     *
     * <p>The TTL is untouched: entries are still filled lazily on read and still expire, so a missed
     * invalidation degrades to the documented 30s bound instead of becoming permanent.</p>
     */
    private void invalidateNowAndAfterCompletion(UUID subjectId) {
        authzContext.invalidate(subjectId);
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) {
                authzContext.invalidate(subjectId);
            }
        });
    }

    /** Drops every {@code source='assigned'} row of a subject (subject deletion / binding wipe). */
    @Transactional
    public int clearSubject(String subjectType, UUID subjectId) {
        List<AuthorizationGrant> existing = grantRepository
                .findBySubjectTypeAndSubjectIdAndSource(subjectType, subjectId, SOURCE_ASSIGNED);
        if (!existing.isEmpty()) {
            grantRepository.deleteAll(existing);
        }
        if (AuthzContext.SUBJECT_USER.equals(subjectType)) {
            invalidateNowAndAfterCompletion(subjectId);
        }
        return existing.size();
    }

    /**
     * Reconciles per <b>import group</b>: the identity of a reconciled row is
     * {@code (scope, atom, originGroupId)}. A row only leaves the table when its own group is
     * still bound and no longer carries the atom — an ungrouped {@code NULL}-origin row (manual,
     * or a legacy row V186 could not attribute) is local work and survives every group rewrite,
     * and one group's rewrite can never delete another group's fine-tune. That is the R39
     * 「导入后每个主体可独立微调」 contract at the row level.
     */
    private Result reconcile(String subjectType, UUID subjectId,
                             Map<AccessScope,
                                 Map<GrantIntersectionEvaluator.PermissionAtom,
                                    Set<UUID>>> desired,
                             UUID actorUserId, String auditWorkspaceId) {
        // (scope, atom, originGroupId) -> row
        Map<AccessScope, Map<Map.Entry<GrantIntersectionEvaluator.PermissionAtom, UUID>,
                AuthorizationGrant>> existing = new HashMap<>();
        List<AuthorizationGrant> malformed = new ArrayList<>();
        for (AuthorizationGrant grant : grantRepository.findBySubjectTypeAndSubjectIdAndSource(
                subjectType, subjectId, SOURCE_ASSIGNED)) {
            AccessScope scope = grantScope(grant);
            // task-895: a capability-family row in `grants` cannot match a desired action atom; it
            // is dropped (and the row rewritten), never allowed to fail the whole reconciliation.
            Set<GrantIntersectionEvaluator.PermissionAtom> atoms =
                    evaluator.parseStored(grant.getPermissions());
            if (atoms.size() != 1) {
                // A materialized row carries exactly one atom; anything else cannot be matched
                // against the desired set, so it is dropped and rewritten.
                malformed.add(grant);
                continue;
            }
            // task-933: an unattributed historical row (origin NULL — V186 backfills the id only
            // when the (subject, scope, atom) matches exactly one preset) is pinned to the NULL
            // group, which no desired set ever contains: it is local work and survives while its
            // atom IS desired elsewhere (the re-import under the same origin would otherwise
            // duplicate the uq_grants_role_atom key).
            Map.Entry<GrantIntersectionEvaluator.PermissionAtom, UUID> key = Map.entry(
                    atoms.iterator().next(),
                    grant.getOriginPresetId() == null ? UNATTRIBUTED_ORIGIN
                            : grant.getOriginPresetId());
            existing.computeIfAbsent(scope, ignored -> new HashMap<>())
                    .put(key, grant);
        }

        List<AuthorizationGrant> toDelete = new ArrayList<>(malformed);
        List<AuthorizationGrant> toCreate = new ArrayList<>();
        Set<AccessScope> scopes = new LinkedHashSet<>();
        scopes.addAll(desired.keySet());
        scopes.addAll(existing.keySet());
        for (AccessScope scope : scopes) {
            Map<Map.Entry<GrantIntersectionEvaluator.PermissionAtom, UUID>, AuthorizationGrant> current =
                    existing.getOrDefault(scope, Map.of());
            Map<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>> wanted =
                    desired.getOrDefault(scope, Map.of());
            for (Map.Entry<Map.Entry<GrantIntersectionEvaluator.PermissionAtom, UUID>,
                    AuthorizationGrant> row
                    : current.entrySet()) {
                // task-933: a NULL-origin row (manual / migration-unattributable) is LOCAL work —
                // no import group ever owns it, so no group rewrite may delete it.
                // The map key holds the UNATTRIBUTED_ORIGIN sentinel, never a literal null, so
                // the guard MUST compare against the sentinel: a `!= null` test is always true and
                // would let one group's rewrite wipe a manual grant (breaking 「导入后每个主体可
                // 独立微调」 and re-adding it on the next import).
                if (!UNATTRIBUTED_ORIGIN.equals(row.getKey().getValue())
                        && !wanted.getOrDefault(row.getKey().getKey(), Set.of())
                                .contains(row.getKey().getValue())) {
                    toDelete.add(row.getValue());
                }
            }
            for (Map.Entry<GrantIntersectionEvaluator.PermissionAtom, Set<UUID>> entry
                    : wanted.entrySet()) {
                // task-933 / V186: uq_grants_role_atom now carries origin_preset_id in its key,
                // so the same atom under a SECOND import group is a DISTINCT row, not a 23505 —
                // the create pass keys on the exact (atom, group) pair and nothing else. An
                // atom another group holds therefore never blocks restoring this group's copy
                // (「重新对齐恢复预设集合」), and one group's rewrite can never have deleted
                // that other group's fine-tune (the delete pass above keeps it).
                for (UUID originGroupId : entry.getValue()) {
                    if (current.containsKey(Map.entry(entry.getKey(), originGroupId))) {
                        continue;
                    }
                    toCreate.add(newGrant(subjectType, subjectId, scope, entry.getKey(),
                            originGroupId, actorUserId));
                }
            }
        }

        if (!toDelete.isEmpty()) {
            grantRepository.deleteAll(toDelete);
            // BL-313 / D-182: the unique key (uq_grants_role_atom) can collide when a malformed
            // multi-atom row for the same (subject, scope, actionClass) is deleted and rewritten in
            // the same flush — Hibernate orders the INSERT before the DELETE (reproduced red as
            // 23505 on the e2e runner shape, requestId 8891fb74-…). Flush the deletions first so
            // the repair path actually repairs (the rewrite is then a plain insert).
            grantRepository.flush();
        }
        if (!toCreate.isEmpty()) {
            grantRepository.saveAll(toCreate);
        }
        Result result = new Result(toCreate.size(), toDelete.size(), scopes.size());
        if (result.changed()) {
            auditLogger.recordDurableChange(
                    actorUserId == null ? null : actorUserId.toString(), auditWorkspaceId,
                    "authorization_preset_grant_materialized", "grant", subjectId.toString(),
                    "subjectType=" + subjectType + " created=" + result.created()
                            + " deleted=" + result.deleted() + " scopes=" + result.scopes());
            logger.info("[POLICY] event=preset_grant_materialized subjectType={} subjectId={}"
                            + " created={} deleted={} scopes={}",
                    subjectType, subjectId, result.created(), result.deleted(), result.scopes());
        }
        return result;
    }

    /**
     * Converts one {@code grant_preset_atoms} row into an atom that may be stored in
     * {@code grants.permissions}, or {@code null} when the atom must not be materialized
     * (capability atoms, per design #23).
     */
    private GrantIntersectionEvaluator.PermissionAtom materializableAtom(
            GrantPresetAtom permission, AccessScope scope) {
        String actionClass = permission.actionClass();
        if (AtomNames.isCapabilityFamily(actionClass)) {
            return null;
        }
        if (!PermissionAtomCatalog.isActionAtom(actionClass)) {
            throw new IllegalStateException("Unknown permission atom in grant_preset_atoms: " + actionClass);
        }
        PermissionAtomCatalog.requireScopeCompatible(actionClass, scope.type());
        String resourcePattern = permission.resourcePattern();
        String resource = ToolFaceRegistry.isCredentialActionClass(actionClass)
                ? resourcePattern
                : (resourcePattern == null || PermissionAtomCatalog.WILDCARD.equals(resourcePattern)
                        ? null
                        : resourcePattern);
        // Validates the vocabulary and the canonical credential resource shape (fail-closed).
        return new GrantIntersectionEvaluator.PermissionAtom(actionClass, resource);
    }

    private AuthorizationGrant newGrant(String subjectType, UUID subjectId, AccessScope scope,
                                        GrantIntersectionEvaluator.PermissionAtom atom,
                                        UUID originPresetId, UUID actorUserId) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(subjectType);
        grant.setSubjectId(subjectId);
        if (actorUserId != null) {
            grant.setGranterType(AuthzContext.SUBJECT_USER);
            grant.setGranterId(actorUserId);
        }
        grant.setSource(SOURCE_ASSIGNED);
        grant.setOriginPresetId(originPresetId == UNATTRIBUTED_ORIGIN ? null : originPresetId);
        grant.setScopeType(scope.type());
        grant.setScopeId(scope.isInstance() ? null : scope.id());
        grant.setReadState(READ_STATE_READ);
        grant.setPermissions(atomArray(atom));
        return grant;
    }

    private ArrayNode atomArray(GrantIntersectionEvaluator.PermissionAtom atom) {
        ArrayNode permissions = objectMapper.createArrayNode();
        ObjectNode node = objectMapper.createObjectNode();
        node.put("actionClass", atom.actionClass());
        if (!PermissionAtomCatalog.WILDCARD.equals(atom.resource())) {
            node.put("resource", atom.resource());
        }
        permissions.add(node);
        return permissions;
    }

    private static AccessScope bindingScope(GrantPresetBinding binding) {
        if (AccessScope.INSTANCE.equals(binding.getScopeType())) {
            return AccessScope.instance();
        }
        if (AccessScope.WORKSPACE.equals(binding.getScopeType()) && binding.getScopeId() != null) {
            return AccessScope.workspace(binding.getScopeId());
        }
        throw new IllegalStateException("grant_preset_bindings row has an invalid scope: " + binding.getId());
    }

    private static AccessScope grantScope(AuthorizationGrant grant) {
        if (AccessScope.INSTANCE.equals(grant.getScopeType())) {
            return AccessScope.instance();
        }
        if (AccessScope.WORKSPACE.equals(grant.getScopeType()) && grant.getScopeId() != null) {
            return AccessScope.workspace(grant.getScopeId());
        }
        throw new IllegalStateException("grants row has an invalid scope: " + grant.getId());
    }

    /**
     * task-996: package-private read of the binding-scope projection so the governance compare
     * face cannot drift from the write path (one implementation, one answer).
     */
    static AccessScope scopeOfBinding(GrantPresetBinding binding) {
        return bindingScope(binding);
    }

    /**
     * task-996: package-private read of the grant-scope projection, for the same reason as
     * {@link #scopeOfBinding}.
     */
    static AccessScope scopeOfGrant(AuthorizationGrant grant) {
        return grantScope(grant);
    }
}
