package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PLAN-0679 T2.3: read-side projection and diff semantics (design 4.4 + two-level model D5).
 *
 * <p>Pure unit tests (no Spring, no repository): the service is where the wire verdicts are decided,
 * so the assertions are about the document shapes a UI can actually receive — in particular that an
 * unavailable side is never silently reported as {@code unchanged}.</p>
 */
class ProviderRequestFingerprintReadServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String RUN = "00000000-0000-4000-8000-000000000001";
    private static final String OTHER = "00000000-0000-4000-8000-000000000002";

    private static ProviderRequestFingerprintReadService.Metadata metadata(String model, int messageCount) {
        ObjectNode histogram = MAPPER.createObjectNode().put("user", messageCount);
        ObjectNode sources = MAPPER.createObjectNode();
        sources.putObject("slots").put("user_input", true);
        return new ProviderRequestFingerprintReadService.Metadata(
                "openai-chat-completions", 1, model, messageCount, 2, 1024L,
                histogram, sources, 1, 1);
    }

    private static ObjectNode document(String historyHash, int historyBytes, int historyCount) {
        ObjectNode document = MAPPER.createObjectNode();
        document.put("algo", "sha256");
        document.put("dispatchAttempt", 1);
        document.put("providerStep", 1);
        ObjectNode layers = document.putObject("layers");
        layers.putObject("systemTemplate").put("hash", "same-system").put("bytes", 100);
        layers.putObject("history").put("hash", historyHash).put("bytes", historyBytes)
                .put("count", historyCount);
        layers.putObject("userInput").put("hash", "same-input").put("bytes", 40);
        layers.putObject("toolSchema").put("hash", "same-tools").put("bytes", 200).put("count", 2);
        layers.putObject("config").put("hash", "same-config").put("bytes", 12);
        document.putObject("outbound").put("hash", "out-" + historyHash).put("bytes", historyBytes + 352);
        return document;
    }

    private static ProviderRequestFingerprintReadService.View captured(String runId, String session,
                                                                      ObjectNode document) {
        return ProviderRequestFingerprintReadService.captured(
                runId, session, document, metadata("openai/gpt-5", 3));
    }

    @Test
    void absentRowIsNamedNotCapturedAndNeverReencoded() {
        ProviderRequestFingerprintReadService.View view =
                ProviderRequestFingerprintReadService.absent(RUN, "session-1");
        JsonNode envelope = ProviderRequestFingerprintReadService.envelope(view);

        assertThat(view.available()).isFalse();
        assertThat(envelope.path("available").asBoolean()).isFalse();
        assertThat(envelope.path("reason").asText()).isEqualTo("not_captured");
        // Two-level model: absence is not a stored state.
        assertThat(envelope.has("fingerprint")).isFalse();
        assertThat(envelope.has("request")).isFalse();
    }

    @Test
    void capturedEnvelopeCarriesDocumentAndMetadataVerbatim() {
        ObjectNode document = document("h", 300, 3);
        ProviderRequestFingerprintReadService.View view = captured(RUN, "session-1", document);
        JsonNode envelope = ProviderRequestFingerprintReadService.envelope(view);

        assertThat(envelope.path("available").asBoolean()).isTrue();
        assertThat(envelope.has("reason")).isFalse();
        assertThat(envelope.path("fingerprint").path("algo").asText()).isEqualTo("sha256");
        assertThat(envelope.path("request").path("model").asText()).isEqualTo("openai/gpt-5");
        assertThat(envelope.path("request").path("roleHistogram").path("user").asInt()).isEqualTo(3);
    }

    @Test
    void identicalDocumentsAreUnchangedEverywhere() {
        ObjectNode left = document("h", 300, 3);
        ObjectNode right = document("h", 300, 3);
        JsonNode diff = ProviderRequestFingerprintReadService.diff(
                captured(OTHER, "session-1", left), captured(RUN, "session-1", right));

        assertThat(diff.path("status").asText()).isEqualTo("comparable");
        assertThat(diff.path("againstRunId").asText()).isEqualTo(OTHER);
        assertThat(diff.path("runId").asText()).isEqualTo(RUN);
        for (String layer : ProviderRequestFingerprintReadService.LAYER_ORDER) {
            assertThat(diff.path("layers").path(layer).path("status").asText())
                    .as("layer %s", layer)
                    .isEqualTo("unchanged");
        }
        assertThat(diff.path("outbound").path("status").asText()).isEqualTo("unchanged");
        assertThat(diff.path("summary").path("changedLayers").size()).isZero();
        assertThat(diff.path("summary").path("unavailableLayers").size()).isZero();
    }

    @Test
    void hashChangeWithEqualCountAndBytesIsChangedSameShape() {
        // Same length, different content — the case the UI must surface, not hide as "no change".
        JsonNode diff = ProviderRequestFingerprintReadService.diff(
                captured(OTHER, "session-1", document("h", 300, 3)),
                captured(RUN, "session-1", document("H", 300, 3)));

        JsonNode history = diff.path("layers").path("history");
        assertThat(history.path("status").asText()).isEqualTo("changed(sameShape)");
        assertThat(history.path("countDelta").asInt()).isZero();
        assertThat(history.path("bytesDelta").asInt()).isZero();
        assertThat(diff.path("summary").path("changedLayers").toString()).contains("history");
    }

    @Test
    void byteAndCountGrowthAreReportedAsGrewWithDeltas() {
        JsonNode diff = ProviderRequestFingerprintReadService.diff(
                captured(OTHER, "session-1", document("h", 300, 3)),
                captured(RUN, "session-1", document("h2", 500, 5)));

        JsonNode history = diff.path("layers").path("history");
        assertThat(history.path("status").asText()).isEqualTo("changed(grew)");
        assertThat(history.path("bytesDelta").asInt()).isEqualTo(200);
        assertThat(history.path("countDelta").asInt()).isEqualTo(2);
    }

    @Test
    void smallerBytesAreReportedAsShrank() {
        JsonNode diff = ProviderRequestFingerprintReadService.diff(
                captured(OTHER, "session-1", document("h", 500, 5)),
                captured(RUN, "session-1", document("h2", 300, 3)));

        assertThat(diff.path("layers").path("history").path("status").asText())
                .isEqualTo("changed(shrank)");
        assertThat(diff.path("outbound").path("status").asText()).isEqualTo("changed(shrank)");
    }

    @Test
    void oneSidedLayerIsAddedOrRemoved() {
        ObjectNode left = document("h", 300, 3);
        ((ObjectNode) left.path("layers")).remove("toolSchema");
        ObjectNode right = document("h", 300, 3);
        ((ObjectNode) right.path("layers")).remove("config");

        JsonNode diff = ProviderRequestFingerprintReadService.diff(
                captured(OTHER, "session-1", left), captured(RUN, "session-1", right));

        assertThat(diff.path("layers").path("toolSchema").path("status").asText()).isEqualTo("added");
        assertThat(diff.path("layers").path("config").path("status").asText()).isEqualTo("removed");
    }

    @Test
    void unavailableSideWinsOverLayerComparison() {
        ProviderRequestFingerprintReadService.View missing =
                ProviderRequestFingerprintReadService.absent(OTHER, "session-1");
        ProviderRequestFingerprintReadService.View present = captured(RUN, "session-1", document("h", 3, 1));

        JsonNode diff = ProviderRequestFingerprintReadService.diff(missing, present);

        assertThat(diff.path("status").asText()).isEqualTo("unavailable");
        assertThat(diff.path("sides").toString()).contains("\"side\":\"against\"")
                .contains("\"reason\":\"not_captured\"");
        // Never downgraded to "nothing changed".
        assertThat(diff.has("layers")).isFalse();
        // Metadata of the captured side still travels (design 4.4: both runs' metadata).
        assertThat(diff.path("current").path("model").asText()).isEqualTo("openai/gpt-5");
    }

    @Test
    void errorMarkerDocumentIsUnavailableWithReasonCode() {
        ObjectNode marker = MAPPER.createObjectNode();
        marker.put("status", "error");
        marker.put("reasonCode", "FINGERPRINT_TOO_LARGE");
        ProviderRequestFingerprintReadService.View errored =
                ProviderRequestFingerprintReadService.captured(OTHER, "session-1", marker,
                        metadata("openai/gpt-5", 3));
        ProviderRequestFingerprintReadService.View ok =
                captured(RUN, "session-1", document("h", 3, 1));

        JsonNode diff = ProviderRequestFingerprintReadService.diff(errored, ok);

        assertThat(diff.path("status").asText()).isEqualTo("unavailable");
        assertThat(diff.path("sides").toString())
                .contains("\"side\":\"against\"")
                .contains("\"reasonCode\":\"FINGERPRINT_TOO_LARGE\"");
    }

    @Test
    void crossSessionDiffIsRejected() {
        ProviderRequestFingerprintReadService.View left = captured(OTHER, "session-1", document("h", 1, 1));
        ProviderRequestFingerprintReadService.View right = captured(RUN, "session-2", document("h", 1, 1));

        assertThatThrownBy(() -> ProviderRequestFingerprintReadService.diff(left, right))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("DIFF_SESSION_MISMATCH");
    }

    @Test
    void layerOrderIsTheDocumentedSixLayerOrder() {
        assertThat(ProviderRequestFingerprintReadService.LAYER_ORDER)
                .isEqualTo(List.of("systemTemplate", "history", "userInput", "toolSchema", "config"));
    }
}
