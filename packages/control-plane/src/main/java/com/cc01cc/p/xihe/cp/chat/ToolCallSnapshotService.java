package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * PLAN-0572 D1=A: builds the bounded tool-call snapshot persisted on an
 * assistant Message.
 *
 * <p>The source is the Run's own durable tool events. The durable payload is
 * already sanitized by CP (result bodies are placeholders), so this service
 * never has access to raw tool output; it only normalizes card metadata.</p>
 */
@Service
public class ToolCallSnapshotService {

    private static final Logger logger = LoggerFactory.getLogger(ToolCallSnapshotService.class);

    static final int ARG_LIMIT = 4096;
    static final int RESULT_LIMIT = 4096;
    static final int MAX_CALLS = 200;
    static final int MESSAGE_BUDGET_BYTES = 64 * 1024;
    static final int MIN_ARG_BUDGET = 256;

    private static final Set<String> EVENT_TYPES = Set.of("tool.called", "tool.result");
    private static final String APPROVAL_TOOL = "request_approval";

    private final EventStoreRepository eventStoreRepository;
    private final ObjectMapper objectMapper;

    public ToolCallSnapshotService(EventStoreRepository eventStoreRepository,
                                   ObjectMapper objectMapper) {
        this.eventStoreRepository = eventStoreRepository;
        this.objectMapper = objectMapper;
    }

