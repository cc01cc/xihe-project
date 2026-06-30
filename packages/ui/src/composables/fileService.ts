import { decideReadMode, FILE_SIZE_THRESHOLDS } from '../lib/fileSize'

const WORKSPACE_API = '/api/v1'

export interface ReadFilePreviewResult {
  content: string
  truncated: boolean
}

async function runtimeReadFile(
  path: string,
  opts?: { max_bytes?: number },
): Promise<ReadFilePreviewResult> {
  const body = JSON.stringify({ path, ...(opts?.max_bytes !== undefined ? { max_bytes: opts.max_bytes } : {}) })
  const res = await fetch(`${WORKSPACE_API}/workspace/{ws_id}/files/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  if (!res.ok) throw new Error(`Read file failed: ${res.status}`)
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
