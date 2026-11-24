export const messages = {
    "zh-CN": {
        steer: {
            fromLead: "来自 Lead",
            fromLeadNamed: "来自 {name}",
            jumpToSource: "跳转到来源会话",
            // M4 插话入口（composer 复用）：写原语 = CP steer 端点，UI 不开第二条写通道。
            entry: "插话给 teammate",
            modeTitle: "插话模式",
            targetLabel: "目标",
            modeHint: "内容将作为指挥消息排入对方后续队列",
            cancel: "取消插话",
            sent: "插话已入队",
            errorTitle: "插话发送失败",
            forbidden: "没有向该会话插话的权限（仅 Lead 可指挥）",
            unavailable: "该会话当前不接受插话",
            queueFull: "对方后续队列已满，插话未能入队",
            keyReused: "请求被重复提交，请再试一次",
            attachmentsUnsupported: "插话仅支持文本，请先移除附件",
        },
    },
    "en-US": {
        steer: {
            fromLead: "From Lead",
            fromLeadNamed: "From {name}",
            jumpToSource: "Jump to source session",
            // M4 steer entry (composer reuse): the write primitive is the CP steer endpoint.
            entry: "Message a teammate",
            modeTitle: "Steer mode",
            targetLabel: "Target",
            modeHint: "The text is queued as a steer message for that session",
            cancel: "Cancel steer",
            sent: "Steer queued",
            errorTitle: "Failed to send the steer",
            forbidden: "You cannot steer that session (Lead only)",
            unavailable: "That session cannot accept a steer right now",
            queueFull: "The target follow-up queue is full; the steer was not queued",
            keyReused: "The request was duplicated; try again",
            attachmentsUnsupported: "Steer messages are text-only; remove the attachments first",
        },
    },
};
