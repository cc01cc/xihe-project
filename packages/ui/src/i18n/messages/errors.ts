export const messages = {
    "zh-CN": {
        // TODO(i18n): 中文措辞待 B-7 落位定稿后统一打磨（PLAN-0660 T5.21）；键名已按 design 冻结。
        // task-45：错误面统一入口（lib/errorMessages.ts#presentError）的兜底文案。
        // 为什么放顶层：这个入口同时服务设置区 / 工作区 / 聊天三条面，塞进 settings.* 会让
        // 工作区面去引设置区的键。判据：说清「发生了什么 + 下一步做什么」，**不含**英文 detail
        // 与错误码（码与原文进 technicalDetail：诊断屏折叠显示，toast 面只 logger.warn）。
        errors: {
            requestFailed: "请求失败，请稍后重试；若多次失败请联系管理员。",
            // Lead 裁 ②（总账 §十四 `fc327a318`，`task-64`）：诊断面的错误码**一律进折叠区**，
            // 所以这句不能再说「提供错误码」就完事 —— 它必须指向一个**用户做得出的动作**（展开），
            // 否则就是「文案要求用户做界面没提供的事」，正是 task-67 记过的那个形态。
            unknownCode:
                "请求失败，请稍后重试；若持续失败，请展开「技术详情」，把其中的错误码报给管理员。",
            technicalDetail: "技术详情",
            // 码标签：折叠区**内部**的标签（展开后可看、可复制；折叠态不渲染，不是 display:none）。
            errorCodeLabel: "错误码",
        },
    },
    "en-US": {
        // task-45: fallback copy for the single error-presentation entry
        // (lib/errorMessages.ts#presentError). Top-level on purpose: it serves settings,
        // workspace and chat surfaces alike. States what happened and what to do next;
        // never carries the raw English detail or the code (those go to technicalDetail).
        errors: {
            requestFailed:
                "Request failed. Retry in a moment; contact your administrator if it keeps failing.",
            // Lead ruling ② (ledger §14 `fc327a318`, `task-64`): diagnostic surfaces put the error
            // code **inside the collapsed area**, so this copy must point at an action the user can
            // actually perform (expand) — "report the error code" alone asks for something the UI
            // hides, which is exactly the defect task-67 recorded.
            unknownCode:
                "Request failed. Retry in a moment; if it persists, expand Technical details and report the error code there to your administrator.",
            technicalDetail: "Technical details",
            // Code label: lives **inside** the collapsed area (visible and copyable after expanding;
            // collapsed state does not render it — not display:none).
            errorCodeLabel: "Error code",
        },
    },
};
