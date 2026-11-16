package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0489 T1.4（contract: PLAN-0486 spec/scheduled-task.md v3.4 §1/§4）：
 * scheduled-tasks 公开 API 的创建/读取/处置编排——校验、权限、配额、审计与
 * 读 DTO 投影；状态推进全部复用 T1.2 repository CAS 与 T1.3 分派器，不绕状态机。
 *
 * <p>权限（0486 #9/#10）接入既有 grant 授权门：action class
 * {@code CREATE_SCHEDULED_TASK}/{@code MANAGE_SCHEDULED_TASK} 入
 * {@link ToolFaceRegistry} builtin 词表，human 走 user grants、agent 走
 * agent_principal grants（同 {@code AgentTemplateService} 的
 * {@code requireUserAction} 语义，默认 deny fail-closed）。创建者对自己的任务
 * 全权处置；非创建者需 {@code MANAGE_SCHEDULED_TASK}，否则 403。</p>
 *
 * <p>配额（0486 #9）：workspace 总上限 50、principal 二级上限 10（按 {@code user_id}
 * 计），只计活跃态（scheduled/firing/missed）。delay_once TTL 7d：{@code expires_at}
 * = created_at + TTL，排期超 TTL 创建即 400。</p>
 */
@Service
public class ScheduledTaskApiService {

    public static final int WORKSPACE_LIMIT = 50;
    public static final int PRINCIPAL_LIMIT = 10;
    public static final Duration DELAY_TTL = Duration.ofDays(7);
    public static final int LIST_PROMPT_MAX = 120;
    public static final int LIST_DEFAULT_SIZE = 100;
    public static final int LIST_MAX_SIZE = 200;

    private static final Logger logger = LoggerFactory.getLogger(ScheduledTaskApiService.class);

    static final List<String> ACTIVE_STATUSES = List.of(
            ScheduledTask.STATUS_SCHEDULED, ScheduledTask.STATUS_FIRING, ScheduledTask.STATUS_MISSED);
    private static final List<String> RERUN_STATUSES = List.of(
            ScheduledTask.STATUS_MISSED, ScheduledTask.STATUS_EXPIRED);
    private static final List<String> POSTPONE_STATUSES = List.of(
            ScheduledTask.STATUS_MISSED, ScheduledTask.STATUS_EXPIRED, ScheduledTask.STATUS_SCHEDULED);
    private static final List<String> REMOVE_STATUSES = List.of(
            ScheduledTask.STATUS_MISSED, ScheduledTask.STATUS_EXPIRED);
    private static final String POLICY_TOOL_CREATE = "scheduled_task.create";
    private static final String POLICY_TOOL_DISPOSE = "scheduled_task.dispose";
    private static final String ACTOR_HUMAN = "human";
    private static final String ACTOR_AGENT = "agent";
    private static final String DEFAULT_TIMEZONE = "UTC";

    private final ScheduledTaskRepository scheduledTaskRepository;
    private final ScheduledTaskDispatcher dispatcher;
    private final WorkspaceService workspaceService;
    private final SessionService sessionService;
    private final GrantIntersectionEvaluator evaluator;
    private final AuthorizationGrantRepository grantRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;
    private final WorkspaceAgentRepository workspaceAgentRepository;
    private final UserRepository userRepository;
    private final AuditLogger auditLogger;
    private final WorkspaceEventManager workspaceEventManager;
    private final SessionParticipantRepository sessionParticipants;
    /** PLAN-0773 M2-8b: org-unit governance grants join the scheduled-task action gate. */
    private final com.cc01cc.p.xihe.cp.policy.OrgUnitGrants orgUnitGrants;
    /** D-1706 stage one: the trigger+action contract table (one row per accepted kind). */
    private final ScheduledTaskContracts contracts;

