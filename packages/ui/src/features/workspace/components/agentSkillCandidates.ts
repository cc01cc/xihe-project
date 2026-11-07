import type { AgentSkillSummary } from "../../../composables/api";

/** Axis a skill binding will land on; the panel always uses the current workspace axis. */
export interface AgentSkillBindScope {
    scopeType: "instance" | "workspace";
    scopeId: string | null;
}

export interface AgentSkillCandidate {
    skillId: string;
    name: string;
    scopeType: "instance" | "workspace";
    scopeId: string | null;
}

/**
 * PLAN-0680 M2 T2.3 / B-1: a workspace-scope binding may point at an instance-library
 * definition or at a private definition owned by that workspace; an instance-scope binding
 * only accepts instance-library definitions. Invisible/unknown definition scopes are dropped,
 * and candidates are deduped by the binding key `(skillId, scopeType, scopeId)`.
 */
export function selectSkillCandidates(
    skills: AgentSkillSummary[],
    bindScope: AgentSkillBindScope,
): AgentSkillCandidate[] {
    const seen = new Set<string>();
    return skills.flatMap((skill) => {
        const definitionScope = skill.definitionScope;
        if (!definitionScope) return [];
        const eligible =
            definitionScope.type === "instance" ||
            (bindScope.scopeType === "workspace" &&
                definitionScope.type === "workspace" &&
                definitionScope.workspaceId === bindScope.scopeId);
        if (!eligible) return [];
        const key = `${skill.skillId}:${bindScope.scopeType}:${bindScope.scopeId ?? ""}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [
            {
                skillId: skill.skillId,
                name: skill.name,
                scopeType: bindScope.scopeType,
                scopeId: bindScope.scopeId,
            },
        ];
    });
}
