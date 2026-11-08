package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.chat.AgentSpawnExecutionService;
import com.cc01cc.p.xihe.cp.chat.ApprovalService;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.chat.ChatRunStatusReadService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpStdioServerRepository;
import com.cc01cc.p.xihe.cp.repository.McpToolAliasRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.cc01cc.p.xihe.cp.skill.Skill;
import com.cc01cc.p.xihe.cp.skill.SkillCatalogSourceService;
import com.cc01cc.p.xihe.cp.skill.SkillReadService;
import com.cc01cc.p.xihe.cp.skill.SkillRepository;
import com.cc01cc.p.xihe.cp.skill.SkillTokenEstimator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0628 M2b: the {@code skill_read} tool end to end on the CP side — route, dispatch, the (A)
 * decision chain, and the three absence semantics.
 *
 * <p>What this class exists to pin, in the order the design ranks the risks:</p>
 *
 * <ul>
 *   <li><b>No existence oracle</b> (#9): "invisible to the caller", "visible but not bound to this
 *       Run" and "does not exist" are asserted <b>in one test method</b>, against full response
 *       bodies. Comparing them apart would not prove that they agree.</li>
 *   <li><b>Silence is the failure mode</b> (D28-38 ②③): a skill deleted or updated mid-Run must say
 *       so in the text the model reads, not only in a field or a log line.</li>
 *   <li><b>Snapshot is the read credential</b> (D28-39): the read of an absent entry must never
 *       touch live bindings, and the legacy {@code {}} path must be visibly a fallback (D28-40)
 *       with no write-back.</li>
 * </ul>
 *
 * <p>The repository is real in production and mocked here; what is <i>not</i> mocked is the decision
 * chain — {@link SkillReadService} is the production implementation, so these assertions cover the
 * code that ships, not a stand-in for it.</p>
 */
class SkillReadToolTest {

    private static final String WS = "66666666-6666-6666-6666-666666666666";
    private static final String USER_ID = "77777777-7777-7777-7777-777777777777";
    private static final String SESSION_ID = "55555555-5555-5555-5555-555555555555";
    private static final UUID RUN_ID = UUID.fromString("11111111-1111-1111-1111-111111111111");
    private static final UUID PRINCIPAL_ID = UUID.fromString("22222222-2222-2222-2222-222222222222");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String BOUND_QUALIFIED = "user:instance:instance:alpha";

    private RequestRewriter requestRewriter;
    private PolicyEngine policyEngine;
    private McpToolTimeoutService toolTimeoutService;
    private SessionService sessionService;
    /** PLAN-0689 A3b: skill_read now resolves the Run's own stamp (design §3-A). */
    private ChatRunStatusReadService chatRunStatusReadService;
    private ChatRunRepository chatRunRepository;
    private SkillRepository skillRepository;
    private SkillCatalogSourceService catalog;
    private LineageInvocationService lineageInvocationService;
    private McpInvocationService mcpInvocationService;
    private McpProxyController controller;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        requestRewriter = mock(RequestRewriter.class);
        policyEngine = mock(PolicyEngine.class);
        when(policyEngine.loadContext(any(), any(), any())).thenReturn(PolicyContext.EMPTY);
        when(policyEngine.allowsByGrant(any(PolicyContext.class), anyString(), anyString(),
                anyString(), anyString(), anyString(), org.mockito.ArgumentMatchers.anyBoolean()))
                .thenReturn(true);
        when(policyEngine.evaluateVerdict(any(PolicyContext.class), anyString(), anyString(),
                anyString(), any(), any(), any()))
                .thenReturn(PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN,
                        "manual", "auto_allow"));
        // The face is resolved by the PRODUCTION registry, not a per-test stub: that is what makes
        // the read/write contrast below a statement about `skill_read`'s classification rather than
        // about this fixture's opinion of it.
        ToolFaceRegistry realFaces = new ToolFaceRegistry();
        when(policyEngine.faceOf(any(PolicyContext.class), anyString()))
                .thenAnswer(call -> realFaces.faceOf(call.getArgument(1)));
        when(policyEngine.hasCurrentAgentToolCall(any(), any(), any(), any(), any(), any()))
                .thenReturn(true);
        when(requestRewriter.rewrite(anyString(), anyString(), anyString()))
                .thenAnswer(invocation -> invocation.getArgument(1));

        AuditLogger audit = mock(AuditLogger.class);
        ApprovalService approvalService = mock(ApprovalService.class);
        SseEmitterManager sse = mock(SseEmitterManager.class);
        sessionService = mock(SessionService.class);
        // PLAN-0689 A3b: skill_read resolves the Run's own stamp now (design §3-A), so the
        // fixture stubs the run read instead of the Session column.
        chatRunStatusReadService = mock(ChatRunStatusReadService.class);
        lenient().when(chatRunStatusReadService.agentPrincipalIdByRunId(anyString()))
                .thenReturn(Optional.of(PRINCIPAL_ID));
        Session session = new Session();
        when(sessionService.requireCurrent(eq(SESSION_ID), eq(USER_ID), eq(WS))).thenReturn(session);

        chatRunRepository = mock(ChatRunRepository.class);
        skillRepository = mock(SkillRepository.class);
        catalog = mock(SkillCatalogSourceService.class);
        SkillReadService skillReadService =
                new SkillReadService(chatRunRepository, skillRepository, catalog);

        var configService = mock(com.cc01cc.p.xihe.cp.config.ConfigService.class);
        var toolTimeoutPolicy = new com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy();
        toolTimeoutService = new McpToolTimeoutService(
                mock(McpServerRepository.class), configService, toolTimeoutPolicy);
        lineageInvocationService = mock(LineageInvocationService.class);
        lenient().when(lineageInvocationService.reserve(any(), any(), any(), any(), any(), any()))
                .thenReturn(new LineageInvocationService.ReservationDecision(
                        LineageInvocationService.DecisionKind.NOT_LINEAGED, null));
        mcpInvocationService = mock(McpInvocationService.class);
        // The dispatch ledger is not what this class is about; every call settles as "no durable
        // invocation row", which is the legacy non-lineaged shape.
        lenient().when(mcpInvocationService.findAgentInvocation(any(), any()))
                .thenReturn(Optional.empty());

        controller = new McpProxyController(
                requestRewriter, policyEngine, audit, approvalService, MAPPER, sse,
                new McpProxyCatalogService(mock(McpStdioServerRepository.class),
                        mock(McpServerRepository.class), mock(McpToolAliasRepository.class)),
                mock(WorkspaceService.class), sessionService,
                mock(com.cc01cc.p.xihe.cp.operation.JobStateService.class),
                configService, toolTimeoutPolicy,
                new org.springframework.mock.env.MockEnvironment(),
                mock(AgentSpawnExecutionService.class),
                mcpInvocationService, lineageInvocationService, toolTimeoutService,
                mock(com.cc01cc.p.xihe.cp.credentials.CredentialLeaseService.class),
                skillReadService,
                new com.cc01cc.p.xihe.cp.status.BuildVersion(),
                mock(com.cc01cc.p.xihe.cp.chat.DelegationBudgetService.class),
                chatRunStatusReadService,
                mock(com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient.class),
                new com.cc01cc.p.xihe.cp.plugin.PluginToolCatalogFilter(
                        org.mockito.Mockito.mock(
                                com.cc01cc.p.xihe.cp.plugin.PluginRunCatalogSnapshotService.class),
                        false));
        ReflectionTestUtils.setField(controller, "runtimeBaseUrl", "http://localhost:9091");

        // Route seeds: the tool map already knows both names, so no Runtime probe is attempted.
        // putMapping (not a raw field poke) so the TTL timestamp and generation move with it —
        // otherwise refreshCacheIfNeeded clears the seed and the call falls through to Runtime.
        Map<String, String> seeded = new ConcurrentHashMap<>();
        seeded.put("skill_read", "__cp__");
        seeded.put("write_file", "__system__");
        toolTimeoutService.putMapping(WS, seeded);
    }

    // ---------------------------------------------------------------- #2 route identity

    @Test
    void internalServiceReadsSkillWithoutOpeningALineageReservation() throws Exception {
        UUID alphaId = UUID.randomUUID();
        seedRun(snapshotWith(snapshotItem(alphaId, BOUND_QUALIFIED, "alpha", 2, "hash-v2")));
        when(skillRepository.findById(alphaId))
                .thenReturn(Optional.of(skill(alphaId, "alpha", 2, "hash-v2", "alpha body")));

        ResponseEntity<String> response = callSkillRead(alphaId.toString());

        assertEquals(HttpStatus.OK, response.getStatusCode());
        JsonNode structured = structured(response);
        assertEquals(alphaId.toString(), structured.path("skillId").asText());
        assertEquals("alpha body", structured.path("body").asText());
        assertEquals("current", structured.path("contentSource").asText());
        // The `read` face is what exempts this tool from the mutation lineage gate; asserting the
        // reservation never happens is the machine form of "it is classified as a read".
        verify(lineageInvocationService, never()).reserve(any(), any(), any(), any(), any(), any());
    }

    @Test
    void writeToolStillHitsTheLineageGateThatReadToolsSkip() throws Exception {
        when(lineageInvocationService.reserve(any(), any(), any(), any(), any(), any()))
                .thenReturn(new LineageInvocationService.ReservationDecision(
                        LineageInvocationService.DecisionKind.REPLAY_BLOCKED, null));

        ResponseEntity<String> response = handle(
                "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":7,"
                        + "\"params\":{\"name\":\"write_file\",\"arguments\":{}}}");

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("RECONCILIATION_REQUIRED",
                MAPPER.readTree(response.getBody()).path("code").asText());
        verify(lineageInvocationService).reserve(any(), any(), any(), any(), any(), any());
    }

    @Test
    void userCallerIsStillRefusedBeforeDispatch() throws Exception {
        String body = skillReadBody(UUID.randomUUID().toString());
        ResponseEntity<String> response = handleAs(body, accessContext(false));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
        verify(chatRunRepository, never()).findById(any());
    }

    // ---------------------------------------------------------------- #3 / #4 three failure semantics

    @Test
    void skillDeletedBeforeTheRunIsSimplyAbsentWithNoDeletionClaim() throws Exception {
        // D28-38 ①: the listing never contained it, so the model has nothing to misread. The answer
        // is the plain absence text — claiming "deleted" here would invent history.
        UUID neverBound = UUID.randomUUID();
        seedRun(snapshotWith());
        when(skillRepository.findById(neverBound))
                .thenReturn(Optional.of(skill(neverBound, "late", 1, "hash", "late body")));

        JsonNode structured = structured(callSkillRead(neverBound.toString()));

        assertEquals("SKILL_NOT_FOUND", structured.path("code").asText());
        assertEquals("skill not found", structured.path("detail").asText());
        assertFalse(structured.path("detail").asText().contains("被删除"));
    }

    @Test
    void skillDeletedDuringTheRunSaysSoInModelVisibleText() throws Exception {
        UUID alphaId = UUID.randomUUID();
        seedRun(snapshotWith(snapshotItem(alphaId, BOUND_QUALIFIED, "alpha", 2, "hash-v2")));
        when(skillRepository.findById(alphaId)).thenReturn(Optional.empty());

        ResponseEntity<String> response = callSkillRead(alphaId.toString());
        JsonNode structured = structured(response);

        assertEquals("SKILL_NOT_FOUND", structured.path("code").asText());
        // D28-38 ②: silence would let the model conclude the skill never existed.
        assertTrue(structured.path("detail").asText().contains("在你看到清单之后被删除"),
                "deleted-during-run must be stated, not implied");
        assertTrue(visibleText(response).contains("在你看到清单之后被删除"),
                "the model reads the content text, not the structured field");
    }

    @Test
    void skillUpdatedDuringTheRunReturnsCurrentContentAndSaysItChanged() throws Exception {
        UUID alphaId = UUID.randomUUID();
        seedRun(snapshotWith(snapshotItem(alphaId, BOUND_QUALIFIED, "alpha", 2, "hash-v2")));
        when(skillRepository.findById(alphaId))
                .thenReturn(Optional.of(skill(alphaId, "alpha", 3, "hash-v3", "alpha body v3")));

        ResponseEntity<String> response = callSkillRead(alphaId.toString());
        JsonNode structured = structured(response);

        // Current content wins; the snapshot only supplies the comparison baseline (§4).
        assertEquals("alpha body v3", structured.path("body").asText());
        assertEquals(3, structured.path("version").asInt());
        assertEquals(3, structured.path("currentVersion").asInt());
        assertEquals("hash-v3", structured.path("currentHash").asText());
        String notice = structured.path("notice").asText();
        assertTrue(notice.contains("被更新过"), notice);
        assertTrue(notice.contains("清单 v2，当前 v3"), notice);
        assertTrue(visibleText(response).contains("清单 v2，当前 v3"));
    }

    @Test
    void qualifiedNameIsRejectedAtTheBoundaryBeforeDispatch() throws Exception {
        UUID alphaId = UUID.randomUUID();
        seedRun(snapshotWith(snapshotItem(alphaId, BOUND_QUALIFIED, "alpha", 1, "hash-v1")));
        when(skillRepository.findById(alphaId))
                .thenReturn(Optional.of(skill(alphaId, "alpha", 1, "hash-v1", "body")));

        JsonNode structured = structured(callSkillRead(BOUND_QUALIFIED));

        assertEquals("INVALID_ARGUMENTS", structured.path("code").asText());
        assertTrue(structured.path("detail").asText().contains("skillId"),
                "the model must be pointed at the listing's skillId, not asked to guess");
        // 收尾 A: a qualified name is a second address form for the same skill. Accepting it
        // would address the skill without matching a rule written against skill:<uuid>, so it
        // must be refused before dispatchCpOwnedSkillRead ever runs.
        verify(chatRunRepository, never()).findById(any());
        verify(mcpInvocationService, never()).findAgentInvocation(any(), any());
        verify(skillRepository, never()).findById(any());
    }

    @Test
    void resourceSpellingIsNotAnAcceptedAddressFormEither() throws Exception {
        UUID alphaId = UUID.randomUUID();
        seedRun(snapshotWith(snapshotItem(alphaId, BOUND_QUALIFIED, "alpha", 1, "hash-v1")));

        JsonNode structured = structured(callSkillRead("skill:" + alphaId));

        assertEquals("INVALID_ARGUMENTS", structured.path("code").asText());
        verify(chatRunRepository, never()).findById(any());
        verify(mcpInvocationService, never()).findAgentInvocation(any(), any());
    }

    @Test
    void bareNameIsRejectedInsteadOfGuessingOneOfTheDoubleStoredCopies() throws Exception {
        seedRun(snapshotWith());

        JsonNode structured = structured(callSkillRead("alpha"));

        assertEquals("INVALID_ARGUMENTS", structured.path("code").asText());
        assertTrue(structured.path("detail").asText().contains("skillId"));
        verify(chatRunRepository, never()).findById(any());
        verify(mcpInvocationService, never()).findAgentInvocation(any(), any());
        verify(skillRepository, never()).findById(any());
    }

    // ---------------------------------------------------------------- #5 legacy fallback

    @Test
    void runWithoutASnapshotResolvesLiveAndClaimsNothing() throws Exception {
        UUID alphaId = UUID.randomUUID();
        seedRun(MAPPER.createObjectNode());
        when(catalog.resolveListing(any())).thenReturn(new SkillCatalogSourceService.Listing(
                SkillCatalogSourceService.STATUS_READY,
                List.of(new SkillCatalogSourceService.Item(alphaId, BOUND_QUALIFIED, "alpha",
                        "alpha description", 2, "hash-v2", false, "user", "instance", "instance")),
                false, List.of(), SkillCatalogSourceService.DEFAULT_MAX_SKILLS, true, false));
        // The live row has moved on (v3) — with no snapshot there is nothing to compare against, so
        // the response must stay silent about a change it cannot prove (D28-40, design §4).
        when(skillRepository.findById(alphaId))
                .thenReturn(Optional.of(skill(alphaId, "alpha", 3, "hash-v3", "alpha body v3")));

        JsonNode structured = structured(callSkillRead(alphaId.toString()));

        assertEquals("alpha body v3", structured.path("body").asText());
        assertTrue(structured.path("notice").isMissingNode() || structured.path("notice").isNull(),
                "no snapshot means no change claim and no 'unchanged' claim either");
        assertTrue(structured.path("diagnostics").toString().contains("snapshot_absent"),
                "the fallback must be visible, not silent");
        // D28-40 ③: writing the fallback result back would forge history.
        verify(chatRunRepository, never()).save(any());
    }

    @Test
    void snapshotPathNeverConsultsLiveBindings() throws Exception {
        UUID alphaId = UUID.randomUUID();
        seedRun(snapshotWith(snapshotItem(alphaId, BOUND_QUALIFIED, "alpha", 1, "hash-v1")));
        when(skillRepository.findById(alphaId))
                .thenReturn(Optional.of(skill(alphaId, "alpha", 1, "hash-v1", "body")));

        callSkillRead(alphaId.toString());

        // D28-39: the Run's capability set is the snapshot, full stop. A live resolve here would
        // reintroduce exactly the drift the snapshot exists to remove.
        verify(catalog, never()).resolveListing(any());
        verify(catalog, never()).resolve(any());
    }

    // ---------------------------------------------------------------- #6 oversize warning

    @Test
    void oversizeReadWarnsAboutTheContextBudgetInModelVisibleText() throws Exception {
        UUID alphaId = UUID.randomUUID();
        String huge = "x".repeat(12_000);
        seedRun(snapshotWith(snapshotItem(alphaId, BOUND_QUALIFIED, "alpha", 1, "hash-v1")));
        when(skillRepository.findById(alphaId))
                .thenReturn(Optional.of(skill(alphaId, "alpha", 1, "hash-v1", huge)));

        ResponseEntity<String> response = callSkillRead(alphaId.toString());
        JsonNode structured = structured(response);

        assertTrue(structured.path("oversize").asBoolean(false));
        assertTrue(structured.path("notice").asText().contains("这次读取可能占用显著上下文预算"),
                "an oversize read must warn; a field alone is not a warning (D28-15)");
        assertTrue(visibleText(response).contains("这次读取可能占用显著上下文预算"));
    }

    // ---------------------------------------------------------------- #7 visibility is not an oracle

    @Test
    void invisibleSkillAnswersNotFoundNeverForbidden() throws Exception {
        UUID hidden = UUID.randomUUID();
        seedRun(snapshotWith());
        // The row exists and belongs to a workspace this caller cannot see; the tool must not even
        // look at it — the Run was never admitted with it, which is the whole decision.
        when(skillRepository.findById(hidden))
                .thenReturn(Optional.of(skill(hidden, "hidden", 1, "hash", "secret body")));

        ResponseEntity<String> response = callSkillRead(hidden.toString());
        JsonNode structured = structured(response);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("SKILL_NOT_FOUND", structured.path("code").asText());
        assertNotEquals("FORBIDDEN", structured.path("code").asText());
        assertEquals(404, structured.path("status").asInt());
        verify(skillRepository, never()).findById(hidden);
    }

    // ---------------------------------------------------------------- #9 / #10 one oracle-free branch

    @Test
    void allThreeAbsenceShapesAreIndistinguishable() throws Exception {
        UUID boundId = UUID.randomUUID();
        UUID visibleButUnbound = UUID.randomUUID();
        UUID invisibleElsewhere = UUID.randomUUID();
        UUID nonexistent = UUID.randomUUID();
        seedRun(snapshotWith(snapshotItem(boundId, BOUND_QUALIFIED, "alpha", 1, "hash-v1")));
        // Input A: exists, and the caller cannot see it.
        when(skillRepository.findById(invisibleElsewhere))
                .thenReturn(Optional.of(skill(invisibleElsewhere, "elsewhere", 1, "h", "secret")));
        // Input B: visible to the caller, but this Run was never bound to it (#10 可见≠可读).
        when(skillRepository.findById(visibleButUnbound))
                .thenReturn(Optional.of(skill(visibleButUnbound, "visible", 1, "h", "body")));
        // Input C: nothing at all behind the uuid.
        when(skillRepository.findById(nonexistent)).thenReturn(Optional.empty());

        ResponseEntity<String> invisible = callSkillRead(invisibleElsewhere.toString());
        ResponseEntity<String> unbound = callSkillRead(visibleButUnbound.toString());
        ResponseEntity<String> missing = callSkillRead(nonexistent.toString());

        // Weakest assertion that is still complete: the three responses are byte-identical, so no
        // field — code, detail, model-visible text, status, anything added later — can differentiate
        // them. This is what makes the tool not an existence oracle (D28-33).
        assertEquals(invisible.getBody(), unbound.getBody());
        assertEquals(unbound.getBody(), missing.getBody());

        // Spelled out as well, because a diff on the whole body is hard to read when it fails.
        assertEquals("SKILL_NOT_FOUND", structured(invisible).path("code").asText());
        assertEquals(structured(invisible).path("detail").asText(),
                structured(unbound).path("detail").asText());
        assertEquals(structured(invisible).path("detail").asText(),
                structured(missing).path("detail").asText());
        assertEquals(visibleText(invisible), visibleText(unbound));
        assertEquals(visibleText(unbound), visibleText(missing));
        // And the existence of the two real rows never reached the decision.
        verify(skillRepository, never()).findById(invisibleElsewhere);
        verify(skillRepository, never()).findById(visibleButUnbound);
    }

    @Test
    void visibleButUnboundIsStillNotReadable() throws Exception {
        UUID boundId = UUID.randomUUID();
        UUID unbound = UUID.randomUUID();
        seedRun(snapshotWith(snapshotItem(boundId, BOUND_QUALIFIED, "alpha", 1, "hash-v1")));
        when(skillRepository.findById(unbound))
                .thenReturn(Optional.of(skill(unbound, "visible", 1, "h", "body")));

        JsonNode structured = structured(callSkillRead(unbound.toString()));

        assertEquals("SKILL_NOT_FOUND", structured.path("code").asText());
        assertTrue(structured.path("body").isMissingNode());
    }

    @Test
    void boundSkillIsReadableSoTheSameFixtureCanProduceBothOutcomes() throws Exception {
        // Guards the tests above from passing for the wrong reason: with the same fixtures, the one
        // entry that IS in the snapshot must be readable.
        UUID boundId = UUID.randomUUID();
        seedRun(snapshotWith(snapshotItem(boundId, BOUND_QUALIFIED, "alpha", 1, "hash-v1")));
        when(skillRepository.findById(boundId))
                .thenReturn(Optional.of(skill(boundId, "alpha", 1, "hash-v1", "alpha body v1")));

        JsonNode structured = structured(callSkillRead(boundId.toString()));

        assertEquals(boundId.toString(), structured.path("skillId").asText());
        assertEquals("alpha body v1", structured.path("body").asText());
    }

    // ---------------------------------------------------------------- helpers

    private void seedRun(JsonNode snapshot) {
        ChatRun run = new ChatRun();
        run.setId(RUN_ID);
        run.setSessionId(SESSION_ID);
        run.setUserId(USER_ID);
        run.setWorkspaceId(WS);
        run.setAgentPrincipalId(PRINCIPAL_ID);
        run.setSkillsSnapshot(snapshot);
        when(chatRunRepository.findById(RUN_ID)).thenReturn(Optional.of(run));
    }

    private static JsonNode snapshotWith(JsonNode... items) {
        ObjectNode document = MAPPER.createObjectNode();
        document.put("version", 1);
        document.put("status", items.length == 0
                ? SkillCatalogSourceService.STATUS_EMPTY : SkillCatalogSourceService.STATUS_READY);
        document.put("source", SkillCatalogSourceService.SOURCE);
        document.put("capturedAt", "2026-11-03T00:00:00Z");
        document.put("snapshotSource", "frozen");
        document.put("maxSkills", SkillCatalogSourceService.DEFAULT_MAX_SKILLS);
        ArrayNode array = document.putArray("items");
        for (JsonNode item : items) {
            array.add(item);
        }
        document.put("truncated", false);
        document.putArray("diagnostics");
        return document;
    }

    private static JsonNode snapshotItem(UUID skillId, String qualifiedName, String name,
                                         int version, String contentHash) {
        ObjectNode item = MAPPER.createObjectNode();
        item.put("skillId", skillId.toString());
        item.put("qualifiedName", qualifiedName);
        item.put("name", name);
        item.put("description", name + " description");
        item.put("version", version);
        item.put("contentHash", contentHash);
        item.put("oversize", false);
        ObjectNode tier = item.putObject("tier");
        tier.put("subjectType", "user");
        tier.put("scopeType", "instance");
        tier.put("definitionScopeType", "instance");
        return item;
    }

    private static Skill skill(UUID id, String name, int version, String contentHash, String body) {
        Skill skill = new Skill();
        skill.setId(id);
        skill.setName(name);
        skill.setDescription(name + " description");
        skill.setBody(body);
        skill.setBodyTokensEst(SkillTokenEstimator.estimate(body));
        skill.setOversize(SkillTokenEstimator.isOversize(SkillTokenEstimator.estimate(body)));
        skill.setContentHash(contentHash);
        skill.setVersion(version);
        skill.setDefinitionScopeType(Skill.DEFINITION_SCOPE_INSTANCE);
        skill.setSourcePath("/skills/" + name + "/SKILL.md");
        skill.setTrusted(true);
        skill.setCreatedByUserId(UUID.fromString(USER_ID));
        skill.setAttachments(MAPPER.createObjectNode());
        return skill;
    }

    private static String skillReadBody(String skillArgument) {
        return "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":7,"
                + "\"params\":{\"name\":\"skill_read\",\"arguments\":{\"skill\":\""
                + skillArgument + "\"}}}";
    }

    private ResponseEntity<String> callSkillRead(String skillArgument) throws Exception {
        return handle(skillReadBody(skillArgument));
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<String> handle(String body) throws Exception {
        return handleAs(body, internalAccessContext());
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<String> handleAs(String body, Object access) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Chat-Run-Id", RUN_ID.toString());
        return (ResponseEntity<String>) ReflectionTestUtils.invokeMethod(
                controller, "handleToolsCall", WS, body, headers, SESSION_ID, access);
    }

    private static JsonNode structured(ResponseEntity<String> response) throws Exception {
        return MAPPER.readTree(response.getBody()).path("result").path("structuredContent");
    }

    private static String visibleText(ResponseEntity<String> response) throws Exception {
        return MAPPER.readTree(response.getBody()).path("result").path("content").get(0)
                .path("text").asText();
    }

    /** The controller's private {@code AccessContext} record, built the way its own callers do. */
    private static Object accessContext(boolean internalService) throws Exception {
        Class<?> accessClass = Class.forName(
                "com.cc01cc.p.xihe.cp.mcp.McpProxyController$AccessContext");
        var constructor = accessClass.getDeclaredConstructor(
                String.class, String.class, String.class, boolean.class);
        constructor.setAccessible(true);
        return constructor.newInstance(WS, USER_ID, SESSION_ID, internalService);
    }

    private static Object internalAccessContext() throws Exception {
        return accessContext(true);
    }
}
