package com.cc01cc.p.xihe.cp.telemetry;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Best-effort server-to-server relay of approved structured telemetry events to
 * the shared TLM ingest service (PLAN-0522). Disabled by default: it requires
 * the instance {@code logging.centralTelemetryEnabled} gate plus the deployment
 * XIHE_TLM_URL/XIHE_TLM_INGEST_TOKEN. Failures never block the local sink, and
 * free text ({@code message}/{@code data}) is never forwarded.
 */
@Service
public class TelemetryRelayService {

    private static final Logger log = LoggerFactory.getLogger(TelemetryRelayService.class);

    static final String GATE_DOMAIN = "logging";
    static final String GATE_KEY = "centralTelemetryEnabled";
    static final int QUEUE_CAPACITY = 256;
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(3);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(5);
    private static final long WARN_THROTTLE_MS = 300_000;

    private final ConfigService configService;
    private final ObjectMapper objectMapper;
    private final String tlmUrl;
    private final String tlmToken;
    private final String deploymentId;
    private final HttpClient httpClient;
    private final ThreadPoolExecutor executor;
    private final AtomicLong dropped = new AtomicLong();
    private final AtomicLong lastWarnAt = new AtomicLong();

    public TelemetryRelayService(ConfigService configService,
                                 ObjectMapper objectMapper,
                                 DeploymentIdProvider deploymentIdProvider,
                                 @Value("${XIHE_TLM_URL:}") String tlmUrl,
                                 @Value("${XIHE_TLM_INGEST_TOKEN:}") String tlmToken) {
        this.configService = configService;
        this.objectMapper = objectMapper;
        this.deploymentId = deploymentIdProvider.get();
        this.tlmUrl = tlmUrl == null ? "" : tlmUrl.trim();
        this.tlmToken = tlmToken == null ? "" : tlmToken.trim();
        this.httpClient = HttpClient.newBuilder().connectTimeout(CONNECT_TIMEOUT).build();
        this.executor = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(QUEUE_CAPACITY),
                runnable -> {
                    Thread thread = new Thread(runnable, "telemetry-relay");
                    thread.setDaemon(true);
                    return thread;
                },
                (runnable, pool) -> {
                    dropped.incrementAndGet();
                    warnThrottled("telemetry relay queue is full; dropping central copies");
                });
    }

    /**
     * Queues only entries with an explicit {@code eventId} and {@code eventType};
     * free-text entries stay local. Never throws and never blocks the caller.
     */
    public void forward(String batchId, List<TelemetryEntry> entries) {
        if (entries == null || entries.isEmpty() || !isEnabled()) {
            return;
        }
        List<Map<String, Object>> events = new ArrayList<>();
        for (TelemetryEntry entry : entries) {
            if (entry == null || entry.getEventId() == null || entry.getEventType() == null) {
                continue;
            }
            Map<String, Object> fields = new LinkedHashMap<>();
            if (entry.getLevel() != null) {
                fields.put("level", entry.getLevel().toUpperCase(Locale.ROOT));
            }
            if (entry.getErrorCode() != null) {
                fields.put("errorCode", entry.getErrorCode());
            }
            if (deploymentId != null) {
                fields.put("deploymentId", deploymentId);
            }
            if (entry.getServiceVersion() != null) {
                fields.put("serviceVersion", entry.getServiceVersion());
            }
            if (entry.getReleaseChannel() != null) {
                fields.put("releaseChannel", entry.getReleaseChannel());
            }
            if (entry.getOsFamily() != null) {
                fields.put("osFamily", entry.getOsFamily());
            }
            if (entry.getBrowserFamily() != null) {
                fields.put("browserFamily", entry.getBrowserFamily());
            }
            if (entry.getLang() != null) {
                fields.put("lang", entry.getLang());
            }
            if (entry.getScreenBucket() != null) {
                fields.put("screenBucket", entry.getScreenBucket());
            }
            if (entry.getAnonSessionId() != null) {
                fields.put("anonSessionId", entry.getAnonSessionId());
            }
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("eventId", entry.getEventId());
            event.put("eventType", entry.getEventType());
            event.put("occurredAt", Instant.ofEpochMilli(
                    entry.getTimestamp() > 0 ? entry.getTimestamp() : System.currentTimeMillis()).toString());
            event.put("fields", fields);
            events.add(event);
        }
        if (events.isEmpty()) {
            return;
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("schemaVersion", 1);
        body.put("batchId", batchId != null ? batchId : UUID.randomUUID().toString());
        body.put("events", events);
        String payload;
        try {
            payload = objectMapper.writeValueAsString(body);
        } catch (JsonProcessingException e) {
            warnThrottled("telemetry relay payload serialization failed");
            return;
        }
        executor.execute(() -> post(payload));
    }

    boolean isEnabled() {
        if (tlmUrl.isEmpty() || tlmToken.isEmpty()) {
            warnThrottled("telemetry relay disabled: XIHE_TLM_URL/XIHE_TLM_INGEST_TOKEN not configured");
            return false;
        }
        return "true".equalsIgnoreCase(configService.resolve(GATE_DOMAIN, GATE_KEY, null, null));
    }

    long droppedCount() {
        return dropped.get();
    }

    private void post(String payload) {
        String endpoint = tlmUrl.endsWith("/")
                ? tlmUrl + "api/v1/telemetry/events"
                : tlmUrl + "/api/v1/telemetry/events";
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                .timeout(REQUEST_TIMEOUT)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + tlmToken)
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == 202) {
                log.debug("telemetry relay accepted batch");
            } else {
                warnThrottled("telemetry relay rejected batch: status=" + response.statusCode());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            warnThrottled("telemetry relay unreachable: " + e.getClass().getSimpleName());
        }
    }

    private void warnThrottled(String message) {
        long now = System.currentTimeMillis();
        long last = lastWarnAt.get();
        if (now - last >= WARN_THROTTLE_MS && lastWarnAt.compareAndSet(last, now)) {
            log.warn(message);
        }
    }

    @PreDestroy
    public void shutdown() {
        executor.shutdownNow();
    }
}
