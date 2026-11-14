package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.SessionParticipantCursor;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * D-1438 (task-48): the roster a <b>new workspace-less (independent)</b> session starts with.
 *
 * <p>The user's ruling (2026-11-15): an independent session is isomorphic to a normal one — several
 * members, humans included, targetable and cc-able — the only difference is that it cannot invoke
 * tools. It has no workspace, so it has no membership table to derive people from; the default
 * roster therefore comes from the config fallback chain
 * {@code workspace-default > user > instance} (the workspace layer is skipped for a session that has
 * no workspace, which degrades the chain to exactly those three layers).</p>
 *
 * <p>The key is {@code agent-runtime.defaultParticipants} (shape in
 * {@code config-schemas/agent-runtime.json}, write-side rules in {@link ConfigService}). <b>Rows are
 * snapshotted at creation</b> and are the single source of truth afterwards: sending a message never
 * re-reads the chain, so editing the config cannot retroactively rewrite an existing roster
 * ({@code V92:13-16} removed {@code cap_snapshot} for exactly that reason — no second source of
 * truth).</p>
 *
 * <p><b>A default must never block creating a session.</b> A stale or disabled principal, a
 * malformed entry, a reserved display name or a duplicated principal is skipped with a WARN; the
 * create still succeeds. That is the difference between this path and
 * {@code SessionParticipantService.add}, which answers 4xx because a user explicitly asked for the
 * row.</p>
 */
@Service
public class WorkspacelessDefaultRoster {

    /** The config domain/key pair that owns the default roster (D-1438). */
    public static final String DOMAIN = "agent-runtime";
    public static final String KEY = "defaultParticipants";

    /** Same spacing the roster uses everywhere ({@code PRIMARY_ORDER_INDEX} = 10, step 10). */
    private static final int ORDER_STEP = 10;

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Logger logger = LoggerFactory.getLogger(WorkspacelessDefaultRoster.class);

    private final ConfigService configService;
    private final SessionParticipantRepository participantRepository;
    private final SessionParticipantCursorRepository cursorRepository;
    private final UserRepository userRepository;
    private final AgentPrincipalRepository agentPrincipalRepository;

    public WorkspacelessDefaultRoster(ConfigService configService,
                                      SessionParticipantRepository participantRepository,
                                      SessionParticipantCursorRepository cursorRepository,
                                      UserRepository userRepository,
                                      AgentPrincipalRepository agentPrincipalRepository) {
        this.configService = configService;
        this.participantRepository = participantRepository;
        this.cursorRepository = cursorRepository;
        this.userRepository = userRepository;
        this.agentPrincipalRepository = agentPrincipalRepository;
    }

    /**
     * Seeds the configured defaults into a just-created workspace-less session.
     *
     * @return the ids of the participant rows actually created (never null; empty when nothing is
     *         configured) — the caller does not need the ids, tests do.
     */
    @Transactional
    public List<UUID> seed(Session session, String ownerUserId) {
        List<UUID> created = new ArrayList<>();
        if (session == null || session.getId() == null || session.getWorkspaceId() != null) {
            return created;
        }
        String raw = configService.resolve(DOMAIN, KEY, parseOwner(ownerUserId), null);
        if (raw == null || raw.isBlank()) {
            return created;
        }
        JsonNode parsed;
        try {
            parsed = MAPPER.readTree(raw);
        } catch (JsonProcessingException invalidJson) {
            // The write path validates the shape, so this only fires for a row written before the
            // schema existed (or by hand). Skipping keeps session creation working.
            logger.warn("[task-48] event=default_roster_skipped sessionId={} reason=invalid_json",
                    session.getId());
            return created;
        }
        if (!parsed.isArray()) {
            logger.warn("[task-48] event=default_roster_skipped sessionId={} reason=not_an_array",
                    session.getId());
            return created;
        }
        int orderIndex = participantRepository.maxOrderIndex(session.getId()) + ORDER_STEP;
        for (JsonNode entry : parsed) {
            try {
                SessionParticipant row = toRow(session.getId(), entry, orderIndex);
                if (row == null) {
                    continue;
                }
                SessionParticipant saved = participantRepository.save(row);
                // R7: every participant gets a cursor; a brand-new session has no events yet.
                cursorRepository.save(new SessionParticipantCursor(saved.getId(), 0L));
                created.add(saved.getId());
                orderIndex += ORDER_STEP;
            } catch (IllegalArgumentException refused) {
                logger.warn("[task-48] event=default_participant_skipped sessionId={} principalId={} "
                                + "reason={} detail={}", session.getId(),
                        entry.path("principalId").asText(""), refused.getMessage(),
                        refused.getClass().getSimpleName());
            }
        }
        if (!created.isEmpty()) {
            logger.info("[task-48] event=default_roster_seeded sessionId={} rows={}",
                    session.getId(), created.size());
        }
        return created;
    }

