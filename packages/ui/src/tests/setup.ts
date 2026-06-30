import { config } from '@vue/test-utils'
import { beforeEach, afterEach } from 'vitest'

config.global.stubs = {
  Teleport: { template: '<div><slot /></div>' },
}

// Diagnostic: log test timing to diagnose timeouts
let testStartTime = 0

beforeEach(() => {
  testStartTime = Date.now()
})

afterEach(() => {
  const elapsed = Date.now() - testStartTime
  // Only log if test is slow (>2s) to avoid noise
  if (elapsed > 2000) {
    console.warn(`[SLOW TEST] ${elapsed}ms`)
  }
})
