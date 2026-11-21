package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.FirstRunAccountService;
import com.cc01cc.p.xihe.cp.config.FirstRunLocalAccess;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.function.Function;

/**
 * D-1535 (task-5, formerly task-149): the first-run credential face.
 *
 * <p>POST only, on purpose. A disclosure consumes a secret, so a GET would be copied by prefetchers,
 * proxies and access logs; the path is opened in {@code SecurityConfig} for every method precisely so
 * a GET reaches the dispatcher and gets 405 instead of being authenticated or mapped.</p>
 *
 * <p>Authorization is not a role: the gate is {@link FirstRunLocalAccess} (loopback peer, loopback
 * {@code Host}, loopback {@code Origin} when present, prod closed) plus the single-account count in
 * {@link FirstRunAccountService}. The window precedes any usable login, so there is no principal to
 * check and no new capability atom (D-1535 ③).</p>
 */
@RestController
@RequestMapping("/api/v1/bootstrap/first-run-account")
public class FirstRunAccountController {

    private final FirstRunAccountService service;
    private final Function<String, String> env;

    @Autowired
    public FirstRunAccountController(FirstRunAccountService service) {
        this(service, FirstRunLocalAccess::envValue);
    }

    /** Test seam: the prod switch is read through the same lookup the service uses. */
    public FirstRunAccountController(FirstRunAccountService service, Function<String, String> env) {
        this.service = service;
        this.env = env;
    }

    @PostMapping
    public ResponseEntity<?> disclose(HttpServletRequest request) {
        ResponseEntity<?> denied = localGate(request);
        if (denied != null) {
            return denied;
        }
        return ResponseEntity.ok(service.disclose());
    }

    @PostMapping("/rewrite")
    public ResponseEntity<?> rewrite(@RequestBody(required = false) Map<String, Object> body,
                                     HttpServletRequest request) {
        ResponseEntity<?> denied = localGate(request);
        if (denied != null) {
            return denied;
        }
        // D-1535 ④: email is not part of the rewrite face. Refuse it explicitly rather than
        // silently ignoring a field the caller believes was applied.
        if (body != null && body.containsKey("email")) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "email is not editable on the first-run rewrite face");
        }
        String username = body == null ? null : asString(body.get("username"));
        String password = body == null ? null : asString(body.get("password"));
        return ResponseEntity.ok(service.rewrite(username, password));
    }

    /** @return a problem response when the caller is not a local first-run caller, else {@code null}. */
    private ResponseEntity<?> localGate(HttpServletRequest request) {
        String denial = FirstRunLocalAccess.denial(request, env).orElse(null);
        if (denial == null) {
            return null;
        }
        return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN,
                FirstRunAccountService.CODE_NOT_AVAILABLE,
                "The first-run account face is closed for this caller (gate=" + denial + ")");
    }

    private static String asString(Object value) {
        return value instanceof String text ? text : null;
    }
}
