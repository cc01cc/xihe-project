package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * PLAN-0624 M2: the projection between {@code session_participants.wake_config} (the CONFIG
 * truth) and the {@code scheduled_tasks} system row (the DISPATCH truth scanned by
 * {@code ScheduledTaskScanService}).
 *
 * <p>Sync points (D24-06): participant added with {@code wake_policy=SCHEDULE}, its policy
 * patched, or it is soft-disabled/removed — each rewrites or cancels the projection row.
 * The scanner itself is untouched: wake rows ride the existing scan/CAS/missed machinery.</p>
 *
 * <p>Catch-up-once (D24-08): {@link #nextFireAfter} always bases on the moment it is called;
 * a long outage therefore produces exactly one wake, never a make-up storm.</p>
 */
@Service
public class WakeScheduleProjectionService {

    private static final Logger logger = LoggerFactory.getLogger(WakeScheduleProjectionService.class);

    /** D24-09 default when wake_config.maxConcurrent is absent. */
    public static final int DEFAULT_MAX_CONCURRENT = 4;
    /** Sub-minute wake intervals are rejected (a 30s scan tick cannot honour them honestly). */
    public static final int MIN_INTERVAL_SECONDS = 60;

    private final ScheduledTaskRepository scheduledTaskRepository;
    private final ObjectMapper objectMapper;

    public WakeScheduleProjectionService(ScheduledTaskRepository scheduledTaskRepository,
                                         ObjectMapper objectMapper) {
        this.scheduledTaskRepository = scheduledTaskRepository;
        this.objectMapper = objectMapper;
    }

    /** Creates or updates the projection row for a participant; cancels it when not SCHEDULE. */
    @Transactional
    public void syncParticipant(SessionParticipant participant, Session session) {
        List<ScheduledTask> projections = scheduledTaskRepository.findByTargetKindAndOrigin(
                ScheduledTask.TARGET_PARTICIPANT_WAKE, ScheduledTask.ORIGIN_SYSTEM).stream()
                .filter(row -> row.getPayload() != null
                        && row.getPayload().path("participantId").asText("")
                                .equals(participant.getId().toString()))
                .toList();
        boolean scheduled = SessionParticipant.WAKE_SCHEDULE.equals(participant.getWakePolicy())
                && participant.getDisabledAt() == null;
        if (!scheduled) {
            projections.forEach(this::cancelRow);
            return;
        }
        JsonNode config = participantWakeConfig(participant);
        int interval = config.path("intervalSeconds").asInt(MIN_INTERVAL_SECONDS);
        Integer jitter = config.hasNonNull("jitterSeconds")
                ? config.path("jitterSeconds").asInt() : null;
        int maxConcurrent = maxConcurrentOrDefault(config);
        if (projections.isEmpty()) {
            ScheduledTask row = new ScheduledTask();
            row.setWorkspaceId(session.getWorkspaceId() == null ? null
                    : UUID.fromString(session.getWorkspaceId()));
            row.setUserId(UUID.fromString(session.getUserId()));
            row.setTriggerKind(ScheduledTask.TRIGGER_INTERVAL);
            row.setIntervalSeconds(interval);
            row.setTimezone("UTC");
            row.setTargetKind(ScheduledTask.TARGET_PARTICIPANT_WAKE);
            row.setTargetSessionId(participant.getSessionId());
            ObjectNode payload = objectMapper.createObjectNode();
            payload.put("participantId", participant.getId().toString());
            if (jitter != null) {
                payload.put("jitterSeconds", jitter);
            }
            payload.put("maxConcurrent", maxConcurrent);
            row.setPayload(payload);
            row.setStatus(ScheduledTask.STATUS_SCHEDULED);
            row.setOrigin(ScheduledTask.ORIGIN_SYSTEM);
            row.setNextFireAt(nextFireAfter(interval, jitter, Instant.now()));
            scheduledTaskRepository.save(row);
            logger.info("[LIFECYCLE] service=cp event=wake_projection_created participantId={} "
                    + "intervalSeconds={}", participant.getId(), interval);
            return;
        }
        for (ScheduledTask row : projections) {
            boolean intervalChanged = !java.util.Objects.equals(row.getIntervalSeconds(), interval);
            row.setIntervalSeconds(interval);
            ((ObjectNode) row.getPayload()).put("maxConcurrent", maxConcurrent);
            if (jitter != null) {
                ((ObjectNode) row.getPayload()).put("jitterSeconds", jitter);
            } else {
                ((ObjectNode) row.getPayload()).remove("jitterSeconds");
            }
            if (intervalChanged && ScheduledTask.STATUS_SCHEDULED.equals(row.getStatus())) {
                // task-74: an interval change re-arms the next fire (catch-up-once: base =
                // now, never prev+interval — a shortened period must not fire immediately).
                row.setNextFireAt(nextFireAfter(interval, jitter, Instant.now()));
            }
            scheduledTaskRepository.save(row);
        }
    }

    /** Soft-disable/remove: the projection must stop firing (D24-11). */
    @Transactional
    public void cancelProjection(SessionParticipant participant) {
        scheduledTaskRepository.findByTargetKindAndOrigin(
                        ScheduledTask.TARGET_PARTICIPANT_WAKE, ScheduledTask.ORIGIN_SYSTEM)
                .stream()
                .filter(row -> row.getPayload() != null
                        && row.getPayload().path("participantId").asText("")
                                .equals(participant.getId().toString())
                        && (ScheduledTask.STATUS_SCHEDULED.equals(row.getStatus())
                                || ScheduledTask.STATUS_FIRING.equals(row.getStatus())))
                .forEach(this::cancelRow);
    }

    private void cancelRow(ScheduledTask row) {
        row.setStatus(ScheduledTask.STATUS_CANCELLED);
        row.setCancelReason("participant_disabled");
        scheduledTaskRepository.save(row);
        logger.info("[LIFECYCLE] service=cp event=wake_projection_cancelled taskId={} "
                + "participantId={}", row.getId(), row.getPayload().path("participantId").asText());
    }

    /** The participant's wake_config (V93); absent means the M2 defaults. */
    static JsonNode participantWakeConfig(SessionParticipant participant) {
        JsonNode config = participant.getWakeConfig();
        return config == null || config.isNull()
                ? com.fasterxml.jackson.databind.node.MissingNode.getInstance() : config;
    }
    /** D24-08: base + interval + jitter, jitter defaulting to [0, interval*0.1). */
    public static Instant nextFireAfter(int intervalSeconds, Integer jitterSeconds, Instant base) {
        long jitterBound = jitterSeconds != null
                ? Math.max(0, jitterSeconds)
                : Math.max(1, intervalSeconds / 10);
        long jitter = jitterBound <= 0 ? 0 : ThreadLocalRandom.current().nextLong(jitterBound);
        return base.plusSeconds(intervalSeconds + jitter);
    }

    public static int maxConcurrentOrDefault(JsonNode config) {
        return config != null && config.hasNonNull("maxConcurrent")
                ? Math.max(1, config.path("maxConcurrent").asInt(DEFAULT_MAX_CONCURRENT))
                : DEFAULT_MAX_CONCURRENT;
    }
}
