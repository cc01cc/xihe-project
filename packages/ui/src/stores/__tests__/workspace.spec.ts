import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { ApiError, api } from '../../composables/api'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      deleteFile: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      readFileRange: vi.fn(),
      listDirectory: vi.fn(),
      moveFile: vi.fn(),
      copyFile: vi.fn(),
      createDirectory: vi.fn(),
    },
  }
})

vi.mock('../../composables/fileService', () => ({
  readFilePreview: vi.fn(),
}))

vi.mock('../session', () => ({
  useSessionStore: () => ({
    currentSessionId: null,
    currentSessionAttachments: [],
    currentSessionFileContext: undefined,
    currentAgentIds: [],
    setFileContext: vi.fn(),
  }),
}))

vi.mock('../auth', () => ({
  useAuthStore: () => ({
    currentWorkspaceId: 'ws-test',
  }),
}))

const mockedApi = vi.mocked(api, true)

function problemError(status: number, code: string): ApiError {
  return new ApiError({ status, code, detail: code, requestId: 'test' })
}

describe('workspace store highlightFile', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('expands parent directories for a nested path', () => {
    const store = useWorkspaceStore()
    store.highlightFile('src/components/Button.tsx')
    expect(store.expandedPaths.has('src')).toBe(true)
    expect(store.expandedPaths.has('src/components')).toBe(true)
    expect(store.expandedPaths.has('src/components/Button.tsx')).toBe(true)
  })

  it('sets activeFilePath if file is already open', () => {
    const store = useWorkspaceStore()
    store.openFiles.set('test.txt', {
      path: 'test.txt',
      name: 'test.txt',
      content: '',
      originalContent: '',
      language: 'plaintext',
      modified: false,
      loading: false,
    })
    store.highlightFile('test.txt')
    expect(store.activeFilePath).toBe('test.txt')
  })

  it('handles single-segment paths', () => {
    const store = useWorkspaceStore()
    store.highlightFile('README.md')
    expect(store.expandedPaths.has('README.md')).toBe(true)
  })
})

describe('workspace store deleteNode (B-2 failure semantics)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('returns true and clears the open file on success', async () => {
    mockedApi.deleteFile.mockResolvedValue(undefined)
    mockedApi.listDirectory.mockResolvedValue({ entries: [] })
    const store = useWorkspaceStore()
    store.openFiles.set('gone.txt', {
      path: 'gone.txt',
      name: 'gone.txt',
      content: '',
      originalContent: '',
      language: 'plaintext',
      modified: false,
      loading: false,
    })
    const result = await store.deleteNode('gone.txt')
    expect(result).toBe(true)
    expect(store.openFiles.has('gone.txt')).toBe(false)
  })

  it('returns false and records treeError on 404 (no throw, no fake success)', async () => {
    mockedApi.deleteFile.mockRejectedValue(problemError(404, 'FILE_NOT_FOUND'))
    const store = useWorkspaceStore()
    const result = await store.deleteNode('missing.txt')
    expect(result).toBe(false)
    expect(store.treeError).toContain('删除失败')
  })

  it('returns false and records treeError on 500', async () => {
    mockedApi.deleteFile.mockRejectedValue(problemError(500, 'RUNTIME_ERROR'))
    const store = useWorkspaceStore()
    const result = await store.deleteNode('x.txt')
    expect(result).toBe(false)
    expect(store.treeError).toContain('沙盒未就绪')
  })
})

describe('workspace store createFile (Q-3 same-mode fix)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('returns true on success', async () => {
    mockedApi.writeFile.mockResolvedValue({ success: true })
    mockedApi.listDirectory.mockResolvedValue({ entries: [] })
    const store = useWorkspaceStore()
    const result = await store.createFile('src', 'new.ts')
    expect(result).toBe(true)
    expect(mockedApi.writeFile).toHaveBeenCalledWith('src/new.ts', '', 'ws-test')
  })

  it('returns false and records treeError on failure', async () => {
    mockedApi.writeFile.mockRejectedValue(problemError(400, 'INVALID_REQUEST'))
    const store = useWorkspaceStore()
    const result = await store.createFile('', 'bad')
    expect(result).toBe(false)
    expect(store.treeError).toContain('创建文件失败')
  })
})

