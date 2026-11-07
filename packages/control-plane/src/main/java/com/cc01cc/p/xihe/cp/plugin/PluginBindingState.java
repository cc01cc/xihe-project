package com.cc01cc.p.xihe.cp.plugin;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

import java.util.Arrays;
import java.util.List;

/**
 * PLAN-0691 T1.2 (spec/data-plane.md SEC-2): the binding state machine vocabulary.
 *
 * <p>The wire vocabulary is the lowercase five-state set frozen in
 * {@code spec/openapi-delta.md} §2 — {@code pending / enabled / degraded / suspended / disabled} —
 * shared with the T2.5 plugin health machine. Two properties matter for T1.2 and are encoded here
 * instead of being re-typed in the service:</p>
 *
 * <ul>
 *   <li>{@link #PENDING} and {@link #SUSPENDED} are <b>not operator-writable</b>: a binding stays
 *       pending until the plugin itself is enabled, and {@code suspended} may only be written by the
 *       CP circuit breaker. A PATCH that asks for either is a client error, not a silent no-op.</li>
 *   <li>A binding can only be {@link #ENABLED} while its plugin version row is enabled — that
 *       coupling lives in the service, because it needs the registry row.</li>
 * </ul>
 */
public enum PluginBindingState {

    PENDING("pending"),
    ENABLED("enabled"),
    DEGRADED("degraded"),
    SUSPENDED("suspended"),
    DISABLED("disabled");

    private final String wire;

    PluginBindingState(String wire) {
        this.wire = wire;
    }

    /** The lowercase value stored in {@code plugin_bindings.state} and sent on the wire. */
    public String wire() {
        return wire;
    }

    public static List<String> wireValues() {
        return Arrays.stream(values()).map(PluginBindingState::wire).toList();
    }

    /**
     * Resolve a stored/wire value.
     *
     * @throws CpApiException 500 when the database holds a value the CHECK constraint should have
     *     refused — that is a broken invariant, never a client error.
     */
    public static PluginBindingState of(String value) {
        for (PluginBindingState state : values()) {
            if (state.wire.equals(value)) {
                return state;
            }
        }
        throw new CpApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INVALID_BINDING_STATE",
                "plugin_bindings.state holds an unknown value: " + value);
    }

    /** Whether an operator may move the binding into this state with PATCH. */
    public boolean operatorWritable() {
        return this == ENABLED || this == DISABLED;
    }

    /** Resolve a PATCH-provided state, refusing the CP-owned values with 400 INVALID_REQUEST. */
    public static PluginBindingState parseOperatorState(String value) {
        if (value == null || value.isBlank()) {
            throw invalid("state is required when provided");
        }
        PluginBindingState state;
        try {
            state = of(value.trim().toLowerCase(java.util.Locale.ROOT));
        } catch (CpApiException e) {
            throw invalid("unknown binding state " + value + "; expected one of "
                    + String.join("|", wireValues()));
        }
        if (!state.operatorWritable()) {
            throw invalid("state " + state.wire()
                    + " is written by the control plane, not by the operator; use enabled|disabled");
        }
        return state;
    }

    private static CpApiException invalid(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
