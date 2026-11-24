/* task-1032：composables/api.ts 聚合入口，只 re-export；既有调用点零改动。 */
export { WORKSPACE_WIRE_FIELDS, _allWorkspaceFieldsListed } from "./api/_types";
export type {
    ProblemDetails,
    ApiWorkspaceRoot,
    ApiWorkspace,
    WorkspaceMappingSurface,
    ApiUserCapabilities,
    ApiSession,
    ApiFollowUpAttachment,
    ApiFollowUpItem,
    ApiFollowUpQueueSnapshot,
    SessionResponse,
    AgentPrincipalHookAdvisor,
    AgentPrincipalHooks,
    AgentModelRef,
    WorkspaceAgentMemoryType,
} from "./api/_types";
export {
    ApiError,
    apiAuthHeaders,
    apiErrorFromResponse,
    onAuthTokensRefreshed,
    registerWorkspaceContextRequired,
    registerForceLogout,
    forceLogout,
    apiRaw,
    request,
    apiPost,
    apiGet,
    apiDelete,
    workspaceHeaders,
} from "./api/_core";
export {
    WORKSPACE_JOB_ERROR_CODES,
    workspaceJobErrorReason,
    WORKSPACE_PREFLIGHT_ERROR_CODES,
    EXECUTION_MODE_SWITCH_PROBE_CODES,
    isExecutionModeSwitchProbeFailure,
} from "./api/_errors";
export type { WorkspaceJobErrorCode, WorkspacePreflightErrorCode } from "./api/_errors";
export { normalizeApprovalRequest, InvalidSessionProjectionError } from "./api/_normalize";
export type { ApiAuthUser, FirstRunAccountDisclosure } from "./api/auth";
export type {
    SessionBindingPatch,
    ApiSessionBranch,
    SessionCommandView,
    SessionCommandListResponse,
    SessionCompactResponse,
    ApiTeamTask,
    SessionBranchCreateResponse,
    SessionListResponse,
} from "./api/session";
export type {
    ApiFollowUpCreateRequest,
    ChatRunGuidanceCreateResult,
    ChatRunGuidanceItem,
    ChatRunGuidanceSnapshot,
    ApiSessionMessage,
} from "./api/sessionMessage";
export { PARTICIPANT_CURSOR_ADVANCE_TO_LATEST } from "./api/sessionParticipant";
export type {
    DelegationUsageView,
    DelegationSpawnResult,
    DelegationSpawnAccepted,
} from "./api/sessionRun";
export type { ChatApprovalDecisionResponse } from "./api/sessionApproval";
export type {
    WorkspaceAgentMemory,
    WorkspaceAgentMemoryOrigin,
    AgentPrincipalOption,
    WorkspaceAgentMemoryInput,
    WorkspaceAgentMemoryStatus,
    AgentPrincipalCreateInput,
    AgentPrincipalCreateResponse,
    AgentPrincipalSummary,
    AgentPrincipalUpdateBody,
    AgentPrincipalUpdateView,
    AgentTemplateSummary,
    AgentTemplateLayerResponse,
} from "./api/agentPrincipal";
export type {
    WorkspaceAgentBinding,
    AgentRoleBinding,
    WorkspaceAgentPermission,
    WorkspaceAgentEffectiveCap,
    WorkspaceAgentCapResponse,
} from "./api/agentWorkspace";
export type {
    DelegateSpawnSession,
    DelegateSpawnSessions,
    AgentPrincipalSessionRole,
    AgentPrincipalSessionKind,
    AgentPrincipalSessionRow,
    AgentPrincipalSessionsCounts,
    AgentPrincipalSessionsResponse,
} from "./api/agentSessions";
export type {
    AgentSkillBinding,
    AgentSkillSummary,
    SkillDefinitionSummary,
    SkillDefinitionDetail,
    SkillImportItemPayload,
    SkillDefinitionScopePayload,
    SkillImportRequestPayload,
    SkillImportResultRow,
    SkillImportRejectionRow,
    SkillImportSummaryRow,
    SkillImportResultPayload,
} from "./api/agentSkill";
export type {
    PermissionAtomSourceView,
    PermissionAtomView,
    SelfPermissionsView,
    AuthorizationExplainAtomView,
    AuthorizationExplainGrantRefView,
    AuthorizationExplainLevelView,
    AuthorizationExplainView,
} from "./api/policy";
export type {
    ApiAtomScopeClass,
    ApiPresetAtom,
    ApiPresetCatalog,
    ApiPreset,
    ApiPresetAtomInput,
    ApiPresetWrite,
    ApiBindingScope,
    ApiBindingRow,
    ApiBindingSet,
    ApiBindingInput,
    ApiPresetGovernanceSubjectType,
    ApiPresetGovernanceAtom,
    ApiPresetGovernanceMissingAtom,
    ApiPresetGovernanceExtraAtom,
    ApiPresetGovernanceScopeDiff,
    ApiPresetGovernanceSummary,
    ApiPresetGovernanceCompare,
    ApiPresetGovernanceRealignResult,
} from "./api/preset";
export type {
    ApiOrgUnitNode,
    ApiOrgUnitMember,
    ApiOrgUnitMemberCandidate,
    ApiOrgUnitCreated,
    ApiOrgUnitMemberMoveResult,
    ApiOrgUnitRoleBindingList,
    ApiAdminUser,
} from "./api/org";
export { normalizeWorkspaceEvent } from "./api/workspace";
export type {
    ApiNestedRepoKind,
    ApiNestedRepoItem,
    ApiNestedReposView,
    ApiWorkspaceMember,
    MemberAssignableRole,
    MxcInstallSnapshot,
} from "./api/workspace";
export {
    normalizeWorkspaceCheckpoints,
    normalizeWorkspaceCheckpointEvent,
    normalizeCheckpointPreview,
    normalizeCheckpointResult,
    normalizeCheckpointCleanupResult,
    normalizeWorkspaceGitStatus,
    normalizeCheckpointRetention,
} from "./api/workspaceCheckpoint";
export { normalizeSafePolicySummary } from "./api/misc";
export type { VersionModule, VersionInfo } from "./api/misc";

