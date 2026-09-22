/** Human-readable copy for stable Problem/SSE error codes (PLAN-290 A6/B1). */
export function humanizeErrorCode(code: string | undefined | null, detail?: string | null): string {
  const key = (code ?? '').trim()
  switch (key) {
    case 'RUNTIME_ERROR':
    case 'RUNTIME_UNAVAILABLE':
    case 'MCP_STREAM_UNAVAILABLE':
    case 'MCP_DISCONNECT_UNAVAILABLE':
      return '沙盒未就绪，请启动 Docker 后重试（Runtime 不可达）'
    case 'PATH_TRAVERSAL':
    case 'FORBIDDEN':
      return '路径不合法：仅允许工作区相对路径'
    case 'APPROVAL_REJECTED':
      return '已取消：本次文件修改未执行'
    case 'APPROVAL_EXPIRED':
      return '审批已过期，请重新发起操作'
    case 'APPROVAL_NOT_FOUND':
      return '审批请求不存在或已被处理'
    case 'CHAT_IN_PROGRESS':
      return '上一条消息仍在处理中，请等待完成或取消后再发送'
    case 'SSE_SUBSCRIPTION_REQUIRED':
      return '实时连接未就绪，请刷新页面后重试'
    case 'LLM_MISSING_CREDENTIALS':
    case 'LLM_INVALID_CREDENTIALS':
      return '模型凭据不可用，请在设置中检查 LLM Provider'
    case 'LLM_MODEL_UNAVAILABLE':
      return '所选模型当前不可用，请更换模型或稍后重试'
    case 'LLM_TOOL_ROUTE_UNSUPPORTED':
      return '当前模型路由不支持工具调用：请改用 OpenAI 兼容连接或更换模型'
    case 'LLM_BASE_URL_MISSING':
      return '模型连接缺少 Base URL：请在设置中为该连接填写地址'
    case 'LLM_REQUEST_REJECTED':
      return '模型提供方拒绝了该请求（消息格式或参数不被接受）'
    case 'AGENT_TIMEOUT':
      return 'AI 响应超时，请重试'
    case 'AGENT_STREAM_FAILED':
      return '对话流中断，请重试'
    case 'SESSION_NOT_FOUND':
      return '会话不存在或已删除'
    case 'PATH_OUT_OF_SCOPE':
      return '路径超出工作区范围，操作已拒绝'
    case 'CAPABILITY_UNAVAILABLE':
      return '执行能力当前不可用，请检查 Runtime 或后端状态'
    case 'PROCESS_TIMEOUT':
      return '进程执行超时，任务已终止'
    case 'PROCESS_CANCELLED':
      return '进程已取消'
    case 'JOB_BACKEND_LAUNCH_PENDING':
      return '当前执行后端尚未提供 Job 启动器，暂不可用'
    case 'UNMAPPED_ERROR':
      return '执行失败，后端未映射具体错误'
    default:
      break
  }
  // Prefer mapped Chinese; keep raw detail as secondary for debugging.
  return detail ? `${key}: ${detail}` : key || '操作失败'
}

export function chatErrorToastText(code: string | undefined, detail?: string | null): string {
  const mapped = humanizeErrorCode(code, detail)
  // When we have a dedicated mapping without embedding raw detail, still show code for support.
  if (mapped !== `${code}: ${detail}` && code) {
    return `${code} — ${mapped}`
  }
  return mapped
}
