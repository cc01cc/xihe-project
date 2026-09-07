package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.entity.User;

import java.time.Instant;

public class UserResponse {

    private String id;
    private String email;
    private String name;
    private String avatar;
    private String role;
    private Instant createdAt;

    public UserResponse() {}

    public static UserResponse from(User user) {
        UserResponse resp = new UserResponse();
        resp.id = user.getId().toString();
        resp.email = user.getEmail();
        resp.name = user.getName();
        resp.avatar = user.getAvatar();
        resp.role = user.getRole().name();
        resp.createdAt = user.getCreatedAt();
        return resp;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getAvatar() { return avatar; }
    public void setAvatar(String avatar) { this.avatar = avatar; }

    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
