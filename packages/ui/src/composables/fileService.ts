import { decideReadMode, FILE_SIZE_THRESHOLDS } from '../lib/fileSize'
import { apiRaw } from './api'

export interface ReadFilePreviewResult {
  content: string
  truncated: boolean
}

async function runtimeReadFile(
  path: string,
  opts?: { max_bytes?: number },
): Promise<ReadFilePreviewResult> {
  const res = await apiRaw(`/files/${encodeURIComponent(path)}`)
  const content = await res.text()
  const maxBytes = opts?.max_bytes
  return maxBytes !== undefined && content.length > maxBytes
    ? { content: content.slice(0, maxBytes), truncated: true }
    : { content, truncated: false }
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
