import { decideReadMode, FILE_SIZE_THRESHOLDS } from '../lib/fileSize'
import { apiRaw } from './api'

const WORKSPACE_API = '/internal/v1/runtime'

export interface ReadFilePreviewResult {
  content: string
  truncated: boolean
}

async function runtimeReadFile(
  path: string,
  opts?: { max_bytes?: number },
): Promise<ReadFilePreviewResult> {
  const body = JSON.stringify({ path, ...(opts?.max_bytes !== undefined ? { maxBytes: opts.max_bytes } : {}) })
  const res = await apiRaw(`${WORKSPACE_API}/workspaces/{workspaceId}/files/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  return res.json()
}

export async function readFilePreview(
  path: string,
  size?: number,
): Promise<ReadFilePreviewResult> {
  const decision = decideReadMode(size)
  switch (decision.action) {
    case 'intercept':
      return { content: '', truncated: true }
    case 'truncate':
      return runtimeReadFile(path, { max_bytes: FILE_SIZE_THRESHOLDS.TRUNCATE_BYTES })
    case 'full':
    default:
      return runtimeReadFile(path)
  }
}
