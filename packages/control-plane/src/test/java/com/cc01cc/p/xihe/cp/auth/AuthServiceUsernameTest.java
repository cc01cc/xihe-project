package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** PLAN-0565 ruling #7: username validation, derivation, and dual-identifier login. */
class AuthServiceUsernameTest {

    @Test
    void selfFilledUsername_persistsAsSupplied() {
        UserRepository repository = repository();
        AuthService service = service(repository);

        User user = service.registerUser(new RegisterRequest(
                "zhang@example.com", "pw-12345678", "Zhang", "zhangsan"));

        assertEquals("zhangsan", user.getUsername());
    }

    @Test
    void selfFilledUsername_digitStart_is400UsernameInvalid() {
        AuthService service = service(repository());
        CpApiException e = assertThrows(CpApiException.class, () -> service.registerUser(
                new RegisterRequest("zhang@example.com", "pw-12345678", "Zhang", "1zhang")));
        assertEquals(HttpStatus.BAD_REQUEST, e.getStatus());
        assertEquals("USERNAME_INVALID", e.getCode());
    }

    @Test
    void selfFilledUsername_uppercase_is400UsernameInvalid() {
        AuthService service = service(repository());
        CpApiException e = assertThrows(CpApiException.class, () -> service.registerUser(
                new RegisterRequest("zhang@example.com", "pw-12345678", "Zhang", "Zhang")));
        assertEquals("USERNAME_INVALID", e.getCode());
    }

    @Test
    void selfFilledUsername_tooLong_is400UsernameInvalid() {
        AuthService service = service(repository());
        CpApiException e = assertThrows(CpApiException.class, () -> service.registerUser(
                new RegisterRequest("zhang@example.com", "pw-12345678", "Zhang", "a".repeat(33))));
        assertEquals("USERNAME_INVALID", e.getCode());
    }

    @Test
    void selfFilledUsername_taken_is409UsernameTaken() {
        UserRepository repository = repository();
        when(repository.existsByUsername("taken")).thenReturn(true);
        AuthService service = service(repository);
        CpApiException e = assertThrows(CpApiException.class, () -> service.registerUser(
                new RegisterRequest("zhang@example.com", "pw-12345678", "Zhang", "taken")));
        assertEquals(HttpStatus.CONFLICT, e.getStatus());
        assertEquals("USERNAME_TAKEN", e.getCode());
    }

    @Test
    void blankUsername_derivesLetterFirstLocalPart() {
        UserRepository repository = repository();
        AuthService service = service(repository);

        User user = service.registerUser(
                new RegisterRequest("zhang.san@example.com", "pw-12345678", "Zhang"));

        assertEquals("zhangsan", user.getUsername());
    }

    @Test
    void blankUsername_digitLeadingLocalPart_getsUserPrefix() {
        UserRepository repository = repository();
        AuthService service = service(repository);

        User user = service.registerUser(
                new RegisterRequest("12345@example.com", "pw-12345678", "N"));

        assertEquals("user12345", user.getUsername());
    }

    @Test
    void blankUsername_conflict_appendsSequence() {
        UserRepository repository = repository();
        when(repository.existsByUsername("zhang")).thenReturn(true);
        when(repository.existsByUsername("zhang2")).thenReturn(true);
        when(repository.existsByUsername("zhang3")).thenReturn(false);
        AuthService service = service(repository);

        User user = service.registerUser(
                new RegisterRequest("zhang@example.com", "pw-12345678", "Zhang"));

        assertEquals("zhang3", user.getUsername());
    }

    @Test
    void blankUsername_longLocalPart_truncatesWithinLimit() {
        UserRepository repository = repository();
        AuthService service = service(repository);

        User user = service.registerUser(new RegisterRequest(
                "abcdefghijklmnopqrstuvwxyz0123456789@example.com", "pw-12345678", "L"));

        assertEquals(32, user.getUsername().length());
        assertEquals("abcdefghijklmnopqrstuvwxyz012345", user.getUsername());
    }

    @Test
    void authenticate_byUsername_returnsUser() {
        User user = new User("a@example.com", "stored-hash", UserRole.USER, "A", "zhangsan");
        UserRepository repository = repository();
        when(repository.findByUsername("zhangsan")).thenReturn(Optional.of(user));
        PasswordEncoder encoder = mock(PasswordEncoder.class);
        when(encoder.matches("right", "stored-hash")).thenReturn(true);
        AuthService service = service(repository, encoder);

        assertEquals(user, service.authenticate(new LoginRequest("zhangsan", "right")));
    }

    @Test
    void authenticate_unknownUsername_isCredentialFailure() {
        UserRepository repository = repository();
        when(repository.findByUsername("nobody")).thenReturn(Optional.empty());
        AuthService service = service(repository);

        assertThrows(InvalidCredentialsException.class,
                () -> service.authenticate(new LoginRequest("nobody", "pw-12345678")));
    }

    @Test
    void defaultUsernameFromEmail_coversEdgeShapes() {
        assertEquals("user", User.defaultUsernameFromEmail("...@example.com"));
        assertEquals("user123", User.defaultUsernameFromEmail("123@example.com"));
        assertEquals("abc", User.defaultUsernameFromEmail("ABC@EXAMPLE.COM"));
        assertEquals("noop", User.defaultUsernameFromEmail("noop@example.com"));
        assertEquals(32, User.defaultUsernameFromEmail(
                "abcdefghijklmnopqrstuvwxyz0123456789@example.com").length());
    }

    private static UserRepository repository() {
        UserRepository repository = mock(UserRepository.class);
        when(repository.existsByEmail(anyString())).thenReturn(false);
        when(repository.existsByUsername(anyString())).thenReturn(false);
        when(repository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        return repository;
    }

    private static AuthService service(UserRepository repository) {
        PasswordEncoder encoder = mock(PasswordEncoder.class);
        when(encoder.encode(anyString())).thenReturn("$2a$10$encoded-hash");
        return service(repository, encoder);
    }

    private static AuthService service(UserRepository repository, PasswordEncoder encoder) {
        return new AuthService(repository, encoder, mock(JwtTokenProvider.class),
                mock(GrantDefaultService.class));
    }
}
