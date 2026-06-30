package com.cc01cc.p.xihe.cp.auth;

import jakarta.validation.constraints.NotBlank;

public class RefreshRequest {

    @NotBlank
    private String refreshToken;

    public RefreshRequest() {}

    public RefreshRequest(String refreshToken) {
        this.refreshToken = refreshToken;
    }

    public String getRefreshToken() { return refreshToken; }
    public void setRefreshToken(String refreshToken) { this.refreshToken = refreshToken; }
}
