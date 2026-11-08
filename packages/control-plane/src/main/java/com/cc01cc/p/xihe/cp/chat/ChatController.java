package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunTransportAttempt;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.SessionParticipantService;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.cc01cc.p.xihe.cp.status.RequestQueue;
import com.cc01cc.p.xihe.cp.status.CircuitBreaker;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.provider.ApiRequestValidator;
import com.cc01cc.p.xihe.cp.config.EmbeddingProfileService;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

@RestController
public class ChatController {

    private static final Logger logger = LoggerFactory.getLogger(ChatController.class);
    private static final String FOLLOW_UP_QUEUE_RESERVATION_PREFIX = "follow-up-queue:";

    private final HttpClient agentHttpClient;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sseManager;
    private final ApprovalService approvalService;
    /** PLAN-0660 T5.11: the relay's durable side for {@code session_question_asked} events. */
    private final UserQuestionService userQuestionService;
    /** PLAN-0660 T5.11: the user-level refresh hint ({@code {questionId, sessionId, state}} only). */
    private final com.cc01cc.p.xihe.cp.event.UserChannelPort userChannel;
    private final com.cc01cc.p.xihe.cp.context.service.ContextService contextService;
    private final ChatSubmissionService chatSubmissionService;
    private final FollowUpQueueService followUpQueueService;
    private final SessionService sessionService;
    private final AgentPrincipalService agentPrincipalService;
    private final com.cc01cc.p.xihe.cp.service.SessionParticipantService sessionParticipantService;
    private final WakeFanOutService wakeFanOutService;
    private final com.cc01cc.p.xihe.cp.service.ParticipantCapabilityService participantCapabilityService;
    /** PLAN-0623 M1b-③: runId → producing participant row id; absent = producer-less system event. */
    private final java.util.concurrent.ConcurrentHashMap<String, String> runParticipants =
            new java.util.concurrent.ConcurrentHashMap<>();
    private final ChatAttachmentService chatAttachmentService;
    private final HealthMonitor healthMonitor;
    private final RequestQueue requestQueue;
    private final ProviderCredentialLeaseService credentialLeases;
    private final EmbeddingProfileService embeddingProfiles;
    private final ApiRequestValidator requestValidator;
    /** PLAN-0635 M2: resolves `@文件/目录` tokens into injectable entries for the Agent. */
    private final com.cc01cc.p.xihe.cp.context.service.MentionPathResolver mentionPathResolver;
    private final ConfigService configService;
    private final com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder mcpRelayToolRecorder;
    private final com.cc01cc.p.xihe.cp.mcp.McpToolTimeoutService mcpToolTimeoutService;
    private final com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy toolTimeoutPolicy;
    private final ChatRunCancellationService chatRunCancellationService;
    private final ChatRunTerminalService chatRunTerminalService;
    private final ChatRunReadService chatRunReadService;
    private final ChatRunTransportService chatRunTransportService;
    private final SessionMonitorService sessionMonitorService;
    private final ChatRunLifecycleService chatRunLifecycleService;
    private final MessageReadService messageReadService;
    private final com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService contextSourceRefreshService;
    /** PLAN-0666 M1b: writes the per-run context fingerprint at the first dispatch (fail-open). */
    private final ContextFingerprintRecorder contextFingerprintRecorder;
    /** PLAN-0679 T2.2: writes the provider-layer request fingerprint (fail-open, durable-before-forward). */
    private final ProviderRequestFingerprintRecorder providerRequestFingerprintRecorder;
    private final com.cc01cc.p.xihe.cp.usage.UsageCostMapper usageCostMapper;
    private final com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService contextTemplateSourceService;
    private final ApplicationEventPublisher eventPublisher;
    private final ChatActiveRunRegistry activeRunRegistry;
    private final com.cc01cc.p.xihe.cp.policy.ResourceGovernor governor;

    /**
     * PLAN-0648 D1: terminal outcome for a submission whose answer was delegated to the mention
     * target. One literal, so the wire body, the durable row and the log cannot drift apart.
     */
    static final String SUPPRESSED_NO_RESPONDER = "suppressed_no_responder";

    private static final java.time.Duration LEASE_TTL = java.time.Duration.ofMinutes(10);
    private static final String INSTANCE_ID = UUID.randomUUID().toString();

    /**
     * PLAN-0328 M2 W3: statuses whose transition ends the Run and therefore must
     * pass through the single ChatRunTerminalService owner.
     */
    /**
     * PLAN-0307 T2.7 (decision #3) + PLAN-0590 (decision #1): domains delivered as
     * per-run payload overrides. PLAN-0590 moved the Agent's config base from a
     * process-wide effective snapshot to a per-run `(workspaceId, userId)` snapshot
     * (5 domains: llm-provider / agent-profile / rag / agent-runtime /
     * context-policy); these explicit rows still ride on top of that snapshot.
     * `embedding` stays in the override set for wire compatibility but is NOT part
     * of the run snapshot: the Agent run path does not read it (RAG resolves its
     * profile per request, PLAN-0485). Instance-only domains stay pull-only.
     */
    private static final List<String> AGENT_RUN_OVERRIDE_DOMAINS =
        List.of("llm-provider", "agent-profile", "embedding", "rag", "agent-runtime",
                "context-policy");