    /** Maps one configured entry to an unsaved row, or null when it is a no-op (already a member). */
    private SessionParticipant toRow(UUID sessionId, JsonNode entry, int orderIndex) {
        String kind = entry.path("principalKind").asText("");
        UUID principalId = parseUuid(entry.path("principalId").asText(""));
        if (!SessionParticipant.KIND_HUMAN.equals(kind) && !SessionParticipant.KIND_AGENT.equals(kind)) {
            throw new IllegalArgumentException("unknown principalKind: " + kind);
        }
        requirePrincipalUsable(kind, principalId);
        if (participantRepository.existsBySessionIdAndPrincipalKindAndPrincipalId(
                sessionId, kind, principalId)) {
            // Named twice (config + the PRIMARY this very create already wrote) — not an error.
            return null;
        }
        String role = entry.path("role").asText(SessionParticipant.ROLE_MEMBER);
        if (SessionParticipant.ROLE_PRIMARY.equals(role)) {
            // D23-13: PRIMARY is created with the session and never transferred (V92:95-96).
            throw new IllegalArgumentException("PRIMARY cannot be configured as a default member");
        }
        if (!SessionParticipant.ROLE_MEMBER.equals(role) && !SessionParticipant.ROLE_GUARD.equals(role)) {
            throw new IllegalArgumentException("unknown role: " + role);
        }
        String wake = entry.path("wakePolicy").asText(SessionParticipant.WAKE_MENTION);
        String respond = entry.path("respondPolicy").asText(SessionParticipant.RESPOND_WHEN_MENTIONED);
        SessionParticipant row = new SessionParticipant(sessionId, kind, principalId, role, orderIndex,
                wake, respond);
        row.setDeliveryDefaults(SessionParticipantDeliveryDefaults.normalize(deliveryDefaults(entry)));
        return row;
    }

    /** Stale / disabled principals are a WARN, never a failed session create (D-1438 ruling 2). */
    private void requirePrincipalUsable(String kind, UUID principalId) {
        if (SessionParticipant.KIND_HUMAN.equals(kind)) {
            if (!userRepository.existsById(principalId)) {
                throw new IllegalArgumentException("human principal does not exist");
            }
            return;
        }
        AgentPrincipal principal = agentPrincipalRepository.findById(principalId).orElse(null);
        if (principal == null) {
            throw new IllegalArgumentException("agent principal does not exist");
        }
        if (principal.getDisabledAt() != null) {
            throw new IllegalArgumentException("agent principal is disabled");
        }
    }

    private static List<String> deliveryDefaults(JsonNode entry) {
        JsonNode node = entry.path("deliveryDefaults");
        if (!node.isArray()) {
            return null;
        }
        List<String> values = new ArrayList<>();
        for (JsonNode item : node) {
            values.add(item.asText());
        }
        return values;
    }

    private static UUID parseUuid(String raw) {
        try {
            return UUID.fromString(raw);
        } catch (RuntimeException malformed) {
            throw new IllegalArgumentException("principalId is not a UUID: " + raw);
        }
    }

    private static UUID parseOwner(String ownerUserId) {
        if (ownerUserId == null || ownerUserId.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(ownerUserId);
        } catch (RuntimeException malformed) {
            return null;
        }
    }
}
