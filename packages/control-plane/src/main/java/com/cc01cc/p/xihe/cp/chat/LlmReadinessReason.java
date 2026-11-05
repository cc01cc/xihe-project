package com.cc01cc.p.xihe.cp.chat;

/**
 * BL-350 (B): why {@code LLM_NOT_CONFIGURED} happened, in a form the 503 body can carry.
 *
 * <p>The Agent's readiness gate evaluates the <b>instance</b> layer only: its config client is
 * layer-less by decision #19, so it can never see that the caller has a user-layer profile. CP is the
 * only place where both layers are visible, so the diagnosis is derived here — the wire {@code code}
 * stays {@code LLM_NOT_CONFIGURED}, only {@code detail} and the additive {@code reason} become
 * specific.</p>
 *
 * <p>Deliberately NOT part of this class: evaluating readiness per actor/session (option A). That is
 * an architecture change (the Agent gate would have to consult user/workspace layers mid-run) and is
 * out of BL-350's scope.</p>
 */
final class LlmReadinessReason {

    /** No llm-provider profile anywhere for this caller: the instance layer is unconfigured. */
    static final String INSTANCE_PROFILE_MISSING = "instance_profile_missing";
    /** The caller's user layer has a profile but the instance layer does not — the lab's case. */
    static final String USER_PROFILE_ONLY = "user_profile_only";
    /** The instance layer has a profile but its credentials are unusable. */
    static final String CREDENTIAL_MISSING = "credential_missing";

    record Diagnosis(String reason, String detail) {
    }

    private LlmReadinessReason() {
    }

    /**
     * @param instanceProfiled the instance-layer effective llm-provider carries a provider
     * @param userProfiled     the caller's effective llm-provider (user layer merged) carries a provider
     */
    static Diagnosis diagnose(boolean instanceProfiled, boolean userProfiled) {
        if (!instanceProfiled && userProfiled) {
            return new Diagnosis(USER_PROFILE_ONLY,
                    "instance 层未配置 llm-provider（当前仅检测到用户层配置）；"
                            + "请由实例管理员在 instance 层配置 llm-provider");
        }
        if (!instanceProfiled) {
            return new Diagnosis(INSTANCE_PROFILE_MISSING,
                    "instance 层未配置 llm-provider；请由实例管理员在 instance 层配置 llm-provider");
        }
        return new Diagnosis(CREDENTIAL_MISSING,
                "instance 层已配置 llm-provider，但凭据不可用；请检查凭据/连接状态");
    }
}
