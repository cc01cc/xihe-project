import { ref, type Ref } from 'vue'

export interface Toast {
  id: number
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
}

const toasts = ref<Toast[]>([]) as Ref<Toast[]>
let nextId = 0

const TIMEOUT: Record<Toast['type'], number> = {
  success: 3000,
  error: 5000,
  warning: 4000,
  info: 3000,
}

const MAX_TOASTS = 5

function addToast(type: Toast['type'], message: string) {
  const normalized = message.trim()
  if (toasts.value.some(t => t.type === type && t.message.trim() === normalized)) {
    return
  }
  const id = nextId++
  toasts.value.push({ id, type, message: normalized })
  if (toasts.value.length > MAX_TOASTS) {
    toasts.value.shift()
  }
  setTimeout(() => {
    const idx = toasts.value.findIndex(t => t.id === id)
    if (idx !== -1) toasts.value.splice(idx, 1)
  }, TIMEOUT[type])
}

export function clearToasts() {
  toasts.value = []
}

export function useToast() {
  return {
    toasts,
    success: (msg: string) => addToast('success', msg),
    error: (msg: string) => addToast('error', msg),
    warning: (msg: string) => addToast('warning', msg),
    info: (msg: string) => addToast('info', msg),
  }
}
