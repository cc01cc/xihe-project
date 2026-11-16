package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.event.WorkspaceEventManager;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGrantsTestFixture;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.when;
/**
 * D-1706 stage one: the contract table is THE definition of what each trigger/action requires.
 *
 * <p>This class holds the two readings the card asks for, both written so they cannot pass by
 * accident:</p>
 *
 * <ol>
 *   <li>One row is enough -- addingOneRow_makesAnUnknownKindWork registers a fake _probe row in a
 *       NEW registry, hands it to an otherwise identical service, and drives a real create through
 *       it. Nothing in ScheduledTaskApiService knows _probe. This is the difference between a table
 *       and a switch spelled differently: with a switch, this test cannot be written.</li>
 *   <li>Deleting a declared parameter turns a test red -- the removing... cases take a request
 *       shape that succeeds when the parameter is supplied and drop it; the expectation is a
 *       specific, distinguishable problem code, not a generic 400. This is the mutation leg: the
 *       declaration is load-bearing, because the resolvers unbox their parameters without
 *       re-checking them.</li>
 * </ol>
 *
 * <p>It also pins the error matrix: every declared parameter has its own code, so a missing
 * required parameter no longer collapses into one shared sentence (the pre-D-1706 shape, where
 * session_wakeup answered one message for either targetSessionId or prompt).</p>
 */
class ScheduledTaskContractsTest {

    private static final String WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
    private static final String USER_ID = "22222222-2222-4222-8222-222222222222";
    private static final String SESSION_ID = "33333333-3333-4333-8333-333333333333";

    private final ObjectMapper objectMapper = new ObjectMapper();

    private ScheduledTaskRepository repository;
    private ScheduledTaskDispatcher dispatcher;
    private WorkspaceService workspaceService;
    private SessionService sessionService;
    private GrantIntersectionEvaluator evaluator;
    private AuthorizationGrantRepository grantRepository;
    private AgentPrincipalRepository agentPrincipalRepository;
    private WorkspaceAgentRepository workspaceAgentRepository;
    private UserRepository userRepository;
    private AuditLogger auditLogger;
    private WorkspaceEventManager eventManager;
    private SessionParticipantRepository sessionParticipantRepository;

    @BeforeEach
    void setUp() {
        repository = Mockito.mock(ScheduledTaskRepository.class);
        dispatcher = Mockito.mock(ScheduledTaskDispatcher.class);
        workspaceService = Mockito.mock(WorkspaceService.class);
        sessionService = Mockito.mock(SessionService.class);
        evaluator = Mockito.mock(GrantIntersectionEvaluator.class);
        grantRepository = Mockito.mock(AuthorizationGrantRepository.class);
        agentPrincipalRepository = Mockito.mock(AgentPrincipalRepository.class);
        workspaceAgentRepository = Mockito.mock(WorkspaceAgentRepository.class);
        userRepository = Mockito.mock(UserRepository.class);
        auditLogger = Mockito.mock(AuditLogger.class);
        eventManager = Mockito.mock(WorkspaceEventManager.class);
        sessionParticipantRepository = Mockito.mock(SessionParticipantRepository.class);

        when(repository.countByWorkspaceIdAndStatusIn(any(), anyCollection())).thenReturn(0L);
        when(repository.countByWorkspaceIdAndUserIdAndStatusIn(any(), any(), anyCollection()))
                .thenReturn(0L);
        when(evaluator.union(anyCollection())).thenReturn(Set.of());
        when(evaluator.allows(any(PolicyRequest.class), any())).thenReturn(true);
        when(repository.save(any())).thenAnswer(invocation -> {
            ScheduledTask task = invocation.getArgument(0);
            task.setId(UUID.randomUUID());
            return task;
        });
    }

