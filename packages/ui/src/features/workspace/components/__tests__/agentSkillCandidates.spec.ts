import { describe, expect, it } from "vitest";
import { selectSkillCandidates } from "../agentSkillCandidates";

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666",
    OTHER_WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";

describe("selectSkillCandidates (PLAN-0680 B-1/B-5)", () => {
    it("keeps instance-library and current-workspace definitions once on the workspace axis", () => {
        const candidates = selectSkillCandidates(
            [
                {
                    skillId: "skill-instance",
                    name: "instance-skill",
                    definitionScope: { type: "instance", workspaceId: null },
                },
                {
                    skillId: "skill-instance",
                    name: "instance-skill duplicate row",
                    definitionScope: { type: "instance", workspaceId: null },
                },
                {
                    skillId: "skill-workspace",
                    name: "workspace-skill",
                    definitionScope: { type: "workspace", workspaceId: WORKSPACE_ID },
                },
                {
                    skillId: "skill-foreign",
                    name: "foreign-workspace-skill",
                    definitionScope: { type: "workspace", workspaceId: OTHER_WORKSPACE_ID },
                },
                {
                    skillId: "skill-unknown",
                    name: "unknown-definition-scope",
                    definitionScope: null,
                },
            ],
            { scopeType: "workspace", scopeId: WORKSPACE_ID },
        );

        expect(candidates).toEqual([
            {
                skillId: "skill-instance",
                name: "instance-skill",
                scopeType: "workspace",
                scopeId: WORKSPACE_ID,
            },
            {
                skillId: "skill-workspace",
                name: "workspace-skill",
                scopeType: "workspace",
                scopeId: WORKSPACE_ID,
            },
        ]);
    });

    it("restricts the instance axis to instance-library definitions", () => {
        const candidates = selectSkillCandidates(
            [
                {
                    skillId: "skill-instance",
                    name: "instance-skill",
                    definitionScope: { type: "instance", workspaceId: null },
                },
                {
                    skillId: "skill-workspace",
                    name: "workspace-skill",
                    definitionScope: { type: "workspace", workspaceId: WORKSPACE_ID },
                },
            ],
            { scopeType: "instance", scopeId: null },
        );

        expect(candidates).toEqual([
            {
                skillId: "skill-instance",
                name: "instance-skill",
                scopeType: "instance",
                scopeId: null,
            },
        ]);
    });
});
