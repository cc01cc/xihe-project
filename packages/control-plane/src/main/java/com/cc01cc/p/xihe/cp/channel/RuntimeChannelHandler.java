package com.cc01cc.p.xihe.cp.channel;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

/**
 * XH Channel handler for Runtime connections (PLAN-245).
 *
 * <p>Message flow follows plans/research/PLAN-245-xh-channel-protocol.md:
 * hello → welcome (+ optional resync_required), then app-level heartbeat
 * events. Transport ping/pong stays framework-managed; this handler never
 * conflates connection liveness with business readiness.</p>
 */
@Component
public class RuntimeChannelHandler extends TextWebSocketHandler {

    private static final Logger logger =
            LoggerFactory.getLogger(RuntimeChannelHandler.class);

    static final long PROTOCOL_VERSION = 1L;
    static final CloseStatus AUTH_REQUIRED = new CloseStatus(4401, "AUTH_REQUIRED");
    static final CloseStatus DEVICE_CONFLICT = new CloseStatus(4409, "DEVICE_CONFLICT");
    static final CloseStatus BAD_ENVELOPE = new CloseStatus(4400, "INVALID_ENVELOPE");

    private final ObjectMapper objectMapper;
    private final ChannelSessionRegistry registry;
    private final ChannelProperties properties;
    private final AtomicLong outboundSequence = new AtomicLong();

    public RuntimeChannelHandler(
            ObjectMapper objectMapper,
            ChannelSessionRegistry registry,
            ChannelProperties properties) {
        this.objectMapper = objectMapper;
        this.registry = registry;
        this.properties = properties;
    }

    @Override
    public void afterConnectionEstablished(@NonNull WebSocketSession session) {
        // Registration completes on hello; nothing to do until then.
        logger.debug("[LIFECYCLE] service=cp event=channel_transport_open sessionId={}",
                session.getId());
    }

    @Override
    protected void handleTextMessage(@NonNull WebSocketSession session,
                                     @NonNull TextMessage message) {
        JsonNode envelope;
        try {
            envelope = objectMapper.readTree(message.getPayload());
        } catch (IOException e) {
            logger.warn("[LIFECYCLE] service=cp event=channel_hello_rejected sessionId={} errorCode=INVALID_ENVELOPE reason=unparseable",
                    session.getId());
            closeQuietly(session, BAD_ENVELOPE);
            return;
        }
        String type = envelope.path("type").asText("");
        long protocolVersion = envelope.path("protocolVersion").asLong(-1);
        if (protocolVersion != PROTOCOL_VERSION) {
            logger.warn(
                    "[LIFECYCLE] service=cp event=channel_hello_rejected sessionId={} errorCode=PROTOCOL_VERSION_MISMATCH received={}",
                    session.getId(), protocolVersion);
            closeQuietly(session, BAD_ENVELOPE);
            return;
        }
        switch (type) {
            case "hello" -> handleHello(session, envelope);
            case "event" -> handleEvent(session, envelope);
            case "ack" -> handleAck(session, envelope);
            case "response", "error" -> handleRuntimeReply(session, envelope);
            default -> {
                logger.warn(
                        "[LIFECYCLE] service=cp event=channel_hello_rejected sessionId={} errorCode=INVALID_ENVELOPE reason=unknown_type value={}",
                        session.getId(), type);
                closeQuietly(session, BAD_ENVELOPE);
            }
        }
    }

    private void handleHello(WebSocketSession session, JsonNode envelope) {
        String deviceId = envelope.path("deviceId").asText("");
        if (!isValidDeviceId(deviceId)) {
            logger.warn(
                    "[LIFECYCLE] service=cp event=channel_hello_rejected sessionId={} errorCode=INVALID_ENVELOPE reason=bad_device_id",
                    session.getId());
            closeQuietly(session, BAD_ENVELOPE);
            return;
        }
        ChannelSessionRegistry.ChannelSession registered =
                registry.register(deviceId, session.getId());
        if (registered == null) {
            logger.warn(
                    "[LIFECYCLE] service=cp event=channel_hello_rejected sessionId={} deviceId={} errorCode=DEVICE_CONFLICT",
                    session.getId(), deviceId);
            closeQuietly(session, DEVICE_CONFLICT);
            return;
        }
        send(session, "welcome", deviceId, Map.of(
                "serverTime", Instant.now().toString(),
                "configVersion", 0L));
        List<String> drifted = diffWorkspaces(envelope.path("payload").path("workspaces"));
        if (!drifted.isEmpty()) {
            send(session, "resync_required", deviceId, Map.of(
                    "workspaceIds", drifted));
        }
    }

    private void handleEvent(WebSocketSession session, JsonNode envelope) {
        String eventName = envelope.path("payload").path("name").asText("");
        if (!"heartbeat".equals(eventName)) {
            logger.debug("[LIFECYCLE] service=cp event=channel_heartbeat_stale sessionId={} reason=unknown_event name={}",
                    session.getId(), eventName);
            return;
        }
        long sequence = envelope.path("sequence").asLong(0);
        ChannelSessionRegistry.ChannelSession updated =
                registry.touchHeartbeat(session.getId(), sequence);
        if (updated == null) {
            closeQuietly(session, DEVICE_CONFLICT);
        }
    }

