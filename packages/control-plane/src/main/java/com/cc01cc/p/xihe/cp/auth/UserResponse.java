package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.entity.User;

import java.time.Instant;

/**
 * PLAN-0610 W3-2b (decision #22): the user object of {@code /auth/me} and the auth responses carries
 * a {@link CapabilitiesView} instead of the retired {@code role} string. The legacy
 * {@code users.role} column is not exposed anywhere on the wire.
 */
public class UserResponse {

    private String id;
    private String email;
    /** PLAN-0581 decision #12: stable handle for the admin surface and future UI. */
    private String username;
    private String name;
    private String avatar;
    private CapabilitiesView capabilities;
    /** PLAN-0581 decision #12: ACTIVE|DISABLED, so clients can react without an extra call. */
    private String status;
    private Instant createdAt;

    public UserResponse() {}

    public static UserResponse from(User user) {
        return from(user, CapabilitiesView.NONE);
    }

    public static UserResponse from(User user, CapabilitiesView capabilities) {
        UserResponse resp = new UserResponse();
        resp.id = user.getId().toString();
        resp.email = user.getEmail();
        resp.username = user.getUsername();
        resp.name = user.getName();
        resp.avatar = user.getAvatar();
        resp.capabilities = capabilities == null ? CapabilitiesView.NONE : capabilities;
        resp.status = user.getStatus() == null ? null : user.getStatus().name();
        resp.createdAt = user.getCreatedAt();
        return resp;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getAvatar() { return avatar; }
    public void setAvatar(String avatar) { this.avatar = avatar; }

    public CapabilitiesView getCapabilities() { return capabilities; }
    public void setCapabilities(CapabilitiesView capabilities) { this.capabilities = capabilities; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
