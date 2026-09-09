import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useSessionStore } from './session'
import { useAuthStore } from './auth'
import { api, apiPost, ApiError } from '../composables/api'
import { readFilePreview } from '../composables/fileService'
import { humanizeErrorCode } from '../lib/errorMessages'
import { logger } from '../lib/logger'
import type { FileNode, OpenFile, UploadItem } from '../types'

function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', java: 'java', go: 'go',
    vue: 'vue', svelte: 'svelte', html: 'html', css: 'css',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
    sql: 'sql', xml: 'xml', sh: 'shell', bash: 'shell',
    toml: 'toml', c: 'c', cpp: 'cpp', h: 'c',
  }
  return map[ext] || 'plaintext'
}

function isRuntimeArtifact(name: string): boolean {
  return name.startsWith('.xihe-') || /^container-runtime\.log(?:\..*)?$/.test(name)
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const sessionStore = useSessionStore()
  const authStore = useAuthStore()

  const sessionId = computed<string | null>(() => sessionStore.currentSessionId)
  const sessionAttachments = computed(() => sessionStore.currentSessionAttachments)
  const sessionFileContext = computed(() => sessionStore.currentSessionFileContext)
  const sessionAgents = computed(() => sessionStore.currentAgentIds)
  const workspaceId = computed(() => authStore.currentWorkspaceId)

  function requireWorkspaceId(): string {
    if (!workspaceId.value) {
      throw new ApiError({
        status: 400,
        code: 'WORKSPACE_CONTEXT_REQUIRED',
        detail: 'Workspace context is required',
        requestId: 'client',
      })
    }
    return workspaceId.value
  }

  const fileTree = ref<FileNode[]>([])
  const expandedPaths = ref<Set<string>>(new Set())
  const loading = ref(false)
  const treeError = ref<string | null>(null)
  const loadedWorkspaceId = ref<string | null>(null)

  const openFiles = ref<Map<string, OpenFile>>(new Map())
  const activeFilePath = ref<string | null>(null)

  const showImportDialog = ref(false)
  const uploadQueue = ref<UploadItem[]>([])

  const activeFile = computed(() => {
    if (!activeFilePath.value) return null
    return openFiles.value.get(activeFilePath.value) ?? null
  })

  const openFileList = computed(() => {
    return Array.from(openFiles.value.values())
  })

  async function fetchDirectoryTree(dirPath: string): Promise<FileNode[]> {
    const nodes: FileNode[] = []
    const res = await api.listDirectory(dirPath, requireWorkspaceId())
    const entries = (res.entries ?? []).filter((entry: any) => !isRuntimeArtifact(entry.name))
    const dirs = entries.filter((e: any) => e.type === 'directory').sort((a: any, b: any) => a.name.localeCompare(b.name))
    const files = entries.filter((e: any) => e.type === 'file').sort((a: any, b: any) => a.name.localeCompare(b.name))
    for (const dir of dirs) {
      const childPath = dirPath ? `${dirPath}/${dir.name}` : dir.name
      const children = await fetchDirectoryTree(childPath)
      if (dir.name === 'logs' && children.length === 0) continue
      nodes.push({
        name: dir.name,
        path: childPath,
        type: 'directory',
        children,
      })
    }
    for (const file of files) {
      const filePath = dirPath ? `${dirPath}/${file.name}` : file.name
      nodes.push({
        name: file.name,
        path: filePath,
        type: 'file',
        size: file.size,
        modified: file.modified,
        mimeType: detectMimeType(file.name),
      })
    }
    return nodes
  }

  // PLAN-292 T6: raster-image extensions routed to the binary-safe
  // read_file_range path (aligned with FileEditor's isImage list);
  // svg is text and takes the utf8 data-URL branch below.
  const IMAGE_PREVIEW_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

  function detectMimeType(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() || ''
    const map: Record<string, string> = {
      md: 'text/markdown', pdf: 'application/pdf',
      ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript',
      py: 'text/x-python', rs: 'text/x-rust', vue: 'text/html',
      json: 'application/json', yaml: 'text/yaml',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
      txt: 'text/plain', csv: 'text/csv', log: 'text/plain',
    }
    return map[ext] || 'application/octet-stream'
  }

  async function loadTree() {
    const currentWorkspaceId = workspaceId.value
    if (!currentWorkspaceId || loading.value || loadedWorkspaceId.value === currentWorkspaceId) return

    loading.value = true
    treeError.value = null
    try {
      // E2E seeding hook (mock profile only): lets Playwright inject a tree
      // without a live CP+MCP chain. Never set by production code.
      if (typeof localStorage !== 'undefined') {
        try {
          const seed = localStorage.getItem('xihe-mock-filetree')
          if (seed) {
            fileTree.value = JSON.parse(seed) as FileNode[]
            loadedWorkspaceId.value = currentWorkspaceId
            return
          }
        } catch {
          // fall through to the real chain
        }
      }
      fileTree.value = await fetchDirectoryTree('')
      loadedWorkspaceId.value = currentWorkspaceId
    } catch (e) {
      treeError.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  async function refreshTree() {
    expandedPaths.value = new Set()
    loadedWorkspaceId.value = null
    await loadTree()
  }

  function toggleExpand(path: string) {
    const next = new Set(expandedPaths.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    expandedPaths.value = next
  }

  function findFileSize(path: string): number | undefined {
    function walk(nodes: FileNode[]): number | undefined {
      for (const n of nodes) {
        if (n.path === path) return n.size
        if (n.children) {
          const found = walk(n.children)
          if (found !== undefined) return found
        }
      }
      return undefined
    }
    return walk(fileTree.value)
  }

  async function openFile(path: string) {
    if (openFiles.value.has(path)) {
      activeFilePath.value = path
      return
    }
    try {
      const size = findFileSize(path)
      const name = path.split('/').pop() || path
      const ext = name.split('.').pop()?.toLowerCase() || ''
      // PLAN-292 T6: images land as data URLs so FileEditor's ImagePreview
      // branch is reachable. svg is text — read via the guarded text path and
      // wrap as a utf8 data URL; raster images use the binary-safe tool.
      if (ext === 'svg') {
        const res = await readFilePreview(path, size, requireWorkspaceId())
        const svg: OpenFile = {
          path,
          name,
          content: `data:image/svg+xml;utf8,${encodeURIComponent(res.content)}`,
          originalContent: res.content,
          language: detectLanguage(path),
          modified: false,
          loading: false,
          truncated: res.truncated,
        }
        openFiles.value.set(path, svg)
        activeFilePath.value = path
        return
      }
      if (IMAGE_PREVIEW_EXTENSIONS.has(ext)) {
        const binary = await api.readFileRange(path, requireWorkspaceId())
        if (!binary.is_binary) {
          throw new Error('not a binary file')
        }
        const image: OpenFile = {
          path,
          name,
          content: `data:${detectMimeType(name)};base64,${binary.content}`,
          originalContent: '',
          language: detectLanguage(path),
          modified: false,
          loading: false,
          truncated: false,
        }
        openFiles.value.set(path, image)
        activeFilePath.value = path
        return
      }
      const res = await readFilePreview(path, size, requireWorkspaceId())
      const file: OpenFile = {
        path,
        name,
        content: res.content,
        originalContent: res.content,
        language: detectLanguage(path),
        modified: false,
        loading: false,
        truncated: res.truncated,
      }
      openFiles.value.set(path, file)
      activeFilePath.value = path
    } catch (e) {
      treeError.value = `Failed to open ${path}: ${(e as Error).message}`
    }
  }

  function closeFile(path: string) {
    openFiles.value.delete(path)
    if (activeFilePath.value === path) {
      const remaining = openFileList.value
      activeFilePath.value = remaining.length > 0 ? remaining[remaining.length - 1].path : null
    }
  }

  function updateFileContent(path: string, content: string) {
    const file = openFiles.value.get(path)
    if (file) {
      openFiles.value.set(path, {
        ...file,
        content,
        modified: content !== file.originalContent,
      })
    }
  }

  async function saveFile(path: string) {
    const file = openFiles.value.get(path)
    if (!file || !file.modified) return
    try {
      await api.writeFile(path, file.content, requireWorkspaceId())
      openFiles.value.set(path, {
        ...file,
        originalContent: file.content,
        modified: false,
      })
    } catch (e) {
      treeError.value = humanizeFileError(e, `保存 ${path} 失败`)
    }
  }

  async function deleteNode(path: string): Promise<boolean> {
    try {
      await api.deleteFile(path, requireWorkspaceId())
      closeFile(path)
      const slash = path.lastIndexOf('/')
      await refreshAfterMutation(slash >= 0 ? path.substring(0, slash) : '')
      return true
    } catch (e) {
      const message = humanizeFileError(e, '删除失败')
      treeError.value = message
      logger.warn('Delete failed: ' + message)
      return false
    }
  }

  async function createFile(parentDir: string, name: string): Promise<boolean> {
    const fullPath = parentDir ? `${parentDir}/${name}` : name
    try {
      await api.writeFile(fullPath, '', requireWorkspaceId())
      await refreshAfterMutation(parentDir)
      return true
    } catch (e) {
      const message = humanizeFileError(e, '创建文件失败')
      treeError.value = message
      logger.warn('Create file failed: ' + message)
      return false
    }
  }

  function humanizeFileError(e: unknown, fallback: string): string {
    if (e instanceof ApiError) {
      const code = e.problem.code
      const mapped = humanizeErrorCode(code, e.problem.detail)
      if (mapped && mapped !== `${code}: ${e.problem.detail}`) return mapped
      if (e.problem.detail) return `${fallback}: ${e.problem.detail}`
    }
    return `${fallback}: ${e instanceof Error ? e.message : String(e)}`
  }

  /** Reload the tree while keeping the current expansion state (M3 task 3.4). */
  async function refreshAfterMutation(keepExpandedDir?: string) {
    if (keepExpandedDir) {
      const next = new Set(expandedPaths.value)
      const parts = keepExpandedDir.split('/')
      let current = ''
      for (const part of parts) {
        if (!part) continue
        current = current ? `${current}/${part}` : part
        next.add(current)
      }
      expandedPaths.value = next
    }
    loadedWorkspaceId.value = null
    await loadTree()
  }

  async function renameNode(oldPath: string, newName: string): Promise<boolean> {
    const trimmed = newName.trim()
    if (!trimmed || trimmed.includes('/')) {
      treeError.value = 'Invalid name: must be non-empty and contain no path separators'
      return false
    }
    const slash = oldPath.lastIndexOf('/')
    const newPath = slash >= 0 ? `${oldPath.substring(0, slash + 1)}${trimmed}` : trimmed
    if (newPath === oldPath) return true
    try {
      await api.moveFile(oldPath, newPath, requireWorkspaceId())
      if (activeFilePath.value === oldPath) {
        const file = openFiles.value.get(oldPath)
        openFiles.value.delete(oldPath)
        if (file) {
          file.path = newPath
          file.name = trimmed
          openFiles.value.set(newPath, file)
        }
        activeFilePath.value = newPath
      }
      await refreshAfterMutation(slash >= 0 ? oldPath.substring(0, slash) : '')
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      treeError.value = `Failed to rename: ${message}`
      logger.warn('Rename failed: ' + message)
      return false
    }
  }

  async function moveNode(from: string, toDir: string): Promise<boolean> {
    const name = from.split('/').pop() || from
    const to = toDir ? `${toDir}/${name}` : name
    if (to === from) return true
    try {
      await api.moveFile(from, to, requireWorkspaceId())
      closeFile(from)
      await refreshAfterMutation(toDir)
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      treeError.value = `Failed to move: ${message}`
      logger.warn('Move failed: ' + message)
      return false
    }
  }

  async function duplicateNode(path: string): Promise<boolean> {
    const slash = path.lastIndexOf('/')
    const dir = slash >= 0 ? path.substring(0, slash) : ''
    const base = slash >= 0 ? path.substring(slash + 1) : path
    const dot = base.lastIndexOf('.')
    const copyName = dot > 0 ? `${base.substring(0, dot)}-copy${base.substring(dot)}` : `${base}-copy`
    const to = dir ? `${dir}/${copyName}` : copyName
    try {
      await api.copyFile(path, to, requireWorkspaceId())
      await refreshAfterMutation(dir)
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      treeError.value = `Failed to duplicate: ${message}`
      logger.warn('Duplicate failed: ' + message)
      return false
    }
  }

  async function createDirectory(parentDir: string, name: string): Promise<boolean> {
    const trimmed = name.trim()
    if (!trimmed || trimmed.includes('/')) {
      treeError.value = 'Invalid directory name: must be non-empty and contain no path separators'
      return false
    }
    const fullPath = parentDir ? `${parentDir}/${trimmed}` : trimmed
    try {
      await api.createDirectory(fullPath, requireWorkspaceId())
      await refreshAfterMutation(parentDir)
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      treeError.value = `Failed to create directory: ${message}`
      logger.warn('Create directory failed: ' + message)
      return false
    }
  }

  function highlightFile(path: string) {
    const parts = path.split('/')
    let current = ''
    for (const part of parts) {
      if (current) current += '/'
      current += part
      const next = new Set(expandedPaths.value)
      next.add(current)
      expandedPaths.value = next
    }
    if (openFiles.value.has(path)) {
      activeFilePath.value = path
    }
  }

  function syncActiveFileToSession() {
    if (!sessionId.value || !activeFilePath.value) return
    sessionStore.setFileContext(sessionId.value, {
      activeFilePath: activeFilePath.value,
      workspaceFiles: Array.from(openFiles.value.keys()),
    })
  }

  function openImportDialog() { showImportDialog.value = true }
  function closeImportDialog() { showImportDialog.value = false; uploadQueue.value = [] }

  function addToUploadQueue(files: File[]) {
    for (const file of files) {
      uploadQueue.value.push({ file, name: file.name, size: file.size, status: 'pending', targetPath: file.name })
    }
  }

  function removeFromUploadQueue(index: number) {
    uploadQueue.value.splice(index, 1)
  }

  const TEXT_EXTENSIONS = new Set([
    'md', 'txt', 'csv', 'json', 'yaml', 'yml', 'toml', 'xml', 'svg',
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'java', 'go',
    'vue', 'svelte', 'css', 'scss', 'html', 'sh', 'bash', 'sql', 'log', 'gitignore',
  ])

  function isTextualFile(file: File): boolean {
    if (file.type.startsWith('text/')) return true
    if (file.type === 'application/json' || file.type === 'application/xml'
      || file.type === 'application/yaml' || file.type === 'application/javascript'
      || file.type === 'application/x-yaml') return true
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    return TEXT_EXTENSIONS.has(ext)
  }

  async function executeUpload(targetDir: string, splitPreference?: boolean) {
    for (const item of uploadQueue.value) {
      if (item.status === 'cancelled') continue
      item.status = 'uploading'
      try {
        const isLargePdf = item.name.toLowerCase().endsWith('.pdf') && item.size > 10 * 1024 * 1024
        if (isLargePdf && splitPreference) {
          const formData = new FormData()
          formData.append('file', item.file)
          formData.append('splitPreference', 'true')
          await apiPost('/api/v1/files/upload', formData)
        } else if (isTextualFile(item.file)) {
          const text = await item.file.text()
          const fullPath = targetDir ? `${targetDir}/${item.name}` : item.name
          await api.writeFile(fullPath, text, requireWorkspaceId())
        } else {
          // Binary files must preserve raw bytes: route through the CP upload
          // proxy (POST /api/v1/files/upload), which forwards the body to the
          // Runtime binary write endpoint. UTF-8 text() decode would corrupt them.
          const formData = new FormData()
          formData.append('file', item.file)
          await apiPost('/api/v1/files/upload', formData)
        }
        item.status = 'done'
      } catch (e) {
        item.status = 'error'
        item.error = (e as Error).message
      }
    }
    await refreshAfterMutation()
  }

  async function splitPdf(path: string) {
    // B-4 (PLAN-262 decision 17): the CP /api/v1/files/split-pdf route does not
    // exist (openapi drift). Fail closed instead of letting the request 404.
    treeError.value = 'PDF splitting is temporarily unavailable: the backend endpoint is not deployed.'
    logger.warn('splitPdf requested but /api/v1/files/split-pdf has no CP implementation: ' + path)
  }

  async function loadFullContent(path: string) {
    try {
      const res = await api.readFile(path, requireWorkspaceId())
      const file = openFiles.value.get(path)
      if (file) {
        file.content = res.content
        file.originalContent = res.content
        file.truncated = false
      }
    } catch (e) {
      treeError.value = `Failed to load full content: ${(e as Error).message}`
    }
  }

  return {
    sessionId, sessionAttachments, sessionFileContext, sessionAgents,
    fileTree, expandedPaths, loading, treeError,
    openFiles, activeFilePath, activeFile, openFileList,
    showImportDialog, uploadQueue,
    loadTree, refreshTree, toggleExpand, highlightFile,
    openFile, closeFile, updateFileContent, saveFile,
    deleteNode, createFile, renameNode, moveNode, duplicateNode, createDirectory,
    refreshAfterMutation,
    splitPdf, loadFullContent,
    openImportDialog, closeImportDialog, addToUploadQueue, removeFromUploadQueue, executeUpload,
    syncActiveFileToSession,
  }
})
