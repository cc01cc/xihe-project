package com.cc01cc.p.xihe.cp.controller;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

class RuntimeHeartbeatControllerTest {

    private final RuntimeHeartbeatState state = new RuntimeHeartbeatState();
    private final RuntimeHeartbeatController controller = new RuntimeHeartbeatController(state);

    @Test
    void initialStateIsAbsentUntilFirstHeartbeat() {
        assertThat(state.latest()).isNull();
    }

    @Test
    void blankDeviceIdIsRejectedWithoutRecordingState() {
        var response = controller.receiveHeartbeat(
                new RuntimeHeartbeatState.RuntimeHeartbeatRequest("  ", "ready", Instant.now()));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(state.latest()).isNull();
    }

    @Test
    void blankStatusIsRejectedWithoutRecordingState() {
        var response = controller.receiveHeartbeat(
                new RuntimeHeartbeatState.RuntimeHeartbeatRequest("device-a", null, Instant.now()));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(state.latest()).isNull();
    }

    @Test
    void acceptedHeartbeatIsVisibleThroughSharedState() {
        var response = controller.receiveHeartbeat(
                new RuntimeHeartbeatState.RuntimeHeartbeatRequest("device-a", "ready", Instant.parse("2026-01-01T00:00:00Z")));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        var latest = state.latest();
        assertThat(latest).isNotNull();
        assertThat(latest.deviceId()).isEqualTo("device-a");
        assertThat(latest.status()).isEqualTo("ready");
        // Server observation time is authoritative; the request timestamp is not stored.
        assertThat(latest.observedAt()).isNotNull().isAfter(Instant.parse("2026-01-01T00:00:00Z"));
    }

    @Test
    void lastAcceptedHeartbeatWins() {
        controller.receiveHeartbeat(
                new RuntimeHeartbeatState.RuntimeHeartbeatRequest("device-a", "ready", Instant.now()));
        controller.receiveHeartbeat(
                new RuntimeHeartbeatState.RuntimeHeartbeatRequest("device-b", "busy", Instant.now()));

        var latest = state.latest();
        assertThat(latest.deviceId()).isEqualTo("device-b");
        assertThat(latest.status()).isEqualTo("busy");
    }
}
