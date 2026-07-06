import { reactive, readonly } from 'vue'
import { logger } from '../lib/logger'
import type { AttachmentFile } from '../types'

export type UploadState = 'pending' | 'uploading' | 'done' | 'error'

export interface UploadTask {
  id: string
  file: File
  name: string
  type: string
  size: number
  state: UploadState
  fileId?: string
  error?: string
  retryCount: number
}

export interface UploadResult {
  success: AttachmentFile[]
  failed: { name: string; reason: string }[]
}

const MAX_FILE_SIZE = 500 * 1024 * 1024

const ALLOWED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
  'pdf', 'doc', 'docx', 'txt', 'md', 'json', 'csv',
  'xls', 'xlsx', 'ppt', 'pptx',
  'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac',
  'mp4', 'webm', 'mov', 'avi', 'mkv',
])

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return ''
  }
  return filename.slice(lastDot + 1).toLowerCase()
}

export function validateAttachment(file: File): { valid: true } | { valid: false; reason: string } {
  const extension = getExtension(file.name)
  if (!extension) {
    return { valid: false, reason: 'File must have an extension' }
  }
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return { valid: false, reason: `File type not allowed: ${extension}` }
  }
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, reason: `File exceeds maximum size of ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB` }
  }
  return { valid: true }
}

const tasks = reactive<Record<string, UploadTask>>({})

export function getUploadTasks(): Readonly<Record<string, UploadTask>> {
  return readonly(tasks) as Readonly<Record<string, UploadTask>>
}

function createTask(file: File): UploadTask {
  const id = crypto.randomUUID()
  const task: UploadTask = {
    id,
    file,
    name: file.name,
    type: file.type,
    size: file.size,
    state: 'pending',
    retryCount: 0,
  }
  tasks[id] = task
  return task
}

export async function uploadAttachments(sessionId: string, files: File[]): Promise<UploadResult> {
  const success: AttachmentFile[] = []
  const failed: { name: string; reason: string }[] = []
  const validTasks: UploadTask[] = []

  for (const file of files) {
    const task = createTask(file)
    const validation = validateAttachment(file)
    if (!validation.valid) {
      task.state = 'error'
      task.error = validation.reason
      failed.push({ name: file.name, reason: validation.reason })
      continue
    }
    task.state = 'uploading'
    validTasks.push(task)
  }

  if (validTasks.length === 0) {
    return { success, failed }
  }

  try {
    const formData = new FormData()
    for (const task of validTasks) {
      formData.append('files', task.file)
    }

    const token = localStorage.getItem('xihe-token')
    const response = await fetch(`/api/v1/sessions/${sessionId}/attachments`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({} as Record<string, unknown>))
      const message = typeof body.error === 'string' ? body.error : `Upload failed: HTTP ${response.status}`
      throw new Error(message)
    }

    const result = await response.json() as {
      success?: Array<{ id: string; name: string; type: string; size: number; url: string }>
      failed?: Array<{ fileName: string; reason: string }>
    }

    if (result.failed) {
      for (const item of result.failed) {
        const task = validTasks.find((t) => t.name === item.fileName)
        if (task) {
          task.state = 'error'
          task.error = item.reason
        }
        failed.push({ name: item.fileName, reason: item.reason })
      }
    }

    if (result.success) {
      for (const item of result.success) {
        const task = validTasks.find((t) => t.name === item.name)
        if (task) {
          task.fileId = item.id
          task.state = 'done'
        }
        success.push({
          id: task?.id ?? crypto.randomUUID(),
          fileId: item.id,
          name: item.name,
          type: item.type,
          size: item.size,
          url: item.url,
          state: 'done',
        })
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.error('Attachment upload failed', err)
    for (const task of validTasks) {
      if (task.state !== 'done') {
        task.state = 'error'
        task.error = reason
        failed.push({ name: task.name, reason })
      }
    }
  }

  return { success, failed }
}

export async function deleteAttachment(sessionId: string, fileId: string): Promise<void> {
  const token = localStorage.getItem('xihe-token')
  const response = await fetch(`/api/v1/sessions/${sessionId}/attachments/${fileId}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({} as Record<string, unknown>))
    const message = typeof body.error === 'string' ? body.error : `Delete failed: HTTP ${response.status}`
    throw new Error(message)
  }
}

export async function getAttachmentMetadata(sessionId: string, fileId: string): Promise<AttachmentFile> {
  const token = localStorage.getItem('xihe-token')
  const response = await fetch(`/api/v1/sessions/${sessionId}/attachments/${fileId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({} as Record<string, unknown>))
    const message = typeof body.error === 'string' ? body.error : `Metadata failed: HTTP ${response.status}`
    throw new Error(message)
  }
  const info = await response.json() as { id: string; name: string; type: string; size: number; url: string }
  return {
    id: info.id,
    fileId: info.id,
    name: info.name,
    type: info.type,
    size: info.size,
    url: info.url,
    state: 'done',
  }
}

export function removeUploadTask(taskId: string): void {
  delete tasks[taskId]
}
