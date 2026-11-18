package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * task-40 §3 (D-1884 / D-1885): an agent finishing its turn can hand the session to another
 * participant of the SAME session, without a human pressing TO.
 *
 * <p><b>Lead Q1 ruling, written into the contract face (this comment is the code half of it):</b>
 * 人发起 vs agent 发起靠审计面区分、不靠 run 行 —— origin 侧 wake run
 * 一律 "scheduled" 那条限制，用 wake_dispatch 审计行的 triggerSource="to" 补齐。
 * The run row therefore stays trigger_source="chain" (zero migration: the CHECK already allows it)
 * and the distinguishability lives in the durable wake_dispatch rows this method produces:
 * parentRunId != null (an agent handoff IS a delegation edge, unlike human TO siblings), the audit
 * label "to", and the round prefix "wake:to:agent:". A reader that wants "was this TO typed by a
 * human or emitted by an agent" joins on those; nobody may add a column for it later — that is what
 * "agent_to 是未来升级项，不是本批欠账" means.</p>
 *
 * <p><b>Lead Q3 ruling:</b> the handoff line lands as an ASSISTANT messages row under the CALLING
 * run, because the acceptance verb is 告知 — a line that only exists inside a wake prompt leaves
 * the human audience unable to read what LEAD said. It is written through the ONE assistant write
 * point with {@link ChatSubmissionService.AssistantWriteKind#AGENT_HANDOFF}, which keeps PLAN-0669
 * "one assistant write point" true and skips exactly the two side effects a handoff must not have
 * (see that enum).</p>
 *
 * <p><b>Never a false announcement:</b> the line is persisted only once at least one audience member
 * was actually acted on (a Run, a queued hand-off, a notify, or a deliberate suppression). If every
 * target failed validation or dispatch, the session gets no sentence claiming a hand-off happened:
 * the buckets in the response say what did. Same 失败不静默 face task-53 / task-60 built for human
 * TO.</p>
 */
@Service
public class AgentHandoffService {

    private static final Logger logger = LoggerFactory.getLogger(AgentHandoffService.class);

    /** Same ceiling as run guidance: one handoff line is a sentence, not a document. */
    static final int MAX_CONTENT_LENGTH = ChatRunGuidanceService.MAX_BODY_LENGTH;
    static final int MAX_IDEMPOTENCY_KEY_LENGTH = 128;

    private final ChatRunRepository chatRunRepository;
    private final SessionParticipantRepository sessionParticipantRepository;
    private final ChatSubmissionService chatSubmissionService;
    private final WakeFanOutService wakeFanOutService;
    /**
     * 名册与显示名的**唯一来源**：{@code SessionParticipantService.list} 就是 {@code MentionParser}
     * 拿名册的同一个入口（AGENT 取 agent_principals.name、HUMAN 取用户显示名、保留名剔除）。
     * 这里若自己再拼一份 displayName，两边迟早对不上 —— 那正是本批要消灭的分歧。
     */
    private final SessionParticipantService sessionParticipantService;

    public AgentHandoffService(ChatRunRepository chatRunRepository,
                               SessionParticipantRepository sessionParticipantRepository,
                               ChatSubmissionService chatSubmissionService,
                               WakeFanOutService wakeFanOutService,
                               SessionParticipantService sessionParticipantService) {
        this.chatRunRepository = chatRunRepository;
        this.sessionParticipantRepository = sessionParticipantRepository;
        this.chatSubmissionService = chatSubmissionService;
        this.wakeFanOutService = wakeFanOutService;
        this.sessionParticipantService = sessionParticipantService;
    }

    /**
     * What one hand-off did. The messageId is null exactly when nothing was announced. The
     * conservation invariant (runIds + failed + deferred + notified + suppressed == requested
     * targets) is inherited from {@link WakeFanOutService.TargetedWake}, not recomputed here.
     */
    public record HandoffOutcome(String runId, String roundId, String messageId,
                                 WakeFanOutService.TargetedWake to,
                                 List<UUID> ccNotified, List<UUID> ccIgnored,
                                 List<String> unresolvedNames) {
    }

    /** One roster row as the agent-side tool reads it: names, not just ids. */
    public record RosterPeer(String participantId, String displayName, String principalKind,
                             String role, String respondPolicy, boolean disabled) {
    }

    /**
     * @param runId the CALLING run — the agent handing off. Provenance (session, branch, workspace,
     *     owner, responder principal) is derived from this row only; the request body carries no
     *     actor, so an agent cannot speak as somebody else by naming them.
     */
    public HandoffOutcome handoff(String runId, String content, List<UUID> toParticipantIds,
                                  List<UUID> ccParticipantIds, String idempotencyKey) {
        return handoff(runId, content, toParticipantIds, List.of(), ccParticipantIds, List.of(),
                idempotencyKey);
    }

    /**
     * task-40 §3 第二批：同一面接受**显示名**（模型只会读名字，不会读 UUID）。
     *
     * <p>解析口径 = {@code MentionParser} 的既有语义：忽略大小写、忽略前导 {@code @}、trim 后
     * **精确匹配本会话 roster 的 displayName**；命中 0 个（不认识）或命中多个（重名）都算未解析
     * ——那份 roster 里"重名即不可判定"本来就是这个平台的老规则，这里不发明第二种判法。</p>
     *
     * <p>失败口径：未解析的名字**复用既有 reason 词** {@code mention_unresolved}（durable 行由
     * {@link WakeFanOutService#auditUnresolvedTargetName} 写，与 ①/② 同一形状），HTTP 上不新增
     * problem code —— 若一个目标都没解析出来，仍走既有的 {@code HANDOFF_TARGETS_REQUIRED}，detail
     * 里点名是哪些名字没解析（模型据此改口，而不是收到一个它看不懂的新码）。</p>
     */
    public HandoffOutcome handoff(String runId, String content, List<UUID> toParticipantIds,
                                  List<String> toDisplayNames, List<UUID> ccParticipantIds,
                                  List<String> ccDisplayNames, String idempotencyKey) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "HANDOFF_IDEMPOTENCY_KEY_REQUIRED",
                    "Idempotency-Key header is required");
        }
        if (idempotencyKey.length() > MAX_IDEMPOTENCY_KEY_LENGTH) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "HANDOFF_IDEMPOTENCY_KEY_TOO_LONG",
                    "Idempotency-Key must be at most " + MAX_IDEMPOTENCY_KEY_LENGTH + " characters");
        }
        if (content == null || content.isBlank()) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "HANDOFF_CONTENT_REQUIRED",
                    "Hand-off content is required: the audience must be able to read it");
        }
        if (content.length() > MAX_CONTENT_LENGTH) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "HANDOFF_CONTENT_TOO_LONG",
                    "Hand-off content exceeds " + MAX_CONTENT_LENGTH + " characters");
        }
        List<UUID> toIds = distinct(toParticipantIds);
        List<UUID> ccIds = distinct(ccParticipantIds);
        List<String> toNames = cleanNames(toDisplayNames);
        List<String> ccNames = cleanNames(ccDisplayNames);
        if (toIds.isEmpty() && ccIds.isEmpty() && toNames.isEmpty() && ccNames.isEmpty()) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "HANDOFF_TARGETS_REQUIRED",
                    "A hand-off names at least one TO or CC participant of this session");
        }
        ChatRun run = chatRunRepository.findById(UUID.fromString(runId))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "HANDOFF_RUN_NOT_FOUND",
                        "Run not found: " + runId));
        if (ChatRunRepository.TERMINAL_STATUSES.contains(run.getStatus())) {
            throw new CpApiException(HttpStatus.CONFLICT, "HANDOFF_RUN_NOT_ACTIVE",
                    "Run is terminal (" + run.getStatus() + "); no hand-off from a finished turn");
        }
        String sessionIdText = run.getSessionId();
        String workspaceId = run.getWorkspaceId();
        String ownerUserId = run.getUserId();
        UUID sessionId = UUID.fromString(sessionIdText);
        UUID responder = run.getAgentPrincipalId();
        if (responder == null) {
            throw new CpApiException(HttpStatus.CONFLICT, "HANDOFF_RUN_HAS_NO_RESPONDER",
                    "Run carries no responder principal, so the hand-off cannot be attributed");
        }
        SessionParticipant caller = sessionParticipantRepository
                .findFirstBySessionIdAndPrincipalId(sessionId, responder)
                .orElseThrow(() -> new CpApiException(HttpStatus.CONFLICT,
                        "HANDOFF_RUN_HAS_NO_RESPONDER",
                        "Responder principal is not a participant of this session"));
        String roundId = "wake:to:agent:" + runId;
        List<String> unresolvedNames = new ArrayList<>();
        List<UUID> resolvedTo = new ArrayList<>(toIds);
        List<UUID> resolvedCc = new ArrayList<>(ccIds);
        // task-40 §3 第二批：把显示名解析成 participantId（口径 = MentionParser 既有语义）。
        // 只有真的给了名字才读名册——用 id 点名的调用方（人类 composer 那条面）不背这次额外查询。
        if (!toNames.isEmpty() || !ccNames.isEmpty()) {
            List<SessionParticipantService.ParticipantView> roster =
                    sessionParticipantService.list(ownerUserId, workspaceId, sessionIdText)
                            .participants();
            resolveNames(roster, toNames, resolvedTo, unresolvedNames);
            resolveNames(roster, ccNames, resolvedCc, unresolvedNames);
        }
        // 没解析出来就留痕（一行一个名字，复用 mention_unresolved），然后按既有码拒绝：
        // 不新增 problem code —— 模型要能看懂「这个名字不认识」，而不是收到一个陌生错误码。
        for (String unresolved : unresolvedNames) {
            wakeFanOutService.auditUnresolvedTargetName(sessionId, workspaceId, ownerUserId, roundId,
                    "to");
            logger.warn("[LIFECYCLE] service=cp event=wake_to_handoff outcome=refused "
                            + "reason=mention_unresolved runId={} round={} name={}", runId, roundId,
                    unresolved);
        }
        if (resolvedTo.isEmpty() && resolvedCc.isEmpty()) {
            throw new CpApiException(HttpStatus.UNPROCESSABLE_ENTITY, "HANDOFF_TARGETS_REQUIRED",
                    "A hand-off names at least one TO or CC participant of this session"
                            + " (unresolved=" + String.join(",", unresolvedNames)
                            + ", reason=mention_unresolved)");
        }
        if (resolvedTo.contains(caller.getId()) || resolvedCc.contains(caller.getId())) {
            // Reuses the composer token: naming yourself is the same mistake on either face.
            throw new CpApiException(HttpStatus.BAD_REQUEST, "PARTICIPANT_SELF_TARGET",
                    "A hand-off cannot name the handing-off participant");
        }
        WakeFanOutService.TargetedWake to = wakeFanOutService.agentHandoffFanOut(sessionId,
                workspaceId, ownerUserId, runId, content, resolvedTo);
        List<UUID> ccRequested = new ArrayList<>();
        for (UUID participantId : resolvedCc) {
            if (!resolvedTo.contains(participantId)) {
                ccRequested.add(participantId);
            }
        }
        List<UUID> ccNotified = wakeFanOutService.notifyExplicitObservers(sessionId,
                workspaceId, ownerUserId, roundId, ccRequested);
        List<UUID> ccIgnored = new ArrayList<>(ccRequested);
        ccIgnored.removeAll(ccNotified);
        int acted = to.runIds().size() + to.deferredTargets().size() + to.notifiedTargets().size()
                + to.suppressedTargets().size() + ccNotified.size();
        String messageId = null;
        if (acted > 0) {
            messageId = chatSubmissionService.persistAssistantResponse(sessionIdText, runId,
                    content, null, ChatSubmissionService.AssistantWriteKind.AGENT_HANDOFF);
        }
        logger.info("[LIFECYCLE] service=cp event=wake_to_handoff sessionId={} round={} targets={} "
                        + "dispatched={} deferred={} failed={} notified={} suppressed={} "
                        + "ccNotified={} ccIgnored={} unresolvedNames={} announced={}", sessionId, roundId,
                resolvedTo.size(),
                to.runIds().size(), to.deferredTargets().size(), to.failedTargets().size(),
                to.notifiedTargets().size(), to.suppressedTargets().size(), ccNotified.size(),
                ccIgnored.size(), unresolvedNames, messageId != null);
        return new HandoffOutcome(runId, roundId, messageId, to, List.copyOf(ccNotified),
                List.copyOf(ccIgnored), List.copyOf(unresolvedNames));
    }

    /**
     * task-40 §3 第二批：run 作用域的名册读面 —— agent 侧「名字从哪来」的唯一答案。
     *
     * <p>为什么必须让模型自己读：把名册当快照塞进提示词等于把解析从 CP 搬到提示词，换个模型就散
     * （Lead 2026-11-19 口径）。这里返回的就是 {@code MentionParser} 用的同一份 roster.</p>
     *
     * <p>禁用的参与者**照样返回**（{@code disabled=true}）：让模型看见它、并知道它不会被叫醒，
     * 比让它猜「为什么名单里没有」好；投递门本身仍会拒它。</p>
     */
    public List<RosterPeer> roster(String runId) {
        ChatRun run = chatRunRepository.findById(UUID.fromString(runId))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "HANDOFF_RUN_NOT_FOUND",
                        "Run not found: " + runId));
        return sessionParticipantService.list(run.getUserId(), run.getWorkspaceId(), run.getSessionId())
                .participants().stream()
                .map(view -> new RosterPeer(view.participantId().toString(), view.displayName(),
                        view.principalKind(), view.role(), view.respondPolicy(),
                        view.disabledAt() != null))
                .toList();
    }

    /** Trim + 去掉模型可能带上的前导 {@code @} + 去重；空名不参与解析。 */
    private static List<String> cleanNames(List<String> names) {
        if (names == null || names.isEmpty()) {
            return List.of();
        }
        Set<String> seen = new LinkedHashSet<>();
        for (String raw : names) {
            if (raw == null) {
                continue;
            }
            String name = raw.trim();
            while (name.startsWith("@")) {
                name = name.substring(1).trim();
            }
            if (!name.isEmpty()) {
                seen.add(name);
            }
        }
        return List.copyOf(seen);
    }

    /**
     * 精确名解析（口径 = {@code MentionParser}）：忽略大小写、名字必须整体相等；命中 0 或命中多个
     * 都算未解析（重名即不可判定是该面既有规则，不发明第二种判法）。
     */
    private static void resolveNames(List<SessionParticipantService.ParticipantView> roster,
                                    List<String> names, List<UUID> target,
                                    List<String> unresolved) {
        for (String name : names) {
            List<SessionParticipantService.ParticipantView> hits = roster.stream()
                    .filter(view -> view.displayName() != null
                            && view.displayName().equalsIgnoreCase(name))
                    .toList();
            if (hits.size() == 1) {
                UUID id = hits.get(0).participantId();
                if (!target.contains(id)) {
                    target.add(id);
                }
            } else if (!unresolved.contains(name)) {
                unresolved.add(name);
            }
        }
    }

    private static List<UUID> distinct(List<UUID> ids) {
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        Set<UUID> seen = new LinkedHashSet<>();
        for (UUID id : ids) {
            if (id != null) {
                seen.add(id);
            }
        }
        return List.copyOf(seen);
    }
}
