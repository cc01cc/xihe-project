import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  validateAttachment,
  uploadAttachments,
  deleteAttachment,
  getAttachmentMetadata,
  getUploadTasks,
  removeUploadTask,
} from '../attachmentService'

const MAX_FILE_SIZE = 500 * 1024 * 1024

function makeFile(name: string, size = 1024, type = 'application/octet-stream'): File {
  const base = new File(['x'], name, { type })
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'size') return size
      return Reflect.get(target, prop)
    },
  })
}

function clearTasks(): void {
  for (const id of Object.keys(getUploadTasks())) {
    removeUploadTask(id)
  }
}

function mockFetch(response: {
  ok: boolean
  status: number
  json?: () => Promise<unknown>
}): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(response)
}

beforeEach(() => {
  localStorage.clear()
  clearTasks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearTasks()
})

describe('validateAttachment', () => {
  it('accepts allowed image files within size limit', () => {
    const result = validateAttachment(makeFile('photo.png', 1024, 'image/png'))
    expect(result).toEqual({ valid: true })
  })

  it('accepts allowed document files', () => {
    const result = validateAttachment(makeFile('report.pdf', 1024, 'application/pdf'))
    expect(result).toEqual({ valid: true })
  })

  it('rejects files without extension', () => {
    const result = validateAttachment(makeFile('README', 1024))
    expect(result).toEqual({ valid: false, reason: 'File must have an extension' })
  })

  it('rejects files with disallowed extension', () => {
    const result = validateAttachment(makeFile('app.exe', 1024))
    expect(result).toEqual({ valid: false, reason: 'File type not allowed: exe' })
  })

  it('rejects files exceeding size limit', () => {
    const result = validateAttachment(makeFile('big.png', MAX_FILE_SIZE + 1, 'image/png'))
    expect(result).toEqual({ valid: false, reason: 'File exceeds maximum size of 500 MB' })
  })
})

