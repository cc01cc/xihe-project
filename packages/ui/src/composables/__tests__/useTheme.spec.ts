import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useTheme } from '../useTheme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
})

describe('useTheme', () => {
  it('defaults to system theme', () => {
    const { colorMode } = useTheme()
    expect(colorMode.value).toBe('system')
  })

  it('defaults theme ref to light when system mode with non-dark preference', () => {
    const { theme } = useTheme()
    expect(theme.value).toBe('light')
  })

  it('setColorMode switches to dark', async () => {
    const { colorMode, setColorMode, theme } = useTheme()

    setColorMode('dark')
    await nextTick()

    expect(colorMode.value).toBe('dark')
    expect(theme.value).toBe('dark')
  })

  it('setColorMode switches to light', async () => {
    const { colorMode, setColorMode, theme } = useTheme()

    setColorMode('dark')
    await nextTick()
    setColorMode('light')
    await nextTick()

    expect(colorMode.value).toBe('light')
    expect(theme.value).toBe('light')
  })

  it('setColorMode switches back to system', async () => {
    const { colorMode, setColorMode } = useTheme()

    setColorMode('dark')
    await nextTick()
    setColorMode('system')
    await nextTick()

    expect(colorMode.value).toBe('system')
  })

  it('persists theme to localStorage', async () => {
    const { setColorMode } = useTheme()

    setColorMode('dark')
    await nextTick()

    expect(localStorage.getItem('xihe-theme')).toBe('dark')
  })

  it('persists light theme to localStorage', async () => {
    const { setColorMode } = useTheme()

    setColorMode('light')
    await nextTick()

    expect(localStorage.getItem('xihe-theme')).toBe('light')
  })

  it('reads persisted theme after setColorMode', async () => {
    const { setColorMode, colorMode } = useTheme()

    setColorMode('dark')
    await nextTick()
    expect(colorMode.value).toBe('dark')

    setColorMode('system')
    await nextTick()
    expect(colorMode.value).toBe('system')
  })

  it('FOUC-free: applies class on html element immediately', async () => {
    const { setColorMode } = useTheme()

    setColorMode('dark')
    await nextTick()

    const htmlClass = document.documentElement.className
    expect(htmlClass).toContain('dark')
  })

  it('returns reactive theme ref', async () => {
    const { theme, setColorMode } = useTheme()

    expect(theme.value).toBe('light')

    setColorMode('dark')
    await nextTick()

    expect(theme.value).toBe('dark')
  })
})