    private ScheduledTaskApiService serviceWith(ScheduledTaskContracts contracts) {
        return new ScheduledTaskApiService(repository, dispatcher, workspaceService, sessionService,
                evaluator, grantRepository, agentPrincipalRepository, workspaceAgentRepository,
                userRepository, auditLogger, eventManager, sessionParticipantRepository,
                OrgUnitGrantsTestFixture.withoutRows(), contracts);
    }

    /** job_dispatch is the action that needs no pre-existing Session, so it isolates the trigger. */
    private static ScheduledTaskApiService.CreateRequest jobRequest(String triggerKind,
                                                                   String at,
                                                                   Integer intervalSeconds) {
        ObjectNode payload = new ObjectMapper().createObjectNode().put("command", "echo probe");
        return new ScheduledTaskApiService.CreateRequest(triggerKind, null, "UTC",
                ScheduledTask.TARGET_JOB_DISPATCH, null, null, payload, at, null, intervalSeconds);
    }

    private static ScheduledTaskApiService.CreateRequest jobRequestWithTargetSession() {
        ObjectNode payload = new ObjectMapper().createObjectNode().put("command", "echo probe");
        return new ScheduledTaskApiService.CreateRequest("cron", "* * * * *", "UTC",
                ScheduledTask.TARGET_JOB_DISPATCH, SESSION_ID, null, payload, null, null, null);
    }

    // -- (1) one row is enough ----------------------------------------------

    @Test
    void addingOneRow_makesAnUnknownKindWork() {
        // A registry identical to production except for exactly one extra declared row. The row's
        // name appears nowhere in production code -- that is the whole point.
        ScheduledTaskContracts.TriggerRow probe = new ScheduledTaskContracts.TriggerRow(
                "_probe",
                List.of(new ScheduledTaskContracts.RequiredParam("at", "PROBE_AT_REQUIRED",
                        "_probe requires at")),
                List.of(),
                null,
                Map.of(),
                input -> new ScheduledTaskContracts.TriggerResolution(
                        null, null, input.now().plusSeconds(30), null));
        List<ScheduledTaskContracts.TriggerRow> withProbe = new ArrayList<>(
                ScheduledTaskContracts.DEFAULT_TRIGGERS);
        withProbe.add(probe);
        ScheduledTaskContracts probeRegistry = new ScheduledTaskContracts(withProbe,
                ScheduledTaskContracts.DEFAULT_TARGETS);

        String at = Instant.now().plus(1, ChronoUnit.HOURS).toString();

        // Before: the production table refuses it.
        CpApiException refused = assertThrows(CpApiException.class, () -> serviceWith(
                new ScheduledTaskContracts()).create(WORKSPACE_ID, USER_ID,
                jobRequest("_probe", at, null)));
        assertEquals("INVALID_REQUEST", refused.getCode());
        assertTrue(refused.getMessage().contains(ScheduledTask.TRIGGER_CRON),
                "the unknown-kind message lists the table's vocabulary: " + refused.getMessage());

        // After: the same service accepts it, purely because the table has one more row.
        ScheduledTaskApiService.TaskView created = serviceWith(probeRegistry).create(WORKSPACE_ID,
                USER_ID, jobRequest("_probe", at, null));
        assertEquals("_probe", created.triggerKind(),
                "a kind that exists only as a table row is created by the unchanged create() path");
        assertEquals(ScheduledTask.STATUS_SCHEDULED, created.status());
        assertNotNull(created.nextFireAt(), "the row's own resolver decided the schedule");
        assertNull(created.cronExpr(), "_probe declares no cron expression");
        assertNull(created.expiresAt(), "_probe declares no expiry");
    }

    /** The advertised vocabulary is derived from the table, so it cannot drift from enforcement. */
    @Test
    void advertisedVocabularyIsDerivedFromTheTable() {
        ScheduledTaskContracts contracts = new ScheduledTaskContracts();
        assertEquals(
                Set.of(ScheduledTask.TRIGGER_CRON, ScheduledTask.TRIGGER_DELAY_ONCE,
                        ScheduledTask.TRIGGER_INTERVAL),
                contracts.triggerKinds(),
                "interval is admitted by the API as of D-1706 2 (it used to be system-only)");
        assertEquals(
                Set.of(ScheduledTask.TARGET_SESSION_WAKEUP, ScheduledTask.TARGET_JOB_DISPATCH),
                contracts.targetKinds(),
                "participant_wake stays system-only: the wake projection writes it, not the API");
    }

