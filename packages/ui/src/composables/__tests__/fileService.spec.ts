import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFilePreview } from '../fileService'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('readFilePreview', () => {
  it('handles intercept case with empty content', async () => {
    const result = await readFilePreview('/large/file', 200 * 1024 * 1024)
    expect(result).toEqual({ content: '', truncated: true })
  })

  it('calls the runtime read_file tool via MCP for full read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: () => Promise.resolve('data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"file content"}]}}'),
    } as unknown as Response)
    const result = await readFilePreview('/small/file', 100)
    expect(result.content).toBe('file content')
    expect(result.truncated).toBe(false)
  })

  it('throws on API error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response)
    await expect(readFilePreview('/bad/file', 100)).rejects.toThrow('API error 500')
  })
})
