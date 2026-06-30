package com.cc01cc.p.xihe.cp.entity;

import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

class UserTest {

    @Test
    void constructorCreatesUserWithGivenFields() {
        User user = new User("test@test.com", "hash123", UserRole.USER, "Test User");

        assertEquals("test@test.com", user.getEmail());
        assertEquals("hash123", user.getPasswordHash());
        assertEquals(UserRole.USER, user.getRole());
        assertEquals("Test User", user.getName());
    }

    @Test
    void constructorAcceptsNullName() {
        User user = new User("noname@test.com", "hash123", UserRole.USER, null);

        assertEquals("noname@test.com", user.getEmail());
        assertNull(user.getName());
    }

    @Test
    void prePersistSetsCreatedAtAndUpdatedAt() {
        User user = new User("timestamp@test.com", "hash123", UserRole.USER, "Timestamp Test");

        assertNull(user.getCreatedAt());
        assertNull(user.getUpdatedAt());

        user.onCreate();

        assertNotNull(user.getCreatedAt());
        assertNotNull(user.getUpdatedAt());
        assertTrue(user.getCreatedAt().compareTo(Instant.now()) <= 0);
        assertTrue(user.getUpdatedAt().compareTo(Instant.now()) <= 0);
    }

    @Test
    void preUpdateUpdatesUpdatedAtOnly() {
        User user = new User("update@test.com", "hash123", UserRole.USER, "Update Test");
        user.onCreate();
        Instant originalCreatedAt = user.getCreatedAt();
        Instant originalUpdatedAt = user.getUpdatedAt();

        user.onUpdate();

        assertEquals(originalCreatedAt, user.getCreatedAt());
        assertTrue(user.getUpdatedAt().compareTo(originalUpdatedAt) >= 0);
    }

    @Test
    void roleCanBeSetToAdmin() {
        User user = new User("admin@test.com", "hash", UserRole.ADMIN, "Admin User");
        assertEquals(UserRole.ADMIN, user.getRole());
    }

    @Test
    void settersAndGettersWork() {
        User user = new User();
        user.setEmail("new@test.com");
        user.setPasswordHash("newhash");
        user.setRole(UserRole.ADMIN);
        user.setName("New Name");
        user.setAvatar("avatar.png");
        user.setSettings("{\"theme\":\"dark\"}");

        assertEquals("new@test.com", user.getEmail());
        assertEquals("newhash", user.getPasswordHash());
        assertEquals(UserRole.ADMIN, user.getRole());
        assertEquals("New Name", user.getName());
        assertEquals("avatar.png", user.getAvatar());
        assertEquals("{\"theme\":\"dark\"}", user.getSettings());
    }

    @Test
    void timestampsCanBeSetExternally() {
        User user = new User();
        Instant now = Instant.now();

        user.setCreatedAt(now);
        user.setUpdatedAt(now);

        assertEquals(now, user.getCreatedAt());
        assertEquals(now, user.getUpdatedAt());
    }

    @Test
    void idIsNullBeforePersist() {
        User user = new User("no-id@test.com", "hash", UserRole.USER, "No ID");
        assertNull(user.getId());
    }
}
