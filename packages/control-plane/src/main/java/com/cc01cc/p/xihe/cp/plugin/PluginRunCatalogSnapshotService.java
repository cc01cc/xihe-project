package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0691 T1.6b (design S4 / D-62): the session plugin catalog <b>frozen at Run admission</b>.
 *
 * <p><b>Why a frozen document and not a live read.</b> Attach/detach takes effect on the next turn
 * ("next turn, not this one", D-62): the set a Run was admitted with is the set its tool face keeps,
 * even if a binding is attached or detached while it is in flight. A live read of
 * {@code session_plugin_bindings} cannot answer that question — a row is revived by a re-attach, so
 * the current row state does not remember which run saw which older set. The admission-time copy is
 * therefore captured in the same transaction as the Run row ({@code chat_runs.plugin_snapshot}, V143)
 * and never rewritten afterwards; T2.1's {@code /api/v1/mcp} {@code tools/list} filter reads that
 * document instead of the table.</p>
 *
 * <p><b>Document shape</b> (JSONB, internal — this is a column, not a wire contract):</p>
 * <pre>
 * {}                                                  // not captured (feature off / pre-T1.6b)
 * {"catalogVersion":0,"items":[],"capturedAt":"…",
 *  "snapshotSource":"admission"}                      // captured: admitted with no plugins
 * {"catalogVersion":2,"snapshotSource":"admission",  // captured: two attached bindings
 *  "capturedAt":"…",
 *  "items":[{"bindingId":"…","pluginId":"…","version":"1.0.0","digest":"…",
 *            "state":"enabled","revision":1}, …]}
 * </pre>
 *
 * <p>{@code catalogVersion} is copied from the same per-session high-water mark
 * ({@code max(revision)}) the attach/detach API reports, so a Run's frozen catalog is comparable with
 * the live one without a second counter. Marker {@code snapshotSource} distinguishes a fresh capture
 * ({@code admission}) from a continuation child inheriting its parent's document ({@code inherited},
 * the D28-39 ② analogue: "a binding added while the parent ran must not appear here").</p>
 *
 * <p><b>Ownership boundary.</b> This class only answers "what was this Run admitted with"; it does
 * <b>not</b> filter tools. Filtering {@code /api/v1/mcp} {@code tools/list} by the frozen document
 * (and the global {@code disabled}/{@code suspended} exception at the invoke gate) is T2.1, which
 * consumes {@link PluginRunSnapshot#contains(String, String, String)}.</p>
 */
@Service
public class PluginRunCatalogSnapshotService {

    private static final Logger log = LoggerFactory.getLogger(PluginRunCatalogSnapshotService.class);

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String KEY_CATALOG_VERSION = "catalogVersion";
    private static final String KEY_ITEMS = "items";
    private static final String KEY_CAPTURED_AT = "capturedAt";
    private static final String KEY_SNAPSHOT_SOURCE = "snapshotSource";
    private static final String SOURCE_ADMISSION = "admission";
    private static final String SOURCE_INHERITED = "inherited";

    private final SessionPluginBindingRepository attachments;
    private final ChatRunRepository runs;
    private final boolean enabled;

    public PluginRunCatalogSnapshotService(SessionPluginBindingRepository attachments,
            ChatRunRepository runs,
            @Value("${cp.plugin.enabled:false}") boolean enabled) {
        this.attachments = attachments;
        this.runs = runs;
        this.enabled = enabled;
    }

    /**
     * Capture the session's attached plugin catalog for a Run being admitted.
     *
     * <p>Called from {@code ChatSubmissionService#persist} inside the admission transaction, so the
     * document and the Run row commit (or roll back) together. A capture failure must never block a
     * Run (a Run is not a plugin feature): it is logged and answered as {@code {}} — "not captured",
     * the same value the feature-off default carries — so the failure cannot masquerade as "this run
     * has no plugins" ({@code {"catalogVersion":0,"items":[]}}).</p>
     *
     * @param sessionId the Session the Run belongs to; {@code null} answers {@code {}}
     */
    public JsonNode capture(UUID sessionId) {
        if (!enabled || sessionId == null) {
            return MAPPER.createObjectNode();
        }
        try {
            List<SessionPluginBinding> active =
                    attachments.findBySessionIdAndDetachedAtIsNullOrderByAttachedAtAsc(sessionId);
            ObjectNode document = MAPPER.createObjectNode();
            document.put(KEY_CATALOG_VERSION, attachments.maxRevision(sessionId));
            document.put(KEY_CAPTURED_AT, Instant.now().toString());
            document.put(KEY_SNAPSHOT_SOURCE, SOURCE_ADMISSION);
            ArrayNode items = document.putArray(KEY_ITEMS);
            for (SessionPluginBinding attachment : active) {
                JsonNode frozen = attachment.getSnapshot();
                if (frozen == null || !frozen.isObject()) {
                    // A row without a snapshot cannot name a plugin version; skipping it keeps the
                    // document honest instead of inventing fields.
                    continue;
                }
                ObjectNode item = items.addObject();
                item.put("bindingId", attachment.getBindingId().toString());
                item.put("pluginId", frozen.path("pluginId").asText(""));
                item.put("version", frozen.path("version").asText(""));
                item.put("digest", frozen.path("digest").asText(""));
                item.put("state", frozen.path("state").asText(""));
                item.put("revision", attachment.getRevision());
            }
            return document;
        } catch (RuntimeException failure) {
            log.warn("plugin catalog snapshot capture failed session={} failureType={}",
                    sessionId, failure.getClass().getSimpleName(), failure);
            return MAPPER.createObjectNode();
        }
    }

    /** The frozen document a Run was admitted with, parsed; empty for {@code {}} / malformed rows. */
    public Optional<PluginRunSnapshot> snapshotOf(ChatRun run) {
        return run == null ? Optional.empty() : parse(run.getPluginSnapshot());
    }

    /**
     * Read-side entry point T2.1 will use: the frozen catalog of the Run named by
     * {@code X-Chat-Run-Id}, without trusting the caller's Session.
     *
     * @param runId the Run id as it arrives on the wire; a malformed id answers empty (not 500)
     */
    public Optional<PluginRunSnapshot> snapshotForRun(String runId) {
        if (runId == null || runId.isBlank()) {
            return Optional.empty();
        }
        UUID id;
        try {
            id = UUID.fromString(runId.trim());
        } catch (IllegalArgumentException notAnId) {
            return Optional.empty();
        }
        return runs.findById(id).flatMap(this::snapshotOf);
    }

    /**
     * Continuation-child inheritance (D28-39 ② analogue): a child that continues a Run must see the
     * parent's plugin catalog verbatim, so a binding attached while the parent ran does not appear
     * mid-conversation. The marker is rewritten so the document stays self-describing, while
     * {@code catalogVersion}/{@code items} are inherited unchanged. An uncaptured parent
     * ({@code {}}) stays uncaptured.
     */
    public static JsonNode inherited(JsonNode source) {
        if (source == null || source.isEmpty()) {
            return MAPPER.createObjectNode();
        }
        JsonNode copy = source.deepCopy();
        if (copy.isObject()) {
            ((ObjectNode) copy).put(KEY_SNAPSHOT_SOURCE, SOURCE_INHERITED);
        }
        return copy;
    }

    private Optional<PluginRunSnapshot> parse(JsonNode document) {
        if (document == null || document.isEmpty() || !document.has(KEY_ITEMS)) {
            return Optional.empty();
        }
        JsonNode itemNodes = document.get(KEY_ITEMS);
        if (!itemNodes.isArray()) {
            // Fail-closed: a document we cannot read is "not captured", never "no plugins".
            return Optional.empty();
        }
        List<Item> items = new ArrayList<>();
        for (JsonNode itemNode : itemNodes) {
            if (!itemNode.isObject()) {
                return Optional.empty();
            }
            String pluginId = itemNode.path("pluginId").asText("");
            String version = itemNode.path("version").asText("");
            String digest = itemNode.path("digest").asText("");
            if (pluginId.isEmpty() || version.isEmpty() || digest.isEmpty()) {
                return Optional.empty();
            }
            UUID bindingId;
            try {
                bindingId = UUID.fromString(itemNode.path("bindingId").asText(""));
            } catch (IllegalArgumentException notAnId) {
                return Optional.empty();
            }
            items.add(new Item(bindingId, pluginId, version, digest,
                    itemNode.path("state").asText(""), itemNode.path("revision").asInt(0)));
        }
        return Optional.of(new PluginRunSnapshot(document.path(KEY_CATALOG_VERSION).asInt(0),
                List.copyOf(items)));
    }

    /**
     * One frozen attachment: the binding identity plus the catalog sequence value it was admitted
     * at. Enough for T2.1 to filter a merged {@code tools/list} by provenance without reading the
     * plugin registry per call.
     */
    public record Item(UUID bindingId, String pluginId, String version, String digest,
            String state, int revision) {
    }

    /**
     * The Run's frozen plugin catalog. {@code catalogVersion} is the session catalog sequence value
     * at admission (0 when the run was admitted with no attachments).
     */
    public record PluginRunSnapshot(int catalogVersion, List<Item> items) {

        /** T2.1 predicate: does this frozen catalog license this plugin tool provenance? */
        public boolean contains(String pluginId, String version, String digest) {
            for (Item item : items) {
                if (item.pluginId().equals(pluginId) && item.version().equals(version)
                        && item.digest().equals(digest)) {
                    return true;
                }
            }
            return false;
        }
    }
}
