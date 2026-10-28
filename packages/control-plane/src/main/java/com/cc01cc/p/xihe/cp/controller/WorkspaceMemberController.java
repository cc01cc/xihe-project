package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.WorkspaceMemberService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * PLAN-0565: workspace membership API (spec/api-members-contract.md §1).
 * Authorization lives entirely in {@link WorkspaceMemberService}; this
 * controller only forwards the path identity and the caller context
 * ({@code TenantContext} user id + instance role, ruling #3).
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/members")
public class WorkspaceMemberController {

    private final WorkspaceMemberService memberService;

    public WorkspaceMemberController(WorkspaceMemberService memberService) {
        this.memberService = memberService;
    }

    @GetMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public List<MemberView> list(@PathVariable String workspaceId) {
        return memberService.listMembers(workspaceId, TenantContext.getUserId(),
                TenantContext.getUserRole());
    }

    @PostMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<MemberView> add(@PathVariable String workspaceId,
            @Valid @RequestBody AddMemberRequest request) {
        MemberView view = memberService.addMember(workspaceId, request.username(),
                request.role(), TenantContext.getUserId(), TenantContext.getUserRole());
        return ResponseEntity.status(201).body(view);
    }

    @PatchMapping("/{userId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public MemberView updateRole(@PathVariable String workspaceId,
            @PathVariable String userId,
            @Valid @RequestBody UpdateMemberRoleRequest request) {
        return memberService.updateMemberRole(workspaceId, userId, request.role(),
                TenantContext.getUserId(), TenantContext.getUserRole());
    }

    @DeleteMapping("/{userId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<Void> remove(@PathVariable String workspaceId,
            @PathVariable String userId) {
        memberService.removeMember(workspaceId, userId, TenantContext.getUserId(),
                TenantContext.getUserRole());
        return ResponseEntity.noContent().build();
    }

    public record AddMemberRequest(@NotBlank String username, @NotBlank String role) {
    }

    public record UpdateMemberRoleRequest(@NotBlank String role) {
    }
}
