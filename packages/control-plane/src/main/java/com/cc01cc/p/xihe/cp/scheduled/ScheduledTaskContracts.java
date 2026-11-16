package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * D-1706 stage one: the explicit <b>trigger + action contract table</b>.
 *
 * <p>Before this class the per-kind requirements lived in if-chains inside
 * {@link ScheduledTaskApiService#create}: one chain decided the trigger schedule, another decided
 * the action target, and several distinct missing parameters collapsed into one shared message.
 * Adding a kind therefore meant editing validation control flow — the shape that would have forced
 * stage two (event triggers) back into ifs.</p>
 *
 * <p>Each row now <b>declares</b> its contract: which wire parameters it requires (each with its own
 * problem {@code code}, so a caller can tell a missing {@code cronExpr} from a missing {@code at}),
 * which it forbids, and how to resolve that row's schedule/target.
 * {@link ScheduledTaskApiService#create} runs one generic declaration loop and then calls the row's
 * resolver, so <b>adding a kind is one row</b>: {@link #triggerKinds()}/{@link #targetKinds()} — used
 * for the "unknown kind" message — are derived from the table, so the advertised vocabulary cannot
 * drift from the enforced one.</p>
 *
 * <p>The declaration is load-bearing, not documentation: resolvers <i>assume</i> their declared
 * parameters are present (they unbox/parse without re-checking), so deleting a {@code RequiredParam}
 * from a row turns the corresponding test red instead of silently passing.</p>
 *
 * <p>Why two tables instead of one row per (trigger, action) combination: the card's rules are
 * naturally two axes (a trigger needs its schedule parameters, an action needs its target
 * parameters), and the axes compose. One table keyed by the pair would need 3×2 = 6 rows today and
 * would multiply with every new trigger, while saying nothing about a trigger on its own. The
 * composed bottom half (what a <i>pair</i> additionally requires) is what
 * {@link TriggerRow#branches()} is reserved for.</p>
 *
 * <p>The registry is a bean rather than a static utility on purpose: the criterion "a new kind takes
 * effect by adding one row only" is then <i>provable</i> — a test constructs a registry holding an
 * extra {@code _probe} row and drives a real {@code create} through it.</p>
 *
 * <p><b>Row shape reserved for stage two</b> (event triggers, see
 * {@code internal/A03-xihe/docs/xh-automation-event-trigger-design.md} §1.3.3): every trigger row
 * carries {@link TriggerRow#branchBy() branchBy} + {@link TriggerRow#branches() branches}. An event
 * trigger's required keys depend on {@code trigger_spec.source}, so a flat list cannot express it;
 * the fields exist now so stage two adds branch <i>rows</i> instead of reshaping every row. Branch
 * <b>evaluation</b> is deliberately not implemented in stage one: there is no {@code trigger_spec}
 * column to branch on, and a second validation path with no input would be untested machinery.
 * Default rows leave the branch fields empty, and a test asserts that.</p>
 *
 * <p>Cross-cutting steps stay shared rather than per-row — ownership/authorization, the Workspace
 * quota, the timezone check and the audit — because a per-kind if there would reintroduce the chain
 * this class removes. Blank {@code timezone} still defaults to {@code UTC} (pre-D-1706 behaviour).</p>
 */
@Component
public class ScheduledTaskContracts {

    /** Trigger kinds the API accepts today; {@link ScheduledTask}'s constants stay the vocabulary. */
    public static final List<TriggerRow> DEFAULT_TRIGGERS = List.of(
            cronRow(), delayOnceRow(), intervalRow());

    /** Action kinds the API accepts today; {@code participant_wake} stays system-only (see below). */
    public static final List<TargetRow> DEFAULT_TARGETS = List.of(
            sessionWakeupRow(), jobDispatchRow());

    /** Sub-minute periods are rejected (D24-09; {@code ck_scheduled_tasks_interval} holds the same bound). */
    public static final int MIN_INTERVAL_SECONDS = 60;

    /** Per-parameter problem codes: "which parameter is missing" is machine-readable, not prose. */
    public static final String CODE_AT_REQUIRED = "SCHEDULED_TASK_AT_REQUIRED";
    public static final String CODE_INTERVAL = "INVALID_INTERVAL";
    public static final String CODE_TARGET_SESSION_REQUIRED = "SCHEDULED_TASK_TARGET_SESSION_REQUIRED";
    public static final String CODE_PROMPT_REQUIRED = "SCHEDULED_TASK_PROMPT_REQUIRED";
    public static final String CODE_PAYLOAD_REQUIRED = "SCHEDULED_TASK_PAYLOAD_REQUIRED";

    private final List<TriggerRow> triggers;
    private final List<TargetRow> targets;

    public ScheduledTaskContracts() {
        this(DEFAULT_TRIGGERS, DEFAULT_TARGETS);
    }

    /** Test seam: the only way to prove "one extra row, no other change" takes effect. */
    ScheduledTaskContracts(List<TriggerRow> triggers, List<TargetRow> targets) {
        this.triggers = List.copyOf(triggers);
        this.targets = List.copyOf(targets);
    }

    // ── lookup ────────────────────────────────────────────────────────────

    /** The row for {@code kind}, or a 400 that lists the table's own vocabulary. */
    public TriggerRow requireTrigger(String kind) {
        String normalized = normalize(kind);
        for (TriggerRow row : triggers) {
            if (row.kind().equals(normalized)) {
                return row;
            }
        }
        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                "triggerKind must be one of " + triggerKinds());
    }

    public TargetRow requireTarget(String kind) {
        String normalized = normalize(kind);
        for (TargetRow row : targets) {
            if (row.kind().equals(normalized)) {
                return row;
            }
        }
        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                "targetKind must be one of " + targetKinds());
    }

    /** The advertised trigger vocabulary — derived from the table, never a second hand-written list. */
    public Set<String> triggerKinds() {
        Set<String> kinds = new LinkedHashSet<>();
        for (TriggerRow row : triggers) {
            kinds.add(row.kind());
        }
        return kinds;
    }

    public Set<String> targetKinds() {
        Set<String> kinds = new LinkedHashSet<>();
        for (TargetRow row : targets) {
            kinds.add(row.kind());
        }
        return kinds;
    }

    public static String normalize(String kind) {
        return kind == null ? null : kind.trim().toLowerCase(Locale.ROOT);
    }

    // ── the rows ──────────────────────────────────────────────────────────

    private static TriggerRow cronRow() {
        return TriggerRow.of(ScheduledTask.TRIGGER_CRON,
                List.of(new RequiredParam("cronExpr", "INVALID_CRON_EXPR",
                        "cronExpr is required for cron tasks")),
                List.of(),
                input -> {
                    String cronExpr = requireCronExpression(input.cronExpr());
                    Instant nextFireAt;
                    try {
                        nextFireAt = CronExpressions.nextUtcInstant(cronExpr, input.timezone(),
                                input.now());
                    } catch (IllegalArgumentException e) {
                        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_CRON_EXPR",
                                "cron expression is not evaluable: " + e.getMessage());
                    }
                    if (nextFireAt == null) {
                        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_CRON_EXPR",
                                "cron expression has no future occurrence");
                    }
                    return new TriggerResolution(cronExpr, null, nextFireAt, null);
                });
    }

    private static TriggerRow delayOnceRow() {
        return TriggerRow.of(ScheduledTask.TRIGGER_DELAY_ONCE,
                List.of(new RequiredParam("at", CODE_AT_REQUIRED,
                        "at is required for delay_once (ISO-8601 UTC)")),
                List.of(),
                input -> {
                    Instant nextFireAt = parseAt(input.at());
                    if (!nextFireAt.isAfter(input.now())) {
                        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                                "delay_once at must be a future instant");
                    }
                    Instant expiresAt = input.now().plus(ScheduledTaskApiService.DELAY_TTL);
                    if (nextFireAt.isAfter(expiresAt)) {
                        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                                "delay_once schedule exceeds the "
                                        + ScheduledTaskApiService.DELAY_TTL.toDays() + "d TTL");
                    }
                    return new TriggerResolution(null, null, nextFireAt, expiresAt);
                });
    }

    /**
     * D-1706 ②: {@code interval} promoted from a system-only constant to a first-class trigger.
     * The schedule is exact ({@code now + intervalSeconds}); the D24-08 jitter spread belongs to the
     * wake projection (it exists to spread system load) and stays off user-created rows, whose UI
     * promise is literally "every N minutes".
     */
    private static TriggerRow intervalRow() {
        return TriggerRow.of(ScheduledTask.TRIGGER_INTERVAL,
                List.of(new RequiredParam("intervalSeconds", CODE_INTERVAL,
                        "intervalSeconds is required for interval tasks")),
                List.of(),
                input -> {
                    int intervalSeconds = input.intervalSeconds();
                    if (intervalSeconds < MIN_INTERVAL_SECONDS) {
                        throw new CpApiException(HttpStatus.BAD_REQUEST, CODE_INTERVAL,
                                "intervalSeconds must be at least " + MIN_INTERVAL_SECONDS);
                    }
                    return new TriggerResolution(null, intervalSeconds,
                            input.now().plusSeconds(intervalSeconds), null);
                });
    }

    private static TargetRow sessionWakeupRow() {
        return TargetRow.of(ScheduledTask.TARGET_SESSION_WAKEUP,
                List.of(new RequiredParam("targetSessionId", CODE_TARGET_SESSION_REQUIRED,
                                "session_wakeup requires targetSessionId"),
                        new RequiredParam("prompt", CODE_PROMPT_REQUIRED,
                                "session_wakeup requires prompt")),
                List.of(),
                ctx -> {
                    UUID sessionId = ctx.sessionGate().resolve(ctx.targetSessionId());
                    return new TargetResolution(sessionId, ctx.prompt(), null);
                });
    }

    private static TargetRow jobDispatchRow() {
        // The one forbidden parameter the API already rejects (V58/V94 CK would refuse the row too;
        // the API answers 400 instead of a DB error). Trigger rows forbid nothing: extra wire fields
        // have always been ignored, and rejecting them now would be a behaviour change.
        return TargetRow.of(ScheduledTask.TARGET_JOB_DISPATCH,
                List.of(new RequiredParam("payload", CODE_PAYLOAD_REQUIRED,
                        "job_dispatch requires a payload object")),
                List.of(new ForbiddenParam("targetSessionId",
                        "job_dispatch must not reference a target session")),
                ctx -> {
                    // Presence already guarantees payload is a JSON object, so a non-object payload
                    // answers CODE_PAYLOAD_REQUIRED (the pre-D-1706 message) instead of a DB CHECK error.
                    JsonNode payload = ctx.payload();
                    JsonNode command = payload.get("command");
                    if (command == null || !command.isTextual() || command.asText().isBlank()) {
                        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                                "job_dispatch payload requires a textual command");
                    }
                    return new TargetResolution(null, null, payload);
                });
    }

    // ── row shape ─────────────────────────────────────────────────────────

    /** One declared parameter: the wire field, the problem code when it is absent, and the detail. */
    public record RequiredParam(String field, String code, String detail) {}

    /** One declared prohibition: the wire field and the detail when it is present. */
    public record ForbiddenParam(String field, String detail) {}

    /** Stage-two placeholder: a nested branch of required parameters (not evaluated in stage one). */
    public record Branch(String value, List<RequiredParam> requiredParams) {
        public Branch {
            requiredParams = List.copyOf(requiredParams);
        }
    }

    /** What a trigger row resolved: at most one of cronExpr/intervalSeconds plus the fire instants. */
    public record TriggerResolution(String cronExpr, Integer intervalSeconds,
                                    Instant nextFireAt, Instant expiresAt) {}

    /** What an action row resolved: at most one of targetSessionId/payload, plus the prompt. */
    public record TargetResolution(UUID targetSessionId, String prompt, JsonNode payload) {}

    /** Raw wire values a trigger row resolves against ({@code timezone} already validated/defaulted). */
    public record TriggerInput(String cronExpr, String timezone, String at,
                               Integer intervalSeconds, Instant now) {}

    /**
     * Raw wire values plus the one behaviour a target row may need from the service: resolving a
     * target session (workspace reachability and, for agent callers, the creator-principal check).
     * Keeping that behind a callback is what lets the row stay a plain function.
     */
    public record TargetContext(JsonNode payload, String targetSessionId, String prompt,
                                SessionGate sessionGate) {}

    /** Resolves a session id against the caller (throws {@code CpApiException} when it must not). */
    @FunctionalInterface
    public interface SessionGate {
        UUID resolve(String targetSessionId);
    }

    @FunctionalInterface
    public interface TriggerSchedule {
        TriggerResolution resolve(TriggerInput input);
    }

    @FunctionalInterface
    public interface TargetAction {
        TargetResolution resolve(TargetContext ctx);
    }

    /**
     * A trigger contract row. {@code branchBy}/{@code branches} are reserved for stage two: once
     * {@code trigger_spec.source} exists, a required-key set depends on the source, and reshaping the
     * row then would touch every row.
     */
    public record TriggerRow(String kind, List<RequiredParam> requiredParams,
                             List<ForbiddenParam> forbiddenParams, String branchBy,
                             Map<String, Branch> branches, TriggerSchedule schedule) {

        public TriggerRow {
            requiredParams = List.copyOf(requiredParams);
            forbiddenParams = List.copyOf(forbiddenParams);
            branches = Map.copyOf(branches);
        }

        /** Stage one rows: no branch, so the table has exactly one evaluation path. */
        static TriggerRow of(String kind, List<RequiredParam> requiredParams,
                             List<ForbiddenParam> forbiddenParams, TriggerSchedule schedule) {
            return new TriggerRow(kind, requiredParams, forbiddenParams, null, Map.of(), schedule);
        }
    }

    public record TargetRow(String kind, List<RequiredParam> requiredParams,
                            List<ForbiddenParam> forbiddenParams, TargetAction action) {
        public TargetRow {
            requiredParams = List.copyOf(requiredParams);
            forbiddenParams = List.copyOf(forbiddenParams);
        }

        static TargetRow of(String kind, List<RequiredParam> requiredParams,
                            List<ForbiddenParam> forbiddenParams, TargetAction action) {
            return new TargetRow(kind, requiredParams, forbiddenParams, action);
        }
    }

    // ── shared enforcement (one loop for every row; no per-kind branch) ────

    /**
     * Fails with the declared parameter's own code when it is absent, naming the field in the
     * problem's {@code param} extension. Codes are distinct per parameter — the full matrix lives in
     * {@code ScheduledTaskContractsTest}.
     */
    public static void requireParams(List<RequiredParam> declared, ParamPresence presence) {
        for (RequiredParam param : declared) {
            if (!presence.isPresent(param.field())) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, param.code(), param.detail())
                        .withExtra(Map.of("param", param.field()));
            }
        }
    }

    /** Fails when a declared-forbidden parameter is on the wire at all. */
    public static void forbidParams(List<ForbiddenParam> declared, ParamPresence presence) {
        for (ForbiddenParam param : declared) {
            if (presence.isPresent(param.field())) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        param.detail()).withExtra(Map.of("param", param.field()));
            }
        }
    }

    /** Reads a wire parameter as present when non-null (text fields: non-blank). */
    @FunctionalInterface
    public interface ParamPresence {
        boolean isPresent(String field);
    }

    /** The shared timezone step (blank already defaulted upstream); every row gets the same check. */
    public static void requireTimezone(String timezone) {
        try {
            ZoneId.of(timezone);
        } catch (java.time.DateTimeException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_TIMEZONE",
                    "unknown timezone: " + timezone);
        }
    }

    /**
     * Minute-grain cron shape (5 fields, seconds prefixed for Spring). Lives here rather than in
     * {@link CronExpressions} so that util stays a pure function library and every API-facing 400 code
     * stays in the contract layer.
     */
    private static String requireCronExpression(String cronExpr) {
        String trimmed = cronExpr.trim();
        String[] fields = trimmed.split("\\s+");
        if (fields.length != 5) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_CRON_EXPR",
                    "cron expression must have 5 fields (minute grain); got " + fields.length);
        }
        try {
            org.springframework.scheduling.support.CronExpression.parse("0 " + trimmed);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_CRON_EXPR",
                    "cron expression is invalid: " + e.getMessage());
        }
        return trimmed;
    }

    private static Instant parseAt(String value) {
        // Presence is already guaranteed by the declared RequiredParam("at", ...).
        try {
            return Instant.parse(value.trim());
        } catch (DateTimeParseException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "at must be an ISO-8601 UTC instant, got: " + value);
        }
    }
}