describe('workspace store rename/move/duplicate/mkdir (M3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('renameNode validates name and remaps open file', async () => {
    mockedApi.listDirectory.mockResolvedValue({ entries: [] })
    const store = useWorkspaceStore()
    expect(await store.renameNode('a.txt', '')).toBe(false)
    expect(await store.renameNode('a.txt', 'b/c')).toBe(false)
    expect(store.treeError).toContain('Invalid name')

    store.openFiles.set('a.txt', {
      path: 'a.txt',
      name: 'a.txt',
      content: 'x',
      originalContent: 'x',
      language: 'plaintext',
      modified: false,
      loading: false,
    })
    store.activeFilePath = 'a.txt'
    mockedApi.moveFile.mockResolvedValue({ success: true })
    const result = await store.renameNode('a.txt', 'b.txt')
    expect(result).toBe(true)
    expect(mockedApi.moveFile).toHaveBeenCalledWith('a.txt', 'b.txt', 'ws-test')
    expect(store.activeFilePath).toBe('b.txt')
    expect(store.openFiles.has('b.txt')).toBe(true)
  })

  it('renameNode records treeError on backend failure', async () => {
    mockedApi.moveFile.mockRejectedValue(problemError(404, 'FILE_NOT_FOUND'))
    const store = useWorkspaceStore()
    expect(await store.renameNode('a.txt', 'b.txt')).toBe(false)
    expect(store.treeError).toContain('Failed to rename')
  })

  it('moveNode closes the file and keeps expansion', async () => {
    mockedApi.moveFile.mockResolvedValue({ success: true })
    mockedApi.listDirectory.mockResolvedValue({ entries: [] })
    const store = useWorkspaceStore()
    store.openFiles.set('src/a.txt', {
      path: 'src/a.txt',
      name: 'a.txt',
      content: '',
      originalContent: '',
      language: 'plaintext',
      modified: false,
      loading: false,
    })
    const result = await store.moveNode('src/a.txt', 'dst')
    expect(result).toBe(true)
    expect(mockedApi.moveFile).toHaveBeenCalledWith('src/a.txt', 'dst/a.txt', 'ws-test')
    expect(store.openFiles.has('src/a.txt')).toBe(false)
  })

  it('duplicateNode appends -copy before extension', async () => {
    mockedApi.copyFile.mockResolvedValue({ success: true })
    mockedApi.listDirectory.mockResolvedValue({ entries: [] })
    const store = useWorkspaceStore()
    expect(await store.duplicateNode('src/a.txt')).toBe(true)
    expect(mockedApi.copyFile).toHaveBeenCalledWith('src/a.txt', 'src/a-copy.txt', 'ws-test')
  })

  it('createDirectory validates name and calls mkdir', async () => {
    mockedApi.createDirectory.mockResolvedValue({ success: true })
    mockedApi.listDirectory.mockResolvedValue({ entries: [] })
    const store = useWorkspaceStore()
    expect(await store.createDirectory('src', '')).toBe(false)
    expect(await store.createDirectory('src', 'a/b')).toBe(false)
    expect(await store.createDirectory('src', 'assets')).toBe(true)
    expect(mockedApi.createDirectory).toHaveBeenCalledWith('src/assets', 'ws-test')
  })
})

describe('workspace store openFile preview routing (PLAN-292 T6)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('routes raster images through the binary-safe read and stores a data URL', async () => {
    const store = useWorkspaceStore()
    vi.mocked(api.readFileRange).mockResolvedValue({ content: 'aGk=', total_lines: 0, is_binary: true })

    await store.openFile('pics/photo.png')

    expect(api.readFileRange).toHaveBeenCalledWith('pics/photo.png', 'ws-test')
    expect(store.openFiles.get('pics/photo.png')?.content).toBe('data:image/png;base64,aGk=')
  })

  it('rejects a non-binary result for raster extensions instead of rendering garbage', async () => {
    const store = useWorkspaceStore()
    vi.mocked(api.readFileRange).mockResolvedValue({ content: 'text?', total_lines: 3, is_binary: false })

    await store.openFile('pics/photo.png')

    expect(store.openFiles.has('pics/photo.png')).toBe(false)
    expect(store.treeError).toContain('not a binary file')
  })

  it('wraps svg text content as a utf8 data URL without the binary path', async () => {
    const store = useWorkspaceStore()
    const { readFilePreview } = await import('../../composables/fileService')
    vi.mocked(readFilePreview).mockResolvedValue({ content: '<svg xmlns="http://www.w3.org/2000/svg"/>', truncated: false })

    await store.openFile('icons/logo.svg')

    expect(api.readFileRange).not.toHaveBeenCalled()
    const opened = store.openFiles.get('icons/logo.svg')
    expect(opened?.content).toBe(
      'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E',
    )
    expect(opened?.originalContent).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>')
  })

  it('keeps text files on the size-guarded text preview path', async () => {
    const store = useWorkspaceStore()
    const { readFilePreview } = await import('../../composables/fileService')
    vi.mocked(readFilePreview).mockResolvedValue({ content: 'hello', truncated: false })

    await store.openFile('docs/note.md')

    expect(api.readFileRange).not.toHaveBeenCalled()
    expect(store.openFiles.get('docs/note.md')?.content).toBe('hello')
  })
})
