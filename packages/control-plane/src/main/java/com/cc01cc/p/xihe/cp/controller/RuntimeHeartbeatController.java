package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

@RestController
@RequestMapping("/internal/v1/runtime")
public class RuntimeHeartbeatController {

    private static final Logger logger = LoggerFactory.getLogger(RuntimeHeartbeatController.class);

    private final RuntimeHeartbeatState heartbeatState;

    public RuntimeHeartbeatController(RuntimeHeartbeatState heartbeatState) {
        this.heartbeatState = heartbeatState;
    }

    @PostMapping("/heartbeat")
    public ResponseEntity<?> receiveHeartbeat(@RequestBody RuntimeHeartbeatState.RuntimeHeartbeatRequest request) {
        if (request.deviceId() == null || request.deviceId().isBlank()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "deviceId is required");
        }
        if (request.status() == null || request.status().isBlank()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "status is required");
        }

        RuntimeHeartbeatState.RuntimeHeartbeatRequest observed = new RuntimeHeartbeatState.RuntimeHeartbeatRequest(
                request.deviceId(), request.status(), Instant.now());
        heartbeatState.record(observed);
        logger.info("[LIFECYCLE] service=cp event=runtimeHeartbeat deviceId={} status={}",
                request.deviceId(), request.status());
        return ResponseEntity.ok(Map.of(
                "status", "accepted",
                "deviceId", request.deviceId()));
    }
}
