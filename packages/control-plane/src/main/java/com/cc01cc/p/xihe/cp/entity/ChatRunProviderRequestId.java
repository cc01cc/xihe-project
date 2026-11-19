package com.cc01cc.p.xihe.cp.entity;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

/**
 * task-103 (D-1869①): composite identity of a per-step provider record.
 *
 * <p>One row per (run, provider step) - V132 reserved this shape as B-6, V175 lifts it to the
 * primary key so a re-dispatched run records step 1 and step 2 instead of colliding on run_id.</p>
 */
public class ChatRunProviderRequestId implements Serializable {

    private UUID runId;
    private Integer providerStep;

    public ChatRunProviderRequestId() {}

    public ChatRunProviderRequestId(UUID runId, Integer providerStep) {
        this.runId = runId;
        this.providerStep = providerStep;
    }

    public UUID getRunId() { return runId; }

    public void setRunId(UUID runId) { this.runId = runId; }

    public Integer getProviderStep() { return providerStep; }

    public void setProviderStep(Integer providerStep) { this.providerStep = providerStep; }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof ChatRunProviderRequestId that)) {
            return false;
        }
        return Objects.equals(runId, that.runId) && Objects.equals(providerStep, that.providerStep);
    }

    @Override
    public int hashCode() {
        return Objects.hash(runId, providerStep);
    }
}