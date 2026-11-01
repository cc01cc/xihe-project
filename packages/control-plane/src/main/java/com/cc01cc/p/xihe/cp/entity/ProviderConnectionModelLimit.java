package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;

import java.util.UUID;

/**
 * PLAN-0622 M1.5 (V90): per-model overrides of a connection's resource limits.
 *
 * <p>An omitted column inherits the connection-level value; {@code null} everywhere means the model
 * behaves like its connection. The row is configuration only — the governor keeps the runtime
 * counters in memory.</p>
 */
@Entity
@Table(name = "provider_connection_model_limits")
@IdClass(ProviderConnectionModelLimitId.class)
public class ProviderConnectionModelLimit {

    @Id
    @Column(name = "connection_id", columnDefinition = "uuid")
    private UUID connectionId;

    @Id
    @Column(nullable = false, length = 128)
    private String provider;

    @Id
    @Column(nullable = false, length = 128)
    private String model;

    @Column(name = "max_inflight")
    private Integer maxInflight;

    @Column(name = "window_token_budget")
    private Long windowTokenBudget;

    @Column(name = "window_seconds")
    private Integer windowSeconds;

    public UUID getConnectionId() {
        return connectionId;
    }

    public void setConnectionId(UUID connectionId) {
        this.connectionId = connectionId;
    }

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public Integer getMaxInflight() {
        return maxInflight;
    }

    public void setMaxInflight(Integer maxInflight) {
        this.maxInflight = maxInflight;
    }

    public Long getWindowTokenBudget() {
        return windowTokenBudget;
    }

    public void setWindowTokenBudget(Long windowTokenBudget) {
        this.windowTokenBudget = windowTokenBudget;
    }

    public Integer getWindowSeconds() {
        return windowSeconds;
    }

    public void setWindowSeconds(Integer windowSeconds) {
        this.windowSeconds = windowSeconds;
    }
}
