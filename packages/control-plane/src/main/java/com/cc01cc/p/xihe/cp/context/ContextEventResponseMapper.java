package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectReader;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/** Response-only mapping; never participates in the replay transaction. */
@Component
public class ContextEventResponseMapper {

    private static final Logger logger = LoggerFactory.getLogger(ContextEventResponseMapper.class);

    private final ObjectReader payloadReader = new ObjectMapper()
            .readerFor(new TypeReference<Map<String, Object>>() { })
            .with(DeserializationFeature.USE_BIG_INTEGER_FOR_INTS,
                    DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS,
                    DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    public List<ContextEventResponse> events(List<ContextEvent> events) {
        return events.stream().map(this::event).toList();
    }

    public Map<String, Object> replay(Map<String, Object> result) {
        var responses = events(replayEvents(result));
        var response = new LinkedHashMap<>(result);
        response.put("events", responses);
        return response;
    }

    @SuppressWarnings("unchecked")
    private List<ContextEvent> replayEvents(Map<String, Object> result) {
        // ContextService.replay owns this envelope and returns List<ContextEvent>.
        Object value = result.get("events");
        if (!(value instanceof List<?> list)
                || list.stream().anyMatch(item -> !(item instanceof ContextEvent))) {
            throw failure(null, "invalid_replay_events");
        }
        return (List<ContextEvent>) list;
    }

    private ContextEventResponse event(ContextEvent event) {
        try {
            Map<String, Object> payload = payloadReader.readValue(event.getPayload());
            if (payload == null) {
                throw failure(event, "null_payload");
            }
            return new ContextEventResponse(event.getSessionId(), event.getSequence(),
                    event.getEventType(), payload, event.getCreatedAt().toString(),
                    event.getCorrelationId(), event.getCausationId());
        } catch (CpApiException exception) {
            throw exception;
        } catch (JsonProcessingException | RuntimeException exception) {
            throw failure(event, exception.getClass().getSimpleName());
        }
    }

    private CpApiException failure(ContextEvent event, String category) {
        logger.error("Context event response failed eventId={} sessionId={} sequence={} category={}",
                event == null ? null : event.getId(),
                event == null ? null : event.getSessionId(),
                event == null ? null : event.getSequence(), category);
        return new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                "Context event response could not be constructed");
    }
}