    /**
     * Returns the compact JSON snapshot, or {@code null} when the Run has no
     * projected tool calls (or the projection failed — message persistence must
     * never be blocked by this snapshot).
     */
    public String snapshotJson(String sessionId, String runId) {
        if (sessionId == null || sessionId.isBlank() || runId == null || runId.isBlank()) {
            return null;
        }
        try {
            List<ContextEvent> events =
                    eventStoreRepository.findBySessionIdAndCorrelationIdAndEventTypeInOrderByCreatedAtAscIdAsc(
                            sessionId, runId, EVENT_TYPES);
            return buildSnapshot(events);
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=tool_calls_snapshot_failed runId={} errorType={}",
                    runId, e.getClass().getSimpleName(), e);
            return null;
        }
    }

    private String buildSnapshot(List<ContextEvent> events) {
        Map<String, Card> cards = new LinkedHashMap<>();
        for (ContextEvent event : events) {
            JsonNode payload = parsePayload(event);
            if (payload == null) {
                logger.debug("[LIFECYCLE] service=cp event=tool_call_snapshot_event_skipped runId={} reason=payload",
                        event.getCorrelationId());
                continue;
            }
            String id = firstText(payload, "toolCallId", "call_id");
            String name = firstText(payload, "toolName", "tool_name");
            if (id == null || name == null) {
                logger.debug("[LIFECYCLE] service=cp event=tool_call_snapshot_event_skipped runId={} reason=identity",
                        event.getCorrelationId());
                continue;
            }
            if (APPROVAL_TOOL.equals(name)) {
                continue;
            }
            if ("tool.called".equals(event.getEventType())) {
                if (!cards.containsKey(id)) {
                    cards.put(id, new Card(id, name, event.getCreatedAt(),
                            serializeArguments(payload)));
                }
                continue;
            }
            Card card = cards.get(id);
            if (card == null || card.completedAt != null) {
                continue;
            }
            card.completedAt = event.getCreatedAt();
            card.status = status(text(payload, "status"), true);
            String resultText = bound(extractResult(payload.get("result")), RESULT_LIMIT, false).text();
            card.result = resultText == null || resultText.isBlank() ? null : resultText;
        }
        if (cards.isEmpty()) {
            return null;
        }
        List<Card> ordered = new ArrayList<>(cards.values());
        int total = ordered.size();
        boolean truncated = false;
        if (ordered.size() > MAX_CALLS) {
            ordered = new ArrayList<>(ordered.subList(0, MAX_CALLS));
            truncated = true;
            logger.info("[LIFECYCLE] service=cp event=tool_calls_snapshot_capped total={} kept={}",
                    total, MAX_CALLS);
        }
        return render(ordered, truncated, total);
    }

    private String render(List<Card> cards, boolean truncated, int total) {
        int budget = ARG_LIMIT;
        String json = renderJson(cards, budget, truncated, total);
        while (json != null
                && json.getBytes(StandardCharsets.UTF_8).length > MESSAGE_BUDGET_BYTES
                && budget > MIN_ARG_BUDGET) {
            budget = Math.max(MIN_ARG_BUDGET, budget / 2);
            json = renderJson(cards, budget, truncated, total);
        }
        if (json != null && json.getBytes(StandardCharsets.UTF_8).length > MESSAGE_BUDGET_BYTES) {
            json = renderJson(cards, 0, truncated, total);
        }
        return json;
    }

    private String renderJson(List<Card> cards, int argBudget, boolean truncated, int total) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("version", 1);
        root.put("truncated", truncated);
        root.put("total", total);
        ArrayNode calls = root.putArray("calls");
        for (Card card : cards) {
            Bound bound = bound(card.arguments, argBudget, true);
            ObjectNode call = calls.addObject();
            call.put("id", card.id);
            call.put("name", card.name);
            call.put("arguments", bound.text());
            call.put("truncated", bound.truncated());
            call.put("status", card.completedAt == null
                    ? status(null, false) : status(card.status, true));
            call.put("startedAt", card.startedAt.toString());
            if (card.completedAt != null) {
                call.put("completedAt", card.completedAt.toString());
            }
            if (card.result != null) {
                call.put("result", card.result);
            }
        }
        try {
            return objectMapper.writeValueAsString(root);
        } catch (JsonProcessingException e) {
            logger.warn("[LIFECYCLE] service=cp event=tool_calls_snapshot_serialize_failed errorType={}",
                    e.getClass().getSimpleName(), e);
            return null;
        }
    }

    private JsonNode parsePayload(ContextEvent event) {
        try {
            return objectMapper.readTree(event.getPayload());
        } catch (JsonProcessingException e) {
            logger.warn("[LIFECYCLE] service=cp event=tool_call_snapshot_payload_invalid runId={}",
                    event.getCorrelationId(), e);
            return null;
        }
    }

    private String serializeArguments(JsonNode payload) {
        JsonNode arguments = payload.has("arguments") ? payload.get("arguments") : payload.get("tool_input");
        if (arguments == null || arguments.isNull()) {
            return "{}";
        }
        if (arguments.isTextual()) {
            String text = arguments.asText();
            return text.isBlank() ? "{}" : text;
        }
        try {
            return objectMapper.writeValueAsString(arguments);
        } catch (JsonProcessingException e) {
            logger.warn("[LIFECYCLE] service=cp event=tool_call_snapshot_args_serialize_failed errorType={}",
                    e.getClass().getSimpleName(), e);
            return "{}";
        }
    }

    private String extractResult(JsonNode result) {
        if (result == null || result.isNull()) {
            return null;
        }
        if (result.isTextual()) {
            return result.asText();
        }
        JsonNode preview = result.get("preview");
        if (preview != null && preview.isTextual()) {
            return preview.asText();
        }
        try {
            return objectMapper.writeValueAsString(result);
        } catch (JsonProcessingException e) {
            logger.warn("[LIFECYCLE] service=cp event=tool_call_snapshot_result_serialize_failed errorType={}",
                    e.getClass().getSimpleName(), e);
            return null;
        }
    }

    private static String firstText(JsonNode payload, String primary, String legacy) {
        for (String key : List.of(primary, legacy)) {
            JsonNode value = payload.get(key);
            if (value != null && value.isTextual() && !value.asText().isBlank()) {
                return value.asText();
            }
        }
        return null;
    }

    private static String text(JsonNode payload, String key) {
        JsonNode value = payload.get(key);
        return value != null && value.isTextual() && !value.asText().isBlank() ? value.asText() : null;
    }

    private static String status(String raw, boolean hasResult) {
        if (raw == null || raw.isBlank()) {
            return hasResult ? "completed" : "running";
        }
        return switch (raw) {
            case "completed", "succeeded" -> "completed";
            case "cancelled" -> "cancelled";
            case "pending" -> "pending";
            default -> "failed";
        };
    }

    /** Bounds one text field; the marker is itself a valid compact JSON string. */
    static Bound bound(String raw, int limit, boolean arguments) {
        if (raw == null) {
            return new Bound(arguments ? "{}" : "", false);
        }
        if (limit <= 0 || raw.length() <= limit) {
            return new Bound(raw, false);
        }
        int prefixLength = Math.max(0, Math.min(4000, limit - 128));
        String prefix = raw.substring(0, prefixLength);
        String marker = "{\"__xihe_truncated__\":true,\"__chars__\":" + raw.length()
                + ",\"__prefix__\":" + quote(prefix) + "}";
        if (marker.length() > limit) {
            marker = "{\"__xihe_truncated__\":true,\"__chars__\":" + raw.length()
                    + ",\"__prefix__\":\"\"}";
        }
        return new Bound(marker, true);
    }

    private static String quote(String value) {
        StringBuilder builder = new StringBuilder(value.length() + 2);
        builder.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> builder.append("\\\"");
                case '\\' -> builder.append("\\\\");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> {
                    if (c < 0x20) {
                        builder.append(String.format("\\u%04x", (int) c));
                    } else {
                        builder.append(c);
                    }
                }
            }
        }
        return builder.append('"').toString();
    }

    private static final class Card {
        private final String id;
        private final String name;
        private final Instant startedAt;
        private final String arguments;
        private Instant completedAt;
        private String status;
        private String result;

        private Card(String id, String name, Instant startedAt, String arguments) {
            this.id = id;
            this.name = name;
            this.startedAt = startedAt;
            this.arguments = arguments;
        }
    }

    record Bound(String text, boolean truncated) {
    }
}
