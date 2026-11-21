package com.cc01cc.p.xihe.cp.config;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * D-1535 (task-5, formerly task-149): the wire face of {@code POST
 * /api/v1/bootstrap/first-run-account} and its rewrite sibling.
 *
 * <p>This is an assembly-level test on purpose (the checklist's "new route" rule): the real
 * controller, the real {@link FirstRunAccountService}, the real password encoder and the real
 * problem-details advice are wired together, and only the repository is mocked. The questions it
 * answers are the four the card freezes: the first call returns the one-time payload; the second is
 * 410; a rewrite makes the old password fail and the new one succeed; and no log event carries either
 * value.</p>
 *
 * <p><b>Credential hygiene.</b> No literal credential appears here. The generated value is read from
 * {@link DataSeeder#seededAdminPassword()} (whatever this JVM resolved) and every rewritten password
 * is minted at runtime, so a failing assertion's message can never print a real secret. The log
 * assertion is written as "does not contain", never as an expected-value match.</p>
 */
class FirstRunAccountDisclosureHttpTest {

    private static final String BASE = "/api/v1/bootstrap/first-run-account";
    private static final String LOOPBACK_HOST = "127.0.0.1:12641";
    private static final Function<String, String> DEV = key -> "dev";

    private UserRepository users;
    private PasswordEncoder encoder;
    private User admin;
    private FirstRunAccountService service;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        users = Mockito.mock(UserRepository.class);
        encoder = new BCryptPasswordEncoder(4);
        admin = new User(FirstRunAccountService.SEEDED_ADMIN_EMAIL,
                encoder.encode(DataSeeder.seededAdminPassword()), "Admin");
        admin.setId(UUID.randomUUID());
        when(users.count()).thenReturn(1L);
        when(users.findByEmail(FirstRunAccountService.SEEDED_ADMIN_EMAIL))
                .thenReturn(Optional.of(admin));
        when(users.save(any(User.class))).thenAnswer(invocation -> invocation.getArgument(0));
        service = new FirstRunAccountService(users, encoder, true, key -> null, () -> null);
        mockMvc = mvc(service, DEV);
    }

    private static MockMvc mvc(FirstRunAccountService service, Function<String, String> env) {
        return MockMvcBuilders
                .standaloneSetup(new FirstRunAccountController(service, env))
                .setControllerAdvice(new ProblemDetailsHandler(5000))
                .build();
    }

    private static MockHttpServletRequestBuilder local(MockHttpServletRequestBuilder builder) {
        return builder.header("Host", LOOPBACK_HOST)
                .with(request -> {
                    request.setRemoteAddr("127.0.0.1");
                    return request;
                });
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> json(MvcResult result) throws Exception {
        return new ObjectMapper().readValue(result.getResponse().getContentAsString(), Map.class);
    }

    /* ---------------- judgement 1: the first call carries the one-time payload ---------------- */

    @Test
    void firstDisclosureReturnsTheGeneratedSecretOnce() throws Exception {
        MvcResult result = mockMvc.perform(local(post(BASE)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value(FirstRunAccountService.STATE_GENERATED))
                .andExpect(jsonPath("$.account.email").value(FirstRunAccountService.SEEDED_ADMIN_EMAIL))
                .andExpect(jsonPath("$.account.username").value(admin.getUsername()))
                .andExpect(jsonPath("$.secret.issuedAt").isNotEmpty())
                .andReturn();
        Object disclosed = ((Map<String, Object>) json(result).get("secret")).get("value");
        assertTrue(disclosed instanceof String text && !text.isBlank(),
                "the generated payload must carry a non-blank secret.value");
        assertTrue(Objects.equals(DataSeeder.seededAdminPassword(), disclosed),
                "the disclosed value must be this boot's generated password");
    }

    /* ---------------- judgement 2: the second call is 410, and GET is 405 ---------------- */

    @Test
    void secondDisclosureIsGoneWithNoSecret() throws Exception {
        mockMvc.perform(local(post(BASE))).andExpect(status().isOk());

        MvcResult second = mockMvc.perform(local(post(BASE)))
                .andExpect(status().isGone())
                .andExpect(jsonPath("$.code").value(FirstRunAccountService.CODE_ALREADY_DISCLOSED))
                .andReturn();
        assertFalse(second.getResponse().getContentAsString().contains(
                        DataSeeder.seededAdminPassword()),
                "the 410 marker must not repeat the plaintext");
    }

    @Test
    void getIsMethodNotAllowed() throws Exception {
        mockMvc.perform(local(get(BASE))).andExpect(status().isMethodNotAllowed());
        mockMvc.perform(local(get(BASE + "/rewrite"))).andExpect(status().isMethodNotAllowed());
    }

    /* ---------------- the four-part local gate ---------------- */

    @Test
    void nonLoopbackPeerIsRefused() throws Exception {
        mockMvc.perform(post(BASE).header("Host", LOOPBACK_HOST)
                        .with(request -> {
                            request.setRemoteAddr("10.0.0.7");
                            return request;
                        }))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value(FirstRunAccountService.CODE_NOT_AVAILABLE));
    }

    @Test
    void nonLoopbackHostIsRefused() throws Exception {
        mockMvc.perform(post(BASE).header("Host", "evil.example")
                        .with(request -> {
                            request.setRemoteAddr("127.0.0.1");
                            return request;
                        }))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value(FirstRunAccountService.CODE_NOT_AVAILABLE));
    }

    @Test
    void crossSiteOriginIsRefused() throws Exception {
        mockMvc.perform(local(post(BASE)).header("Origin", "https://evil.example"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value(FirstRunAccountService.CODE_NOT_AVAILABLE));
    }

    @Test
    void prodClosesTheFace() throws Exception {
        mvc(service, key -> "prod").perform(local(post(BASE)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value(FirstRunAccountService.CODE_NOT_AVAILABLE));
    }

    /* ---------------- the three password paths ---------------- */

    @Test
    void operatorProvidedPasswordIsNeverEchoed() throws Exception {
        String operatorValue = "operator-" + UUID.randomUUID();
        FirstRunAccountService operator = new FirstRunAccountService(users, encoder, true,
                key -> "XIHE_DEV_ADMIN_PASSWORD".equals(key) ? operatorValue : "dev", () -> null);

        MvcResult result = mvc(operator, DEV).perform(local(post(BASE)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value(FirstRunAccountService.STATE_OPERATOR))
                .andExpect(jsonPath("$.source").value("env"))
                .andReturn();
        Map<String, Object> body = json(result);
        assertNull(body.get("secret"), "path C must answer secret: null (D-1535 ②)");
        assertFalse(result.getResponse().getContentAsString().contains(operatorValue),
                "the operator secret must never be echoed");
    }

    @Test
    void seedSwitchedOffIsUnavailable() throws Exception {
        FirstRunAccountService off = new FirstRunAccountService(users, encoder, false,
                key -> null, () -> null);
        mvc(off, DEV).perform(local(post(BASE)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value(FirstRunAccountService.CODE_NOT_AVAILABLE));
    }

    @Test
    void anotherAccountClosesTheSingleUserGate() throws Exception {
        when(users.count()).thenReturn(2L);
        mockMvc.perform(local(post(BASE)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value(FirstRunAccountService.CODE_NOT_AVAILABLE));
    }

    /**
     * Restart case: the row exists but this boot's generated value was not applied. Handing it out
     * would be a credential that cannot log in, so the face fails closed.
     */
    @Test
    void generatedValueThatIsNotTheStoredCredentialIsRefused() throws Exception {
        admin.setPasswordHash(encoder.encode("other-" + UUID.randomUUID()));
        mockMvc.perform(local(post(BASE)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value(FirstRunAccountService.CODE_NOT_AVAILABLE));
    }

    /* ---------------- judgement 3: rewrite swaps the credential and revokes tokens ---------------- */

    @Test
    void rewriteMakesTheOldPasswordFailAndTheNewOneSucceed() throws Exception {
        String newPassword = "pw-" + UUID.randomUUID();
        String newUsername = "root" + UUID.randomUUID().toString().replace("-", "").substring(0, 6);

        mockMvc.perform(local(post(BASE + "/rewrite"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"" + newUsername + "\",\"password\":\""
                                + newPassword + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.secretRevoked").value(true))
                .andExpect(jsonPath("$.account.username").value(newUsername));

        assertTrue(encoder.matches(newPassword, admin.getPasswordHash()),
                "the rewritten password must authenticate");
        assertFalse(encoder.matches(DataSeeder.seededAdminPassword(), admin.getPasswordHash()),
                "the disclosed password must stop authenticating");
        assertEquals(1, admin.getTokenVersion(), "the access-token epoch must be bumped");
        assertEquals(1, admin.getSessionVersion(), "the refresh-token epoch must be bumped");

        // The one-time window is closed: no re-disclosure after a rewrite.
        mockMvc.perform(local(post(BASE))).andExpect(status().isGone());
    }

    @Test
    void secondRewriteConflicts() throws Exception {
        String body = "{\"password\":\"pw-" + UUID.randomUUID() + "\"}";
        mockMvc.perform(local(post(BASE + "/rewrite"))
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk());
        mockMvc.perform(local(post(BASE + "/rewrite"))
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value(FirstRunAccountService.CODE_ALREADY_REWRITTEN));
    }

    @Test
    void emailIsNotPartOfTheRewriteFace() throws Exception {
        mockMvc.perform(local(post(BASE + "/rewrite"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"x@example.com\",\"password\":\"pw-"
                                + UUID.randomUUID() + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    }

    /* ---------------- judgement 4: neither value ever reaches the log ---------------- */

    @Test
    void neitherTheGeneratedNorTheNewPasswordEverReachesTheLog() throws Exception {
        Logger logger = (Logger) LoggerFactory.getLogger(FirstRunAccountService.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            MvcResult first = mockMvc.perform(local(post(BASE)))
                    .andExpect(status().isOk())
                    .andReturn();
            @SuppressWarnings("unchecked")
            Object disclosed = ((Map<String, Object>) json(first).get("secret")).get("value");
            String newPassword = "pw-" + UUID.randomUUID();

            mockMvc.perform(local(post(BASE + "/rewrite"))
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"password\":\"" + newPassword + "\"}"))
                    .andExpect(status().isOk());

            assertFalse(appender.list.isEmpty(),
                    "the calls must emit log events, otherwise this assertion is vacuous");
            for (ILoggingEvent event : appender.list) {
                String message = event.getFormattedMessage();
                assertFalse(message.contains(String.valueOf(disclosed)),
                        "the generated password must never be logged");
                assertFalse(message.contains(newPassword),
                        "the rewritten password must never be logged");
            }
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }
}