    @Value("${cp.agent-url:http://localhost:12632/chat}")
    private String agentUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ChatController(
            ObjectMapper objectMapper,
            SseEmitterManager sseManager,
            ApprovalService approvalService,
            com.cc01cc.p.xihe.cp.context.service.ContextService contextService,
            ChatSubmissionService chatSubmissionService,
            FollowUpQueueService followUpQueueService,
            SessionService sessionService,
            AgentPrincipalService agentPrincipalService,
            com.cc01cc.p.xihe.cp.service.SessionParticipantService sessionParticipantService,
            WakeFanOutService wakeFanOutService,
            com.cc01cc.p.xihe.cp.service.ParticipantCapabilityService participantCapabilityService,
            ChatAttachmentService chatAttachmentService,
            ChatActiveRunRegistry activeRunRegistry,
            HealthMonitor healthMonitor,
            RequestQueue requestQueue,
            ProviderCredentialLeaseService credentialLeases,
            EmbeddingProfileService embeddingProfiles,
            ApiRequestValidator requestValidator,
            ConfigService configService,
            com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder mcpRelayToolRecorder,
            com.cc01cc.p.xihe.cp.mcp.McpToolTimeoutService mcpToolTimeoutService,
            com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy toolTimeoutPolicy,
            ChatRunCancellationService chatRunCancellationService,
            ChatRunTerminalService chatRunTerminalService,
            ChatRunReadService chatRunReadService,
            ChatRunTransportService chatRunTransportService,
            SessionMonitorService sessionMonitorService,
            ChatRunLifecycleService chatRunLifecycleService,
            MessageReadService messageReadService,
             com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService contextSourceRefreshService,
              com.cc01cc.p.xihe.cp.usage.UsageCostMapper usageCostMapper,
              com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService contextTemplateSourceService,
              ApplicationEventPublisher eventPublisher,
              com.cc01cc.p.xihe.cp.policy.ResourceGovernor governor,
              // PLAN-0635 M2: appended last so the many positional constructions stay stable.
              com.cc01cc.p.xihe.cp.context.service.MentionPathResolver mentionPathResolver,
              // PLAN-0666 M1b: appended last for the same reason.
              ContextFingerprintRecorder contextFingerprintRecorder,
              // PLAN-0660 T5.11: the session_question_asked relay (durable row + user-channel hint).
              UserQuestionService userQuestionService,
              com.cc01cc.p.xihe.cp.event.UserChannelPort userChannel,
              // PLAN-0679 T2.2: appended last for the same reason.
              ProviderRequestFingerprintRecorder providerRequestFingerprintRecorder) {
        this.agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.sseManager = sseManager;
        this.approvalService = approvalService;
        this.contextService = contextService;
        this.chatSubmissionService = chatSubmissionService;
        this.followUpQueueService = followUpQueueService;
        this.sessionService = sessionService;
        this.agentPrincipalService = agentPrincipalService;
        this.sessionParticipantService = sessionParticipantService;
        this.wakeFanOutService = wakeFanOutService;
        this.participantCapabilityService = participantCapabilityService;
        this.chatAttachmentService = chatAttachmentService;
        this.activeRunRegistry = activeRunRegistry;
        this.governor = governor;
        this.healthMonitor = healthMonitor;
        this.requestQueue = requestQueue;
        this.credentialLeases = credentialLeases;
        this.embeddingProfiles = embeddingProfiles;
        this.requestValidator = requestValidator;
        this.mentionPathResolver = mentionPathResolver;
        this.contextFingerprintRecorder = contextFingerprintRecorder;
        this.userQuestionService = userQuestionService;
        this.userChannel = userChannel;
        this.providerRequestFingerprintRecorder = providerRequestFingerprintRecorder;
        this.configService = configService;
        this.mcpRelayToolRecorder = mcpRelayToolRecorder;
        this.mcpToolTimeoutService = mcpToolTimeoutService;
        this.toolTimeoutPolicy = toolTimeoutPolicy;
        this.chatRunCancellationService = chatRunCancellationService;
        this.chatRunTerminalService = chatRunTerminalService;
        this.chatRunReadService = chatRunReadService;
        this.chatRunTransportService = chatRunTransportService;
        this.sessionMonitorService = sessionMonitorService;
        this.chatRunLifecycleService = chatRunLifecycleService;
        this.messageReadService = messageReadService;
        this.contextSourceRefreshService = contextSourceRefreshService;
        this.usageCostMapper = usageCostMapper;
        this.contextTemplateSourceService = contextTemplateSourceService;
        this.eventPublisher = eventPublisher;

        // Wire drain callback: when agent recovers, drain queued requests
        healthMonitor.setOnServiceRecovered(serviceName -> {
            if ("agent".equals(serviceName)) {
                requestQueue.drain(req -> {
                    String requestId = nonBlankOrGenerated(req.requestId());
                    String runId = nonBlankOrGenerated(req.runId());
                    if (!acquireRun(req.sessionId(), runId)
                            || !acquireLeaseForExistingRun(runId)) {
                        logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} runId={} errorCode=CHAT_IN_PROGRESS",
                                requestId, req.sessionId(), runId);
                        markQueuedRequestFailed(req, requestId, "CHAT_IN_PROGRESS", "A chat run is already active for this session");
                        return;
                    }
                    logger.info("[LIFECYCLE] service=cp event=requestRedelivered requestId={} sessionId={} runId={} outcome=accepted",
                            requestId, req.sessionId(), runId);
                    execAsync(req.sessionId(), req.content(), req.provider(), req.model(), req.toolMode(),
                            req.toolTimeouts(), req.attachments(),
                            req.userId(), req.workspaceId(), requestId, runId, null);
                }, req -> markQueuedRequestFailed(
                        req,
                        nonBlankOrGenerated(req.requestId()),
                        "AGENT_UNAVAILABLE",
                        "Queued chat request could not be delivered"));
            }
        });
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/sessions/{sessionId}/follow-ups")
    public ResponseEntity<FollowUpQueueSnapshot> getFollowUpQueue(@PathVariable String sessionId) {
        return ResponseEntity.ok(followUpQueueService.snapshot(
                sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId()));
    }

    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/api/v1/sessions/{sessionId}/follow-ups/{itemId}")
    public ResponseEntity<FollowUpQueueSnapshot> withdrawFollowUp(
            @PathVariable String sessionId, @PathVariable UUID itemId) {
        return ResponseEntity.ok(followUpQueueService.withdraw(
                sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId(), itemId));
    }

    @EventListener
    void onFollowUpQueueWakeup(FollowUpQueueWakeupEvent event) {
        // PLAN-0645 D45-06: the queue admission keeps its own local serialization token instead of
        // borrowing the Session's (former) single run slot — with several runs per Session an
        // unrelated in-flight run must never block the queue drain.
        String queueReservationKey = FOLLOW_UP_QUEUE_RESERVATION_PREFIX + event.sessionId();
        String reservationId = UUID.randomUUID().toString();
        if (!activeRunRegistry.tryReserve(queueReservationKey, reservationId)) {
            return;
        }
        boolean retryAdmission = false;
        try {
            followUpQueueService.admitHead(event.sessionId(), admission -> {
                Session session = admission.session();
                com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem item = admission.item();
                Map<String, Integer> timeouts = objectMapper.convertValue(item.getToolTimeouts(),
                        new TypeReference<LinkedHashMap<String, Integer>>() {});
                String provider = session.getProviderConnectionId() == null
                        ? item.getProvider() : session.getModelProvider();
                String model = session.getProviderConnectionId() == null
                        ? item.getModel() : session.getModelName();
                // PLAN-0689 A2 (T1.2 / design B2-a): read the same value the Session column used to
                // hold — the PRIMARY row's principal, which every create/bind path wrote in the same
                // transaction. Same input ⇒ same hash ⇒ pre-upgrade Idempotency-Keys still dedupe.
                UUID followUpPrincipal =
                        sessionParticipantService.responderPrincipalIdFor(session.getId(), null);
                String principalId = followUpPrincipal == null ? null : followUpPrincipal.toString();
                String branchId = item.getBranchId().toString();
                String requestHash = ChatRequestHash.calculate(objectMapper, item.getContent(), provider, model,
                        item.getToolMode(), admission.attachments().fileIds(), timeouts, principalId, branchId);
                List<Map<String, Object>> attachmentRefs = new ArrayList<>();
                for (AttachmentInfo attachment : admission.attachments().references()) {
                    Map<String, Object> ref = new LinkedHashMap<>();
                    ref.put("fileId", attachment.getId());
                    ref.put("name", attachment.getName());
                    ref.put("type", attachment.getType());
                    ref.put("size", attachment.getSize());
                    attachmentRefs.add(ref);
                }
                String attachmentsJson;
                try {
                    attachmentsJson = objectMapper.writeValueAsString(attachmentRefs);
                } catch (Exception e) {
                    throw new IllegalStateException("Unable to serialize admitted Follow-up attachments", e);
                }
                String runId = UUID.randomUUID().toString();
                ChatSubmissionService.Submission created = chatSubmissionService.createFollowUp(
                        runId, event.sessionId(), session.getUserId(), session.getWorkspaceId(), branchId,
                        item.getIdempotencyKey(), requestHash, provider, model, item.getToolMode(),
                        session.getProviderConnectionId(), session.getConnectionRevision(), instanceId(),
                        UUID.randomUUID().toString(), item.getContent(), attachmentsJson,
                        admission.attachments().fileIds());
                return new FollowUpQueueService.ChildAdmission(
                        created.run().getId(), created.userMessage().getId());
            });
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_queue_dispatch_failed "
                            + "sessionId={} retryAttempt={} failureType={}",
                    event.sessionId(), event.retryAttempt(), e.getClass().getSimpleName(), e);
            retryAdmission = true;
        } finally {
            activeRunRegistry.releaseReservation(queueReservationKey, reservationId);
        }
        if (retryAdmission) {
            followUpQueueService.scheduleAdmissionRetry(event);
        }
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/api/v1/sessions/{sessionId}/follow-ups")
    public ResponseEntity<FollowUpQueueSnapshot> enqueueFollowUp(
            @PathVariable String sessionId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody FollowUpCreateRequest request) {
        FollowUpQueueService.EnqueueResult result = followUpQueueService.enqueue(
                sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId(),
                idempotencyKey == null ? null : idempotencyKey.trim(), request);
        return ResponseEntity.status(result.replayed() ? HttpStatus.OK : HttpStatus.ACCEPTED)
                .body(result.snapshot());
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/api/v1/sessions/{sessionId}/follow-ups/continue")
    public ResponseEntity<FollowUpQueueSnapshot> continueFollowUpQueue(@PathVariable String sessionId) {
        FollowUpQueueService.ContinueResult result = followUpQueueService.continueQueue(
                sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId());
        return ResponseEntity.status(result.changed() ? HttpStatus.ACCEPTED : HttpStatus.OK)
                .body(result.snapshot());
    }

    @EventListener
    void onFollowUpChildAdmitted(FollowUpChildAdmittedEvent event) {
        String runId = event.childRunId();
        ChatRunReadService.DispatchRun run = chatRunReadService.findDispatchRun(runId).orElse(null);
        if (run == null) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_child_dispatch_failed sessionId={} runId={} reason=run_missing",
                    event.sessionId(), runId);
            return;
        }
        try {
            MessageReadService.DispatchMessage message = messageReadService.findDispatchMessage(run.userMessageId())
                    .orElseThrow(() -> new IllegalStateException("Admitted Follow-up Message is missing"));
            List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments =
                    resolveAdmittedAttachments(message.attachments());
            // PLAN-0645: the admitted child claims its own run id. There is no per-Session run slot
            // to hand over any more; a duplicate claim means another path already dispatches it.
            if (!activeRunRegistry.claim(event.sessionId(), runId)) {
                logger.info("[LIFECYCLE] service=cp event=follow_up_child_dispatch_skipped "
                                + "sessionId={} runId={} reason=already_claimed",
                        event.sessionId(), runId);
                return;
            }
            logger.info("[LIFECYCLE] service=cp event=follow_up_child_dispatch_started sessionId={} runId={} queueItemId={} attachments={}",
                    event.sessionId(), runId, event.queueItemId(), attachments.size());
            execAsync(event.sessionId(), message.content(), run.provider(), run.model(), run.toolMode(),
                    event.toolTimeouts(), attachments, run.userId(), run.workspaceId(),
                    UUID.randomUUID().toString(), runId, null);
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_child_dispatch_failed sessionId={} runId={} failureType={}",
                    event.sessionId(), runId, e.getClass().getSimpleName(), e);
            failFollowUpDispatch(event.sessionId(), runId);
        }
    }

    private List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> resolveAdmittedAttachments(String attachmentsJson)
            throws java.io.IOException {
        return chatAttachmentService.resolveAdmittedMessageAttachments(attachmentsJson);
    }

    private void failFollowUpDispatch(String sessionId, String runId) {
        try {
            chatRunTerminalService.terminalize(new ChatRunTerminalService.TerminalRequest(
                    runId, List.of("accepted"), "ambiguous", "ambiguous", "FOLLOW_UP_DISPATCH_FAILED",
                    "The admitted Follow-up could not be dispatched; it will not be replayed",
                    0, 0, ChatRunTerminalService.TerminalSource.RECONCILIATION, List.of(), null));
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_dispatch_failure_terminalization_failed sessionId={} runId={} failureType={}",
                    sessionId, runId, e.getClass().getSimpleName(), e);
        } finally {
            releaseRun(sessionId, runId, "follow_up_dispatch_failed");
        }
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping(path = "/api/v1/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@RequestParam(name = "sessionId") String sessionId,
                             @RequestParam(name = "asParticipantId", required = false) String asParticipantId,
                             @RequestHeader(name = "X-XH-SSE-Connection-Id", required = false)
                             String connectionId,
                             @RequestHeader(name = "X-Workspace-Id", required = false) String workspaceHeader) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new com.cc01cc.p.xihe.cp.config.CpApiException(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sessionId is required");
        }
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null) {
            throw CpApiException.workspaceContextRequired();
        }
        // PLAN-0647 D-678/D-47-05: a request WITHOUT the header is the workspace-less intent; it must
        // resolve an owner-only, workspace-less Session (a workspace Session answers 400 WORKSPACE_
        // CONTEXT_REQUIRED instead of being adopted by the interceptor/token fallback). Requests
        // WITH the header keep the byte-identical workspace path.
        if (workspaceHeader == null) {
            // Header-less: the ROW decides (D-47-05). A NULL workspace is the pure-chat scope; a
            // workspace Session keeps its workspace from the token claim (the pre-D-678 behaviour).
            Session rowProbe = sessionService.requireOwnedSession(sessionId, userId);
            if (rowProbe.getWorkspaceId() == null) {
                workspaceId = null;
            } else if (workspaceId == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "WORKSPACE_CONTEXT_REQUIRED",
                        "This Session belongs to a workspace; send X-Workspace-Id");
            } else {
                sessionService.requireCurrent(sessionId, userId, workspaceId);
            }
        } else {
            sessionService.requireCurrent(sessionId, userId, workspaceId);
        }
        // PLAN-0623 M1b-③ / D23-08: a declared participant view must be one the caller is
        // authorised to act for — same gate as chat --as; undeclared = observer (full stream).
        String declaredView = asParticipantId == null || asParticipantId.isBlank() ? null : asParticipantId;
        if (declaredView != null) {
            if (workspaceId == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "WORKSPACE_LESS_FEATURE_FORBIDDEN",
                        "Participant views require a workspace context");
            }
            sessionParticipantService.authorizeAsParticipant(userId, workspaceId, sessionId, declaredView);
        }
        SseEmitter emitter = sseManager.createEmitter(sessionId, declaredView, connectionId);
        sseManager.send(sessionId, "connected", Map.of("sessionId", sessionId, "type", "connected"));
        if (workspaceId != null) {
            // Approvals are workspace-scoped (approval_requests.workspace_id NOT NULL); a pure-chat
            // session can never own one, so the replay is skipped rather than passed a null tenant.
            for (Map<String, Object> approval : approvalService.replayPending(sessionId, userId, workspaceId)) {
                sseManager.send(sessionId, "approval_request", approval);
            }
        }
        logger.info("[LIFECYCLE] service=cp event=chat_sse_connected requestId={} sessionId={} workspaceId={} connectionGeneration={} outcome=ok",
                currentRequestId(), sessionId, workspaceId, sseManager.connectionGeneration(sessionId));
        return emitter;
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/api/v1/chat")
    public ResponseEntity<Map<String, Object>> chat(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyHeader,
            @RequestHeader(value = "X-Workspace-Id", required = false) String workspaceHeader,
            @RequestBody Map<String, Object> request) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        String sessionId = (String) request.get("sessionId");
        if (sessionId == null || sessionId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sessionId is required");
        }
        Object rawBranchId = request.get("branchId");
        if (!(rawBranchId instanceof String branchValue) || branchValue.isBlank()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "branchId is required");
        }
        String branchId;
        try {
            branchId = UUID.fromString(branchValue).toString();
        } catch (IllegalArgumentException invalidBranchId) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "branchId must be a UUID");
        }
        String content = (String) request.getOrDefault("content", "");
        // PLAN-0689 A2 (T1.2 / design §3 B3): the wire field is retired — a request can no longer
        // name the run's answering principal; that is resolved at admission instead. Old clients
        // that still send it are ignored rather than rejected: the body is a Map, so there is no
        // strict deserialization to 400 on it (BL-444 tracks the deprecation window).
        Object rawAsParticipantId = request.get("asParticipantId");
        if (rawAsParticipantId != null && !(rawAsParticipantId instanceof String)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "asParticipantId must be a UUID string");
        }
        String asParticipantId = (String) rawAsParticipantId;
        // PLAN-0630 M5b (D30-14): optional composer cc list — observer participant ids. Every
        // entry must be a UUID string (400 INVALID_REQUEST otherwise); roster membership and
        // disabled state are resolved fail-closed in WakeFanOutService, same as mentions.
        // cc is notify-only and deliberately NOT part of the idempotency request hash.
        Object rawCc = request.get("cc");
        List<UUID> ccParticipantIds = null;
        if (rawCc != null) {
            if (!(rawCc instanceof List<?> ccList)) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                        "INVALID_REQUEST", "cc must be an array of participant UUID strings");
            }
            List<UUID> parsedCc = new ArrayList<>();
            Set<String> seenCc = new HashSet<>();
            for (Object item : ccList) {
                if (!(item instanceof String ccValue) || ccValue.isBlank()) {
                    return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                            "INVALID_REQUEST", "cc entries must be participant UUID strings");
                }
                try {
                    UUID ccId = UUID.fromString(ccValue.trim());
                    if (seenCc.add(ccId.toString())) {
                        parsedCc.add(ccId);
                    }
                } catch (IllegalArgumentException invalidCc) {
                    return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                            "INVALID_REQUEST", "cc entries must be participant UUID strings");
                }
            }
            ccParticipantIds = parsedCc;
        }
        // PLAN-0665 M1 (D6/Q3): explicit TO target set. Shape is validated here (fail-closed
        // 400 INVALID_REQUEST; never silently dropped); roster authz + AGENT-only classification
        // runs with the other participant gates further down. Empty/absent ⇒ today's single-TO path.
        List<UUID> toParticipantIds;
        try {
            toParticipantIds = ChatToTargets.parse(request.get(ChatToTargets.FIELD));
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        if (!toParticipantIds.isEmpty()) {
            // PLAN-0665 M1/Q1: the FIRST target owns the user_submission Run (runId = runIds[0]);
            // the remaining targets become sibling runs through the single TargetedWake entry.
            // `asParticipantId` may not contradict the explicit selection.
            String firstTarget = toParticipantIds.get(0).toString();
            if (asParticipantId != null && !asParticipantId.isBlank()
                    && !asParticipantId.equalsIgnoreCase(firstTarget)) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "asParticipantId conflicts with toParticipantIds[0]");
            }
            asParticipantId = firstTarget;
        }
        String provider = (String) request.get("provider");
        String model = (String) request.get("model");
        String toolMode = (String) request.getOrDefault("toolMode", "none");
        // PLAN-0308 M1 T1.9（决策 #28/#29，spec S2.2 规则 6）：run 请求可携带 per-tool 超时
        // （per-call，最高优先输入）。非法/超上限 → 400 拒绝并署名，不静默截断。
        com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy.PerCallMap perCallTimeouts =
                toolTimeoutPolicy.validatePerCallMap(request.get("toolTimeouts"));
        if (!perCallTimeouts.valid()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", perCallTimeouts.error());
        }

        // PLAN-0647 D-678/D-697: the pure-chat (workspace-less) door. The decision uses the ROW
        // (D-47-05), never the interceptor fallback: a workspace Session without a workspace context
        // is a 400; a workspace-less Session needs no workspace. Every surface that requires a
        // workspace is refused here BEFORE any run is persisted: tools (toolMode != none),
        // attachments, TO/CC fan-out and participant views — explicit 400s, zero run rows.
        Session workspacelessSession = null;
        if (workspaceHeader == null) {
            Session rowProbe;
            try {
                rowProbe = sessionService.requireOwnedSession(sessionId, userId);
            } catch (CpApiException e) {
                return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
            }
            if (rowProbe.getWorkspaceId() == null) {
                workspacelessSession = rowProbe;
                // The token/tenant fallback must not leak into a workspace-less run.
                workspaceId = null;
            } else if (workspaceId == null) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                        "WORKSPACE_CONTEXT_REQUIRED",
                        "This Session belongs to a workspace; send X-Workspace-Id");
            }
        }
        if (workspacelessSession != null) {
            if (toolMode != null && !"none".equals(toolMode)) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                        "WORKSPACE_LESS_TOOL_MODE_FORBIDDEN",
                        "A workspace-less Session only supports toolMode=none");
            }
            if (!toParticipantIds.isEmpty()
                    || (ccParticipantIds != null && !ccParticipantIds.isEmpty())
                    || (asParticipantId != null && !asParticipantId.isBlank())
                    || !extractAttachmentIds(request).isEmpty()) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                        "WORKSPACE_LESS_FEATURE_FORBIDDEN",
                        "A workspace-less Session does not support attachments, TO/CC fan-out or participant views");
            }
        }
        String idempotencyKey = idempotencyHeader == null || idempotencyHeader.isBlank()
                ? UUID.randomUUID().toString()
                : idempotencyHeader.trim();
        if (idempotencyKey.length() > 128) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Idempotency-Key exceeds 128 characters");
        }

        if (workspaceId != null && workspacelessSession == null) {
            try {
                sessionService.requireWorkspace(userId, workspaceId);
                // PLAN-0618 M1 (BL-178): the frozen docker backend is refused here — before the SSE and
                // circuit-breaker checks — so the client sees the contract's 503 BACKEND_DISABLED instead
                // of a raw Runtime transport error.
                sessionService.requireBackendUsableWorkspace(workspaceId);
            } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
                return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
            }
        }

        // PLAN-0623 D23-08: `asParticipantId` lets the conversation owner speak *as* an added
        // participant (the agent answers under that identity). Adding a member never grants this —
        // it is a separate authorization, so it is gated in the request thread and answers 403
        // PARTICIPANT_CAP_DENIED before any run exists.
        if (asParticipantId != null && !asParticipantId.isBlank()) {
            try {
                sessionParticipantService.authorizeAsParticipant(userId, workspaceId, sessionId, asParticipantId);
            } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
                return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
            }
        }
        // PLAN-0665 M1/Q3: every explicit TO target passes the SAME D23-08 gate as `asParticipantId`
        // (a fan-out selector must never become an authorization bypass). M1 accepts AGENT
        // participants only; human TO is a later plan (blocked on BL-238).
        if (!toParticipantIds.isEmpty()) {
            try {
                sessionParticipantService.authorizeToTargets(userId, workspaceId, sessionId, toParticipantIds);
            } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
                return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
            }
        }
        // PLAN-0623 M1b-②: cap 与 run 归属必须出自同一个 Responder —— 在请求线程解析一次并随
        // execAsync 链传到 lease 段；lease 段不得重新解析（否则"A 的 cap"可能驱动"B 的消息"）。
        // 解析必须无条件：responderFor(sessionId, null) 落 PRIMARY 行（缺省回答者）；
        // 只在显式 as 时解析会让缺省 run 的 SSE 归属丢失（真栈 A/B 联验抓到）。
        // responder == null（会话既无 PRIMARY 也无显式 as）时 lease 段走 0622 C3 冻结语义（D23-31 双轨）。
        SessionParticipantService.Responder responder =
                sessionParticipantService.responderFor(UUID.fromString(sessionId), asParticipantId);
        String requestId = currentRequestId();
        String runId = UUID.randomUUID().toString();
        if (!sseManager.hasEmitter(sessionId)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} runId={} errorCode=SSE_SUBSCRIPTION_REQUIRED",
                    requestId, sessionId, runId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "SSE_SUBSCRIPTION_REQUIRED", "An active SSE subscription is required");
        }

        // Circuit breaker check
        CircuitBreaker agentBreaker = healthMonitor.getAgentBreaker();
        if (!agentBreaker.allowRequest()) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_rejected requestId={} sessionId={} runId={} errorCode=AGENT_CIRCUIT_OPEN",
                    requestId, sessionId, runId);
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header("Retry-After", "30")
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .header("X-Request-Id", requestId)
                .body(Map.of(
                    "type", "https://xihe.dev/problems/agent-circuit-open",
                    "title", "Agent service temporarily unavailable",
                    "status", 503,
                    "code", "AGENT_CIRCUIT_OPEN",
                    "detail", "Agent service is temporarily unavailable, retry after 30 seconds",
                    "requestId", requestId
                ));
        }

        // LLM readiness is separate from HTTP liveness. Do not let an
        // unknown/non-ready Agent enter the async or transport queue path.
        HealthMonitor.ServiceHealth agentHealth = healthMonitor.getAgentHealth();
        boolean transportOnlyFailure = "down".equals(agentHealth.status())
                && "ready".equals(agentHealth.llmReady());
        if (!transportOnlyFailure && !healthMonitor.isAgentLlmReady()) {
            return llmNotReadyResponse(requestId, runId, healthMonitor.getAgentLlmReady(),
                    userId, workspaceId);
        }

        Session session;
        try {
            // D-47-05: the ROW decides. A workspace-less Session uses the row probe (the request may
            // still carry a token/header workspace claim — it must not be adopted); a workspace
            // Session keeps the byte-identical requireCurrent path.
            session = workspacelessSession != null
                    ? workspacelessSession
                    : sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        // From here on, the effective tenant is the ROW's workspace (null for pure chat): lease
        // cap（D-697 []）、Agent payload、wake/mention、run.workspace_id all follow this value.
        workspaceId = session.getWorkspaceId();
        if (session.getDeleteRequestedAt() != null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.CONFLICT, "SESSION_DELETING", "Session deletion is in progress");
        }
        if (session.getProviderConnectionId() != null) {
            // A bound Session is authoritative. Do not allow the browser's display
            // hints to switch the credential or model used by this run.
            provider = session.getModelProvider();
            model = session.getModelName();
        }

        List<String> attachmentIds = extractAttachmentIds(request);
        List<AttachmentInfo> attachmentInfos;
        try {
            attachmentInfos = attachmentIds.isEmpty()
                    ? List.of()
                    : chatAttachmentService.resolveForChatSubmission(
                            attachmentIds, sessionId, workspaceId, userId, session.getUserId());
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }

        String attachmentsJson = null;
        if (!attachmentInfos.isEmpty()) {
            try {
                List<Map<String, Object>> refs = new ArrayList<>();
                for (AttachmentInfo info : attachmentInfos) {
                    Map<String, Object> ref = new java.util.LinkedHashMap<>();
                    ref.put("fileId", info.getId());
                    ref.put("name", info.getName());
                    ref.put("type", info.getType());
                    ref.put("size", info.getSize());
                    refs.add(ref);
                }
                attachmentsJson = objectMapper.writeValueAsString(refs);
            } catch (Exception e) {
                logger.error("Failed to serialize attachments session={}", sessionId, e);
                return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "SERIALIZATION_FAILED", "Attachment serialization failed");
            }
        }

        // 0689 B3: wire field deleted ⇒ the run principal is never part of the identity; the key
        // can no longer appear in the canonical form, so this hash family is "identity v3".
        String requestHash = requestHash(content, provider, model, toolMode, attachmentIds,
                perCallTimeouts.values(), null, branchId,
                ChatToTargets.canonical(toParticipantIds), asParticipantId);
        try {
            var replay = chatSubmissionService.findSubmissionReplay(
                    userId, sessionId, idempotencyKey, requestHash);
            if (replay.isPresent()) {
                return ResponseEntity.accepted().body(runResponse(replay.orElseThrow()));
            }
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }

        // PLAN-0622 D28 (verify V7 / D14): borrow this run's governor slots on the **request
        // thread**, before anything is persisted, so an over-limit POST /chat answers
        // 429 RESOURCE_EXHAUSTED (Retry-After + resourceKind + scope) instead of 202 followed by
        // an asynchronous RESOURCE_EXHAUSTED run failure (R2: a refusal leaves no row behind).
        ProviderCredentialLeaseService.Admission admission = credentialLeases.admit(
                session.getProviderConnectionId(), provider, model, null);
        if (!admission.isEmpty()) {
            governor.bindToRun(runId, admission.leases());
        }

        if (!acquireRun(sessionId, runId)) {
            // PLAN-0645: only a duplicate dispatch of the same run id reaches this branch; the
            // Session's run-count limit is enforced inside admission (Session row lock) and answers
            // 409 CHAT_IN_PROGRESS from ChatSubmissionService. Borrowed slots must not survive.
            governor.releaseRun(runId);
            logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} runId={} errorCode=CHAT_IN_PROGRESS",
                    requestId, sessionId, runId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS", "A chat run is already active for this session");
        }

        // PLAN-0648 D1 + decision v15 (2026-11-04): an explicit `as` only counts as a targeted answer
        // when it points at a NON-PRIMARY participant. The UI sends `asParticipantId = PRIMARY` on
        // every ordinary submission, so treating that as "explicit" would silently disable `@` for
        // the default form — which is exactly the case the suppression exists for.
        boolean explicitAsParticipant = asParticipantId != null && !asParticipantId.isBlank()
                && !asParticipantId.equalsIgnoreCase(primaryParticipantId(userId, workspaceId, sessionId));
        boolean handedOff = false;
        try {
            ChatSubmissionService.Submission submission = chatSubmissionService.create(
                    // 0689 B3/A4b: no caller can name a run principal — the parameter is gone.
                    runId, sessionId, userId, workspaceId, branchId, idempotencyKey, requestHash,
                    provider, model, toolMode, session.getProviderConnectionId(), session.getConnectionRevision(),
                    instanceId(), requestId, content, attachmentsJson, attachmentIds, asParticipantId,
                    ChatDeliveryPayload.toJson(objectMapper, toParticipantIds, asParticipantId, ccParticipantIds));
            ChatRun chatRun = submission.run();
            if (!admission.isEmpty() && !admission.covers(chatRun.getProviderConnectionId(),
                    chatRun.getProvider(), chatRun.getModel())) {
                // The Session was re-bound between admission and persist, so the borrowed slots
                // belong to a different connection/provider/model key: drop them and let the
                // worker's issue() acquire for the key the run actually carries.
                logger.warn("[LIFECYCLE] service=cp event=chat_admission_key_changed requestId={} sessionId={} runId={}"
                                + " addressKey={}/{}/{} runKey={}/{}/{} action=release_admission_and_reacquire",
                        requestId, sessionId, runId,
                        admission.connectionId(), admission.providerId(), admission.model(),
                        chatRun.getProviderConnectionId(), chatRun.getProvider(), chatRun.getModel());
                governor.releaseRun(runId);
                admission = ProviderCredentialLeaseService.Admission.none();
            }
            Message userMessage = submission.userMessage();

            if (!attachmentIds.isEmpty()) {
                logger.debug("[LIFECYCLE] service=cp event=chat_attachments_linked runId={} count={}",
                        runId, attachmentIds.size());
            }

            logger.info("[LIFECYCLE] service=cp event=chat_message_persisted requestId={} sessionId={} runId={} messageId={} attachments={}",
                    requestId, sessionId, runId, userMessage.getId(), attachmentIds.size());

            // Agent down with a previously ready LLM -> queue transport recovery.
            if (transportOnlyFailure) {
                chatSubmissionService.persistRunStatus(chatRun, "queued");
                boolean queued = requestQueue.enqueue(
                        sessionId, content, provider, model, toolMode, attachmentInfos,
                        userId, workspaceId, requestId, runId, perCallTimeouts.values());
                if (queued) {
                    // The run is parked for transport recovery: no run is executing, so the
                    // admission slots must not stay borrowed (the queued dispatch acquires its own).
                    governor.releaseRun(runId);
                    // The slots are gone, so the worker must not treat itself as already admitted —
                    // otherwise a flag would suppress the acquire and the ceiling would be bypassed.
                    admission = ProviderCredentialLeaseService.Admission.none();
                    logger.info("[LIFECYCLE] service=cp event=chat_run_queued requestId={} sessionId={} runId={} reason=agent_down",
                            requestId, sessionId, runId);
                    handedOff = true;
                    return ResponseEntity.accepted().body(runAcceptedBody(chatRun, "queued", sessionId,
                        userMessage.getId(), runId, "agent_down"));
                }
                chatSubmissionService.persistRunStatus(chatRun, "accepted");
            }

            // PLAN-0648 D1 (interim ruling): an explicit @ of another participant outranks the
            // PRIMARY's default answer. The Run still exists as the mention-wake anchor and the
            // user Message stays in the conversation, but the PRIMARY must not answer: the Run is
            // terminalized with an explicit outcome instead of being dispatched, so "who replied"
            // stays observable (a silent non-dispatch would look like a stuck Run).
            List<MentionParser.RosterEntry> roster = workspaceId == null
                    ? List.of()
                    : mentionRoster(userId, workspaceId, sessionId);
            MentionParser.ParseResult mentions = MentionParser.parse(content, roster);
            // PLAN-0665 M1: an explicit TO selection outranks the mention suppression — the caller
            // named exactly who should answer, so the first target always owns this run.
            boolean suppressPrimary = toParticipantIds.isEmpty()
                    && MentionParser.suppressesPrimary(mentions,
                            responder == null ? null : responder.participantId(), explicitAsParticipant);
            if (suppressPrimary) {
                List<String> mentionedNames = mentions.mentions().stream().map(MentionParser.Mention::displayName)
                        .toList();
                // PLAN-0648 task-33: "suppress" means "I do not answer", never "nobody answers". The
                // suppression is therefore only legal once the hand-off to the @-target is actually
                // enqueued; a round that finds no recipient falls back to answering here instead of
                // leaving the message unanswered (that silent loss is what session e1d08857 hit).
                WakeFanOutService.WakeHandoff handoff = wakeFanOutService.fanOut(
                        UUID.fromString(sessionId), workspaceId, userId, runId,
                        content, roster, ccParticipantIds);
                if (!handoff.enqueued()) {
                    logger.error("[LIFECYCLE] service=cp event=wake_handoff_lost requestId={} sessionId={} "
                                    + "runId={} mentioned={} skipReason={} fallback=primary_dispatch",
                            requestId, sessionId, runId, mentionedNames, handoff.skipReason());
                } else {
                    chatRunLifecycleService.transition(runId, List.of("accepted"), "succeeded",
                            SUPPRESSED_NO_RESPONDER, null, null, 0, 0, null);
                    logger.info("[LIFECYCLE] service=cp event=chat_primary_suppressed requestId={} sessionId={} "
                                    + "runId={} mentioned={} handoffRound={} handoffRecipients={} "
                                    + "cause=explicit_mention_of_other",
                            requestId, sessionId, runId, mentionedNames, handoff.roundId(),
                            handoff.recipients());
                    handedOff = true;
                    Map<String, Object> suppressedBody = runAcceptedBody(chatRun, "succeeded", sessionId,
                            userMessage.getId(), runId, "primary_suppressed");
                    // Same token in all three places: the wire body, the durable run row
                    // (terminal_outcome, written by the transition above) and the log line.
                    suppressedBody.put("terminalOutcome", SUPPRESSED_NO_RESPONDER);
                    return ResponseEntity.accepted().body(suppressedBody);
                }
            }

            final ProviderCredentialLeaseService.Admission dispatchAdmission =
                    admission == null ? ProviderCredentialLeaseService.Admission.none() : admission;
            execAsync(sessionId, content, provider, model, toolMode, perCallTimeouts.values(),
                    attachmentInfos, userId, workspaceId, requestId, runId, dispatchAdmission, null, responder);
            // PLAN-0624 M4 (D24-10): mention fan-out rides the accepted submission — the
            // recipients answer serially on the session executor, never on this thread.
            // PLAN-0630 M5b (D30-14): the composer's cc observer list rides the same round —
            // observers get a notify signal only, never a run of their own.
            // PLAN-0665 M1: TO targets own their run — the mention/cc round skips them so one
            // message can never create two runs for the same participant.
            Set<UUID> toTargetIds = toParticipantIds.isEmpty() ? Set.of() : new HashSet<>(toParticipantIds);
            if (workspaceId != null) {
                // Pure-chat Sessions have no roster/cc/TO surface; fan-out requires a workspace tenant.
                wakeFanOutService.fanOut(UUID.fromString(sessionId), workspaceId, userId, runId,
                        content, roster, ccParticipantIds, toTargetIds);
            }
            handedOff = true;
            Map<String, Object> acceptedBody = runAcceptedBody(chatRun, "accepted", sessionId,
                    userMessage.getId(), runId, null);
            if (!toParticipantIds.isEmpty()) {
                // PLAN-0665 Q1: runId = runIds[0] (this Run = the first target); the remaining
                // targets are dispatched through the SINGLE TargetedWake entry and answered as
                // sibling runs. Explicit TO (not @) drives the wake, so `triggerSource="to"`.
                List<String> runIds = new ArrayList<>();
                runIds.add(runId);
                List<Map<String, String>> failedTargets = new ArrayList<>();
                List<Map<String, String>> deferredTargets = new ArrayList<>();
                if (toParticipantIds.size() > 1) {
                    WakeFanOutService.TargetedWake targeted = wakeFanOutService.targetedFanOut(
                            UUID.fromString(sessionId), workspaceId, userId, runId, content,
                            toParticipantIds.subList(1, toParticipantIds.size()));
                    targeted.runIds().forEach(id -> runIds.add(id.toString()));
                    targeted.failedTargets().forEach(failure -> failedTargets.add(Map.of(
                            "participantId", failure.participantId(), "reason", failure.reason())));
                    targeted.deferredTargets().forEach(deferred -> deferredTargets.add(Map.of(
                            "participantId", deferred.participantId(), "reason", deferred.reason())));
                }
                acceptedBody.put("runIds", runIds);
                // BL-283 (Lead ruling 2026-11-05): three explicit buckets, one invariant —
                // runIds + failedTargets + deferredTargets = requested targets. Deferred = queued
                // (a follow-up item waits for a slot); failed = a real dispatch error. Neither is
                // ever silent.
                if (!deferredTargets.isEmpty()) {
                    acceptedBody.put("deferredTargets", deferredTargets);
                    logger.info("[LIFECYCLE] service=cp event=to_fanout_deferred sessionId={} runId={} "
                                    + "targets={} dispatched={} deferred={} failed={}", sessionId, runId,
                            toParticipantIds.size(), runIds.size(), deferredTargets.size(),
                            failedTargets.size());
                }
                if (!failedTargets.isEmpty()) {
                    acceptedBody.put("failedTargets", failedTargets);
                    logger.error("[LIFECYCLE] service=cp event=to_fanout_partial sessionId={} runId={} "
                                    + "targets={} dispatched={} deferred={} failed={}", sessionId, runId,
                            toParticipantIds.size(), runIds.size(), deferredTargets.size(),
                            failedTargets.size());
                }
                if (runIds.size() + failedTargets.size() + deferredTargets.size()
                        != toParticipantIds.size()) {
                    logger.error("[LIFECYCLE] service=cp event=to_fanout_accounting_mismatch sessionId={} "
                                    + "runId={} targets={} dispatched={} deferred={} failed={}", sessionId,
                            runId, toParticipantIds.size(), runIds.size(), deferredTargets.size(),
                            failedTargets.size());
                }
            }
            return ResponseEntity.accepted().body(acceptedBody);
        } finally {
            if (!handedOff) {
                // D28: a run that never reached dispatch must not keep the admission slots.
                governor.releaseRun(runId);
                releaseRun(sessionId, runId, "chat_handoff_failed");
            }
        }
    }

    /**
     * Decision v15: the PRIMARY participant row id, or {@code null} when the Session has no PRIMARY.
     * Used only to tell "the UI defaulted the field" apart from "the owner is answering as a member".
     */
    private String primaryParticipantId(String userId, String workspaceId, String sessionId) {
        try {
            SessionParticipantService.Responder primary =
                    sessionParticipantService.responderFor(UUID.fromString(sessionId), null);
            return primary == null ? null : primary.participantId().toString();
        } catch (RuntimeException noPrimary) {
            return null;
        }
    }
    /** PLAN-0624 M4: the current roster as parser entries (the list is already order_index-ordered). */
    private List<MentionParser.RosterEntry> mentionRoster(String userId, String workspaceId,
                                                          String sessionId) {
        try {
            return sessionParticipantService.list(userId, workspaceId, sessionId).participants().stream()
                    .map(view -> new MentionParser.RosterEntry(
                            view.participantId(), view.principalKind(), view.displayName(),
                            view.role(), view.respondPolicy(), view.disabledAt()))
                    .toList();
        } catch (RuntimeException noRoster) {
            // BL-273: a roster failure must be VISIBLE — silently returning an empty roster degrades a
            // DB/permission fault into "@mention suppression quietly stopped working" with no alert.
            // The dispatch still proceeds (chat must not die because the roster is unreadable), but the
            // warn line is greppable: event=mention_roster_unavailable.
            logger.warn("[LIFECYCLE] service=cp event=mention_roster_unavailable sessionId={} "
                            + "requestId={} reason={}", sessionId, requestIdOrNull(),
                    noRoster.getClass().getSimpleName());
            return List.of();
        }
    }

    /** The current request's correlation id, or {@code null} outside a request scope. */
    private static String requestIdOrNull() {
        return org.slf4j.MDC.get(com.cc01cc.p.xihe.cp.logging.RequestIdFilter.MDC_KEY);
    }

    /**
     * PLAN-0635 M2 (D35-03): hand `@文件/目录` targets to the Agent as an **additive optional** field.
     *
     * <p><b>Participant-first</b>: a token the roster already resolves is never treated as a path,
     * so M1 mention semantics are unchanged when a display name happens to look like a path. The
     * roster match itself is delegated to {@link MentionParser} — there is no second matching rule
     * in this class.</p>
     *
     * <p>Token counting is deliberately NOT done here: the Agent owns the run-scoped
     * {@code InjectionLedger} (same split as PLAN-0627 nested and PLAN-0629 memory).</p>
     */
    private void attachPathMentions(Map<String, Object> agentRequest, String sessionId,
                                    String userId, String workspaceId, String content) {
        if (content == null || !content.contains("@")) {
            return;
        }
        List<MentionParser.RosterEntry> roster = mentionRoster(userId, workspaceId, sessionId);
        com.cc01cc.p.xihe.cp.context.service.MentionPathResolver.Resolution resolution =
                mentionPathResolver.resolve(sessionId, userId, workspaceId, content,
                        token -> !MentionParser.parse("@" + token, roster).mentions().isEmpty());
        // Defensive: unit tests build this controller with a bare mock (resolve → null).
        if (resolution == null || resolution.entries().isEmpty()) {
            return;
        }
        List<Map<String, Object>> payload = new ArrayList<>();
        for (com.cc01cc.p.xihe.cp.context.service.MentionPathResolver.Entry entry
                : resolution.entries()) {
            Map<String, Object> item = new java.util.LinkedHashMap<>();
            item.put("path", entry.path());
            item.put("kind", entry.kind());
            item.put("content", entry.content());
            item.put("truncated", entry.truncated());
            payload.add(item);
        }
        agentRequest.put("pathMentions", payload);
    }

    // ── PLAN-292 M3 (C2): run status recovery ──────────────────────────────

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/chat/runs/{runId}")
    public ResponseEntity<Map<String, Object>> getRunStatus(@PathVariable String runId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        UUID runUuid;
        try {
            runUuid = UUID.fromString(runId);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        try {
            return ResponseEntity.ok(chatRunReadService.getStatus(runUuid, runId, userId, workspaceId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    // ── PLAN-0508 T2.2: per-run transport attempt read surface ─────────────

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/chat/runs/{runId}/attempts")
    public ResponseEntity<Map<String, Object>> getRunAttempts(@PathVariable String runId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        UUID runUuid;
        try {
            runUuid = UUID.fromString(runId);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        try {
            return ResponseEntity.ok(chatRunReadService.getRunAttempts(runUuid, runId, userId, workspaceId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    // ── PLAN-0464 T2.1: session-scoped run list (waiting/status read surface) ──

    /**
     * Runs of one Session with their status and spawn waiting link. This is the
     * recovery source ChatPanel uses after a refresh: the child run row itself
     * carries {@code waitingOnRunId}/{@code waitingToolCallId}, so no Operation
     * read is involved.
     */
    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/chat/sessions/{sessionId}/runs")
    public ResponseEntity<Map<String, Object>> listSessionRuns(
            @PathVariable String sessionId,
            @RequestParam(name = "page", defaultValue = "0") int page,
            @RequestParam(name = "size", defaultValue = "100") int size) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        // BL-299: the run list is read-only metadata (runId/status/origin/terminal outcome/error
        // code/timestamps/waiting links). The messages read surface already exposes the same run
        // fields to an invited participant; there is no owner-only content here.
        Session session = sessionService.requireReadable(sessionId, userId, workspaceId);
        int safePage = Math.max(page, 0);
        int safeSize = Math.min(Math.max(size, 1), 200);
        return ResponseEntity.ok(chatRunReadService.listSessionRuns(
                session.getId().toString(), safePage, safeSize));
    }

    // ── PLAN-0507: session monitor aggregate (read-only) ───────────────────

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/chat/sessions/{sessionId}/monitor")
    public ResponseEntity<Map<String, Object>> getSessionMonitor(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        try {
            Session session = sessionService.requireCurrent(sessionId, userId, workspaceId);
            return ResponseEntity.ok(sessionMonitorService.getMonitor(session, userId, workspaceId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    // ── PLAN-275 M1 Task 1.3: Cancel contract ──────────────────────────────

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/api/v1/chat/runs/{runId}/cancel")
    public ResponseEntity<Map<String, Object>> cancelRun(
            @PathVariable String runId,
            @RequestBody(required = false) Map<String, Object> request) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }

        String reason = request != null ? (String) request.getOrDefault("reason", "user_requested") : "user_requested";
        // PLAN-0407 T2.5：序列化认领（条件更新，与 spawn 的 parent Run 行锁同一行）
        // → 认领获胜者收口根 run → 沿 kind=spawn 停止传播 + 有界等待。
        ChatRunCancellationService.CancelClaim claim;
        try {
            claim = chatRunCancellationService.cancelForCurrentOwner(runId, userId, workspaceId, reason);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        return switch (claim.outcome()) {
            case CLAIMED, ALREADY_CANCELLING ->
                    ResponseEntity.ok(Map.of("status", "cancel_accepted", "runId", runId));
            case NOT_CANCELLABLE ->
                    ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "RUN_NOT_CANCELLABLE",
                            "Run is in terminal state: " + claim.status());
            case NOT_FOUND ->
                    ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        };
    }

    @GetMapping("/api/v1/health")
    public Map<String, Object> health() {
        return Map.of(
            "status", "UP",
            "service", "xihe-control-plane",
            "timestamp", System.currentTimeMillis()
        );
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    void onSpawnRunDispatchRequested(SpawnRunDispatchRequestedEvent event) {
        // PLAN-0630 M5b / D2: same refusal contract as the scheduled handoff — a committed
        // accepted Run has exactly one owner (this listener), so it must not drop it silently.
        DispatchOutcome outcome;
        try {
            outcome = dispatchSpawnRunDetailed(event.childRunId());
        } catch (RuntimeException e) {
            outcome = DispatchOutcome.refused("handoff_failed:" + e.getClass().getSimpleName());
        }
        logger.info("[LIFECYCLE] service=cp event=spawn_dispatch_result parentRunId={} childRunId={} dispatched={} reason={}",
                event.parentRunId(), event.childRunId(), outcome.dispatched(), outcome.reason());
        if (!outcome.dispatched()) {
            terminalizeRefusedDispatch(event.childRunId(), event.childRunId(), "SPAWN_DISPATCH_REFUSED",
                    outcome.reason());
        }
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    void onContinuationRunDispatchRequested(ContinuationRunDispatchRequestedEvent event) {
        try {
            boolean dispatched = dispatchContinuationRun(event);
            logger.info("[LIFECYCLE] service=cp event=continuation_dispatch_result sourceRunId={} runId={} dispatched={}",
                    event.sourceRunId(), event.continuationRunId(), dispatched);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=continuation_dispatch_failed sourceRunId={} runId={} failureType={}",
                    event.sourceRunId(), event.continuationRunId(), e.getClass().getSimpleName(), e);
        }
    }

    /** Dispatches a committed continuation through the same worker and lease path as other Chat Runs. */
    boolean dispatchContinuationRun(ContinuationRunDispatchRequestedEvent event) {
        ChatRunReadService.ContinuationDispatchRun run = chatRunReadService
                .findContinuationDispatchRun(event.continuationRunId()).orElse(null);
        if (run == null || !ChatRun.ORIGIN_USER_SUBMISSION.equals(run.origin())
                || !"accepted".equals(run.status()) || run.continuation() == null
                || !event.sourceRunId().equals(run.continuation().sourceRunId())) {
            return false;
        }
        boolean appendsMessage = ChatRunContinuationRequest.APPEND_USER_TURN.equals(run.continuation().mode());
        boolean resumesPending = ChatRunContinuationRequest.RESUME_PENDING.equals(run.continuation().mode());
        if ((!appendsMessage && !resumesPending) || appendsMessage != (run.userMessageId() != null)) {
            throw new IllegalStateException("Continuation Run mode and user Message provenance do not match");
        }

        Session session;
        try {
            session = sessionService.requireCurrent(run.sessionId(), run.userId(), run.workspaceId());
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            throw new IllegalStateException("Committed continuation Session is no longer dispatchable", e);
        }
        MessageReadService.DispatchMessage userMessage = appendsMessage
                ? messageReadService.findDispatchMessage(run.userMessageId()).orElse(null) : null;
        if (session == null || !run.userId().equals(session.getUserId())
                || !run.workspaceId().equals(session.getWorkspaceId())
                || appendsMessage && (userMessage == null
                    || !run.id().equals(userMessage.runId())
                    || !run.sessionId().equals(userMessage.sessionId()))) {
            throw new IllegalStateException("Committed continuation Run is missing its Session or user Message");
        }

        String sessionId = run.sessionId();
        if (!activeRunRegistry.claim(sessionId, run.id())) {
            return false;
        }
        if (!acquireLeaseForExistingRun(run.id())) {
            activeRunRegistry.release(sessionId, run.id());
            return false;
        }
        try {
            ContinuationDispatchContext continuation = new ContinuationDispatchContext(
                    run.continuation(), event.completedToolCallIds());
            execAsync(sessionId, userMessage == null ? "" : userMessage.content(),
                    run.provider(), run.model(), run.toolMode(), Map.of(), List.of(),
                    run.userId(), run.workspaceId(), run.id(), run.id(), continuation, null);
            return true;
        } catch (RuntimeException e) {
            releaseRun(sessionId, run.id(), "continuation_dispatch_handoff_failed");
            throw e;
        }
    }

    /** Dispatches a committed spawn Run through the same local worker and lease path as user Runs. */
    public boolean dispatchSpawnRun(String runId) {
        return dispatchSpawnRunDetailed(runId).dispatched();
    }

    DispatchOutcome dispatchSpawnRunDetailed(String runId) {
        ChatRunReadService.DispatchRun run = chatRunReadService.findDispatchRun(runId).orElse(null);
        if (run == null) {
            return DispatchOutcome.refused("run_missing");
        }
        if (!ChatRun.ORIGIN_SPAWN.equals(run.origin())) {
            return DispatchOutcome.refused("origin_not_spawn:" + run.origin());
        }
        if (!"accepted".equals(run.status())) {
            return DispatchOutcome.refused("status_not_dispatchable:" + run.status());
        }
        Session session;
        try {
            session = sessionService.requireCurrent(run.sessionId(), run.userId(), run.workspaceId());
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            return DispatchOutcome.refused("session_not_dispatchable:" + e.getCode());
        }
        MessageReadService.DispatchMessage userMessage = run.userMessageId() == null
                ? null : messageReadService.findDispatchMessage(run.userMessageId()).orElse(null);
        if (session == null) {
            return DispatchOutcome.refused("session_missing");
        }
        if (userMessage == null || !run.id().equals(userMessage.runId())
                || !run.sessionId().equals(userMessage.sessionId())
                || !run.userId().equals(session.getUserId())
                || !run.workspaceId().equals(session.getWorkspaceId())) {
            return DispatchOutcome.refused("user_message_mismatch");
        }
        if (!Session.KIND_SPAWN.equals(session.getKind())) {
            return DispatchOutcome.refused("child_session_kind:" + session.getKind());
        }

        String sessionId = run.sessionId();
        if (!activeRunRegistry.claim(sessionId, runId)) {
            return DispatchOutcome.refused("already_claimed");
        }
        if (!acquireLeaseForExistingRun(runId)) {
            activeRunRegistry.release(sessionId, runId);
            return DispatchOutcome.refused("lease_not_acquired");
        }
        try {
            execAsync(sessionId, userMessage.content(), run.provider(), run.model(), run.toolMode(),
                    Map.of(), List.of(), run.userId(), run.workspaceId(), runId, runId, null);
            return DispatchOutcome.ok();
        } catch (RuntimeException e) {
            releaseRun(sessionId, runId, "spawn_dispatch_handoff_failed");
            return DispatchOutcome.refused("handoff_failed:" + e.getClass().getSimpleName());
        }
    }

    /**
     * PLAN-0630 M5b / D2: an event-driven handoff that returns {@code false} used to leave the Run
     * in {@code accepted} for ever — nothing retried it (only the startup recovery sweep did). The
     * outcome now carries the refusing branch, so the listener can log it, audit it on the Run row
     * and terminalize instead of orphaning the Run.
     */
    record DispatchOutcome(boolean dispatched, String reason) {
        static DispatchOutcome ok() { return new DispatchOutcome(true, "dispatched"); }

        static DispatchOutcome refused(String reason) { return new DispatchOutcome(false, reason); }
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    void onScheduledRunDispatchRequested(ScheduledRunDispatchRequestedEvent event) {
        DispatchOutcome outcome;
        try {
            outcome = dispatchScheduledRunDetailed(event.runId());
        } catch (RuntimeException e) {
            outcome = DispatchOutcome.refused("handoff_failed:" + e.getClass().getSimpleName());
        }
        logger.info("[LIFECYCLE] service=cp event=scheduled_dispatch_result sessionId={} runId={} dispatched={} reason={}",
                event.sessionId(), event.runId(), outcome.dispatched(), outcome.reason());
        if (!outcome.dispatched()) {
            terminalizeRefusedDispatch(event.sessionId(), event.runId(), "SCHEDULED_DISPATCH_REFUSED", outcome.reason());
        }
    }

    /**
     * PLAN-0630 M5b / D2: a Run that could not be handed to a worker must not stay {@code accepted}
     * — that state looks like "queued work" to every reader (UI, recovery sweep, ②-a verification)
     * while nothing owns it. The refusing branch rides {@code error_code}/{@code error_detail}, so the
     * reason survives the request that produced it.
     */
    private void terminalizeRefusedDispatch(String sessionId, String runId, String errorCode, String reason) {
        boolean failed = chatRunLifecycleService.transition(runId, List.of("accepted"), "failed",
                "dispatch_refused", errorCode, reason, 0, 0, null);
        logger.warn("[LIFECYCLE] service=cp event=chat_run_dispatch_refused_terminal runId={} errorCode={} reason={} terminalized={}",
                runId, errorCode, reason, failed);
        chatRunLifecycleService.releaseLease(UUID.fromString(runId), instanceId());
        String registrySessionId = sessionId;
        if (registrySessionId == null) {
            registrySessionId = chatRunReadService.findDispatchRun(runId)
                    .map(ChatRunReadService.DispatchRun::sessionId).orElse(null);
        }
        if (registrySessionId != null) {
            activeRunRegistry.release(registrySessionId, runId);
        }
    }

    /**
     * PLAN-0489 决策 #7: dispatches a committed scheduled wakeup Run through the
     * same local worker and lease path as spawn Runs. Unlike the spawn handoff
     * the target is a normal Session (kind is not checked — only the origin,
     * accepted status and Run/Session/user-Message consistency gate dispatch).
     */
    public boolean dispatchScheduledRun(String runId) {
        return dispatchScheduledRunDetailed(runId).dispatched();
    }

    DispatchOutcome dispatchScheduledRunDetailed(String runId) {
        ChatRunReadService.DispatchRun run = chatRunReadService.findDispatchRun(runId).orElse(null);
        if (run == null) {
            return DispatchOutcome.refused("run_missing");
        }
        if (!ChatRun.ORIGIN_SCHEDULED.equals(run.origin())) {
            return DispatchOutcome.refused("origin_not_scheduled:" + run.origin());
        }
        if (!"accepted".equals(run.status())) {
            return DispatchOutcome.refused("status_not_dispatchable:" + run.status());
        }
        Session session;
        try {
            session = sessionService.requireCurrent(run.sessionId(), run.userId(), run.workspaceId());
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            return DispatchOutcome.refused("session_not_dispatchable:" + e.getCode());
        }
        MessageReadService.DispatchMessage userMessage = run.userMessageId() == null
                ? null : messageReadService.findDispatchMessage(run.userMessageId()).orElse(null);
        if (session == null) {
            return DispatchOutcome.refused("session_missing");
        }
        if (userMessage == null || !run.id().equals(userMessage.runId())
                || !run.sessionId().equals(userMessage.sessionId())
                || !run.userId().equals(session.getUserId())
                || !run.workspaceId().equals(session.getWorkspaceId())) {
            return DispatchOutcome.refused("user_message_mismatch");
        }

        String sessionId = run.sessionId();
        if (!activeRunRegistry.claim(sessionId, runId)) {
            return DispatchOutcome.refused("already_claimed");
        }
        if (!acquireLeaseForExistingRun(runId)) {
            activeRunRegistry.release(sessionId, runId);
            return DispatchOutcome.refused("lease_not_acquired");
        }
        try {
            execAsync(sessionId, userMessage.content(), run.provider(), run.model(), run.toolMode(),
                    Map.of(), List.of(), run.userId(), run.workspaceId(), runId, runId, null);
            return DispatchOutcome.ok();
        } catch (RuntimeException e) {
            releaseRun(sessionId, runId, "scheduled_dispatch_handoff_failed");
            return DispatchOutcome.refused("handoff_failed:" + e.getClass().getSimpleName());
        }
    }

    /**
     * PLAN-0623 M1b-②: the lease cap for this run. A request-thread dispatch passes its already
     * resolved Responder; a derived dispatch (spawn/follow-up/scheduled/continuation/redelivery)
     * resolves the PRIMARY participant once in {@link #execAsync} and passes that same Responder
     * here. Both call sites use the same {@code resolveParticipantCap} arguments — no branch and no
     * cached cap.
     *
     * <p>PLAN-0689 A7 (D-54, D-55; Lead 2026-11-07 option A): the cap stays <em>live</em> as frozen
     * by design.md:118 / the 2026-11-02 ruling. D-54's {@code sessions.agent_permissions_snapshot}
     * is an authorization-intersection input only and must not be used as a lease cap. Once A7 drops
     * the identity column, the old Session fallback can only yield {@code null}, and a null cap is an
     * <em>uncapped</em> lease — strictly weaker than refusing to issue one. A run with no resolved
     * Responder (or a Responder without a principal) has no identity to bound the lease against, so
     * it is refused here, the same fail-closed invariant A3b applied to unattributed runs.
     */
    JsonNode leaseCapFor(SessionParticipantService.Responder responder, String workspaceId) {
        if (responder == null || responder.principalId() == null) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "AGENT_PRINCIPAL_MISSING",
                    "Chat run has no Agent principal to bound the credential lease");
        }
        if (workspaceId == null) {
            // PLAN-0647 D-697: pure-chat has no tool face, so the credential lease cap is an
            // explicit EMPTY array (zero capability) — never null, which the lease contract reads as
            // "uncapped". This is a DIFFERENT object from the authorization snapshot: the snapshot
            // stays null (D-686, "not applicable"), the lease cap is [] (D-697, "zero grants").
            return objectMapper.createArrayNode();
        }
        return participantCapabilityService.resolveParticipantCap(responder, UUID.fromString(workspaceId));
    }

    private void execAsync(String sessionId, String content, String provider, String model, String toolMode,
                           Map<String, Integer> toolTimeouts,
                           List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments,
                           String userId, String workspaceId, String requestId, String runId,
                           SessionParticipantService.Responder responder) {
        execAsync(sessionId, content, provider, model, toolMode, toolTimeouts, attachments,
                userId, workspaceId, requestId, runId, null, responder);
    }

    private void execAsync(String sessionId, String content, String provider, String model, String toolMode,
                           Map<String, Integer> toolTimeouts,
                           List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments,
                           String userId, String workspaceId, String requestId, String runId,
                           ContinuationDispatchContext continuationContext,
                           SessionParticipantService.Responder responder) {
        execAsync(sessionId, content, provider, model, toolMode, toolTimeouts, attachments,
                userId, workspaceId, requestId, runId, null, continuationContext, responder);
    }

    private void execAsync(String sessionId, String content, String provider, String model, String toolMode,
                           Map<String, Integer> toolTimeouts,
                           List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments,
                           String userId, String workspaceId, String requestId, String runId,
                           ProviderCredentialLeaseService.Admission admission,
                           ContinuationDispatchContext continuationContext,
                           SessionParticipantService.Responder responder) {
        // PLAN-0689 A7 (D-55): derived dispatch paths (spawn / follow-up / scheduled / continuation)
        // carry no request-thread Responder. A7 made the lease cap fail closed on a null Responder
        // instead of falling back to the dropped Session column, so resolve the durable run's PRIMARY
        // here — once — and thread that same object through attribution, lease identity and cap.
        final SessionParticipantService.Responder effectiveResponder = responder != null
                ? responder
                : sessionParticipantService.responderFor(UUID.fromString(sessionId), null);
        if (responder == null && effectiveResponder != null) {
            logger.info("[LIFECYCLE] service=cp event=derived_dispatch_primary_resolved sessionId={} runId={} participantId={}",
                    sessionId, runId, effectiveResponder.participantId());
        }
        Thread worker = new Thread(() -> {
            MDC.put("requestId", requestId);
            MDC.put("chatRunId", runId);
            // M1b-③: attribute this run's SSE output to the Responder's participant row.
            if (effectiveResponder != null && effectiveResponder.participantId() != null) {
                runParticipants.put(runId, effectiveResponder.participantId().toString());
            }
            AtomicBoolean terminalSent = new AtomicBoolean(false);
            // Set inside relayAgentStream when an approval_request has been
            // relayed; read by the IO-interrupt catch below (PLAN-292 C1).
            AtomicBoolean approvalInFlight = new AtomicBoolean(false);
            try {
                // PLAN-294 M3 (decisions #4/#18): pre-run compaction gate — the gate
                // compresses history before the run consumes it. Context service owns the
                // cooldown/anti-thrash rules. PLAN-0645 removed the implicit "one run per
                // Session" serialization this comment used to rely on: two runs of the same
                // Session can both pass the gate, and per-Session compaction mutual exclusion
                // is a PLAN-0645 backlog item, not an invariant.
                try {
                    // PLAN-0410 T2.2: the gate resolves THIS Run's branch path —
                    // sibling Run usage/summary/circuit never drive the decision.
                    if (workspaceId != null && continuationContext == null
                            && contextService.shouldAutoCompact(sessionId, runId)) {
                        // Auto-compaction is a workspace-context feature; pure chat has no workspace projection.
                        contextService.compact(sessionId, workspaceId, userId, null, "auto", runId);
                        logger.info("[LIFECYCLE] service=cp event=chat_pre_run_compaction sessionId={} runId={}", sessionId, runId);
                    }
                } catch (Exception gateError) {
                    // The gate never blocks a run: failed compaction degrades
                    // to no compaction and the overflow fallback (runner)
                    // remains the safety net.
                    logger.warn("[LIFECYCLE] service=cp event=chat_pre_run_compaction_failed sessionId={} runId={} error={}",
                            sessionId, runId, gateError.getMessage());
                }
                ChatRunReadService.ExecutionRun persistedRun = chatRunReadService.findExecutionRun(runId)
                        .orElseThrow(() -> new IllegalStateException("Chat run not found"));
                boolean refreshRootAgentsMd = shouldRefreshRootAgentsMd(persistedRun.context());
                // PLAN-0340/0415: the source policy is fixed by the admission
                // template. per_chat_run refreshes each turn; per_session pins
                // the first successful source snapshot for this Session.
                if (workspaceId != null && continuationContext == null) {
                    // Pure chat has no workspace file/context sources; the whole refresh chain is
                    // workspace-scoped (ContextTemplateSourceService resolves workspace roots).
                    try {
                        String sourceStatus = contextSourceRefreshService.refreshForRun(
                                sessionId, workspaceId, userId, refreshRootAgentsMd);
                        logger.info("[LIFECYCLE] service=cp event=chat_pre_run_source_refresh sessionId={} runId={} status={}",
                                sessionId, runId, sourceStatus);
                        // PLAN-0340 U2: only AGENTS.md chain created/updated (not env, not unchanged/failed).
                        if ("created".equals(sourceStatus) || "updated".equals(sourceStatus)) {
                            sseManager.send(sessionId, "context_sources_changed", Map.of(
                                    "type", "context_sources_changed",
                                    "sourceKey", "AGENTS.md",
                                    "status", sourceStatus));
                        }
                    } catch (Exception sourceError) {
                        logger.warn("[LIFECYCLE] service=cp event=chat_pre_run_source_refresh_failed sessionId={} runId={} error={}",
                                sessionId, runId, sourceError.getMessage());
                        // Env refresh can fail while per_session L1 is deliberately
                        // frozen; only mark L1 unavailable when this Run attempted it.
                        if (refreshRootAgentsMd) {
                            contextSourceRefreshService.markSourceUnavailable(sessionId, workspaceId, userId);
                        }
                    }
                }
                transitionRun(runId, List.of("accepted", "queued"), "running", null, null, null, 0, 0);
                String effectiveProvider = persistedRun.provider() == null ? provider : persistedRun.provider();
                String effectiveModel = persistedRun.model() == null ? model : persistedRun.model();
                ProviderCredentialLeaseService.IssuedLease credentialLease = null;
                if (persistedRun.providerConnectionId() != null) {
                    // PLAN-0689 A7/D-55: the lease identity is the ONE Responder resolved at dispatch
                    // entry (request thread or durable-run handoff) — the same principal that bounds
                    // the cap. A missing Responder is refused by leaseCapFor below; never fall back
                    // to the dropped Session column.
                    String leasePrincipalId = effectiveResponder == null
                            || effectiveResponder.principalId() == null
                            ? null : effectiveResponder.principalId().toString();
                    credentialLease = credentialLeases.issue(
                            userId,
                            workspaceId,
                            sessionId,
                            runId,
                            persistedRun.providerConnectionId(),
                            effectiveProvider,
                            effectiveModel,
                            persistedRun.connectionRevision(),
                            null,
                            leasePrincipalId,
                            // PLAN-0623 M1b-② / PLAN-0689 A7/D-55: single-source cap — the same
                            // Responder that names the lease identity also bounds it.
                            leaseCapFor(effectiveResponder, workspaceId),
                            continuationContext == null ? admission : null);
                }
                Map<String, Object> agentRequest = new java.util.LinkedHashMap<>();
                agentRequest.put("sessionId", sessionId);
                agentRequest.put("content", content);
                agentRequest.put("userId", userId);
                agentRequest.put("workspaceId", workspaceId);
                agentRequest.put("requestId", requestId);
                agentRequest.put("runId", runId);
                // PLAN-0660 T5.16 (LD-16=A): a spawned Run tells the Agent it is a child, so
                // ask_user refuses at the door instead of waiting for a CP relay refusal.
                putParentRunId(agentRequest, persistedRun.parentRunId());
                agentRequest.put("stream", true);
                if (continuationContext != null) {
                    if (!continuationContext.checkpoint().equals(persistedRun.continuation())) {
                        throw new IllegalStateException("Continuation dispatch event does not match ChatRun provenance");
                    }
                    Map<String, Object> continuation = new java.util.LinkedHashMap<>();
                    continuation.put("mode", continuationContext.checkpoint().mode());
                    continuation.put("sourceRunId", continuationContext.checkpoint().sourceRunId());
                    continuation.put("continuationRunId", runId);
                    continuation.put("lineageId", continuationContext.checkpoint().lineageId());
                    continuation.put("threadId", continuationContext.checkpoint().threadId());
                    continuation.put("checkpointId", continuationContext.checkpoint().checkpointId());
                    continuation.put("eventSequence", continuationContext.checkpoint().eventSequence());
                    continuation.put("branchId", continuationContext.checkpoint().branchId());
                    continuation.put("completedToolCallIds", continuationContext.completedToolCallIds());
                    agentRequest.put("continuation", continuation);
                }
                if (effectiveProvider != null && !effectiveProvider.isBlank()) {
                    agentRequest.put("provider", effectiveProvider);
                }
                agentRequest.put("toolMode", toolMode == null || toolMode.isBlank() ? "none" : toolMode);
                if (effectiveModel != null && !effectiveModel.isEmpty()) {
                    agentRequest.put("model", effectiveModel);
                }
                if (credentialLease != null) {
                    agentRequest.put("credentialLease", credentialLease.token());
                    agentRequest.put("providerConnectionId", persistedRun.providerConnectionId());
                    agentRequest.put("connectionRevision", persistedRun.connectionRevision());
                }
                // PLAN-0415 M1: only the admission-frozen template snapshot and,
                // when present, the CP-selected model instructions cross to Agent.
                // The existing AgentChatIntegrationTest security contract keeps
                // principal IDs and permission snapshots strictly CP-local.
                Session boundSession = workspaceId == null
                        ? sessionService.requireOwnedSession(sessionId, userId)
                        : sessionService.requireCurrent(sessionId, userId, workspaceId);
                // PLAN-0689 A4 (T1.4 / design §2): the run's own stamp is the only execution
                // identity. A Session with no binding is legal (dev data / HUMAN-only sessions)
                // and must not fail the dispatch here.
                agentRequest.put("contextTemplateSnapshot", persistedRun.context().contextTemplateSnapshot());
                // PLAN-0605: image references (ids + metadata only). Bytes stay behind the
                // run-bound internal route; the Agent pulls them lazily while rendering.
                List<Map<String, Object>> imageReferences = chatRunReadService
                        .findUserMessageAttachmentsJson(runId)
                        .map(chatAttachmentService::imageReferencesFromAttachmentsJson)
                        .orElseGet(List::of);
                if (!imageReferences.isEmpty()) {
                    agentRequest.put("images", imageReferences);
                }
                addRagCredentials(agentRequest, persistedRun.context().contextTemplateSnapshot(),
                        userId, workspaceId, sessionId, runId);
                Map<String, Object> componentSources =
                        contextTemplateSourceService.resolve(persistedRun.context(), boundSession);
                if (!componentSources.isEmpty()) {
                    agentRequest.put("componentSources", componentSources);
                }
                // PLAN-0689 A4 (T1.4 / design §3-A): instructions for THIS run resolve from the
                // run's own principal stamp, not from the Session column A7 deletes.
                String agentInstructions = agentPrincipalService.resolveSystemInstructionsForRun(
                        persistedRun.context().agentPrincipalId());
                if (agentInstructions != null) {
                    agentRequest.put("instructions", agentInstructions);
                }
                // PLAN-0307 T2.7 (decision #3=#3a): run-scoped layer overrides are
                // resolved per run from this request's workspace/user context and
                // pushed with the payload; Agent merges without side effects.
                Map<String, Map<String, String>> userOverrides = configService.overrides(
                        "user", AGENT_RUN_OVERRIDE_DOMAINS,
                        uuidOrNull(userId), uuidOrNull(workspaceId));
                Map<String, Map<String, String>> workspaceOverrides = workspaceId == null
                        ? Map.of()
                        : configService.overrides("workspace", AGENT_RUN_OVERRIDE_DOMAINS,
                                uuidOrNull(userId), uuidOrNull(workspaceId));
                if (!userOverrides.isEmpty()) {
                    agentRequest.put("userOverrides", userOverrides);
                }
                if (!workspaceOverrides.isEmpty()) {
                    agentRequest.put("workspaceOverrides", workspaceOverrides);
                }
                // PLAN-0308 M1（spec S2.1）：CP 计算好的等待值随 run 下发（Agent 只消费）；
                // per-call 原始值（T1.9）同批下发，供 Agent 随工具调用附带入站头。
                // Pure chat has no MCP tool face; the timeout payload is workspace-scoped (cache key
                // is the workspace id) and is therefore omitted rather than resolved with null.
                if (workspaceId != null) {
                    agentRequest.putAll(mcpToolTimeoutService.toolTimeoutPayload(workspaceId, userId, toolTimeouts));
                }
                if (!attachments.isEmpty()) {
                    List<Map<String, Object>> agentAttachments = new ArrayList<>();
                    for (com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo info : attachments) {
                        Map<String, Object> a = new java.util.LinkedHashMap<>();
                        a.put("fileId", info.getId());
                        a.put("name", info.getName());
                        a.put("type", info.getType());
                        a.put("url", info.getUrl());
                        agentAttachments.add(a);
                    }
                    agentRequest.put("attachments", agentAttachments);
                }
                // PLAN-0635 M2: additive, optional — absent when the message mentions no path.
                if (workspaceId != null) {
                    attachPathMentions(agentRequest, sessionId, userId, workspaceId, content);
                }

                String agentRequestBody = objectMapper.writeValueAsString(agentRequest);

                // PLAN-0666 M1b: fingerprint the outbound context at the first dispatch.
                // Placed after the payload is complete and before any POST — the only point where
                // every layer (componentSources/instructions/overrides/images) exists (design D3).
                // Fail-open: never blocks the run.
                recordContextFingerprint(runId, sessionId, userId, workspaceId, persistedRun, content,
                        componentSources, agentInstructions, userOverrides, workspaceOverrides,
                        agentRequest);

                // PLAN-0341 T1.1 (decision #2/#3): at-most-once overflow retry.
                // On CONTEXT_OVERFLOW: force-compact (bypass cooldown) → preflight →
                // re-dispatch the same runId before any terminal transition.
                boolean overflowRetried = false;
                boolean directApiRequest = persistedRun.context().contextTemplateSnapshot() != null
                        && persistedRun.context().contextTemplateSnapshot().path("template").path("bodySource").isTextual();
                StreamRelayResult relayResult;

                while (true) {
                    HttpRequest.Builder dispatchBuilder = HttpRequest.newBuilder(URI.create(agentUrl))
                        .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                        .header(HttpHeaders.ACCEPT, MediaType.TEXT_EVENT_STREAM_VALUE)
                        .header("Authorization", "Bearer " + agentApiToken)
                        .header("X-Request-Id", requestId)
                        .header("X-Chat-Run-Id", runId)
                        .header("X-User-Id", userId)
                        .header("X-Session-Id", sessionId);
                    if (workspaceId != null) {
                        // PLAN-0647: the header is omitted (not null) for a workspace-less Run.
                        dispatchBuilder.header("X-Workspace-Id", workspaceId);
                    }
                    if (overflowRetried) {
                        dispatchBuilder.header("X-Overflow-Retry", "1");
                    }
                    HttpRequest agentRequestMessage = dispatchBuilder
                        .timeout(Duration.ofSeconds(30))
                        .POST(HttpRequest.BodyPublishers.ofString(agentRequestBody, StandardCharsets.UTF_8))
                        .build();

                    long startMs = System.currentTimeMillis();
                    HttpResponse<InputStream> response = agentHttpClient.send(
                        agentRequestMessage,
                        HttpResponse.BodyHandlers.ofInputStream()
                    );
                    long elapsedMs = System.currentTimeMillis() - startMs;

                    if (response.statusCode() >= 400) {
                        String upstreamBody;
                        try (InputStream errorBody = response.body()) {
                            upstreamBody = new String(errorBody.readAllBytes(), StandardCharsets.UTF_8);
                        }
                        Map<?, ?> upstreamProblem = asMap(parsePayload("error", upstreamBody));
                        String upstreamCode = safeErrorCode(stringValue(upstreamProblem, "code"));
                        if (!directApiRequest && "CONTEXT_OVERFLOW".equals(upstreamCode) && !overflowRetried
                                && tryOverflowRecovery(sessionId, workspaceId, userId, requestId, runId,
                                        effectiveModel, terminalSent)) {
                            overflowRetried = true;
                            continue;
                        }
                        String detail = ChatErrorDetails.safeErrorDetail(upstreamCode);
                        logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode={} upstreamStatus={} durationMs={}",
                                requestId, sessionId, runId, upstreamCode, response.statusCode(), elapsedMs);
                        healthMonitor.getAgentBreaker().recordFailure();
                        sendRunErrorAndDone(sessionId, requestId, runId, upstreamCode, detail, "error", terminalSent);
                        return;
                    }

                    healthMonitor.getAgentBreaker().recordSuccess();
                    logger.info("[LIFECYCLE] service=cp event=chat_run_forwarded requestId={} sessionId={} runId={} status={} durationMs={}",
                            requestId, sessionId, runId, response.statusCode(), elapsedMs);
                    try (InputStream agentStream = response.body()) {
                        relayResult = relayAgentStream(
                                sessionId, agentStream, requestId, runId, userId, workspaceId,
                                approvalInFlight, !directApiRequest && !overflowRetried);
                    }

                    if (!directApiRequest && "CONTEXT_OVERFLOW".equals(relayResult.errorCode()) && !overflowRetried) {
                        terminalSent.set(false);
                        if (tryOverflowRecovery(sessionId, workspaceId, userId, requestId, runId,
                                effectiveModel, terminalSent)) {
                            overflowRetried = true;
                            continue;
                        }
                        logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=CONTEXT_OVERFLOW reason=preflight_failed",
                                requestId, sessionId, runId);
                        sendRunErrorAndDone(sessionId, requestId, runId, "CONTEXT_OVERFLOW",
                                ChatErrorDetails.safeErrorDetail("CONTEXT_OVERFLOW"), "error", terminalSent);
                        return;
                    }
                    break;
                }

                String assistantContent = relayResult.assistantContent();
                logger.info("[LIFECYCLE] service=cp event=chat_run_finished requestId={} sessionId={} runId={} assistantChars={}",
                        requestId, sessionId, runId, assistantContent == null ? 0 : assistantContent.length());

                // PLAN-0572 D5: persist a tool-only terminal turn as well; the
                // service returns null only when there is neither text nor tools.
                String assistantMessageId = chatSubmissionService.persistAssistantResponse(
                        sessionId, runId, assistantContent);
                if (assistantMessageId != null) {
                    logger.info("[LIFECYCLE] service=cp event=chat_assistant_persisted requestId={} sessionId={} runId={} messageId={} assistantChars={}",
                            requestId, sessionId, runId, assistantMessageId,
                            assistantContent == null ? 0 : assistantContent.length());
                }

                String outcome = relayResult.outcome();
                String status = "success".equals(outcome)
                        ? "succeeded"
                        : "partial".equals(outcome) ? "partial" : "ambiguous".equals(outcome) ? "ambiguous" : "failed";
                // PLAN-0492 T2.2: a budget-exhausted run converges to `failed`
                // (via the relay outcome) with the exhausted dimension written as
                // the durable terminal fact (history payload + error detail).
                String exhaustedDimension = "RUN_BUDGET_EXHAUSTED".equals(relayResult.errorCode())
                        ? relayResult.budgetDimension() : null;
                boolean terminalCommitted = transitionRun(
                        runId,
                        List.of("running", "streaming", "awaiting_approval"),
                        status,
                        outcome,
                        relayResult.errorCode(),
                        exhaustedDimension == null ? null : "budgetDimension=" + exhaustedDimension,
                        relayResult.tokenCount(),
                        assistantContent == null ? 0 : assistantContent.length(),
                        relayResult.usageEnvelope(),
                        exhaustedDimension,
                        relayResult.agentContextTruncation());
                // PLAN-0352 V1: the session SSE must observe the terminal error/done
                // BEFORE the connection closes. Two real orders exist around session
                // delete (claim `cancelling` → settleCancellation durable `cancelled`):
                // ① settle already committed → our transition is a no-op but the events
                //    must still be delivered; ② relay ends first while the run sits in
                //    `cancelling` → the durable terminal is owned by the settle path,
                //    and our job is only client delivery. The terminalSent CAS keeps
                //    delivery emit-once in both orders.
                String currentRunStatus = runStatus(runId);
                boolean durableTerminal = terminalCommitted
                        || (currentRunStatus != null && ChatRunTerminalService.isTerminalStatus(currentRunStatus));
                boolean cancelOwnsTerminal = "cancelling".equals(currentRunStatus);
                if ((durableTerminal || cancelOwnsTerminal)
                        && terminalSent.compareAndSet(false, true)) {
                    for (RelayedTerminalEvent terminalEvent : relayResult.terminalEvents()) {
                        dispatchRelayedEvent(sessionId, terminalEvent.name(), terminalEvent.data(),
                                runId, requestId, userId, workspaceId, relayResult.runState());
                    }
                } else if (terminalCommitted) {
                    logger.warn("[LIFECYCLE] service=cp event=chat_terminal_sse_suppressed requestId={} runId={} reason=terminal_already_sent",
                            requestId, runId);
                } else {
                    logger.warn("[LIFECYCLE] service=cp event=chat_terminal_sse_suppressed requestId={} runId={} status={} reason=terminal_owner_unknown",
                            requestId, runId, currentRunStatus);
                }

            } catch (CpApiException e) {
                logger.warn("[LIFECYCLE] service=cp event=chat_run_failed requestId={} runId={} errorCode={}",
                        requestId, runId, e.getCode(), e);
                sendRunErrorAndDone(sessionId, requestId, runId, e.getCode(), e.getMessage(), "error", terminalSent);
            } catch (java.net.http.HttpTimeoutException e) {
                logger.warn("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=AGENT_TIMEOUT timeoutMs=30000",
                        requestId, sessionId, runId, e);
                healthMonitor.getAgentBreaker().recordFailure();
                sendRunErrorAndDone(sessionId, requestId, runId, "AGENT_TIMEOUT", "Agent request timed out after 30 seconds", "ambiguous", terminalSent);
            } catch (java.io.IOException e) {
                // PLAN-292 C1: a relay-stream break while the Agent is waiting
                // for a user decision is recoverable, not a run failure — the
                // approval row + GET run status keep the decision reachable
                // after a reconnect. Fail the run only when no approval was
                // in flight.
                if (approvalInFlight.get()) {
                    logger.warn("[LIFECYCLE] service=cp event=chat_relay_interrupted requestId={} sessionId={} runId={} reason=approval_in_flight outcome=ambiguous",
                            requestId, sessionId, runId);
                    sendRunErrorAndDone(sessionId, requestId, runId, "AGENT_STREAM_INTERRUPTED",
                            "Connection interrupted while awaiting approval; the pending decision stays recoverable",
                            "ambiguous", terminalSent);
                } else {
                    logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=CHAT_EXECUTION_FAILED",
                            requestId, sessionId, runId, e);
                    healthMonitor.getAgentBreaker().recordFailure();
                    sendRunErrorAndDone(sessionId, requestId, runId, "CHAT_EXECUTION_FAILED", "Chat execution failed", "error", terminalSent);
                }
            } catch (Exception e) {
                logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=CHAT_EXECUTION_FAILED",
                        requestId, sessionId, runId, e);
                healthMonitor.getAgentBreaker().recordFailure();
                sendRunErrorAndDone(sessionId, requestId, runId, "CHAT_EXECUTION_FAILED", "Chat execution failed", "error", terminalSent);
            } finally {
                releaseRun(sessionId, runId, "run_finished");
                runParticipants.remove(runId);
                MDC.remove("requestId");
                MDC.remove("chatRunId");
            }
        }, "xihe-chat-" + runId);
        try {
            worker.start();
        } catch (RuntimeException e) {
            releaseRun(sessionId, runId, "worker_start_failed");
            throw e;
        }
    }

    /** Resolve solely from authenticated dispatch scope; request bodies carry no profile selector. */
    void addRagCredentials(Map<String, Object> request, com.fasterxml.jackson.databind.JsonNode snapshot,
                           String userId, String workspaceId, String sessionId, String runId) {
        if (!requestValidator.usesRagContext(snapshot)) {
            return;
        }
        EmbeddingProfileService.ResolvedProfile profile;
        try {
            profile = embeddingProfiles.resolve(uuidOrNull(userId), uuidOrNull(workspaceId));
        } catch (RuntimeException e) {
            throw new CpApiException(HttpStatus.CONFLICT, "RAG_PROFILE_UNAVAILABLE",
                    "The Run embedding profile is unavailable", e);
        }
        ProviderCredentialLeaseService.IssuedLease lease;
        try {
            lease = embeddingProfiles.issueLease(profile, userId, workspaceId, sessionId, runId);
        } catch (RuntimeException e) {
            throw new CpApiException(HttpStatus.CONFLICT, "RAG_LEASE_UNAVAILABLE",
                    "The Run embedding credential lease is unavailable", e);
        }
        request.put("embeddingProfile", embeddingProfiles.describe(profile));
        request.put("embeddingCredentialLease", lease.token());
    }

    private boolean shouldRefreshRootAgentsMd(
            com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService.RunContext run) {
        com.fasterxml.jackson.databind.JsonNode snapshot = run.contextTemplateSnapshot();
        com.fasterxml.jackson.databind.JsonNode components = snapshot == null
                ? null : snapshot.path("template").path("components");
        // Pre-template/legacy ChatRuns retain the existing per-run refresh.
        if (components == null || !components.isArray()) {
            return true;
        }
        boolean hasRootComponent = false;
        boolean hasPerSession = false;
        for (com.fasterxml.jackson.databind.JsonNode component : components) {
            if (!component.path("enabled").asBoolean(false)
                    || !"root_agents_md".equals(component.path("type").asText())) {
                continue;
            }
            hasRootComponent = true;
            String policy = component.path("config").path("refreshPolicy").asText("");
            if ("per_chat_run".equals(policy)) {
                return true;
            }
            if ("per_session".equals(policy)) {
                hasPerSession = true;
            } else {
                // Unknown persisted value fails safe toward the established
                // fresh-per-run source rather than pinning stale rules.
                return true;
            }
        }
        if (!hasRootComponent) {
            return false;
        }
        return hasPerSession && !contextSourceRefreshService.hasSuccessfulSessionL1Snapshot(run.sessionId());
    }

    /**
     * PLAN-0341 T1.1: force-compact on overflow (bypass cooldown), emit U3,
     * then preflight. Returns true when the caller should re-dispatch.
     */
    private boolean tryOverflowRecovery(String sessionId, String workspaceId, String userId,
                                        String requestId, String runId, String model,
                                        AtomicBoolean terminalSent) {
        try {
            Long maxInputTokens = resolveMaxInputTokens(userId, workspaceId, model);
            contextService.compactForOverflow(sessionId, workspaceId, userId, runId);
            // PLAN-0410 T2.3 (matrix §4): overflow_retry is run-scoped — the
            // durable correlation lets CP derive its branch on append.
            contextService.appendEvent(sessionId, workspaceId, userId, "context.overflow_retry", Map.of(
                    "runId", runId == null ? "" : runId,
                    "requestId", requestId == null ? "" : requestId,
                    "maxInputTokens", maxInputTokens == null ? 0 : maxInputTokens), runId);
            sseManager.send(sessionId, "context_overflow_retry", Map.of(
                    "type", "context_overflow_retry",
                    "requestId", requestId == null ? "" : requestId,
                    "runId", runId == null ? "" : runId,
                    "message", "上下文超限，已压缩并重试一次"));
            logger.info("[LIFECYCLE] service=cp event=chat_overflow_recovery sessionId={} runId={} maxInputTokens={}",
                    sessionId, runId, maxInputTokens);
            return contextService.preflightRetryAfterOverflow(sessionId, maxInputTokens, runId);
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=chat_overflow_recovery_failed sessionId={} runId={}",
                    sessionId, runId, e);
            return false;
        }
    }

    /**
     * PLAN-0660 T5.16 (LD-16=A): only a spawned Run carries a parent. A root Run omits the key, so
     * the payload stays additive — the pre-T5.16 Agent ignores it, and an Agent without a value
     * keeps treating the Run as a root (only a root run may ask the user).
     */
    static void putParentRunId(Map<String, Object> agentRequest, String parentRunId) {
        if (parentRunId != null && !parentRunId.isBlank()) {
            agentRequest.put("parentRunId", parentRunId);
        }
    }

    /**
     * Resolve model window from context-policy (T1.6). Priority:
     * models.&lt;model&gt;.maxInputTokens → defaults.maxInputTokens → null (caller falls back).
     */    /**
     * PLAN-0666 M1b: record the dispatch-time fingerprint. Deliberately swallows every failure —
     * an observability artifact must never fail a run (D5 fail-open); the recorder itself already
     * downgrades failures to a stored {@code status=error} document.
     */
    private void recordContextFingerprint(String runId, String sessionId, String userId, String workspaceId,
                                          ChatRunReadService.ExecutionRun persistedRun, String content,
                                          Map<String, Object> componentSources, String agentInstructions,
                                          Map<String, Map<String, String>> userOverrides,
                                          Map<String, Map<String, String>> workspaceOverrides,
                                          Map<String, Object> agentRequest) {
        try {
            contextFingerprintRecorder.recordFirstDispatch(new ContextFingerprintRecorder.RecordInput(
                    runId, sessionId, persistedRun.branchId(), userId, workspaceId,
                    persistedRun.context().contextTemplateSnapshot(),
                    persistedRun.context().skillsSnapshot(),
                    content, componentSources, agentInstructions,
                    userOverrides, workspaceOverrides, agentRequest));
        } catch (RuntimeException exception) {
            logger.warn("[CONTEXT-FINGERPRINT] event=record_failed runId={} reason={}",
                    runId, exception.getClass().getSimpleName());
        }
    }

    private Long resolveMaxInputTokens(String userId, String workspaceId, String model) {
        try {
            Map<String, String> domain = configService.resolveDomain(
                    "context-policy", uuidOrNull(userId), uuidOrNull(workspaceId));
            if (domain == null || domain.isEmpty()) {
                return null;
            }
            if (model != null && !model.isBlank()) {
                String modelsJson = domain.get("models");
                if (modelsJson != null && !modelsJson.isBlank()) {
                    var models = objectMapper.readTree(modelsJson);
                    var modelNode = models.path(model);
                    if (modelNode.hasNonNull("maxInputTokens")) {
                        return modelNode.get("maxInputTokens").asLong();
                    }
                }
            }
            String defaultsJson = domain.get("defaults");
            if (defaultsJson != null && !defaultsJson.isBlank()) {
                var defaults = objectMapper.readTree(defaultsJson);
                if (defaults.hasNonNull("maxInputTokens")) {
                    return defaults.get("maxInputTokens").asLong();
                }
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=context_policy_max_input_tokens_unresolved model={} error={}",
                    model, e.getMessage());
        }
        return null;
    }

    private void sendRunErrorAndDone(String sessionId, String requestId, String runId,
                                     String errorCode, String detail, String outcome,
                                     AtomicBoolean terminalSent) {
        if (!terminalSent.compareAndSet(false, true)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_terminal_ignored requestId={} sessionId={} runId={} errorCode={} reason=terminal_already_sent",
                    requestId, sessionId, runId, errorCode);
            return;
        }
        String terminalStatus = "ambiguous".equals(outcome) ? "ambiguous" : "failed";
        boolean transitioned = transitionRun(runId,
                List.of("accepted", "queued", "running", "streaming", "awaiting_approval", "dispatching"),
                terminalStatus, outcome, errorCode, detail, 0, 0);
        if (!transitioned) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_terminal_emit_suppressed runId={} errorCode={} reason=terminal_not_committed",
                    runId, errorCode);
            return;
        }
        // PLAN-0706: the detail key is OMITTED (never null) when CP has no localized copy; the UI
        // renders humanizeErrorCode(code) instead of an English fallback sentence.
        Map<String, Object> errorEvent = new java.util.LinkedHashMap<>();
        errorEvent.put("code", errorCode);
        errorEvent.put("requestId", requestId);
        errorEvent.put("runId", runId);
        if (detail != null && !detail.isBlank()) {
            errorEvent.put("detail", detail);
        }
        errorEvent.put("retryable", isRetryableError(errorCode));
        errorEvent.put("outcome", outcome);
        errorEvent.put("type", "error");
        sseManager.send(sessionId, "error", errorEvent, participantIdFor(runId));
        sseManager.send(sessionId, "done", Map.of(
                "type", "done",
                "requestId", requestId,
                "runId", runId,
                "errorCode", errorCode,
                "outcome", outcome,
                "synthetic", true), participantIdFor(runId));
    }

    /** PLAN-0623 M1b-③: the participant row that produced this run's output (null = system). */
    private String participantIdFor(String runId) {
        return runId == null ? null : runParticipants.get(runId);
    }

    /**
     * Current durable status of the run, or {@code null} when unknown. Used by
     * the terminal-SSE gate to decide whether the durable terminal write is
     * owned by this relay or by another path (cancellation settle / recovery).
     */
    private String runStatus(String runId) {
        return chatRunReadService.statusOrNull(runId);
    }

    /**
     * @return true when this call performed the transition; false when it was
     *         ignored (already terminal / expected-status mismatch)
     */
    private boolean transitionRun(String runId, List<String> expectedStatuses, String status,
                                  String outcome, String errorCode, String errorDetail,
                                  int tokenCount, int assistantChars) {
        return chatRunLifecycleService.transition(runId, expectedStatuses, status, outcome,
                errorCode, errorDetail, tokenCount, assistantChars, null);
    }

    /**
     * PLAN-0464 T1.4: {@code usagePayload} is the relay's in-memory (cost-mapped)
     * usage envelope and is only carried by the terminal transition that this
     * relay owns; every other caller passes {@code null}.
     */
    private boolean transitionRun(String runId, List<String> expectedStatuses, String status,
                                  String outcome, String errorCode, String errorDetail,
                                  int tokenCount, int assistantChars, Object usagePayload,
                                  String budgetDimension) {
        return chatRunLifecycleService.transition(runId, expectedStatuses, status, outcome,
                errorCode, errorDetail, tokenCount, assistantChars, usagePayload, budgetDimension);
    }

    /**
     * PLAN-0670 M2c / BL-293: the relay's parsed {@code done.agentContextTruncation} node is carried
     * into the same terminal transition that already carries the usage envelope; only the relay-owned
     * terminal path passes a non-null node, every other caller uses the 10-arg overload.
     */
    private boolean transitionRun(String runId, List<String> expectedStatuses, String status,
                                  String outcome, String errorCode, String errorDetail,
                                  int tokenCount, int assistantChars, Object usagePayload,
                                  String budgetDimension, JsonNode contextTruncation) {
        return chatRunLifecycleService.transition(runId, expectedStatuses, status, outcome,
                errorCode, errorDetail, tokenCount, assistantChars, usagePayload, budgetDimension,
                contextTruncation);
    }

    private String safeErrorCode(String code) {
        if (code == null) {
            return "AGENT_UNAVAILABLE";
        }
        return switch (code) {
            case "LLM_NOT_CONFIGURED", "LLM_CREDENTIALS_INVALID", "LLM_PROVIDER_UNREACHABLE",
                    "LLM_MODEL_UNAVAILABLE", "LLM_REQUEST_REJECTED", "LLM_TOOL_ROUTE_UNSUPPORTED",
                    "AGENT_UNAVAILABLE", "AGENT_TIMEOUT",
                    "AGENT_CIRCUIT_OPEN", "AGENT_STREAM_FAILED", "SSE_SUBSCRIPTION_REQUIRED", "CHAT_IN_PROGRESS",
                    "IDEMPOTENCY_KEY_CONFLICT", "APPROVAL_REJECTED", "APPROVAL_EXPIRED",
                    "APPROVAL_EXECUTOR_UNSUPPORTED", "APPROVAL_DECISION_CONFLICT", "AGENT_EVENT_ID_MISMATCH",
                    "CONTEXT_OVERFLOW", "RUN_BUDGET_EXHAUSTED", "RUN_NO_PROGRESS" -> code;
            // PLAN-0416 V12/V6: these are Agent-side fail-closed rejections raised
            // BEFORE any provider dispatch. Their whole point is a stable,
            // actionable code on the wire; collapsing them to AGENT_UNAVAILABLE
            // hides the real cause from the run terminal and the UI.
            case "RAG_PROFILE_UNAVAILABLE", "RAG_LEASE_INVALID", "RAG_LEASE_UNAVAILABLE",
                    "RAG_LEASE_MISMATCH", "RAG_QUERY_FAILED", "BASELINE_UNAUTHORIZED" -> code;
            default -> "AGENT_UNAVAILABLE";
        };
    }

    private boolean isRetryableError(String code) {
        return switch (code) {
            case "SSE_SUBSCRIPTION_REQUIRED", "CHAT_IN_PROGRESS", "IDEMPOTENCY_KEY_CONFLICT",
                    "APPROVAL_REJECTED", "APPROVAL_EXPIRED", "APPROVAL_EXECUTOR_UNSUPPORTED",
                    "APPROVAL_DECISION_CONFLICT", "AGENT_EVENT_ID_MISMATCH",
                    // PLAN-0416 V12/V6: the Agent marks these retryable=false; a
                    // client must not be invited to retry a fail-closed baseline.
                    "RAG_PROFILE_UNAVAILABLE", "RAG_LEASE_INVALID", "RAG_LEASE_MISMATCH",
                    "RAG_QUERY_FAILED", "BASELINE_UNAUTHORIZED" -> false;
            default -> true;
        };
    }

    private ResponseEntity<Map<String, Object>> llmNotReadyResponse(
            String requestId, String runId, String readiness, String userId, String workspaceId) {
        String code = switch (readiness) {
            case "missing_credentials" -> "LLM_NOT_CONFIGURED";
            case "invalid_credentials" -> "LLM_CREDENTIALS_INVALID";
            case "unreachable" -> "LLM_PROVIDER_UNREACHABLE";
            case "model_unavailable" -> "LLM_MODEL_UNAVAILABLE";
            default -> "AGENT_UNAVAILABLE";
        };
        String detail = "unknown".equals(readiness)
                ? "Agent LLM readiness is unknown"
                : "Agent LLM is not ready: " + readiness;
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("type", "https://xihe.dev/problems/llm-not-ready");
        body.put("title", "LLM is not ready");
        body.put("status", 503);
        body.put("code", code);
        if ("LLM_NOT_CONFIGURED".equals(code)) {
            // BL-350 (B): say WHICH layer is missing. The Agent gate is instance-layer-only, so this
            // classification needs CP's view of both layers; the wire code stays LLM_NOT_CONFIGURED.
            LlmReadinessReason.Diagnosis diagnosis = llmConfigurationDiagnosis(userId, workspaceId);
            body.put("detail", diagnosis.detail());
            body.put("reason", diagnosis.reason());
        } else {
            body.put("detail", detail);
        }
        body.put("retryable", true);
        body.put("requestId", requestId);
        body.put("runId", runId);
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header("Retry-After", "5")
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .header("X-Request-Id", requestId)
                .body(body);
    }

    /**
     * BL-350 (B): instance-layer presence vs the caller's effective (user-layer-merged) presence.
     * Any read failure degrades to "not profiled" (the 503 still answers; no new 500 path).
     */
    private LlmReadinessReason.Diagnosis llmConfigurationDiagnosis(String userId, String workspaceId) {
        boolean instanceProfiled = false;
        boolean userProfiled = false;
        try {
            Map<String, String> instanceEntries = configService
                    .effective("llm-provider", null, null).entries();
            instanceProfiled = instanceEntries != null
                    && !instanceEntries.getOrDefault("provider", "").isBlank();
            UUID actor = parseUuidOrNull(userId);
            UUID workspace = parseUuidOrNull(workspaceId);
            if (actor != null) {
                Map<String, String> userEntries = configService
                        .effective("llm-provider", actor, workspace).entries();
                userProfiled = userEntries != null
                        && !userEntries.getOrDefault("provider", "").isBlank();
            }
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=run_llm_diagnosis_unavailable failureType={}",
                    e.getClass().getSimpleName());
        }
        return LlmReadinessReason.diagnose(instanceProfiled, userProfiled);
    }

    private static UUID parseUuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * PLAN-0645 D45-01: the local claim is no longer the admission decision — the Session's
     * bounded-concurrency gate ({@link SessionRunConcurrencyGate}, under the Session row lock)
     * owns that. This returns {@code false} only when the <b>same</b> run id is already claimed,
     * i.e. a duplicate dispatch of one run; other in-flight runs of the Session are untouched.
     */
    private boolean acquireRun(String sessionId, String runId) {
        return activeRunRegistry.claim(sessionId, runId);
    }

    private boolean acquireLeaseForExistingRun(String runId) {
        return chatRunLifecycleService.tryAcquireLease(
                UUID.fromString(runId),
                instanceId(),
                Instant.now().plus(LEASE_TTL),
                Instant.now()) > 0;
    }

    private void releaseRun(String sessionId, String runId, String reason) {
        boolean dbReleased = chatRunLifecycleService.releaseLease(UUID.fromString(runId), instanceId()) > 0;
        boolean memoryReleased = activeRunRegistry.release(sessionId, runId);
        eventPublisher.publishEvent(new FollowUpQueueWakeupEvent(sessionId));
        // PLAN-0352 T1.2：唤醒会话删除路径的 release 等待位（终态投递在此之后已完成）。
        chatRunCancellationService.onRunReleased(runId);
        if (dbReleased || memoryReleased) {
            logger.info("[LIFECYCLE] service=cp event=chat_run_lease_released sessionId={} runId={} reason={} dbReleased={} memoryReleased={}",
                    sessionId, runId, reason, dbReleased, memoryReleased);
        } else {
            logger.debug("[LIFECYCLE] service=cp event=chat_run_lease_release_ignored sessionId={} runId={} reason={}",
                    sessionId, runId, reason);
        }
    }

    private String instanceId() {
        return currentInstanceId();
    }

    static String currentInstanceId() {
        return INSTANCE_ID;
    }

    private void markQueuedRequestFailed(RequestQueue.QueuedRequest request, String requestId,
                                         String errorCode, String detail) {
        String runId = request.runId();
        if (runId == null || runId.isBlank()) {
            return;
        }
        releaseRun(request.sessionId(), runId, "queue_drop");
        sendRunErrorAndDone(
                request.sessionId(), requestId, runId, errorCode, detail, "error", new AtomicBoolean(false));
    }

    private String currentRequestId() {
        return nonBlankOrGenerated(MDC.get("requestId"));
    }

    private String nonBlankOrGenerated(String value) {
        return value == null || value.isBlank() ? UUID.randomUUID().toString() : value;
    }

    /** T2.7: tolerate non-UUID tenant ids by degrading to an empty override set. */
    private static UUID uuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            logger.warn("[LIFECYCLE] service=cp event=config_override_context_invalid value={}", value);
            return null;
        }
    }

    private List<String> extractAttachmentIds(Map<String, Object> request) {
        Object raw = request.get("attachments");
        if (raw == null) {
            return List.of();
        }
        if (raw instanceof List<?> list) {
            return list.stream()
                    .map(Object::toString)
                    .filter(s -> s != null && !s.isBlank())
                    .toList();
        }
        return List.of();
    }

    private String requestHash(String content, String provider, String model,
                               String toolMode, List<String> attachmentIds,
                               Map<String, Integer> toolTimeouts, String agentPrincipalId, String branchId) {
        return ChatRequestHash.calculate(objectMapper, content, provider, model,
                toolMode, attachmentIds, toolTimeouts, agentPrincipalId, branchId);
    }

    /**
     * PLAN-0665 D6: identity-bearing overload — the TO target set (canonical, order-insensitive) and
     * the explicit responder (`asParticipantId`) are part of the request hash. Fixes a pre-existing
     * bug where the same content sent as two different participants under one Idempotency-Key
     * replayed the first run (design §2.2 supersede row).
     */
    private String requestHash(String content, String provider, String model,
                               String toolMode, List<String> attachmentIds,
                               Map<String, Integer> toolTimeouts, String agentPrincipalId, String branchId,
                               List<String> toParticipantIds, String asParticipantId) {
        return ChatRequestHash.calculate(objectMapper, content, provider, model,
                toolMode, attachmentIds, toolTimeouts, agentPrincipalId, branchId,
                toParticipantIds, asParticipantId);
    }

    /**
     * R1 (PLAN-0623): the accepted/queued body carries the run's responder so a client that just spoke
     * as somebody sees the attribution without a second read. null is a real value (a legacy Session
     * without participants), hence a mutable map instead of Map.of.
     */
    private static Map<String, Object> runAcceptedBody(ChatRun run, String status, String sessionId,
                                                       java.util.UUID messageId, String runId, String reason) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", status);
        body.put("origin", run.getOrigin());
        body.put("sessionId", sessionId);
        body.put("messageId", messageId);
        body.put("runId", runId);
        if (reason != null) {
            body.put("reason", reason);
        }
        body.put("agentPrincipalId", run.getAgentPrincipalId() == null
                ? null : run.getAgentPrincipalId().toString());
        return body;
    }
    private Map<String, Object> runResponse(ChatSubmissionService.SubmissionReplay run) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", run.status());
        response.put("origin", run.origin());
        response.put("sessionId", run.sessionId());
        response.put("runId", run.runId());
        response.put("providerConnectionId", run.providerConnectionId());
        response.put("connectionRevision", run.connectionRevision());
        if (run.messageId() != null) {
            response.put("messageId", run.messageId());
        }
        if (run.terminalOutcome() != null) {
            response.put("outcome", run.terminalOutcome());
        }
        if (run.errorCode() != null) {
            response.put("errorCode", run.errorCode());
        }
        return response;
    }

    private StreamRelayResult relayAgentStream(String sessionId, InputStream agentStream,
                                               String requestId, String runId,
                                               String userId, String workspaceId,
                                               AtomicBoolean approvalInFlight,
                                               boolean suppressOverflowError) throws Exception {
        StringBuilder assistantContent = new StringBuilder();
        List<RelayedTerminalEvent> terminalEvents = new ArrayList<>();
        Map<String, Integer> eventCounts = new LinkedHashMap<>();
        // PLAN-294 decision #13: real/estimated token totals from the agent's
        // usage event; replaces the SSE chunk counter in chat_runs.token_count.
        Map<?, ?> usageData = null;
        // PLAN-0464 T1.4: cost-mapped usage envelope handed to the terminal write.
        Map<?, ?> usageEnvelope = null;
        boolean doneSeen = false;
        boolean streamingMarked = false;
        boolean awaitingApprovalSeen = false;
        String outcome = "success";
        String errorCode = null;
        String budgetDimension = null;
        // PLAN-0670 M2c / BL-293: parsed from the SAME `done` payload that is relayed to the UI; the
        // terminal write persists exactly this node (no second parse/derivation).
        JsonNode contextTruncation = null;
        int eventIndex = 0;
        var runState = com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder.RunState.create();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(agentStream, StandardCharsets.UTF_8))) {
            String eventName = "message";
            StringBuilder data = new StringBuilder();
            String line;

            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    eventIndex++;
                    recordStreamEvent(eventCounts, eventName, data.length(), requestId, sessionId, runId, eventIndex);
                    boolean isDone = "done".equals(eventName);
                    doneSeen = doneSeen || isDone;
                    if ("approval_request".equals(eventName)) {
                        // PLAN-292 C1: once the Agent is blocked on a user
                        // decision, a broken relay stream (page refresh kills
                        // the browser SSE and eventually the relay read) must
                        // NOT fail the run — the durable approval + run status
                        // endpoint keep the decision recoverable.
                        awaitingApprovalSeen = true;
                        approvalInFlight.set(true);
                    }
                    if (!streamingMarked && ("token".equals(eventName) || "message".equals(eventName))) {
                        transitionRun(runId, List.of("running", "awaiting_approval"), "streaming", null, null, null, 0, 0);
                        streamingMarked = true;
                    }
                    collectEventContent(assistantContent, eventName, data.toString());
                    if ("usage".equals(eventName)) {
                        // PLAN-0464 T1.4: cost mapping still happens here so the
                        // session-header usage line is relayed before `done`
                        // (PLAN-0343 decision #9), but nothing is persisted —
                        // the terminal transition owns the llm.usage write.
                        Object usagePayload = parsePayload(eventName, data.toString());
                        Object enriched = mapUsageCost(runId, usagePayload);
                        usageEnvelope = enriched instanceof Map<?, ?> map ? map : null;
                        if (usageEnvelope != null) {
                            sseManager.send(sessionId, "usage", usageEnvelope, participantIdFor(runId));
                        }
                        Map<?, ?> usage = asMap(usagePayload).get("usage") instanceof Map<?, ?> u ? u : null;
                        if (usage != null) {
                            usageData = usage;
                        }
                        eventName = "message";
                        data.setLength(0);
                        continue;
                    }
                    if ("error".equals(eventName)) {
                        Map<?, ?> errorPayload = asMap(parsePayload(eventName, data.toString()));
                        errorCode = stringValue(errorPayload, "code");
                        budgetDimension = budgetDimensionPreserving(errorPayload, budgetDimension);
                        String eventOutcome = stringValue(errorPayload, "outcome");
                        outcome = "ambiguous".equals(eventOutcome)
                                ? "ambiguous" : assistantContent.isEmpty() ? "error" : "partial";
                        // PLAN-0341: first overflow is consumed by the retry loop;
                        // do not forward it as a user-facing terminal error.
                        if (suppressOverflowError && "CONTEXT_OVERFLOW".equals(errorCode)) {
                            eventName = "message";
                            data.setLength(0);
                            continue;
                        }
                    } else if (isDone) {
                        Map<?, ?> donePayload = asMap(parsePayload(eventName, data.toString()));
                        contextTruncation = contextTruncationOf(donePayload, contextTruncation);
                        String doneOutcome = stringValue(donePayload, "outcome");
                        String doneErrorCode = stringValue(donePayload, "errorCode");
                        if (doneErrorCode != null) {
                            errorCode = doneErrorCode;
                            // The Agent's `done` mirrors the error code but does not
                            // repeat the dimension — keep the captured value.
                            budgetDimension = budgetDimensionPreserving(donePayload, budgetDimension);
                            String doneOutcomeValue = stringValue(donePayload, "outcome");
                            outcome = "ambiguous".equals(doneOutcomeValue)
                                    ? "ambiguous" : assistantContent.isEmpty() ? "error" : "partial";
                        } else if (doneOutcome != null) {
                            outcome = doneOutcome;
                        }
                    }
                    boolean suppressThisEvent = suppressOverflowError
                            && "CONTEXT_OVERFLOW".equals(errorCode)
                            && ("error".equals(eventName) || isDone);
                    if (!suppressThisEvent) {
                        if (isDone || "error".equals(eventName)) {
                            terminalEvents.add(new RelayedTerminalEvent(eventName, data.toString()));
                        } else {
                            dispatchRelayedEvent(sessionId, eventName, data.toString(), runId, requestId,
                                    userId, workspaceId, runState);
                        }
                    }
                    eventName = "message";
                    data.setLength(0);
                    continue;
                }

                if (line.startsWith("event:")) {
                    eventName = line.substring("event:".length()).trim();
                    continue;
                }

                if (line.startsWith("data:")) {
                    if (data.length() > 0) {
                        data.append('\n');
                    }
                    data.append(line.substring("data:".length()).trim());
                }
            }

            if (data.length() > 0) {
                eventIndex++;
            }
            recordStreamEvent(eventCounts, eventName, data.length(), requestId, sessionId, runId, eventIndex);
            boolean isDone = "done".equals(eventName);
            doneSeen = doneSeen || isDone;
            if (!streamingMarked && ("token".equals(eventName) || "message".equals(eventName))) {
                transitionRun(runId, List.of("running", "awaiting_approval"), "streaming", null, null, null, 0, 0);
                streamingMarked = true;
            }
            collectEventContent(assistantContent, eventName, data.toString());
            if ("error".equals(eventName)) {
                Map<?, ?> errorPayload = asMap(parsePayload(eventName, data.toString()));
                errorCode = stringValue(errorPayload, "code");
                budgetDimension = budgetDimension(errorPayload);
                String eventOutcome = stringValue(errorPayload, "outcome");
                outcome = "ambiguous".equals(eventOutcome)
                        ? "ambiguous" : assistantContent.isEmpty() ? "error" : "partial";
            } else if (isDone) {
                Map<?, ?> donePayload = asMap(parsePayload(eventName, data.toString()));
                contextTruncation = contextTruncationOf(donePayload, contextTruncation);
                String doneOutcome = stringValue(donePayload, "outcome");
                String doneErrorCode = stringValue(donePayload, "errorCode");
                if (doneErrorCode != null) {
                    errorCode = doneErrorCode;
                    budgetDimension = budgetDimension(donePayload);
                    String doneOutcomeValue = stringValue(donePayload, "outcome");
                    outcome = "ambiguous".equals(doneOutcomeValue)
                            ? "ambiguous" : assistantContent.isEmpty() ? "error" : "partial";
                } else if (doneOutcome != null) {
                    outcome = doneOutcome;
                }
            }
            boolean suppressTail = suppressOverflowError && "CONTEXT_OVERFLOW".equals(errorCode);
            if (!suppressTail) {
                if (isDone || "error".equals(eventName)) {
                    terminalEvents.add(new RelayedTerminalEvent(eventName, data.toString()));
                } else {
                    dispatchRelayedEvent(sessionId, eventName, data.toString(), runId, requestId,
                            userId, workspaceId, runState);
                }
            }
        }
        if (!doneSeen) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_missing_done requestId={} sessionId={} runId={} errorCode=AGENT_DONE_MISSING",
                    requestId, sessionId, runId);
            boolean suppressSyntheticDone = suppressOverflowError && "CONTEXT_OVERFLOW".equals(errorCode);
            if (!suppressSyntheticDone) {
                terminalEvents.add(new RelayedTerminalEvent("done",
                        "{\"type\":\"done\",\"outcome\":\"ambiguous\",\"synthetic\":true}"));
            }
            if (!suppressSyntheticDone) {
                outcome = "ambiguous";
            }
            eventCounts.put("done", 1);
        }
        logger.info("[LIFECYCLE] service=cp event=chat_stream_relay_finished requestId={} sessionId={} runId={} tokenCount={} assistantChars={}",
                requestId, sessionId, runId, eventCounts.getOrDefault("token", 0), assistantContent.length());
        // PLAN-294 decision #13: token_count column now carries the
        // model-reported (or estimated) total token count, not the SSE chunk
        // count it used to log.
        int usageTotal = usageData != null
                ? intValue(usageData.get("totalTokens"), eventCounts.getOrDefault("token", 0))
                : eventCounts.getOrDefault("token", 0);
        return new StreamRelayResult(
                assistantContent.toString(), outcome, errorCode, budgetDimension,
                usageTotal, List.copyOf(terminalEvents), runState, usageEnvelope, contextTruncation);
    }

    private static int intValue(Object value, int fallback) {
        return value instanceof Number n ? n.intValue() : fallback;
    }

    // PLAN-0464 T1.4: the `llm_usage` extension path is gone. Cost mapping stays
    // here (single computation point, PLAN-0343 decision #7) so the UI relay
    // carries the same cost fields the terminal write will persist; the durable
    // `llm.usage` ContextEvent is written by ChatRunTerminalService from the
    // envelope this relay hands over.

    /**
     * PLAN-0343 decision #7: single cost computation point (now shared with
     * compaction summaries via {@link com.cc01cc.p.xihe.cp.usage.UsageCostMapper},
     * PLAN-0354 Q5-A). Legacy payloads without a model key and empty usage stay
     * verbatim; everything else gets cost/costCurrency/costSource/costNote.
     */
    private Object mapUsageCost(String runId, Object parsedPayload) {
        try {
            Map<?, ?> envelope = asMap(parsedPayload);
            Map<?, ?> usage = asMap(envelope.get("usage"));
            if (usage.isEmpty()) {
                return parsedPayload;
            }
            String model = stringValue(usage, "model");
            if (model == null) {
                // Pre-0343 payloads without a model key stay verbatim (spec
                // §2.2 legacy rows: aggregation handles them, no alert).
                return parsedPayload;
            }
            Map<String, Object> usageCopy = new java.util.HashMap<>();
            for (Map.Entry<?, ?> entry : usage.entrySet()) {
                usageCopy.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            Map<String, Object> mapped = usageCostMapper.withCost(model, usageCopy, runId);
            Map<String, Object> envelopeOut = new java.util.HashMap<>();
            for (Map.Entry<?, ?> entry : envelope.entrySet()) {
                envelopeOut.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            envelopeOut.put("usage", mapped);
            return envelopeOut;
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=usage_cost_mapping_failed runId={} error={}", runId, e.getMessage());
            return parsedPayload;
        }
    }

    /**
     * PLAN-0508 T3.2: persist bounded provider-attempt telemetry before the CP
     * relays it (durable-before-dispatch). Best-effort by contract: a malformed
     * payload or failed write is logged and the relay proceeds untouched — the
     * telemetry side channel must never fail the provider Run. The {@code runId}
     * comes from the relay's authorized context, never from the Agent payload.
     */
    private void persistTransportTelemetry(String eventName, Map<?, ?> payload, String runId) {
        try {
            UUID attemptId = UUID.fromString(requiredString(payload, "attemptId"));
            long sequence = requiredLong(payload, "seq");
            Instant startedAt = Instant.parse(requiredString(payload, "startedAt"));
            if ("transport_progress".equals(eventName)) {
                String stage = requiredString(payload, "stage");
                long elapsedMs = requiredLong(payload, "elapsedMs");
                if (ChatRunTransportAttempt.STAGE_ATTEMPT_STARTED.equals(stage)) {
                    chatRunTransportService.startAttempt(runId, attemptId, sequence, startedAt);
                }
                chatRunTransportService.recordProgress(runId, attemptId, sequence, stage, elapsedMs);
                return;
            }
            String outcome = requiredString(payload, "outcome");
            Instant endedAt = Instant.parse(requiredString(payload, "endedAt"));
            long durationMs = requiredLong(payload, "durationMs");
            Long firstChunkMs = nullableLong(payload, "firstChunkMs");
            Long chunkCount = nullableLong(payload, "chunkCount");
            Object errorSlot = payload.get("errorCode");
            String errorCode = errorSlot instanceof String string ? string : null;
            Integer providerHttpStatus = errorSlot instanceof Number number ? number.intValue() : null;
            chatRunTransportService.completeAttempt(runId, attemptId, sequence,
                    new ChatRunTransportService.AttemptCompletion(
                            outcome, startedAt, endedAt, durationMs,
                            errorCode, providerHttpStatus, firstChunkMs, chunkCount));
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=transport_telemetry_dropped eventName={} runId={} reason={}",
                    eventName, runId, e.getMessage());
        }
    }

    private static String requiredString(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        if (!(value instanceof String string) || string.isBlank()) {
            throw new IllegalArgumentException("Missing transport telemetry field " + key);
        }
        return string;
    }

    private static long requiredLong(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        if (!(value instanceof Number number)) {
            throw new IllegalArgumentException("Missing transport telemetry field " + key);
        }
        return number.longValue();
    }

    private static Long nullableLong(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        return value instanceof Number number ? number.longValue() : null;
    }

    private Map<?, ?> asMap(Object value) {
        return value instanceof Map<?, ?> map ? map : Map.of();
    }

    private String stringValue(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        return value instanceof String string && !string.isBlank() ? string : null;
    }

    /**
     * PLAN-0492 T2.2: the exhausted budget dimension from a RUN_BUDGET_EXHAUSTED
     * error payload; absent/malformed payloads stay {@code null} so no other
     * error path gains a payload fact.
     */
    private String budgetDimension(Map<?, ?> payload) {
        if (!"RUN_BUDGET_EXHAUSTED".equals(stringValue(payload, "code"))) {
            return null;
        }
        return stringValue(payload, "dimension");
    }

    /**
     * The Agent's {@code done} mirrors the error code but carries no dimension;
     * only an explicit dimension overwrites the value captured from the error
     * event (error → done ordering in the same stream).
     */
    private String budgetDimensionPreserving(Map<?, ?> payload, String current) {
        String captured = budgetDimension(payload);
        return captured == null ? current : captured;
    }

    private record StreamRelayResult(
            String assistantContent,
            String outcome,
            String errorCode,
            /** PLAN-0492: exhausted run-budget dimension when errorCode=RUN_BUDGET_EXHAUSTED. */
            String budgetDimension,
            int tokenCount,
            List<RelayedTerminalEvent> terminalEvents,
            com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder.RunState runState,
            Map<?, ?> usageEnvelope,
            /** PLAN-0670 M2c / BL-293: same parsed done object the UI receives; null = no truncation. */
            JsonNode agentContextTruncation
    ) {}

    private record ContinuationDispatchContext(
            ChatRunReadService.ContinuationDescriptor checkpoint,
            List<String> completedToolCallIds
    ) {
        private ContinuationDispatchContext {
            completedToolCallIds = completedToolCallIds == null ? List.of() : List.copyOf(completedToolCallIds);
        }
    }

    private record RelayedTerminalEvent(String name, String data) {}

    private void recordStreamEvent(Map<String, Integer> eventCounts, String eventName, int payloadLength,
                                   String requestId, String sessionId, String runId, int eventIndex) {
        if (payloadLength <= 0) {
            return;
        }
        eventCounts.merge(eventName, 1, Integer::sum);
        logger.debug("[LIFECYCLE] service=cp event=chat_stream_event_received requestId={} sessionId={} runId={} eventIndex={} eventName={} payloadLength={}",
                requestId, sessionId, runId, eventIndex, eventName, payloadLength);
    }

    private void collectEventContent(StringBuilder builder, String eventName, String payload) {
        if (payload == null || payload.isBlank()) {
            return;
        }
        // Agent emits token/tool_call/tool_result/done; UI expects token for text.
        // Accumulate assistant text from token and legacy message events; ignore tool/status/done.
        if (!"token".equals(eventName) && !"message".equals(eventName)) {
            return;
        }
        Object parsed = parsePayload(eventName, payload);
        if (parsed instanceof Map<?, ?> map) {
            // Reasoning tokens are separate parts (hint=reasoning), not final assistant text.
            Object hint = map.get("hint");
            if ("reasoning".equals(hint)) {
                return;
            }
            Object content = map.get("content");
            if (content instanceof String s && !s.isBlank()) {
                builder.append(s);
            } else if (content instanceof java.util.List<?> list) {
                for (Object item : list) {
                    if (item instanceof String str) {
                        builder.append(str);
                    } else if (item instanceof Map<?, ?> block) {
                        Object text = block.get("text");
                        if (text instanceof String t && !t.isBlank()) {
                            builder.append(t);
                        }
                    }
                }
            }
        } else if (parsed instanceof String s) {
            builder.append(s);
        }
    }

    private void dispatchEvent(String sessionId, String eventName, String payload) {
        if (payload == null || payload.isBlank()) {
            return;
        }

        Object parsedPayload = parsePayload(eventName, payload);
        sseManager.send(sessionId, eventName, parsedPayload, null);
    }

    private void dispatchRelayedEvent(String sessionId, String eventName, String payload,
                                      String runId, String requestId, String userId, String workspaceId,
                                      com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder.RunState runState) {
        Object parsedPayload = stampRunIdIfAbsent(parsePayload(eventName, payload), runId);
        // PLAN-0508 T3.2: durable-before-forward transport persistence. Best-
        // effort by contract — malformed payloads and write failures are logged
        // and the SSE dispatch continues unchanged.
        if ("transport_progress".equals(eventName) || "transport_attempt".equals(eventName)) {
            persistTransportTelemetry(eventName, asMap(parsedPayload), runId);
        }
        // PLAN-0679 T2.2: same durable-before-forward contract as the transport rows — the
        // fingerprint row is best-effort (a dropped document is reported as not_captured, never as
        // a fake state) and the relay below still runs, so a diagnostics write cannot break a run.
        if (ProviderRequestFingerprintRecorder.EVENT_NAME.equals(eventName)) {
            providerRequestFingerprintRecorder.recordFirstDispatch(asMap(parsedPayload), runId);
        }
        // PLAN-0464 T2.2：Agent 侧工具事实记账只剩执行域（invocation + agent_tool
        // attempt）；LedgerToolRecorder 及其 operation_* 写入已随本计划删除。
        mcpRelayToolRecorder.record(eventName, asMap(parsedPayload), runId, requestId, runState);
        if ("approval_request".equals(eventName)) {
            ChatApproval storedApproval = approvalService.recordPending(
                    asMap(parsedPayload), sessionId, runId, userId, workspaceId);
            // T1.9: an answerer-rejected row is terminal from creation — never park the run or
            // push an approval card for it. The blocked Agent waiter is notified inside the
            // service (best-effort respond), so the run just continues on the failed tool call.
            if (!approvalService.isAwaitingAnswer(storedApproval)) {
                logger.info("[LIFECYCLE] service=cp event=chat_approval_relay_answerer_rejected requestId={}"
                                + " sessionId={} runId={} state={}",
                        storedApproval.getRequestId(), sessionId, runId, storedApproval.getState());
                return;
            }
            transitionRun(runId, List.of("running", "streaming"), "awaiting_approval", null, null, null, 0, 0);

            // Relay the durable canonical Approval row, not the stale Agent payload.
            sseManager.send(sessionId, eventName, approvalService.payloadFor(storedApproval, false),
                    participantIdFor(runId));
            return;
        }
        if ("session_question_asked".equals(eventName)) {
            relayUserQuestion(sessionId, runId, userId, workspaceId, asMap(parsedPayload));
            return;
        }
        sseManager.send(sessionId, eventName, parsedPayload, participantIdFor(runId));
    }

    /**
     * PLAN-0660 T5.11 — the {@code session_question_asked} relay: the Agent asked its user a question.
     *
     * <p>Durable first (the {@code user_questions} row is the fact), then a <b>user-channel hint</b>
     * ({@code {questionId, sessionId, state}} only — the UI reloads the projection), and
     * <b>deliberately not</b> the session SSE: the question body must never enter a session stream
     * (T5.11 judgement: grepping the session stream for the body finds nothing). The addressee is the
     * run owner, resolved inside the service.</p>
     *
     * <p>A refused relay (one pending question per run, a child run, a live approval) is logged and
     * <b>does not break the stream</b>: it is an invariant decision, not a transport failure, and the
     * Agent's own wait/deadline owns what happens next. Nothing is pushed for a refused ask, so the UI
     * can never see a card for a row that does not exist.</p>
     */
    private void relayUserQuestion(String sessionId, String runId, String userId, String workspaceId,
                                   Map<?, ?> payload) {
        Object rawPrompt = payload == null ? null : payload.get("question");
        Instant expiresAt = optionalInstant(payload == null ? null : payload.get("expiresAt"));
        UUID askedByParticipant = optionalUuid(payload == null ? null : payload.get("askedByParticipantId"));
        com.cc01cc.p.xihe.cp.entity.UserQuestion stored;
        try {
            stored = userQuestionService.recordPending(sessionId, runId, userId, workspaceId,
                    rawPrompt == null ? null : String.valueOf(rawPrompt), expiresAt, askedByParticipant);
        } catch (CpApiException refused) {
            logger.info("[LIFECYCLE] service=cp event=run_question_relay_refused runId={} code={}",
                    runId, refused.getCode());
            return;
        }
        userChannel.questionChanged(stored.getAddresseeUserId().toString(),
                stored.getId().toString(), sessionId, stored.getState());
    }

    private static Instant optionalInstant(Object raw) {
        if (raw instanceof String text && !text.isBlank()) {
            try {
                return Instant.parse(text.trim());
            } catch (RuntimeException malformed) {
                return null;
            }
        }
        return null;
    }

    private static UUID optionalUuid(Object raw) {
        if (raw instanceof String text && !text.isBlank()) {
            try {
                return UUID.fromString(text.trim());
            } catch (RuntimeException malformed) {
                return null;
            }
        }
        return null;
    }

    private Object parsePayload(String eventName, String payload) {
        try {
            return objectMapper.readValue(payload, Object.class);
        } catch (Exception e) {
            logger.debug("Failed to parse SSE payload as JSON, falling back to raw text: {}", e.getMessage());
            return Map.of("content", payload, "type", eventName);
        }
    }

    /**
     * PLAN-0670 M2c / BL-293: extract the inbound truncation marker from the parsed {@code done}
     * payload. The node is built from the SAME map used for the terminal-outcome fields and for the
     * relayed SSE payload, so the durable value cannot drift from what the UI received. A malformed /
     * absent marker keeps {@code fallback} (null unless a valid object was seen earlier in the stream).
     */
    private JsonNode contextTruncationOf(Map<?, ?> donePayload, JsonNode fallback) {
        Object raw = donePayload.get("agentContextTruncation");
        return raw instanceof Map<?, ?> ? objectMapper.valueToTree(raw) : fallback;
    }

    /**
     * PLAN-0645 M2 T2.1: every run-level SSE event must carry its {@code runId} so the client can
     * route concurrent runs into separate bubbles without depending on which stream (out/err) the
     * CP wrote to or on the Agent's payload honesty. The Agent payload usually already contains the
     * field; an explicit value always wins (putIfAbsent semantics) because the payload is the
     * record of what happened. Non-map payloads (bare strings) are forwarded unchanged — there is
     * no object to stamp, and the envelope-level participantId already marks the producer.
     */
    private Object stampRunIdIfAbsent(Object payload, String runId) {
        if (runId == null || payload == null) {
            return payload;
        }
        if (payload instanceof Map<?, ?> map) {
            java.util.LinkedHashMap<Object, Object> copy = new java.util.LinkedHashMap<>(map);
            copy.putIfAbsent("runId", runId);
            return copy;
        }
        return payload;
    }
}



