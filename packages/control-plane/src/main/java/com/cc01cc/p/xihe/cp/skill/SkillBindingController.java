package com.cc01cc.p.xihe.cp.skill;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * PLAN-0628 M1: the two-axis binding writer.
 *
 * <p>Thin by design: no repository (architecture rule) and no rules of its own.
 * {@link SkillAccessGuard} resolves who is calling; {@link SkillBindingService} owns the order
 * (existence → shape → definition visibility → authorization → subject validity → duplicate).</p>
 *
 * <p>Note the shape of that order: authorization precedes subject validity on purpose, so a caller
 * who may not bind cannot probe whether a user or principal exists from the error code.</p>
 */
@RestController
@RequestMapping("/api/v1/skill-bindings")
public class SkillBindingController {

    private final SkillBindingService bindingService;
    private final SkillAccessGuard guard;

    public SkillBindingController(SkillBindingService bindingService, SkillAccessGuard guard) {
        this.bindingService = bindingService;
        this.guard = guard;
    }

    /** The request body; {@code scopeId} is present exactly for a workspace-scoped binding. */
    public record CreateRequest(UUID skillId, String subjectType, UUID subjectId, String scopeType,
                                UUID scopeId) {}

    @PreAuthorize("isAuthenticated()")
    @PostMapping
    public ResponseEntity<?> create(@RequestBody CreateRequest request) {
        try {
            UUID actor = UUID.fromString(guard.requireActor());
            SkillBindingService.Caller caller = new SkillBindingService.Caller(
                    actor, guard.canManageInstanceLibrary(), guard.canManageWorkspace(request.scopeId()));
            SkillBinding binding = bindingService.bind(
                    new SkillBindingService.BindCommand(request.skillId(), request.subjectType(),
                            request.subjectId(), request.scopeType(), request.scopeId()),
                    caller);
            return ResponseEntity.status(HttpStatus.CREATED).body(SkillBindingView.from(binding));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{bindingId}")
    public ResponseEntity<?> delete(@PathVariable String bindingId) {
        try {
            // The row's own scope decides the workspace question, so the guard goes to the service,
            // which loads the row first. Passing a blanket "manages every workspace" flag from a
            // controller is exactly the bug this signature makes unwritable.
            bindingService.unbind(parseUuid(bindingId), guard);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private static UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A valid binding id is required", e);
        }
    }
}
