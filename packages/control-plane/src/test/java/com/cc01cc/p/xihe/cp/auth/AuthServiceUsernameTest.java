package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.User;
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
    void selfFilledUsername_uppercaseAndChinese_areAcceptedSinceV29() {
        // 决策 v29（2026-11-04）：username 与 agent 主体名/昵称同规则 —— 允许大写与中文汉字。
        User english = service(repository()).registerUser(
                new RegisterRequest("zhang@example.com", "pw-12345678", "Zhang", "Zhang"));
        assertEquals("Zhang", english.getUsername());

        User chinese = service(repository()).registerUser(
                new RegisterRequest("li@example.com", "pw-12345678", "Li", "李小明"));
        assertEquals("李小明", chinese.getUsername());
    }

    @Test
    void selfFilledUsername_spacesAndSymbols_are400UsernameInvalid() {
        // v23/v29：不得含空格与符号；含前后空格也不再 trim 放行（静默 trim 会掩盖非法输入）。
        for (String invalid : new String[] {" zhang", "zhang ", "zhang san", "zhang-san", "zhang_san", "zhang.san"}) {
            AuthService service = service(repository());
            CpApiException e = assertThrows(CpApiException.class,
                    () -> service.registerUser(new RegisterRequest(
                            "zhang@example.com", "pw-12345678", "Zhang", invalid)),
                    invalid + " must be rejected");
            assertEquals(HttpStatus.BAD_REQUEST, e.getStatus());
            assertEquals("USERNAME_INVALID", e.getCode());
        }
    }

    @Test
    void selfFilledUsername_uppercase_isNoLongerRejected() {
        // 保留这条明确的回归断言：v29 之前大写会被 400，现在必须通过。
        User user = service(repository()).registerUser(
                new RegisterRequest("zhang@example.com", "pw-12345678", "Zhang", "ZhangSan"));
        assertEquals("ZhangSan", user.getUsername());
    }

    @Test
    void selfFilledUsername_tooLong_is400UsernameInvalid() {
        AuthService service = service(repository());
        CpApiException e = assertThrows(CpApiException.class, () -> service.registerUser(
                new RegisterRequest("zhang@example.com", "pw-12345678", "Zhang", "a".repeat(33))));
        assertEquals("USERNAME_INVALID", e.getCode());
    }

    @Test
    void selfFilledUsername_exactly32chars_isAccepted() {
        String username = "a".repeat(32);
        User user = service(repository()).registerUser(
                new RegisterRequest("zhang@example.com", "pw-12345678", "Zhang", username));
        assertEquals(username, user.getUsername());
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
        User user = new User("a@example.com", "stored-hash", "A", "zhangsan");
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
                mock(GrantDefaultService.class), mock(CapabilityProjectionService.class));
    }
}
