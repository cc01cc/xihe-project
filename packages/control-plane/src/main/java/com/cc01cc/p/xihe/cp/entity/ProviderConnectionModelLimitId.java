package com.cc01cc.p.xihe.cp.entity;

/** PLAN-0622 M1.5: composite id of {@link ProviderConnectionModelLimit}. */
public class ProviderConnectionModelLimitId implements java.io.Serializable {

    private java.util.UUID connectionId;
    private String provider;
    private String model;

    public ProviderConnectionModelLimitId() {
    }

    public ProviderConnectionModelLimitId(java.util.UUID connectionId, String provider, String model) {
        this.connectionId = connectionId;
        this.provider = provider;
        this.model = model;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof ProviderConnectionModelLimitId candidate)) {
            return false;
        }
        return java.util.Objects.equals(connectionId, candidate.connectionId)
                && java.util.Objects.equals(provider, candidate.provider)
                && java.util.Objects.equals(model, candidate.model);
    }

    @Override
    public int hashCode() {
        return java.util.Objects.hash(connectionId, provider, model);
    }
}
