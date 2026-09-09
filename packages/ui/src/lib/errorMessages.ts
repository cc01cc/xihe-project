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
    case 'AGENT_TIMEOUT':
      return 'AI 响应超时，请重试'
    case 'AGENT_STREAM_FAILED':
      return '对话流中断，请重试'
    case 'SESSION_NOT_FOUND':
      return '会话不存在或已删除'
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