    public ScheduledTaskApiService(ScheduledTaskRepository scheduledTaskRepository,
                                   ScheduledTaskDispatcher dispatcher,
                                   WorkspaceService workspaceService,
                                   SessionService sessionService,
                                   GrantIntersectionEvaluator evaluator,
                                   AuthorizationGrantRepository grantRepository,
                                   AgentPrincipalRepository agentPrincipalRepository,
                                   WorkspaceAgentRepository workspaceAgentRepository,
                                   UserRepository userRepository,
                                   AuditLogger auditLogger,
                                   WorkspaceEventManager workspaceEventManager,
                                   SessionParticipantRepository sessionParticipants,
                                   com.cc01cc.p.xihe.cp.policy.OrgUnitGrants orgUnitGrants,
                                   ScheduledTaskContracts contracts) {
        this.scheduledTaskRepository = scheduledTaskRepository;
        this.dispatcher = dispatcher;
        this.workspaceService = workspaceService;
        this.sessionService = sessionService;
        this.evaluator = evaluator;
        this.grantRepository = grantRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
        this.workspaceAgentRepository = workspaceAgentRepository;
        this.userRepository = userRepository;
        this.auditLogger = auditLogger;
        this.workspaceEventManager = workspaceEventManager;
        this.sessionParticipants = sessionParticipants;
        this.orgUnitGrants = orgUnitGrants;
        this.contracts = contracts;
    }

    /** 读 DTO createdBy（0486 #9：principal 名 + 类型 human/agent）。 */
    public record CreatedBy(String name, String type) {}

    /**
     * 17 字段读 DTO（0486 §4）：camelCase、wire 不透传内部字段
     * （payload/cancel_reason 不在读面）；列表项 prompt 截断 120、detail 全文。
     */
    public record TaskView(String id, String triggerKind, String cronExpr, String timezone,
                           String targetKind, String targetSessionId, String prompt, String status,
                           String nextFireAt, String expiresAt, int missedCount, String lastMissedAt,
                           String missedReason, String lastRunId, CreatedBy createdBy,
                           String createdAt, String updatedAt) {}

    public record ListPage(String workspaceId, int page, int size, List<TaskView> tasks) {}

    public record DisposeResult(String taskId, String status, boolean changed, TaskView task) {}

    /**
     * 创建请求（human/agent 同一 API，0486 #9；agentPrincipalId 缺省 = human 创建）。
     * {@code intervalSeconds} 是 D-1706 ② 转正的 interval 触发器参数（与 {@link
     * ScheduledTaskContracts} 的 interval 行一一对应；其它 triggerKind 不得携带）。
     */
    public record CreateRequest(String triggerKind, String cronExpr, String timezone,
                                String targetKind, String targetSessionId, String prompt,
                                tools.jackson.databind.JsonNode payload, String at, String agentPrincipalId,
                                Integer intervalSeconds) {}

    /** 处置请求：agentPrincipalId 可选——agent 执行的处置显式标记进 audit（0486 #10）。 */
    public record DisposeRequest(String agentPrincipalId) {}

    public record PostponeRequest(String at, String agentPrincipalId) {}

    /** 创建主体：human=user grants；agent=agent_principal grants + workspace 绑定校验。 */
    private record Creator(UUID userId, UUID agentPrincipalId, String actorType) {}

    // ── 读 ────────────────────────────────────────────────────────────────

    public ListPage list(String workspaceId, String userId, int page, int size) {
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        int safePage = Math.max(page, 0);
        int safeSize = Math.min(Math.max(size, 1), LIST_MAX_SIZE);
        List<ScheduledTask> tasks = scheduledTaskRepository.findByWorkspaceIdOrderByCreatedAtDesc(
                UUID.fromString(workspaceId), PageRequest.of(safePage, safeSize));
        List<TaskView> items = tasks.stream()
                .map(task -> toView(task, true))
                .toList();
        return new ListPage(workspaceId, safePage, safeSize, items);
    }

    public TaskView detail(String workspaceId, String userId, String taskId) {
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        return toView(requireTask(workspaceId, taskId), false);
    }