    /**
     * Stage one leaves the stage-two branch fields empty; this assert is what stops a later edit from
     * half-filling them (a branchBy with no branches cannot be evaluated by anyone).
     */
    @Test
    void defaultRowsReserveTheStageTwoBranchShapeWithoutUsingIt() {
        for (ScheduledTaskContracts.TriggerRow row : ScheduledTaskContracts.DEFAULT_TRIGGERS) {
            assertNull(row.branchBy(), "stage one has no trigger_spec to branch on: " + row.kind());
            assertTrue(row.branches().isEmpty(),
                    "branch evaluation is stage two; an empty map reserves the shape: " + row.kind());
        }
    }

    // -- (2) the mutation leg: every declared parameter is load-bearing ----

    @Test
    void cronTaskWithoutExpressionIsRefusedByItsDeclaredParam() {
        CpApiException error = assertThrows(CpApiException.class, () -> serviceWith(
                new ScheduledTaskContracts()).create(WORKSPACE_ID, USER_ID,
                new ScheduledTaskApiService.CreateRequest("cron", null, "UTC",
                        ScheduledTask.TARGET_JOB_DISPATCH, null, null,
                        objectMapper.createObjectNode().put("command", "echo"),
                        null, null, null)));
        assertEquals("INVALID_CRON_EXPR", error.getCode(),
                "declared RequiredParam(cronExpr) is what rejects a cron task without one");
    }

    @Test
    void delayTaskWithoutAtAnswersItsOwnCode() {
        CpApiException error = assertThrows(CpApiException.class, () -> serviceWith(
                new ScheduledTaskContracts()).create(WORKSPACE_ID, USER_ID,
                new ScheduledTaskApiService.CreateRequest("delay_once", null, "UTC",
                        ScheduledTask.TARGET_JOB_DISPATCH, null, null,
                        objectMapper.createObjectNode().put("command", "echo"),
                        null, null, null)));
        assertEquals(ScheduledTaskContracts.CODE_AT_REQUIRED, error.getCode(),
                "a missing at has its own code -- not generic INVALID_REQUEST, not the cron code");
        assertEquals("at", error.getExtra().get("param"),
                "the problem names the offending parameter so a client can highlight the field");
    }

    @Test
    void intervalTaskWithoutPeriodOrBelowTheFloorAnswersInvalidInterval() {
        CpApiException missing = assertThrows(CpApiException.class, () -> serviceWith(
                new ScheduledTaskContracts()).create(WORKSPACE_ID, USER_ID,
                jobRequest(ScheduledTask.TRIGGER_INTERVAL, null, null)));
        assertEquals(ScheduledTaskContracts.CODE_INTERVAL, missing.getCode(),
                "the interval row's declared RequiredParam(intervalSeconds) rejects this");

        CpApiException tooShort = assertThrows(CpApiException.class, () -> serviceWith(
                new ScheduledTaskContracts()).create(WORKSPACE_ID, USER_ID,
                jobRequest(ScheduledTask.TRIGGER_INTERVAL, null,
                        ScheduledTaskContracts.MIN_INTERVAL_SECONDS - 1)));
        assertEquals(ScheduledTaskContracts.CODE_INTERVAL, tooShort.getCode(),
                "sub-minute periods share the code (the DB CHECK holds the same bound)");
    }

