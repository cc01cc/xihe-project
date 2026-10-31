package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.entity.User;

import java.time.Instant;

/**
 * PLAN-0581 §3: the admin view of an account, shared by list rows and the detail
 * endpoint (same shape in both).
 *
 * <p>Deliberately absent: {@code passwordHash}, {@code tokenVersion},
 * {@code sessionVersion} (contract §2 "数据隔离"): the epoch columns are internal
 * revocation machinery, and exposing them would let an operator compute when a
 * session dies. {@code deletedAt} is only non-null on a soft-deleted row.
 *
 * <p>PLAN-0610 W3-2b (decision #22): the legacy {@code role} string is gone from this view; the
 * admin surface shows the binding-backed {@link CapabilitiesView} instead.
 */
public class UserAdminView {

    private String id;
    private String email;
    private String username;
    private String name;
    private CapabilitiesView capabilities;
    private String status;
    private Instant deletedAt;
    private Instant createdAt;

    public static UserAdminView from(User user) {
        return from(user, CapabilitiesView.NONE);
    }

    public static UserAdminView from(User user, CapabilitiesView capabilities) {
        UserAdminView view = new UserAdminView();
        view.id = user.getId().toString();
        view.email = user.getEmail();
        view.username = user.getUsername();
        view.name = user.getName();
        view.capabilities = capabilities == null ? CapabilitiesView.NONE : capabilities;
        view.status = user.getStatus() == null ? null : user.getStatus().name();
        view.deletedAt = user.getDeletedAt();
        view.createdAt = user.getCreatedAt();
        return view;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public CapabilitiesView getCapabilities() { return capabilities; }
    public void setCapabilities(CapabilitiesView capabilities) { this.capabilities = capabilities; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public Instant getDeletedAt() { return deletedAt; }
    public void setDeletedAt(Instant deletedAt) { this.deletedAt = deletedAt; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
