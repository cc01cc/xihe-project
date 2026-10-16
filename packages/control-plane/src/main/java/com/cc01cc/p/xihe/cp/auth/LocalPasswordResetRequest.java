package com.cc01cc.p.xihe.cp.auth;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** PLAN-0526: local-mode password reset payload (no old password; loopback-gated). */
public class LocalPasswordResetRequest {

    @NotBlank
    @Size(min = 8, max = 128)
    private String newPassword;

    public LocalPasswordResetRequest() {}

    public String getNewPassword() { return newPassword; }
    public void setNewPassword(String newPassword) { this.newPassword = newPassword; }
}
