package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * PLAN-0628 M2b (D28-39/D28-40, design §2/§2.5/§3/§4): the read side of {@code skill_read}.
 *
 * <h2>Why this is not {@link SkillLibraryService}</h2>
 *
 * <p>{@code SkillLibraryService.require(...)} answers "may this <b>caller</b> see this definition" by
 * asking {@link SkillAccessGuard}, which reads {@code TenantContext} — the HTTP request context. The
 * MCP logical entrypoint has no HTTP tenant context (DEV-016); the only caller facts available are
 * {@code AccessContext(userId, workspaceId, applicationSessionId)}. Reusing that service would mean
 * <b>fabricating a {@code TenantContext} for the duration of an MCP call</b>, and a fabricated
 * authorization input is worse than a second, narrower rule: the day the two disagree, the forgery
 * decides.</p>
 *
 * <p>So the reuse here is real but <b>not at the class level</b>: the credential that authorizes a
 * read is the Run's frozen {@code skills_snapshot} (the same document M2a freezes, D28-39), and the
 * legacy path ({@code {}} — pre-M2a Runs) reuses the <i>existing</i> scope resolution
 * {@link SkillCatalogSourceService#resolveListing}, which takes principal/user/workspace as plain
 * arguments and therefore needs no {@code TenantContext} at all. Nothing here re-implements scope
 * filtering.</p>
 *
 * <h2>Two facts, two roles (§4)</h2>
 *
 * <p>The snapshot answers "what was this Run admitted with"; the database answers "what is this
 * definition now". Neither is subordinate: the read <b>always</b> returns current content and then
 * reports the difference, so the model can distinguish "I misremembered" from "it changed" (D28-38
 * ③). With no snapshot there is nothing to compare against, so no comparison is made — and the
 * response <b>never claims "unchanged"</b> in that case (D28-40).</p>
 *
 * <h2>No existence oracle (§2.5, #9)</h2>
 *
 * <p>Three different situations — the skill exists but the caller cannot see it, the caller can see
 * it but this Run was never bound to it, and it does not exist at all — are answered by one and the
 * same branch: "not an entry of this Run's snapshot". They cannot drift apart because there is only
 * one branch, and it never consults live bindings or live visibility. That is the point: an
 * interface that answers by looking only at the Run's own frozen capability set has nothing to leak
 * about the rest of the database.</p>
 *
 * <p>The one visible-text difference is "in the snapshot but the row is gone". That case is not an
 * oracle either — the model was already shown that entry at admission — and D28-38 ② requires it to
 * say so out loud instead of silently omitting the skill.</p>
 */
@Service
public class SkillReadService {

    /** Reuses the read-surface code so the MCP tool and the public API cannot describe absence differently. */
    public static final String SKILL_NOT_FOUND = SkillLibraryService.SKILL_NOT_FOUND;

    /** The exact detail used for <b>all three</b> indistinguishable absence paths — never vary it. */
    public static final String SKILL_NOT_FOUND_DETAIL = "skill not found";

    public static final String INVALID_ARGUMENTS = "INVALID_ARGUMENTS";
    public static final String RUN_NOT_FOUND = "RUN_NOT_FOUND";

    /** Design §2: the body always comes from the live row, never from the snapshot. */
    public static final String CONTENT_SOURCE_CURRENT = "current";

    /** D28-38 ②: the Run was admitted with this entry and the definition has since been deleted. */
    public static final String NOTICE_DELETED = "该 skill 在你看到清单之后被删除";

    /** D28-38 ③: the visible text must let the model tell "it changed" from "I misremembered". */
    public static final String NOTICE_UPDATED = "该 skill 在你看到清单之后被更新过";

    /** Design §5: oversize is not approval-gated, but it must warn the model (D28-15). */
    public static final String NOTICE_OVERSIZE = "这次读取可能占用显著上下文预算";

    private static final Logger logger = LoggerFactory.getLogger(SkillReadService.class);

    private final ChatRunRepository chatRunRepository;
    private final SkillRepository skillRepository;
    private final SkillCatalogSourceService catalog;

    public SkillReadService(ChatRunRepository chatRunRepository, SkillRepository skillRepository,
                            SkillCatalogSourceService catalog) {
        this.chatRunRepository = chatRunRepository;
        this.skillRepository = skillRepository;
        this.catalog = catalog;
    }

    /**
     * One read request. {@code agentPrincipalId} is the identity M2a would have captured under
     * (D28-43: the Session's Agent principal), used only by the legacy fallback; {@code sessionId}
     * scopes the Run lookup so a mismatched run id cannot read another session's snapshot.
     */
    public record Query(UUID runId, String sessionId, UUID agentPrincipalId, String rawArgument) {
    }

    /** A resolved read. Scalars only — nothing here can carry a Jackson-2 node to the wire (PLAN-0633 C1). */
    public record Result(UUID skillId, String qualifiedName, String name, String description,
                         int version, String contentHash, String body, int bodyTokensEst,
                         boolean oversize, String contentSource, String notice,
                         boolean snapshotAbsent) {

        public Map<String, Object> toMap() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("skillId", skillId == null ? "" : skillId.toString());
            view.put("qualifiedName", qualifiedName);
            view.put("name", name);
            view.put("description", description);
            view.put("version", version);
            view.put("contentHash", contentHash);
            // D28-38 ③ names the current pair explicitly so the model never has to infer which side
            // of the comparison a field belongs to. They are the same values as version/contentHash
            // above by construction — that duplication is deliberate, not an oversight.
            view.put("currentVersion", version);
            view.put("currentHash", contentHash);
            view.put("body", body);
            view.put("bodyTokensEst", bodyTokensEst);
            view.put("oversize", oversize);
            view.put("contentSource", contentSource);
            List<String> diagnostics = new ArrayList<>();
            if (snapshotAbsent) {
                // D28-40 ①: the Run predates M2a. Say so where the caller reads it, not only in logs.
                diagnostics.add(SkillCatalogSnapshotService.DIAG_ABSENT);
            }
            view.put("diagnostics", List.copyOf(diagnostics));
            if (notice != null && !notice.isBlank()) {
                view.put("notice", notice);
            }
            return view;
        }
    }

    /**
     * The only address form the tool accepts: the canonical uuid shown as {@code skillId} in the
     * run's listing.
     *
     * <p>Qualified names are refused <b>before dispatch</b> rather than resolved here. The policy
     * layer binds rules to {@code skill:<uuid>}; accepting a second spelling would let a caller
     * address the same skill without matching a rule written against its uuid.</p>
     *
     * <p>A <b>bare name</b> is also refused rather than resolved because V101's 双存 allows the same
     * name in the instance library and in several workspaces: picking one would be picking a
     * permission the caller may not have (D28-31). The listing's {@code skillId} is the only
     * unambiguous address the model already holds.</p>
     */
    public static UUID requireSkillIdArgument(String rawArgument) {
        String candidate = rawArgument == null ? "" : rawArgument.trim();
        UUID parsed = canonicalUuid(candidate);
        if (parsed == null) {
            throw invalidArgument();
        }
        return parsed;
    }

    public Result read(Query query) {
        UUID target = requireSkillIdArgument(query.rawArgument());
        ChatRun run = chatRunRepository.findById(query.runId())
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, RUN_NOT_FOUND,
                        "chat run not found"));
        if (query.sessionId() == null || !query.sessionId().equals(run.getSessionId())) {
            // The gate above already proved the Run belongs to this Session; a mismatch here is a
            // caller bug, and answering "no such run" leaks nothing about any skill.
            throw new CpApiException(HttpStatus.NOT_FOUND, RUN_NOT_FOUND, "chat run not found");
        }

        JsonNode snapshot = run.getSkillsSnapshot();
        boolean snapshotAbsent = SkillCatalogSnapshotService.isAbsent(snapshot);
        SkillCatalogSourceService.Item entry = snapshotAbsent
                ? resolveLegacy(run, query.agentPrincipalId(), target)
                : match(SkillCatalogSourceService.itemsFromSnapshot(snapshot), target);
        if (entry == null) {
            // The single absence branch: invisible / not-bound / nonexistent all land here (#9).
            throw notFound();
        }
        if (entry.skillId() == null) {
            // An entry without an id can only be an older/hand-written snapshot; it cannot be read,
            // and it has no id to leak. Treat it as "was in the listing, no longer readable".
            throw deletedDuringRun();
        }

        Skill current = skillRepository.findById(entry.skillId()).orElse(null);
        if (current == null) {
            // D28-38 ②: the model holds the name from the listing, so silence would let it conclude
            // the skill never existed. Only reachable for entries this Run was actually shown.
            throw deletedDuringRun();
        }

        String notice = buildNotice(snapshotAbsent, entry, current);
        return new Result(current.getId(), entry.qualifiedName(), current.getName(),
                current.getDescription(), current.getVersion(), current.getContentHash(),
                current.getBody(), current.getBodyTokensEst(), current.isOversize(),
                CONTENT_SOURCE_CURRENT, notice, snapshotAbsent);
    }

    /**
     * D28-40: a Run without a snapshot falls back to <b>live</b> resolution, visibly.
     *
     * <p>Three things happen together and none of them is optional: the response carries the
     * {@code snapshot_absent} diagnostic, a structured log line records run + reason, and the result
     * is <b>never written back</b> to {@code skills_snapshot}. Writing back would forge history —
     * worse than having none, because a later reader could not tell a captured snapshot from a
     * back-filled one.</p>
     *
     * <p>{@code resolveListing} rather than {@code resolve}: the line view has already discarded the
     * id/version/hash this tool needs. It is the same resolution (same ordering, dedupe, scope
     * rules), so the fallback cannot disagree with what the listing would have shown.</p>
     */
    private SkillCatalogSourceService.Item resolveLegacy(ChatRun run, UUID agentPrincipalId,
                                                         UUID target) {
        SkillCatalogSourceService.Request request = SkillCatalogSourceService.Request.of(
                agentPrincipalId, uuidOrNull(run.getUserId()), uuidOrNull(run.getWorkspaceId()));
        SkillCatalogSourceService.Listing listing = catalog.resolveListing(request);
        logger.info("[LIFECYCLE] service=cp event=skill_read_snapshot_absent runId={} reason={} "
                        + "fallback=live status={} entries={}",
                run.getId(), SkillCatalogSnapshotService.DIAG_ABSENT, listing.status(),
                listing.items().size());
        return match(listing.items(), target);
    }

    private static SkillCatalogSourceService.Item match(List<SkillCatalogSourceService.Item> items,
                                                        UUID target) {
        for (SkillCatalogSourceService.Item item : items) {
            if (target.equals(item.skillId())) {
                return item;
            }
        }
        return null;
    }

    /** Strict uuid: {@link UUID#fromString} alone accepts short groups ("1-1-1-1-1"). */
    private static UUID canonicalUuid(String candidate) {
        try {
            UUID parsed = UUID.fromString(candidate);
            return parsed.toString().equals(candidate.toLowerCase(Locale.ROOT)) ? parsed : null;
        } catch (IllegalArgumentException notAnId) {
            return null;
        }
    }

    private static UUID uuidOrNull(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw.trim());
        } catch (IllegalArgumentException notAnId) {
            return null;
        }
    }

    /**
     * The model-visible notice (§3 ③, §5). Composed from independent fragments so a read can be
     * simultaneously "changed since the listing" and "expensive to read in full".
     *
     * <p>With {@code snapshotAbsent} there is nothing to compare against, so no change is claimed —
     * and "unchanged" is not claimed either (D28-40, design §4).</p>
     */
    private static String buildNotice(boolean snapshotAbsent, SkillCatalogSourceService.Item entry,
                                      Skill current) {
        StringBuilder notice = new StringBuilder();
        if (!snapshotAbsent && changedSinceSnapshot(entry, current)) {
            notice.append(NOTICE_UPDATED)
                    .append("（清单 v").append(entry.version())
                    .append("，当前 v").append(current.getVersion()).append("）。");
        }
        if (current.isOversize()) {
            notice.append(NOTICE_OVERSIZE)
                    .append("（约 ").append(current.getBodyTokensEst()).append(" tokens）。");
        }
        return notice.isEmpty() ? null : notice.toString();
    }

    private static boolean changedSinceSnapshot(SkillCatalogSourceService.Item entry, Skill current) {
        if (entry.version() != current.getVersion()) {
            return true;
        }
        // A snapshot without a hash has nothing to compare; version alone then decides.
        String recorded = entry.contentHash();
        return recorded != null && !recorded.isBlank()
                && !Objects.equals(recorded, current.getContentHash());
    }

    private static CpApiException notFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, SKILL_NOT_FOUND, SKILL_NOT_FOUND_DETAIL);
    }

    private static CpApiException deletedDuringRun() {
        return new CpApiException(HttpStatus.NOT_FOUND, SKILL_NOT_FOUND, NOTICE_DELETED);
    }

    private static CpApiException invalidArgument() {
        return new CpApiException(HttpStatus.BAD_REQUEST, INVALID_ARGUMENTS,
                "skill_read requires the skill's uuid — use the skillId shown for this run's "
                        + "skill listing; qualified names and bare names are not accepted");
    }
}