    /** The positive control for the interval row: a legal period is accepted and scheduled. */
    @Test
    void intervalTaskAtTheFloorIsCreatedWithAnExactIntervalSchedule() {
        ScheduledTaskApiService.TaskView created = serviceWith(new ScheduledTaskContracts())
                .create(WORKSPACE_ID, USER_ID, jobRequest(ScheduledTask.TRIGGER_INTERVAL, null,
                        ScheduledTaskContracts.MIN_INTERVAL_SECONDS));
        assertEquals(ScheduledTask.TRIGGER_INTERVAL, created.triggerKind());
        assertNull(created.cronExpr(), "interval never carries a cron expression (V94 CHECK)");
        assertNull(created.expiresAt(), "interval never carries an expiry (V94 CHECK)");
        assertNotNull(created.nextFireAt());
    }

    @Test
    void sessionWakeupDistinguishesMissingSessionFromMissingPrompt() {
        CpApiException noSession = assertThrows(CpApiException.class, () -> serviceWith(
                new ScheduledTaskContracts()).create(WORKSPACE_ID, USER_ID,
                new ScheduledTaskApiService.CreateRequest("cron", "* * * * *", "UTC",
                        ScheduledTask.TARGET_SESSION_WAKEUP, null, "wake up", null, null, null,
                        null)));
        assertEquals(ScheduledTaskContracts.CODE_TARGET_SESSION_REQUIRED, noSession.getCode(),
                "missing targetSessionId answers its own code (pre-D-1706 it shared one sentence "
                        + "with a missing prompt)");

        CpApiException noPrompt = assertThrows(CpApiException.class, () -> serviceWith(
                new ScheduledTaskContracts()).create(WORKSPACE_ID, USER_ID,
                new ScheduledTaskApiService.CreateRequest("cron", "* * * * *", "UTC",
                        ScheduledTask.TARGET_SESSION_WAKEUP, SESSION_ID, null, null, null, null,
                        null)));
        assertEquals(ScheduledTaskContracts.CODE_PROMPT_REQUIRED, noPrompt.getCode());
        assertNotEquals(noSession.getCode(), noPrompt.getCode(),
                "the two missing session_wakeup parameters are distinguishable");
    }

    @Test
    void jobDispatchWithoutPayloadAnswersItsOwnCode() {
        CpApiException error = assertThrows(CpApiException.class, () -> serviceWith(
                new ScheduledTaskContracts()).create(WORKSPACE_ID, USER_ID,
                new ScheduledTaskApiService.CreateRequest("cron", "* * * * *", "UTC",
                        ScheduledTask.TARGET_JOB_DISPATCH, null, null, null, null, null, null)));
        assertEquals(ScheduledTaskContracts.CODE_PAYLOAD_REQUIRED, error.getCode());
        assertEquals("payload", error.getExtra().get("param"));
    }

    /** A declared ForbiddenParam is enforced by the same generic loop. */
    @Test
    void forbiddenTargetSessionIsRejectedForJobDispatch() {
        CpApiException error = assertThrows(CpApiException.class, () -> serviceWith(
                new ScheduledTaskContracts()).create(WORKSPACE_ID, USER_ID,
                jobRequestWithTargetSession()));
        assertEquals("INVALID_REQUEST", error.getCode());
        assertEquals("targetSessionId", error.getExtra().get("param"));
        assertEquals(HttpStatus.BAD_REQUEST, error.getStatus());
    }

    // -- (3) the parameter codes are distinct, and stay distinct ------------

    @Test
    void everyDeclaredParameterCarriesItsOwnProblemCode() {
        List<ScheduledTaskContracts.RequiredParam> all = new ArrayList<>();
        for (ScheduledTaskContracts.TriggerRow row : ScheduledTaskContracts.DEFAULT_TRIGGERS) {
            all.addAll(row.requiredParams());
        }
        for (ScheduledTaskContracts.TargetRow row : ScheduledTaskContracts.DEFAULT_TARGETS) {
            all.addAll(row.requiredParams());
        }
        assertEquals(all.size(),
                all.stream().map(ScheduledTaskContracts.RequiredParam::code).distinct().count(),
                "two parameters sharing a code would make the errors indistinguishable again: " + all);
    }
}