describe('uploadAttachments', () => {
  it('returns empty result for empty input', async () => {
    const fetchSpy = mockFetch({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await uploadAttachments('session-1', [])

    expect(result.success).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uploads valid files and marks tasks done', async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      json: async () => ({
        success: [{ id: 'file-1', name: 'photo.png', type: 'image/png', size: 1024, url: '/files/file-1' }],
      }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await uploadAttachments('session-1', [makeFile('photo.png', 1024, 'image/png')])

    expect(result.success).toHaveLength(1)
    expect(result.success[0]).toMatchObject({
      fileId: 'file-1',
      name: 'photo.png',
      type: 'image/png',
      size: 1024,
      url: '/files/file-1',
      state: 'done',
    })
    expect(result.failed).toHaveLength(0)

    const tasks = Object.values(getUploadTasks())
    expect(tasks).toHaveLength(1)
    expect(tasks[0].state).toBe('done')
    expect(tasks[0].fileId).toBe('file-1')
  })

  it('rejects invalid files locally without calling backend', async () => {
    const fetchSpy = mockFetch({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await uploadAttachments('session-1', [
      makeFile('virus.exe', 1024),
      makeFile('huge.png', MAX_FILE_SIZE + 1, 'image/png'),
      makeFile('noextension', 1024),
    ])

    expect(result.success).toHaveLength(0)
    expect(result.failed).toHaveLength(3)
    expect(result.failed.map((f) => f.name).sort()).toEqual(['huge.png', 'noextension', 'virus.exe'])
    expect(fetchSpy).not.toHaveBeenCalled()

    const tasks = Object.values(getUploadTasks())
    expect(tasks).toHaveLength(3)
    expect(tasks.every((t) => t.state === 'error')).toBe(true)
  })

  it('handles backend partial failure', async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      json: async () =>
        ({
          success: [{ id: 'file-1', name: 'photo.png', type: 'image/png', size: 1024, url: '/files/file-1' }],
          failed: [{ fileName: 'corrupt.svg', reason: 'MIME type mismatch' }],
        }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await uploadAttachments('session-1', [
      makeFile('photo.png', 1024, 'image/png'),
      makeFile('corrupt.svg', 1024, 'image/svg+xml'),
    ])

    expect(result.success).toHaveLength(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toEqual({ name: 'corrupt.svg', reason: 'MIME type mismatch' })

    const tasks = Object.values(getUploadTasks())
    const doneTask = tasks.find((t) => t.name === 'photo.png')
    const failedTask = tasks.find((t) => t.name === 'corrupt.svg')
    expect(doneTask?.state).toBe('done')
    expect(failedTask?.state).toBe('error')
  })

  it('marks all valid files failed on network error', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('Network failure'))
    vi.stubGlobal('fetch', fetchSpy)

    const result = await uploadAttachments('session-1', [
      makeFile('photo.png', 1024, 'image/png'),
      makeFile('doc.pdf', 1024, 'application/pdf'),
    ])

    expect(result.success).toHaveLength(0)
    expect(result.failed).toHaveLength(2)
    expect(result.failed.every((f) => f.reason.includes('Network failure'))).toBe(true)

    const tasks = Object.values(getUploadTasks())
    expect(tasks.every((t) => t.state === 'error')).toBe(true)
  })

  it('marks all valid files failed on non-ok response', async () => {
    const fetchSpy = mockFetch({
      ok: false,
      status: 413,
      json: async () => ({ detail: 'Payload Too Large', code: 'PAYLOAD_TOO_LARGE', requestId: 'test' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await uploadAttachments('session-1', [makeFile('photo.png', 1024, 'image/png')])

    expect(result.success).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].reason).toContain('Payload Too Large')
  })

  it('sends Authorization header when token exists', async () => {
    localStorage.setItem('xihe-token', 'jwt-123')
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      json: async () => ({
        success: [{ id: 'file-1', name: 'photo.png', type: 'image/png', size: 1024, url: '/files/file-1' }],
      }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    await uploadAttachments('session-1', [makeFile('photo.png', 1024, 'image/png')])

    const [, options] = fetchSpy.mock.calls[0]
    expect(options.headers).toEqual({ Authorization: 'Bearer jwt-123' })
  })

  it('sends all valid files in a single FormData body', async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      json: async () => ({
        success: [
          { id: 'file-1', name: 'a.png', type: 'image/png', size: 1, url: '/files/file-1' },
          { id: 'file-2', name: 'b.png', type: 'image/png', size: 1, url: '/files/file-2' },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    await uploadAttachments('session-1', [
      makeFile('a.png', 1, 'image/png'),
      makeFile('b.png', 1, 'image/png'),
    ])

    const [endpoint, options] = fetchSpy.mock.calls[0]
    expect(endpoint).toBe('/api/v1/sessions/session-1/attachments')
    expect(options.body).toBeInstanceOf(FormData)
    const entries = Array.from(options.body.entries())
    expect(entries).toHaveLength(2)
    expect(entries.every(([key]) => key === 'files')).toBe(true)
  })
})

describe('deleteAttachment', () => {
  it('resolves when backend returns success', async () => {
    const fetchSpy = mockFetch({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchSpy)

    await deleteAttachment('session-1', 'file-1')

    const [endpoint, options] = fetchSpy.mock.calls[0]
    expect(endpoint).toBe('/api/v1/sessions/session-1/attachments/file-1')
    expect(options.method).toBe('DELETE')
  })

  it('throws with backend error message on failure', async () => {
    const fetchSpy = mockFetch({
      ok: false,
      status: 404,
      json: async () => ({ detail: 'Attachment not found', code: 'ATTACHMENT_NOT_FOUND', requestId: 'test' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(deleteAttachment('session-1', 'file-1')).rejects.toThrow('Attachment not found')
  })

  it('sends Authorization header when token exists', async () => {
    localStorage.setItem('xihe-token', 'jwt-123')
    const fetchSpy = mockFetch({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchSpy)

    await deleteAttachment('session-1', 'file-1')

    const [, options] = fetchSpy.mock.calls[0]
    expect(options.headers).toEqual({ Authorization: 'Bearer jwt-123' })
  })
})

describe('getAttachmentMetadata', () => {
  it('returns AttachmentFile for valid fileId', async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'file-1',
        name: 'photo.png',
        type: 'image/png',
        size: 1024,
        url: '/files/file-1',
      }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const file = await getAttachmentMetadata('session-1', 'file-1')

    expect(file).toEqual({
      id: 'file-1',
      fileId: 'file-1',
      name: 'photo.png',
      type: 'image/png',
      size: 1024,
      url: '/files/file-1',
      state: 'done',
    })
  })

  it('throws with backend error message on failure', async () => {
    const fetchSpy = mockFetch({
      ok: false,
      status: 403,
      json: async () => ({ detail: 'Forbidden', code: 'FORBIDDEN', requestId: 'test' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(getAttachmentMetadata('session-1', 'file-1')).rejects.toThrow('Forbidden')
  })
})

describe('removeUploadTask', () => {
  it('removes a tracked upload task', async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      json: async () => ({
        success: [{ id: 'file-1', name: 'photo.png', type: 'image/png', size: 1, url: '/files/file-1' }],
      }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await uploadAttachments('session-1', [makeFile('photo.png', 1, 'image/png')])
    const taskId = result.success[0].id

    expect(getUploadTasks()[taskId]).toBeDefined()
    removeUploadTask(taskId)
    expect(getUploadTasks()[taskId]).toBeUndefined()
  })
})
