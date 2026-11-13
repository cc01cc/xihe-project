package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.service.OrgUnitReadService;
import com.cc01cc.p.xihe.cp.service.OrgUnitWriteService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * PLAN-0773 M2-11 (batch A): the two read endpoints of the org-unit group, per the contract in
 * `docs/api/openapi.yaml` (`tasks.md` M2-11 端点契约 lines 146-153, written contract-first).
 *
 * <p><b>Why `isAuthenticated()` rather than `holdsActionAtom`.</b> The atom gate lives in
 * {@link OrgUnitReadService} on purpose: gating it here would answer 403 before the service can
 * answer 404 for a non-member, and `设计 §4.3` forbids the 403 there ("非成员读任意单元 ⇒ 404，不泄露
 * 存在性"). A `@PreAuthorize` atom check cannot express "403 only when the unit is visible to
 * you", so it would either leak existence or move the decision into the annotation — both worse
 * than one explicit service call in the design's own order.</p>
 *
 * <p>Batch B (create/rename/move) and batch C (members/role bindings) land in this same controller
 * as separate commits; the six not-yet-implemented routes are declared in
 * {@code RouteContractParityTest.PLANNED_APIS} until their batch removes them.</p>
 */
@RestController
@RequestMapping("/api/v1/org-units")
public class OrgUnitController {

    /** Request bodies of the write endpoints (the contract's `additionalProperties: false` maps
     *  onto these records: an unknown field is a 400 from Jackson, not a silent ignore). */
    public record CreateBody(String name, String parentId) {}

    public record RenameBody(String name) {}

    public record MoveBody(String parentId) {}

    private final OrgUnitReadService readService;
    private final OrgUnitWriteService writeService;

    public OrgUnitController(OrgUnitReadService readService, OrgUnitWriteService writeService) {
        this.readService = readService;
        this.writeService = writeService;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public OrgUnitWireView.NodeList list(
            @RequestParam(required = false) String parentId,
            @RequestParam(required = false) String q) {
        return readService.list(parentId, q);
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public OrgUnitWireView.Created create(@RequestBody CreateBody body) {
        return writeService.create(body.name(), body.parentId());
    }

    @PreAuthorize("isAuthenticated()")
    @PatchMapping("/{unitId}")
    public OrgUnitWireView.Node rename(@PathVariable String unitId, @RequestBody RenameBody body) {
        return writeService.rename(unitId, body.name());
    }

    @PreAuthorize("isAuthenticated()")
    @PutMapping("/{unitId}/parent")
    public OrgUnitWireView.Node move(@PathVariable String unitId, @RequestBody MoveBody body) {
        return writeService.move(unitId, body.parentId());
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{unitId}/members")
    public OrgUnitWireView.MemberList members(
            @PathVariable String unitId,
            @RequestParam(defaultValue = "false") boolean includeDescendants) {
        return readService.members(unitId, includeDescendants);
    }
}
