package com.cc01cc.p.xihe.cp.auth;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public class LoginRequest {

    /**
     * PLAN-0565 ruling #7: dual identifier — an email (contains '@') or a
     * username. Field renamed from {@code email}; the wire contract changes in
     * the same release as the CP (no cross-release compatibility burden).
     */
    @NotBlank
    @Size(max = 255)
    private String identifier;

    @NotBlank
    private String password;

    public LoginRequest() {}

    public LoginRequest(String identifier, String password) {
        this.identifier = identifier;
        this.password = password;
    }

    public String getIdentifier() { return identifier; }
    public void setIdentifier(String identifier) { this.identifier = identifier; }

    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }
}
