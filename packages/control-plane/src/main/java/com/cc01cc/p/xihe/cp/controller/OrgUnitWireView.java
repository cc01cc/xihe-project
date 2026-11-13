package com.cc01cc.p.xihe.cp.controller;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0773 M2-11 wire shapes for the org-unit endpoints.
 *
 * <p>Deliberately separate from the repository rows: the response is a contract
 * ({@code openapi.yaml} `OrgUnitNode` / `OrgUnitMemberView`), and the rows are storage. Reusing the
 * row record as the response body would let a column rename silently break the contract — the
 * schemas carry `additionalProperties: false`, so an extra field is not a harmless addition
 * either.</p>
 *
 * <p>`path` is absent on purpose: it is a materialized index (design §3.1), not a client-facing
 * identity, and exposing it would invite a client to derive parentage from it while the truth is
 * `parentId`. The one place it is returned is the create response, where the contract says so.</p>
 */
public final class OrgUnitWireView {

    public record Node(UUID id, String name, UUID parentId, int depth, boolean hasChildren) {}

    public record NodeList(List<Node> nodes) {}

    /** Create response: the id plus the materialized path (the contract's one place for `path`). */
    public record Created(UUID id, String path) {}

    public record Member(String memberKind, UUID memberId, UUID orgUnitId, String displayName) {}

    public record MemberList(List<Member> members) {}
    /**
     * G1 (M2-10b): the move response. {@code affectedWorkspaceIds} is <b>always present</b> — an
     * empty array is a real answer (no workspace is affected), and a client that branches on
     * presence rather than emptiness is the one thing this shape must not allow.
     */
    /** Stored binding set, ordered by role id (the contract's byte-identical-reads guarantee). */
    public record RoleBindings(List<UUID> roleIds) {}

    public record MemberMoved(UUID memberId, UUID fromOrgUnitId, UUID toOrgUnitId,
                              List<UUID> affectedWorkspaceIds, String auditEvent) {}

    private OrgUnitWireView() {}
}
