import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Dexie
const mockTable = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue(1),
  count: vi.fn().mockResolvedValue(0),
  orderBy: vi.fn().mockReturnThis(),
  toArray: vi.fn().mockResolvedValue([]),
  bulkDelete: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
  limit: vi.fn().mockReturnThis(),
}))
vi.mock('dexie', () => {
  class Dexie {
    logs: unknown
    version = vi.fn().mockReturnThis()
    stores = vi.fn().mockImplementation(function (this: Dexie) {
      this.logs = mockTable
      return this
    })
  }
  return { default: Dexie }
})

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export logger singleton', async () => {
    const { logger } = await import('../../lib/logger')
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(typeof logger.debug).toBe('function')
  })

  it('should provide useLogger composable', async () => {
    const { useLogger } = await import('../../lib/logger')
    const l = useLogger()
    expect(l).toBeDefined()
  })

  it('should have getLogs and exportLogs methods', async () => {
    const { logger } = await import('../../lib/logger')
    expect(typeof logger.getLogs).toBe('function')
    expect(typeof logger.exportLogs).toBe('function')
    expect(typeof logger.download).toBe('function')
    expect(typeof logger.clearLogs).toBe('function')
  })

  it('should redact sensitive keys and secret patterns in persisted data', async () => {
    const { logger } = await import('../../lib/logger')
    mockTable.add.mockClear()

    logger.info('auth ok', {
      token: 'secret-token-value',
      nested: { authorization: 'Bearer abc.def.ghi', keep: 'visible' },
      list: [{ refreshToken: 'refresh-secret' }],
    })
    logger.info('Bearer sk-live-1234567890abcdef and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZw')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mockTable.add).toHaveBeenCalled()
    const persisted = JSON.stringify(mockTable.add.mock.calls.map(call => call[0]))
    expect(persisted).not.toContain('secret-token-value')
    expect(persisted).not.toContain('abc.def.ghi')
    expect(persisted).not.toContain('refresh-secret')
    expect(persisted).not.toContain('sk-live-1234567890abcdef')
    expect(persisted).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(persisted).toContain('visible')
    expect(persisted).toContain('***redacted***')
  })
})
