package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.chat.ChatRunCancellationService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Inbox;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.InboxRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** User-visible derived projection for one already-authorized parent Session. */
@Service
public class SessionDerivedStateService {
    private static final Logger logger = LoggerFactory.getLogger(SessionDerivedStateService.class);
    private static final Set<String> POINTER_KEYS = Set.of("sessionId", "runId", "state");
    private static final Set<String> TERMINAL_STATES = Set.of("success", "error", "partial", "ambiguous", "cancelled");

    private final SessionRepository sessions;
    private final ChatRunRepository chatRuns;
    private final InboxRepository inboxes;
    private final ObjectMapper objectMapper;

    public SessionDerivedStateService(SessionRepository sessions, ChatRunRepository chatRuns,
                                      InboxRepository inboxes, ObjectMapper objectMapper) {
        this.sessions = sessions;
        this.chatRuns = chatRuns;
        this.inboxes = inboxes;
        this.objectMapper = objectMapper;
    }

    @Transactional(readOnly = true)
    public Response project(Session parent) {
        UUID parentId = parent.getId();
        List<Session> spawnChildren = sessions.findBySpawnedFromSessionIdAndKind(parentId, Session.KIND_SPAWN);
        Map<String, Session> childrenById = new HashMap<>();
        spawnChildren.forEach(child -> childrenById.put(child.getId().toString(), child));

        List<String> childSessionIds = spawnChildren.stream().map(child -> child.getId().toString()).toList();
        List<ChatRun> activeRuns = new ArrayList<>(childSessionIds.isEmpty()
                ? List.of()
                : chatRuns.findBySessionIdInAndStatusIn(childSessionIds,
                        ChatRunCancellationService.NON_TERMINAL_STATUSES));
        activeRuns.sort(Comparator.comparing(ChatRun::getSessionId).thenComparing(run -> run.getId().toString()));
        List<ActiveChild> activeChildren = activeRuns.stream()
                .map(run -> new ActiveChild(run.getSessionId(), run.getId().toString(),
                        visibleName(parent, childrenById.get(run.getSessionId())), run.getStatus()))
                .toList();

        List<Inbox> notices = inboxes.findByToSessionIdAndTypeOrderByCreatedAtAscIdAsc(
                parentId.toString(), Inbox.TYPE_CHILD_TERMINAL);
        List<Pointer> pointers = notices.stream().map(this::parsePointer).filter(pointer -> pointer != null).toList();
        List<UUID> runIds = pointers.stream().map(Pointer::runId).distinct().toList();
        Map<UUID, ChatRun> runsById = new HashMap<>();
        if (!runIds.isEmpty()) {
            chatRuns.findAllById(runIds).forEach(run -> runsById.put(run.getId(), run));
        }

        List<TerminalNotice> terminalNotices = new ArrayList<>();
        for (Pointer pointer : pointers) {
            ChatRun run = runsById.get(pointer.runId());
            if (run == null || run.getTerminalAt() == null
                    || !pointer.sessionId().equals(run.getSessionId())) {
                // Inbox intentionally has no child FK/cascade. A child deleted independently can leave a
                // stale pointer; do not fabricate terminalAt from inbox.created_at or expose stale data.
                logger.warn("[LIFECYCLE] service=cp event=derived_notice_orphan_skipped parentSessionId={} runId={}",
                        parentId, pointer.runId());
                continue;
            }
            Session child = childrenById.get(pointer.sessionId());
            terminalNotices.add(new TerminalNotice(pointer.sessionId(), pointer.runId().toString(),
                    visibleName(parent, child), pointer.state(), run.getTerminalAt().toString()));
        }

        return new Response(parentId.toString(), activeChildren, terminalNotices);
    }

    private String visibleName(Session parent, Session child) {
        if (child == null || !Session.KIND_SPAWN.equals(child.getKind())
                || !parent.getId().equals(child.getSpawnedFromSessionId())
                || !parent.getUserId().equals(child.getUserId())
                || !parent.getWorkspaceId().equals(child.getWorkspaceId())) {
            return null;
        }
        return child.getTitle();
    }

    private Pointer parsePointer(Inbox inbox) {
        try {
            JsonNode payload = objectMapper.readTree(inbox.getPayloadPointer());
            if (payload == null || !payload.isObject()) {
                return invalidPointer(inbox);
            }
            Set<String> keys = new HashSet<>();
            payload.fieldNames().forEachRemaining(keys::add);
            if (!keys.equals(POINTER_KEYS)) {
                return invalidPointer(inbox);
            }
            String sessionId = payload.path("sessionId").asText(null);
            String runId = payload.path("runId").asText(null);
            String state = payload.path("state").asText(null);
            if (sessionId == null || runId == null || !TERMINAL_STATES.contains(state)) {
                return invalidPointer(inbox);
            }
            UUID childSessionId = UUID.fromString(sessionId);
            UUID childRunId = UUID.fromString(runId);
            if (!childRunId.toString().equals(inbox.getRef())) {
                return invalidPointer(inbox);
            }
            return new Pointer(childSessionId.toString(), childRunId, state);
        } catch (JsonProcessingException | IllegalArgumentException exception) {
            logger.warn("[LIFECYCLE] service=cp event=derived_notice_invalid parentSessionId={} inboxId={} errorType={}",
                    inbox.getToSessionId(), inbox.getId(), exception.getClass().getSimpleName());
            return null;
        }
    }

    private Pointer invalidPointer(Inbox inbox) {
        logger.warn("[LIFECYCLE] service=cp event=derived_notice_invalid parentSessionId={} inboxId={}",
                inbox.getToSessionId(), inbox.getId());
        return null;
    }

    public record Response(String sessionId, List<ActiveChild> activeChildren,
                           List<TerminalNotice> terminalNotices) {
        public Response {
            activeChildren = List.copyOf(activeChildren);
            terminalNotices = List.copyOf(terminalNotices);
        }
    }

    public record ActiveChild(String childSessionId, String runId, String name, String status) {}

    public record TerminalNotice(String childSessionId, String runId, String name,
                                 String state, String terminalAt) {}

    private record Pointer(String sessionId, UUID runId, String state) {}
}
