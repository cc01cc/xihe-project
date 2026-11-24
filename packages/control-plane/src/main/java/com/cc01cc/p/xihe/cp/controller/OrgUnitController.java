package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.OrgUnitNameKeys;
import com.cc01cc.p.xihe.cp.config.PolicyChecked;
import com.cc01cc.p.xihe.cp.service.OrgUnitMemberService;
import com.cc01cc.p.xihe.cp.service.OrgUnitReadService;
import com.cc01cc.p.xihe.cp.service.OrgUnitPresetBindingService;
import com.cc01cc.p.xihe.cp.service.OrgUnitWriteService;
import tools.jackson.databind.JsonNode;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.DeleteMapping;
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

    /** G1 body: `confirmAffected` is opt-in, and required only when the move affects workspaces. */
    public record MemberMoveBody(Boolean confirmAffected) {}

    private final OrgUnitReadService readService;
    private final OrgUnitWriteService writeService;
    private final OrgUnitMemberService memberService;
    private final OrgUnitPresetBindingService roleBindingService;

    public OrgUnitController(OrgUnitReadService readService, OrgUnitWriteService writeService,
                             OrgUnitMemberService memberService,
                             OrgUnitPresetBindingService roleBindingService) {
        this.readService = readService;
        this.writeService = writeService;
        this.memberService = memberService;
        this.roleBindingService = roleBindingService;
    }

    /**
     * The tree read face. {@code locale} localizes the <b>seeded</b> unit names only (DSD-1520 D3c);
     * it comes from {@code ?locale=} when given, else the {@code Accept-Language} header, else
     * {@code zh-CN} ({@link OrgUnitNameKeys#normalize}) — the same resolution the permission-atom
     * labels use, so a client that already passes a locale for one surface does not need a second
     * convention for this one. A unit without {@code name_key} renders its stored name verbatim in
     * every locale.
     */
    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public OrgUnitWireView.NodeList list(
            @RequestParam(required = false) String parentId,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String locale,
            @RequestHeader(name = "Accept-Language", required = false) String acceptLanguage) {
        return readService.list(parentId, q,
                OrgUnitNameKeys.normalize(locale != null ? locale : acceptLanguage));
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

    /**
     * R32 (task-956): delete an empty unit. A unit with direct children or members is a
     * {@code 409} carrying both counts in the problem body — the caller has to see the impact
     * before deciding, rather than learn that a whole subtree disappeared in one click. The
     * unit's preset bindings cascade with it (they are configuration of that unit); the audit
     * row records their ids before the cascade.
     */
    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{unitId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PolicyChecked(atom = "action:MANAGE_ORG_UNITS")
    public void delete(@PathVariable String unitId) {
        writeService.delete(unitId);
    }

    @PreAuthorize("isAuthenticated()")
    @PutMapping("/{unitId}/members/{memberId}")
    public ResponseEntity<OrgUnitWireView.MemberMoved> moveMember(
            @PathVariable String unitId,
            @PathVariable String memberId,
            @RequestParam String memberKind,
            @RequestBody(required = false) MemberMoveBody body) {
        boolean confirmAffected = body != null && Boolean.TRUE.equals(body.confirmAffected());
        return ResponseEntity.ok(memberService.move(unitId, memberId, memberKind, confirmAffected));
    }

    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{unitId}/members/{memberId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void removeMember(@PathVariable String unitId, @PathVariable String memberId,
                             @RequestParam String memberKind) {
        // R31: this deactivates the subject (soft delete / disabled), not just the membership
        // row; see OrgUnitMemberService.remove for the MVP ruling (task-956).
        memberService.remove(unitId, memberId, memberKind);
    }

    @PreAuthorize("isAuthenticated()")
    @PutMapping("/{unitId}/preset-bindings")
    public OrgUnitWireView.PresetBindings replacePresetBindings(
            @PathVariable String unitId, @RequestBody JsonNode body) {
        // A record would let Jackson ignore an unknown `roleIds` key and land `presetIds=null`,
        // which the service would then treat as "clear the set" — a silent permission change.
        // Parse the key set explicitly so the retired name is a 400 at the wire edge.
        if (body == null || !body.isObject() || body.size() != 1 || !body.has("presetIds")
                || !body.get("presetIds").isArray()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "Body must contain only presetIds (an array of preset ids)");
        }
        java.util.List<String> presetIds = new java.util.ArrayList<>();
        for (JsonNode element : body.get("presetIds")) {
            if (!element.isTextual() || element.asText().isBlank()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "presetIds must be an array of preset ids");
            }
            presetIds.add(element.asText());
        }
        return roleBindingService.replace(unitId, presetIds);
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{unitId}/members")
    public OrgUnitWireView.MemberList members(
            @PathVariable String unitId,
            @RequestParam(defaultValue = "false") boolean includeDescendants) {
        return readService.members(unitId, includeDescendants);
    }

    /**
     * task-985: the "add a member" picker. Server-side candidate judgement
     * ({@code findUnassignedCandidates}) — a subject already placed anywhere in the tree or a
     * disabled subject is absent by construction, so the client must not fetch a broader directory
     * and filter it itself. The gates (scope 404 before atom 403) are the write face's own, so a
     * read-only member cannot enumerate unassigned subjects.
     */
    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{unitId}/member-candidates")
    @PolicyChecked(atom = "action:READ_ORG_UNIT_MEMBERS")
    public OrgUnitWireView.MemberCandidateList memberCandidates(
            @PathVariable String unitId,
            @RequestParam String memberKind,
            @RequestParam(required = false) String q) {
        return memberService.candidates(unitId, memberKind, q);
    }
}
