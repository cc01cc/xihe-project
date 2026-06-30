import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiPost, apiGet, apiDelete } from '../composables/api'

export interface KnowledgeDoc {
  id: string
  filename: string
  chunks: number
  uploadedAt: string
}

export const useKnowledgeStore = defineStore('knowledge', () => {
  const documents = ref<KnowledgeDoc[]>([])
  const loading = ref(false)

  async function upload(file: File, chunkSize = 1000, chunkOverlap = 200) {
    const form = new FormData()
    form.append('file', file)
    form.append('chunk_size', String(chunkSize))
    form.append('chunk_overlap', String(chunkOverlap))
    const res = await apiPost('/api/rag/ingest', form)
    return res
  }

  async function search(query: string, topK = 5) {
    const form = new FormData()
    form.append('query', query)
    form.append('top_k', String(topK))
    return await apiPost('/api/rag/search', form)
  }

  async function fetchStats() {
    return await apiGet('/api/rag/stats')
  }

  async function remove(id: string) {
    await apiDelete(`/api/rag/documents/${id}`)
  }

  return { documents, loading, upload, search, fetchStats, remove }
})