import { authApi } from "./api/auth";
import { sessionApi } from "./api/session";
import { sessionMessageApi } from "./api/sessionMessage";
import { sessionParticipantApi } from "./api/sessionParticipant";
import { sessionRunApi } from "./api/sessionRun";
import { sessionApprovalApi } from "./api/sessionApproval";
import { agentPrincipalApi } from "./api/agentPrincipal";
import { agentWorkspaceApi } from "./api/agentWorkspace";
import { agentSessionsApi } from "./api/agentSessions";
import { agentSkillApi } from "./api/agentSkill";
import { policyApi } from "./api/policy";
import { presetApi } from "./api/preset";
import { orgApi } from "./api/org";
import { workspaceApi } from "./api/workspace";
import { workspaceCheckpointApi } from "./api/workspaceCheckpoint";
import { fileApi } from "./api/file";
import { credentialApi } from "./api/credential";
import { miscApi } from "./api/misc";
import { sessionRunTraceApi } from "./api/sessionRunTrace";

export const api = {
    ...authApi,
    ...sessionApi,
    ...sessionMessageApi,
    ...sessionParticipantApi,
    ...sessionRunApi,
    ...sessionApprovalApi,
    ...agentPrincipalApi,
    ...agentWorkspaceApi,
    ...agentSessionsApi,
    ...agentSkillApi,
    ...policyApi,
    ...presetApi,
    ...orgApi,
    ...workspaceApi,
    ...workspaceCheckpointApi,
    ...fileApi,
    ...credentialApi,
    ...miscApi,
    ...sessionRunTraceApi,
};