    // ── 创建 ──────────────────────────────────────────────────────────────

    /**
     * D-1706 stage one: creation runs <b>one</b> generic path over the contract table
     * ({@link ScheduledTaskContracts}). Nothing below branches on the concrete kind — the trigger row
     * resolves the schedule, the action row resolves the target, and both are looked up by name from
     * the table. Adding a trigger or an action is one row there, not an edit here.
     *
     * <p>Cross-cutting steps stay stepwise: workspace reachability, creator/permission, timezone,
     * quota, event, audit. They apply identically to every kind, so putting them in the table would
     * reintroduce the per-kind branching this refactor exists to remove.</p>
     */
    public TaskView create(String workspaceId, String userId, CreateRequest request) {
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        if (request == null || request.triggerKind() == null || request.targetKind() == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "triggerKind and targetKind are required");
        }
        String triggerKind = ScheduledTaskContracts.normalize(request.triggerKind());
        String targetKind = ScheduledTaskContracts.normalize(request.targetKind());
        ScheduledTaskContracts.TriggerRow trigger = contracts.requireTrigger(triggerKind);
        ScheduledTaskContracts.TargetRow target = contracts.requireTarget(targetKind);
        UUID userUuid = parseUuid(userId, "INVALID_ACTOR");
        UUID workspaceUuid = parseUuid(workspaceId, "INVALID_WORKSPACE");
        Creator creator = resolveCreator(userUuid, workspaceUuid, request.agentPrincipalId());
        requireActionPermission(creator, POLICY_TOOL_CREATE,
                ToolFaceRegistry.ACTION_CREATE_SCHEDULED_TASK, workspaceUuid, userId);

        String timezone = request.timezone() == null || request.timezone().isBlank()
                ? DEFAULT_TIMEZONE : request.timezone().trim();
        ScheduledTaskContracts.requireTimezone(timezone);

        // The declaration check runs before any resolver: a row's resolver may unbox a declared
        // parameter (intervalSeconds), so presence must be enforced generically first.
        ScheduledTaskContracts.requireParams(trigger.requiredParams(), wirePresence(request));
        ScheduledTaskContracts.forbidParams(trigger.forbiddenParams(), wirePresence(request));
        ScheduledTaskContracts.requireParams(target.requiredParams(), wirePresence(request));
        ScheduledTaskContracts.forbidParams(target.forbiddenParams(), wirePresence(request));

        Instant now = Instant.now();
        ScheduledTaskContracts.TriggerResolution schedule = trigger.schedule().resolve(
                new ScheduledTaskContracts.TriggerInput(request.cronExpr(), timezone, request.at(),
                        request.intervalSeconds(), now));
        ScheduledTaskContracts.TargetResolution action = target.action().resolve(
                new ScheduledTaskContracts.TargetContext(domainPayload(request.payload()), request.targetSessionId(),
                        request.prompt(), targetSessionGate(creator, userId, workspaceId)));

        requireQuota(workspaceUuid, userUuid);

