package com.cc01cc.p.xihe.cp.auth;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public class RegisterRequest {

    @NotBlank
    @Email
    @Size(max = 255)
    private String email;

    // PLAN-0526: not @NotBlank — local mode may omit the password (server generates
    // one). Non-local mode still requires it; the controller enforces that as 400.
    @Size(min = 8, max = 128)
    private String password;

    @Size(max = 100)
    private String name;

    /**
     * PLAN-0565 ruling #7: optional at registration — when blank the CP derives
     * a default from the email local part. Format enforcement happens in
     * {@link AuthService#registerUser} (400 USERNAME_INVALID / 409 USERNAME_TAKEN).
     */
    @Size(max = 32)
    private String username;

    public RegisterRequest() {}

    public RegisterRequest(String email, String password, String name) {
        this.email = email;
        this.password = password;
        this.name = name;
    }

    public RegisterRequest(String email, String password, String name, String username) {
        this.email = email;
        this.password = password;
        this.name = name;
        this.username = username;
    }

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }
}
