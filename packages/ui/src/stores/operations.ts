import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../composables/api'
import type { OperationListResponse, OperationStatus, OperationSummary, OperationTrace } from '../types'

export const useOperationStore = defineStore('operations', () => {
  const operations = ref<OperationSummary[]>([])
  const selectedTrace = ref<OperationTrace | null>(null)
  const page = ref(0)
  const totalPages = ref(0)
  const totalElements = ref(0)
  const loading = ref(false)
  const traceLoading = ref(false)
  const error = ref<string | null>(null)

  async function load(filters: {
    sessionId?: string
    workspaceId?: string
    status?: OperationStatus | string
    page?: number
    size?: number
  } = {}): Promise<OperationListResponse> {
    loading.value = true
    error.value = null
    try {
      const result = await api.listOperations(filters)
      operations.value = result.operations
      page.value = result.page
      totalPages.value = result.totalPages
      totalElements.value = result.totalElements
      return result
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function loadTrace(operationId: string): Promise<OperationTrace> {
    traceLoading.value = true
    error.value = null
    try {
      const trace = await api.getOperationTrace(operationId)
      selectedTrace.value = trace
      return trace
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      traceLoading.value = false
    }
  }

  function clearTrace() {
    selectedTrace.value = null
  }

  return {
    operations,
    selectedTrace,
    page,
    totalPages,
    totalElements,
    loading,
    traceLoading,
    error,
    load,
    loadTrace,
    clearTrace,
  }
})
