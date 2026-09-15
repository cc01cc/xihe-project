import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ApiError, api } from '../composables/api'
import { logger } from '../lib/logger'
import type { SessionPolicyMode, SessionPolicyModeState } from '../types'

export interface SessionPolicyState {
  mode: SessionPolicyMode | null
  loading: boolean
  changing: boolean
  loaded: boolean
  error: string | null
}

function createState(): SessionPolicyState {
  return {
    mode: null,
    loading: false,
    changing: false,
    loaded: false,
    error: null,
  }
}

export const usePolicyStore = defineStore('policy', () => {
  const states = ref<Record<string, SessionPolicyState>>({})
  const loadPromises = new Map<string, Promise<void>>()
  const mutationGenerations = new Map<string, number>()

  function getState(sessionId: string): SessionPolicyState | undefined {
    return states.value[sessionId]
  }

  function stateFor(sessionId: string): SessionPolicyState {
    const existing = states.value[sessionId]
    if (existing) return existing
    const created = createState()
    states.value[sessionId] = created
    return states.value[sessionId]!
  }

  function errorMessage(cause: unknown, fallback: string): string {
    if (cause instanceof ApiError) {
      return `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
    }
    return cause instanceof Error ? cause.message : fallback
  }

  async function load(sessionId: string): Promise<void> {
    if (!sessionId) return
    const existingRequest = loadPromises.get(sessionId)
    if (existingRequest) return existingRequest

    const state = stateFor(sessionId)
    if (state.loaded) return
    const mutationGeneration = mutationGenerations.get(sessionId) ?? 0
    state.loading = true
    state.error = null
    const request = Promise.resolve().then(async () => {
      try {
        const result = await api.getPolicyMode(sessionId)
        if ((mutationGenerations.get(sessionId) ?? 0) === mutationGeneration) {
          state.mode = result.mode
          state.loaded = true
        }
      } catch (cause) {
        if ((mutationGenerations.get(sessionId) ?? 0) === mutationGeneration) {
          state.error = errorMessage(cause, 'Failed to load approval mode')
          logger.warn('Failed to load session policy mode', cause)
        }
      } finally {
        if (states.value[sessionId] === state) state.loading = false
        if (loadPromises.get(sessionId) === request) loadPromises.delete(sessionId)
      }
    })
    loadPromises.set(sessionId, request)
    return request
  }

  async function change(sessionId: string, mode: SessionPolicyMode): Promise<SessionPolicyModeState> {
    const state = stateFor(sessionId)
    const generation = (mutationGenerations.get(sessionId) ?? 0) + 1
    mutationGenerations.set(sessionId, generation)
    state.changing = true
    state.error = null
    try {
      const result = await api.setPolicyMode(sessionId, mode)
      if (mutationGenerations.get(sessionId) === generation) {
        state.mode = result.mode
        state.loaded = true
      }
      return result
    } catch (cause) {
      if (mutationGenerations.get(sessionId) === generation) {
        state.error = errorMessage(cause, 'Failed to change approval mode')
        logger.warn('Failed to change session policy mode', cause)
      }
      throw cause
    } finally {
      if (mutationGenerations.get(sessionId) === generation) state.changing = false
    }
  }

  function reset() {
    states.value = {}
    loadPromises.clear()
    mutationGenerations.clear()
  }

  return { states, getState, stateFor, load, change, reset }
})