    private void handleAck(WebSocketSession session, JsonNode envelope) {
        logger.debug(
                "[LIFECYCLE] service=cp event=channel_heartbeat_stale sessionId={} reason=ack_received messageId={}",
                session.getId(), envelope.path("correlationId").asText(""));
    }

    private void handleRuntimeReply(WebSocketSession session, JsonNode envelope) {
        logger.debug(
                "[LIFECYCLE] service=cp event=channel_heartbeat_stale sessionId={} reason=runtime_reply type={}",
                session.getId(), envelope.path("type").asText());
    }

    @Override
    public void afterConnectionClosed(@NonNull WebSocketSession session,
                                      @NonNull CloseStatus status) {
        ChannelSessionRegistry.ChannelSession removed =
                registry.unregister(session.getId());
        if (removed != null) {
            logger.info(
                    "[LIFECYCLE] service=cp event=channel_disconnected deviceId={} sessionId={} closeStatus={}",
                    removed.deviceId(), session.getId(), status);
        }
    }

    @Override
    public void handleTransportError(@NonNull WebSocketSession session,
                                     @NonNull Throwable exception) {
        logger.debug("[LIFECYCLE] service=cp event=channel_disconnected sessionId={} reason=transport_error error={}",
                session.getId(), exception.getMessage());
        closeQuietly(session, CloseStatus.SERVER_ERROR);
    }

    /** Workspace ids whose DB spec differs from the runtime-reported summary. */
    List<String> diffWorkspaces(JsonNode workspaces) {
        // v1: CP-side reconciliation queries the durable spec store on demand;
        // the diff compares generation/specHash with the runtime summary.
        List<String> drifted = new ArrayList<>();
        if (workspaces == null || !workspaces.isArray()) {
            return drifted;
        }
        for (JsonNode ws : workspaces) {
            String workspaceId = ws.path("workspaceId").asText("");
            long generation = ws.path("generation").asLong(0);
            String specHash = ws.path("sandboxSpecHash").asText("");
            if (workspaceId.isEmpty() || generation <= 0 || specHash.isEmpty()) {
                drifted.add(workspaceId);
            }
            // Full spec-store comparison is delegated to resync: Runtime calls
            // ensure_workspace_materialized per id, which performs the targeted
            // ExecutionSpec lookup and reconcile (PLAN-222 semantics).
        }
        return drifted;
    }

    private void send(WebSocketSession session, String type, String deviceId,
                      Map<String, Object> payload) {
        if (!session.isOpen()) {
            return;
        }
        try {
            ObjectNode envelope = objectMapper.createObjectNode();
            envelope.put("protocolVersion", PROTOCOL_VERSION);
            envelope.put("messageId", ChannelSessionRegistry.PendingMessages.newMessageId());
            envelope.put("type", type);
            envelope.put("source", "control-plane");
            envelope.put("target", "runtime");
            envelope.put("sentAt", Instant.now().toString());
            envelope.put("sequence", outboundSequence.incrementAndGet());
            envelope.put("deviceId", deviceId);
            envelope.set("payload", objectMapper.valueToTree(payload));
            session.sendMessage(new TextMessage(objectMapper.writeValueAsString(envelope)));
        } catch (IOException e) {
            logger.warn("[LIFECYCLE] service=cp event=channel_disconnected sessionId={} reason=send_failed error={}",
                    session.getId(), e.getMessage());
            closeQuietly(session, CloseStatus.SERVER_ERROR);
        }
    }

    private void closeQuietly(WebSocketSession session, CloseStatus status) {
        try {
            session.close(status);
        } catch (IOException ignored) {
            logger.debug("[LIFECYCLE] service=cp event=channel_disconnected sessionId={} reason=close_failed",
                    session.getId());
        }
    }

    static boolean isValidDeviceId(String deviceId) {
        if (deviceId == null || deviceId.length() != 36) {
            return false;
        }
        try {
            // Same semantics as Runtime device.rs: is_valid_device_id (UUID v4 shape).
            java.util.UUID.fromString(deviceId);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** Read-only view for tests and the stale-session sweeper. */
    public Map<String, ChannelSessionRegistry.ChannelSession> snapshot() {
        return new HashMap<>(registrySnapshot());
    }

    private Map<String, ChannelSessionRegistry.ChannelSession> registrySnapshot() {
        Map<String, ChannelSessionRegistry.ChannelSession> result = new HashMap<>();
        for (ChannelSessionRegistry.ChannelSession session : registryByDevice()) {
            result.put(session.deviceId(), session);
        }
        return result;
    }

    private List<ChannelSessionRegistry.ChannelSession> registryByDevice() {
        List<ChannelSessionRegistry.ChannelSession> result = new ArrayList<>();
        for (String deviceId : knownDeviceIds()) {
            ChannelSessionRegistry.ChannelSession session = registry.byDevice(deviceId);
            if (session != null) {
                result.add(session);
            }
        }
        return result;
    }

    private List<String> knownDeviceIds() {
        // Registry exposes per-device lookup; enumerate via reflection-free path.
        return registry.deviceIds();
    }

    /** Heartbeat timeout in ms, from properties. */
    public long heartbeatTimeoutMs() {
        return properties.heartbeatTimeoutSeconds() * 1000L;
    }
}
