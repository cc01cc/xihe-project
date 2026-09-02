import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useSessionStore } from './session'
import { useAuthStore } from './auth'
import { api, apiPost, ApiError } from '../composables/api'
import { readFilePreview } from '../composables/fileService'
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
    try {
      const res = await api.listDirectory(dirPath, requireWorkspaceId())
      const entries = res.entries ?? []
      const dirs = entries.filter((e: any) => e.type === 'directory').sort((a: any, b: any) => a.name.localeCompare(b.name))
      const files = entries.filter((e: any) => e.type === 'file').sort((a: any, b: any) => a.name.localeCompare(b.name))
      for (const dir of dirs) {
        const childPath = dirPath ? `${dirPath}/${dir.name}` : dir.name
        nodes.push({
          name: dir.name,
          path: childPath,
          type: 'directory',
          children: await fetchDirectoryTree(childPath),
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
    } catch (e) {
      logger.warn('Failed to list directory: ' + (e instanceof Error ? e.message : String(e)))
    }
    return nodes
  }

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
    loading.value = true
    treeError.value = null
    try {
      fileTree.value = await fetchDirectoryTree('')
    } catch (e) {
      treeError.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  async function refreshTree() {
    expandedPaths.value = new Set()
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
      const res = await readFilePreview(path, size, requireWorkspaceId())
      const file: OpenFile = {
        path,
        name: path.split('/').pop() || path,
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
      file.content = content
      file.modified = content !== file.originalContent
    }
  }

  async function saveFile(path: string) {
    const file = openFiles.value.get(path)
    if (!file || !file.modified) return
    try {
      await api.writeFile(path, file.content, requireWorkspaceId())
      file.originalContent = file.content
      file.modified = false
    } catch (e) {
      treeError.value = `Failed to save ${path}: ${(e as Error).message}`
    }
  }

  async function deleteNode(path: string) {
    try {
      await api.deleteFile(path, requireWorkspaceId())
      closeFile(path)
      await loadTree()
      return true
    } catch (e) {
      treeError.value = `Failed to delete: ${(e as Error).message}`
      return false
    }
  }

  async function createFile(parentDir: string, name: string) {
    const fullPath = parentDir ? `${parentDir}/${name}` : name
    try {
      await api.writeFile(fullPath, '', requireWorkspaceId())
      await loadTree()
      return true
    } catch (e) {
      treeError.value = `Failed to create file: ${(e as Error).message}`
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
        } else {
          const text = await item.file.text()
          const fullPath = targetDir ? `${targetDir}/${item.name}` : item.name
          await api.writeFile(fullPath, text, requireWorkspaceId())
        }
        item.status = 'done'
      } catch (e) {
        item.status = 'error'
        item.error = (e as Error).message
      }
    }
    await loadTree()
  }

  async function splitPdf(path: string) {
    try {
      const res = await apiPost<{ chunks: string[] }>('/api/v1/files/split-pdf', JSON.stringify({ path }))
      const file = openFiles.value.get(path)
      if (file) {
        file.chunks = res.chunks
        file.chunkIndex = 0
        if (res.chunks.length > 0) {
          const chunkRes = await api.readFile(res.chunks[0], requireWorkspaceId())
          file.content = chunkRes.content
          file.originalContent = chunkRes.content
        }
      }
    } catch (e) {
      treeError.value = `Split failed: ${(e as Error).message}`
    }
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
    deleteNode, createFile, splitPdf, loadFullContent,
    openImportDialog, closeImportDialog, addToUploadQueue, removeFromUploadQueue, executeUpload,
    syncActiveFileToSession,
  }
})
