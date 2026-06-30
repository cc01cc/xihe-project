import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useToast, clearToasts } from '../useToast'

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearToasts()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('adds a success toast', () => {
    const { toasts, success } = useToast()
    success('File saved')
    expect(toasts.value.length).toBe(1)
    expect(toasts.value[0].type).toBe('success')
    expect(toasts.value[0].message).toBe('File saved')
  })

  it('adds an error toast', () => {
    const { toasts, error } = useToast()
    error('Connection failed')
    expect(toasts.value.length).toBe(1)
    expect(toasts.value[0].type).toBe('error')
  })

  it('adds a warning toast', () => {
    const { toasts, warning } = useToast()
    warning('Disk nearly full')
    expect(toasts.value.length).toBe(1)
    expect(toasts.value[0].type).toBe('warning')
  })

  it('adds an info toast', () => {
    const { toasts, info } = useToast()
    info('Theme switched')
    expect(toasts.value.length).toBe(1)
    expect(toasts.value[0].type).toBe('info')
  })

  it('auto-removes success toast after 3s', () => {
    const { toasts, success } = useToast()
    success('Done')
    expect(toasts.value.length).toBe(1)
    vi.advanceTimersByTime(3000)
    expect(toasts.value.length).toBe(0)
  })

  it('auto-removes error toast after 5s', () => {
    const { toasts, error } = useToast()
    error('Failed')
    expect(toasts.value.length).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(toasts.value.length).toBe(0)
  })

  it('allows multiple toasts', () => {
    const { toasts, success, warning } = useToast()
    success('First')
    warning('Second')
    expect(toasts.value.length).toBe(2)
  })
})
