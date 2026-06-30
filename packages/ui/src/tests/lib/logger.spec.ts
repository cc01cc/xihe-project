import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Dexie
vi.mock('dexie', () => {
  const mockTable = {
    add: vi.fn().mockResolvedValue(1),
    count: vi.fn().mockResolvedValue(0),
    orderBy: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
    bulkDelete: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    limit: vi.fn().mockReturnThis(),
  }
  const Dexie = vi.fn(() => ({
    version: vi.fn().mockReturnThis(),
    stores: vi.fn().mockReturnThis(),
    logs: mockTable,
  }))
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
})