        ScheduledTask task = new ScheduledTask();
        task.setWorkspaceId(workspaceUuid);
        task.setUserId(userUuid);
        task.setAgentPrincipalId(creator.agentPrincipalId());
        task.setTriggerKind(triggerKind);
        task.setCronExpr(schedule.cronExpr());
        task.setIntervalSeconds(schedule.intervalSeconds());
        task.setTimezone(timezone);
        task.setTargetKind(targetKind);
        task.setTargetSessionId(action.targetSessionId());
        task.setPrompt(action.prompt());
        task.setPayload(action.payload());
        task.setStatus(ScheduledTask.STATUS_SCHEDULED);
        task.setNextFireAt(schedule.nextFireAt());
        task.setExpiresAt(schedule.expiresAt());
        ScheduledTask saved = scheduledTaskRepository.save(task);
        workspaceEventManager.publishScheduledTasksChanged(workspaceId);
        audit(userId, workspaceId, "scheduled_task_created", saved, creator,
                "triggerKind=" + triggerKind + " targetKind=" + targetKind);
        return toView(saved, false);
    }

    // ── 处置 ──────────────────────────────────────────────────────────────

    /**
     * DELETE：scheduled→cancelled 的等价移除路径；missed/expired 走
     * {@code /remove}（409 指引）；已 cancelled 幂等 {@code 200 {changed:false}}。
     */
    public DisposeResult delete(String workspaceId, String userId, String taskId,
                                String agentPrincipalId) {
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        ScheduledTask task = requireTask(workspaceId, taskId);
        requireDisposePermission(task, userId, workspaceId, agentPrincipalId);
        String status = task.getStatus();
        if (ScheduledTask.STATUS_CANCELLED.equals(status)) {
            return new DisposeResult(task.getId().toString(), status, false, toView(task, false));
        }
        if (!ScheduledTask.STATUS_SCHEDULED.equals(status)) {
            throw stateConflict(task, "DELETE only cancels scheduled tasks; use /remove for missed or expired");
        }
        int updated = scheduledTaskRepository.markCancelled(task.getId(),
                List.of(ScheduledTask.STATUS_SCHEDULED), "user_delete");
        if (updated == 0) {
            throw stateConflict(task, "task state changed concurrently; reload and retry");
        }
        workspaceEventManager.publishScheduledTasksChanged(workspaceId);
        ScheduledTask fresh = reload(task.getId());
        audit(userId, workspaceId, "scheduled_task_cancelled", fresh,
                disposeCreator(userId, agentPrincipalId), "via=delete");
        return new DisposeResult(fresh.getId().toString(), fresh.getStatus(), true, toView(fresh, false));
    }

    /** POST /remove：missed/expired→cancelled；已 cancelled 幂等 {changed:false}。 */
    public DisposeResult remove(String workspaceId, String userId, String taskId,
                                String agentPrincipalId) {
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        ScheduledTask task = requireTask(workspaceId, taskId);
        requireDisposePermission(task, userId, workspaceId, agentPrincipalId);
        String status = task.getStatus();
        if (ScheduledTask.STATUS_CANCELLED.equals(status)) {
            return new DisposeResult(task.getId().toString(), status, false, toView(task, false));
        }
        if (!REMOVE_STATUSES.contains(status)) {
            throw stateConflict(task, "remove accepts missed or expired tasks only");
        }
        int updated = scheduledTaskRepository.markCancelled(task.getId(), REMOVE_STATUSES, "user_remove");
        if (updated == 0) {
            throw stateConflict(task, "task state changed concurrently; reload and retry");
        }
        workspaceEventManager.publishScheduledTasksChanged(workspaceId);
        ScheduledTask fresh = reload(task.getId());
        audit(userId, workspaceId, "scheduled_task_removed", fresh,
                disposeCreator(userId, agentPrincipalId), "via=remove");
        return new DisposeResult(fresh.getId().toString(), fresh.getStatus(), true, toView(fresh, false));
    }

    /**
     * POST /rerun：missed/expired→一次性补跑；双击防护 = claimForRerun CAS
     * （第二次请求无行可认领 → 409）+ job 侧独立 retry 键。
     */
    public TaskView rerun(String workspaceId, String userId, String taskId, String agentPrincipalId) {
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        ScheduledTask task = requireTask(workspaceId, taskId);
        requireDisposePermission(task, userId, workspaceId, agentPrincipalId);
        if (!RERUN_STATUSES.contains(task.getStatus())) {
            throw stateConflict(task, "rerun accepts missed or expired tasks only");
        }
        int claimed = scheduledTaskRepository.claimForRerun(task.getId(), RERUN_STATUSES);
        if (claimed == 0) {
            throw stateConflict(reload(task.getId()),
                    "task is not rerunnable anymore (already claimed or terminal)");
        }
        ScheduledTask firing = reload(task.getId());
        dispatcher.dispatchRerun(firing,
                ScheduledTaskDispatcher.rerunIdempotencyKey(firing.getId(), firing.getNextFireAt()));
        ScheduledTask fresh = reload(task.getId());
        audit(userId, workspaceId, "scheduled_task_rerun", fresh,
                disposeCreator(userId, agentPrincipalId), "via=rerun");
        workspaceEventManager.publishScheduledTasksChanged(workspaceId);
        return toView(fresh, false);
    }

    /** POST /postpone：missed/expired/scheduled→scheduled，重设 next_fire_at。 */
    public TaskView postpone(String workspaceId, String userId, String taskId,
                             String at, String agentPrincipalId) {
        workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        Instant newFireAt = parseInstant(at, "at is required (ISO-8601 UTC)");
        if (!newFireAt.isAfter(Instant.now())) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "postpone at must be a future instant");
        }
        ScheduledTask task = requireTask(workspaceId, taskId);
        requireDisposePermission(task, userId, workspaceId, agentPrincipalId);
        if (!POSTPONE_STATUSES.contains(task.getStatus())) {
            throw stateConflict(task, "postpone accepts missed, expired or scheduled tasks only");
        }
        if (ScheduledTask.TRIGGER_DELAY_ONCE.equals(task.getTriggerKind())
                && task.getExpiresAt() != null && newFireAt.isAfter(task.getExpiresAt())) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "postpone beyond the delay_once expires_at is not allowed");
        }
        int updated = scheduledTaskRepository.postponeToScheduled(
                task.getId(), POSTPONE_STATUSES, newFireAt);
        if (updated == 0) {
            throw stateConflict(reload(task.getId()),
                    "task state changed concurrently; reload and retry");
        }
        workspaceEventManager.publishScheduledTasksChanged(workspaceId);
        ScheduledTask fresh = reload(task.getId());
        audit(userId, workspaceId, "scheduled_task_postponed", fresh,
                disposeCreator(userId, agentPrincipalId), "via=postpone");
        return toView(fresh, false);
    }

    // ── 权限与主体解析 ─────────────────────────────────────────────────────

    private Creator resolveCreator(UUID userUuid, UUID workspaceUuid, String agentPrincipalId) {
        if (agentPrincipalId == null || agentPrincipalId.isBlank()) {
            return new Creator(userUuid, null, ACTOR_HUMAN);
        }
        UUID principalId = parseUuid(agentPrincipalId, "INVALID_AGENT_PRINCIPAL");
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found"));
        if (principal.getDisabledAt() != null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Agent principal is disabled");
        }
        if (workspaceAgentRepository.findById(new WorkspaceAgentId(principalId, workspaceUuid)).isEmpty()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Agent principal is not bound to this Workspace");
        }
        return new Creator(userUuid, principalId, ACTOR_AGENT);
    }

    /**
     * PLAN-0610 W1c (round-3 P0-1): the subject's permission set is the <b>scoped</b> union for the
     * request workspace — not every grant row the subject owns.
     *
     * <p>The previous unscoped read let a user who is {@code WS_OWNER} in workspace A pass this gate
     * for workspace B, where they hold only {@code WS_VIEWER} (the scheduled-task atoms are
     * {@code scope_class=both}, so a workspace-A binding materializes them). {@code findScopedGrants}
     * mirrors the evaluation kernel's predicate: instance rows always participate, workspace rows
     * only for the request workspace, and the retired {@code default}/{@code direct} sources are
     * excluded through {@link GrantSources#EVALUATION_SOURCES}.</p>
     */
    private void requireActionPermission(Creator creator, String policyTool, String actionClass,
                                         UUID workspaceId, String userId) {
        String subjectType = creator.agentPrincipalId() == null
                ? GrantPrincipalPathResolver.USER : GrantPrincipalPathResolver.AGENT_PRINCIPAL;
        UUID subjectId = creator.agentPrincipalId() == null ? creator.userId() : creator.agentPrincipalId();
        boolean allowed;
        try {
            var permissions = evaluator.union(orgUnitGrants.merge(grantRepository.findScopedGrants(subjectType,
                    subjectId, GrantSources.EVALUATION_SOURCES, workspaceId),
                    orgUnitGrants.forPrincipal(subjectType, subjectId)));
            PolicyRequest request = new PolicyRequest(policyTool, List.of(actionClass),
                    List.of(workspaceId.toString()), ToolShape.OPAQUE, userId,
                    workspaceId.toString(), null);
            allowed = evaluator.allows(request, List.of(permissions));
        } catch (RuntimeException e) {
            logger.error("[POLICY] event=scheduled_task_grant_evaluation_failed actor={} "
                    + "subjectType={} actionClass={} failureType={}", userId, subjectType, actionClass,
                    e.getClass().getSimpleName(), e);
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Scheduled task grant could not be verified");
        }
        if (!allowed) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    actionClass + " grant is required");
        }
    }

    /** 处置权（0486 #10）：创建者全权；非创建者需 MANAGE_SCHEDULED_TASK。 */
    private void requireDisposePermission(ScheduledTask task, String userId, String workspaceId,
                                          String agentPrincipalId) {
        if (task.getUserId() != null && task.getUserId().toString().equals(userId)) {
            return;
        }
        Creator actor = resolveCreator(UUID.fromString(userId),
                UUID.fromString(workspaceId), agentPrincipalId);
        requireActionPermission(actor, POLICY_TOOL_DISPOSE,
                ToolFaceRegistry.ACTION_MANAGE_SCHEDULED_TASK,
                UUID.fromString(workspaceId), userId);
    }

    private Creator disposeCreator(String userId, String agentPrincipalId) {
        if (agentPrincipalId == null || agentPrincipalId.isBlank()) {
            return new Creator(UUID.fromString(userId), null, ACTOR_HUMAN);
        }
        return new Creator(UUID.fromString(userId), UUID.fromString(agentPrincipalId), ACTOR_AGENT);
    }

    // ── 校验与仓储助手 ─────────────────────────────────────────────────────

    private void requireQuota(UUID workspaceUuid, UUID userUuid) {
        long workspaceCount = scheduledTaskRepository.countByWorkspaceIdAndStatusIn(
                workspaceUuid, ACTIVE_STATUSES);
        if (workspaceCount >= WORKSPACE_LIMIT) {
            throw new CpApiException(HttpStatus.CONFLICT, "SCHEDULED_TASK_LIMIT",
                    "Workspace already has the maximum of " + WORKSPACE_LIMIT + " active scheduled tasks");
        }
        long principalCount = scheduledTaskRepository.countByWorkspaceIdAndUserIdAndStatusIn(
                workspaceUuid, userUuid, ACTIVE_STATUSES);
        if (principalCount >= PRINCIPAL_LIMIT) {
            throw new CpApiException(HttpStatus.CONFLICT, "SCHEDULED_TASK_PRINCIPAL_LIMIT",
                    "Principal already has the maximum of " + PRINCIPAL_LIMIT
                            + " active scheduled tasks in this Workspace");
        }
    }

    /**
     * Wire presence for the contract table's declaration checks. Text fields count as absent when
     * blank (unchanged pre-D-1706 behaviour); {@code payload} and {@code intervalSeconds} are checked
     * by shape, so a non-object payload still answers the declared parameter code rather than a DB
     * CHECK failure.
     */
    private static ScheduledTaskContracts.ParamPresence wirePresence(CreateRequest request) {
        return field -> switch (field) {
            case "cronExpr" -> isPresent(request.cronExpr());
            case "at" -> isPresent(request.at());
            case "timezone" -> isPresent(request.timezone());
            case "targetSessionId" -> isPresent(request.targetSessionId());
            case "prompt" -> isPresent(request.prompt());
            case "intervalSeconds" -> request.intervalSeconds() != null;
            case "payload" -> request.payload() != null && request.payload().isObject();
            default -> throw new IllegalStateException("undeclared wire field: " + field);
        };
    }

    private static boolean isPresent(String value) {
        return value != null && !value.isBlank();
    }

    /**
     * Boundary bridge for the one request field whose wire type and domain type are different
     * versions of the same abstraction (task-67 / D-1720, the inbound twin of PLAN-0633 C1).
     *
     * <p>Boot 4 binds request bodies with <b>Jackson 3</b>, so {@link CreateRequest#payload()} is a
     * {@code tools.jackson} node; the domain (entity, contract table, dispatcher) reads
     * {@code com.fasterxml} nodes. A Jackson-3 node handed straight to the contract table would
     * not compile, and typing the record component as a Jackson-2 node made Spring fail with
     * "Cannot construct instance of ... JsonNode (no Creators)" — a 500 on every request that
     * carried a payload. Converting at the boundary (rather than teaching Jackson to build a
     * node it cannot build) keeps the type difference explicit and in one place.
     *
     * <p>The conversion goes through <em>plain JSON values</em> ({@code Map}/{@code List}/scalars)
     * so it cannot depend on either mapper's feature configuration: the tree is written out as
     * bytes by the Jackson-3 mapper and re-read by the Jackson-2 mapper. {@code null} stays
     * {@code null}, and a non-object payload keeps whatever shape the caller sent so the contract
     * table can answer its declared parameter code instead of a DB CHECK failure.
     */
    private static JsonNode domainPayload(tools.jackson.databind.JsonNode wire) {
        if (wire == null) {
            return null;
        }
        try {
            return new ObjectMapper().readTree(new tools.jackson.databind.ObjectMapper()
                    .writeValueAsBytes(wire));
        } catch (java.io.IOException e) {
            // Unreachable in practice: the bytes come from a live in-memory tree, not a stream.
            // Surfaced as the same 400 shape a malformed wire body gets, never a 500.
            throw new CpApiException(HttpStatus.BAD_REQUEST,
                    ScheduledTaskContracts.CODE_PAYLOAD_REQUIRED,
                    "payload could not be re-read as a JSON document");
        }
    }


    /**
     * The behaviour a {@code session_wakeup} row needs from the service: resolve the target session
     * in this Workspace, and (PLAN-0689 A2c) require an agent-created wakeup target to be a Session
     * of the creating principal, read off the target's PRIMARY participant row. A missing PRIMARY
     * matches no creator and therefore rejects (fail-closed, never a column fallback). Human
     * creators carry no principal, so the check — and the read — stays skipped for them.
     */
    private ScheduledTaskContracts.SessionGate targetSessionGate(Creator creator, String userId,
                                                                String workspaceId) {
        return targetSessionId -> {
            UUID sessionId = parseUuid(targetSessionId, "INVALID_REQUEST");
            Session session = sessionService.requireCurrent(sessionId.toString(), userId, workspaceId);
            if (creator.agentPrincipalId() != null) {
                UUID targetPrincipalId = sessionParticipants.primaryPrincipalId(session.getId())
                        .orElse(null);
                if (!creator.agentPrincipalId().equals(targetPrincipalId)) {
                    throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                            "session_wakeup target must be a Session of the creating agent principal");
                }
            }
            return sessionId;
        };
    }

    private static Instant parseInstant(String value, String detail) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
        }
        try {
            return Instant.parse(value.trim());
        } catch (DateTimeParseException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "at must be an ISO-8601 UTC instant, got: " + value);
        }
    }

    private ScheduledTask requireTask(String workspaceId, String taskId) {
        UUID id = parseUuid(taskId, "INVALID_REQUEST");
        ScheduledTask task = scheduledTaskRepository.findById(id)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "SCHEDULED_TASK_NOT_FOUND", "Scheduled task not found"));
        if (!workspaceId.equals(task.getWorkspaceId().toString())) {
            // CP 归并惯例：外属与不存在同为 404，不泄露存在性。
            throw new CpApiException(HttpStatus.NOT_FOUND,
                    "SCHEDULED_TASK_NOT_FOUND", "Scheduled task not found");
        }
        return task;
    }

    private ScheduledTask reload(UUID taskId) {
        return scheduledTaskRepository.findById(taskId)
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND,
                        "SCHEDULED_TASK_NOT_FOUND", "Scheduled task disappeared during disposition"));
    }

    private static CpApiException stateConflict(ScheduledTask task, String detail) {
        return new CpApiException(HttpStatus.CONFLICT, "SCHEDULED_TASK_STATE",
                "Task is " + task.getStatus() + "; " + detail);
    }

    private static UUID parseUuid(String value, String code) {
        if (value == null || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, code, "a UUID value is required");
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, code, "invalid UUID: " + value);
        }
    }

    private void audit(String actorUserId, String workspaceId, String action, ScheduledTask task,
                       Creator actor, String extra) {
        String detail = "action=" + action
                + " taskId=" + task.getId()
                + " status=" + task.getStatus()
                + " actorType=" + actor.actorType()
                + (actor.agentPrincipalId() == null ? "" : " agentPrincipalId=" + actor.agentPrincipalId())
                + " " + extra;
        auditLogger.recordDurableChange(actorUserId, workspaceId, action,
                "scheduled_task", task.getId().toString(), detail);
    }

    // ── 读 DTO 投影 ───────────────────────────────────────────────────────

    private TaskView toView(ScheduledTask task, boolean truncatePrompt) {
        String prompt = task.getPrompt();
        if (truncatePrompt && prompt != null && prompt.length() > LIST_PROMPT_MAX) {
            prompt = prompt.substring(0, LIST_PROMPT_MAX);
        }
        return new TaskView(
                task.getId().toString(),
                task.getTriggerKind(),
                task.getCronExpr(),
                task.getTimezone(),
                task.getTargetKind(),
                task.getTargetSessionId() == null ? null : task.getTargetSessionId().toString(),
                prompt,
                task.getStatus(),
                task.getNextFireAt() == null ? null : task.getNextFireAt().toString(),
                task.getExpiresAt() == null ? null : task.getExpiresAt().toString(),
                task.getMissedCount(),
                task.getLastMissedAt() == null ? null : task.getLastMissedAt().toString(),
                task.getMissedReason(),
                task.getLastRunId() == null ? null : task.getLastRunId().toString(),
                resolveCreatedBy(task),
                task.getCreatedAt() == null ? null : task.getCreatedAt().toString(),
                task.getUpdatedAt() == null ? null : task.getUpdatedAt().toString());
    }

    /**
     * createdBy 投影（0486 #9，V60 列）：{@code agent_principal_id} 非空 → agent，
     * name 取 {@code agent_principals.name}；否则回退 human——name 沿用既有
     * users name → email 优先级。principal 删除由 FK SET NULL 清列（降级 human）；
     * 行缺失（防御分支）同样降级到 human 回退，不抛错。
     */
    private CreatedBy resolveCreatedBy(ScheduledTask task) {
        UUID agentPrincipalId = task.getAgentPrincipalId();
        if (agentPrincipalId != null) {
            AgentPrincipal principal = agentPrincipalRepository.findById(agentPrincipalId)
                    .orElse(null);
            if (principal != null) {
                return new CreatedBy(principal.getName(), ACTOR_AGENT);
            }
        }
        UUID userId = task.getUserId();
        if (userId == null) {
            return new CreatedBy(null, ACTOR_HUMAN);
        }
        return userRepository.findById(userId)
                .map(user -> new CreatedBy(displayName(user), ACTOR_HUMAN))
                .orElseGet(() -> new CreatedBy(null, ACTOR_HUMAN));
    }

    private static String displayName(User user) {
        if (user.getName() != null && !user.getName().isBlank()) {
            return user.getName();
        }
        return user.getEmail();
    }
}
