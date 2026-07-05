import Dexie, { type Table } from 'dexie'

const MAX_BATCH = 50
const MAX_BATCH_BYTES = 64 * 1024
const FLUSH_INTERVAL = 5000

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  id?: number
  timestamp: number
  level: LogLevel
  message: string
  data?: unknown
}

interface TelemetryEntry {
  timestamp: number
  level: LogLevel
  message: string
  data?: unknown
}

class LogDatabase extends Dexie {
  logs!: Table<LogEntry, number>

  constructor() {
    super('XiheLogDB')
    this.version(1).stores({
      logs: '++id, timestamp, level',
    })
  }
}

const db = new LogDatabase()
const MAX_LOGS = 10000

class Logger {
  private isEnabled = true
  private context: Record<string, unknown> = {}
  private batch: TelemetryEntry[] = []
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private rateLimitedUntil = 0

  constructor() {
    this.startFlushTimer()
    this.installPagehideHook()
  }

  setContext(ctx: Record<string, unknown>): void {
    this.context = ctx
  }

  private async persist(entry: LogEntry): Promise<void> {
    try {
      await db.logs.add(entry)
      const count = await db.logs.count()
      if (count > MAX_LOGS) {
        const toDelete = await db.logs.orderBy('id').limit(count - MAX_LOGS).toArray()
        if (toDelete.length > 0) await db.logs.bulkDelete(toDelete.map(l => l.id!))
      }
    } catch { /* storage failure is non-critical */ }
  }

  private sanitizeData(data: unknown): unknown {
    if (data && typeof data === 'object') {
      const isDomException = typeof DOMException !== 'undefined' && data instanceof DOMException
      if (data instanceof Error || isDomException) {
        return {
          name: (data as Error).name,
          message: (data as Error).message,
          stack: (data as Error).stack,
          ...(isDomException ? { code: (data as DOMException).code } : {}),
        }
      }
      const sanitized = { ...data as Record<string, unknown> }
      if ('token' in sanitized) sanitized.token = '[REDACTED]'
      if ('key' in sanitized) sanitized.key = '[REDACTED]'
      return sanitized
    }
    return data
  }

  private sanitizeMessage(msg: string): string {
    return msg.replace(/\n/g, ' ').replace(/\r/g, '')
  }

  private startFlushTimer(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = setTimeout(() => {
      this.flush().catch(() => {})
      this.startFlushTimer()
    }, FLUSH_INTERVAL)
  }

  private installPagehideHook(): void {
    if (typeof window === 'undefined') return
    window.addEventListener('pagehide', () => {
      if (this.batch.length === 0) return
      this.clearBatchOnPageHide()
    })
  }

  async flush(): Promise<void> {
    if (this.batch.length === 0) return
    if (this.rateLimitedUntil > Date.now()) {
      if (this.batch.length > MAX_BATCH) this.batch = this.batch.slice(-MAX_BATCH)
      return
    }

    const entries = this.batch.splice(0, MAX_BATCH)
    const deviceId = (this.context.deviceId as string) || 'unknown'
    const payload = JSON.stringify({ device_id: deviceId, entries })

    if (payload.length > MAX_BATCH_BYTES) {
      const truncated = this.truncateBatch(entries)
      await this.sendTelemetry(JSON.stringify({ device_id: deviceId, entries: truncated }))
      return
    }

    await this.sendTelemetry(payload)
  }

  private truncateBatch(entries: TelemetryEntry[]): TelemetryEntry[] {
    const deviceId = (this.context.deviceId as string) || 'unknown'
    let result = [...entries]
    while (result.length > 0) {
      const test = JSON.stringify({ device_id: deviceId, entries: result })
      if (test.length <= MAX_BATCH_BYTES) return result
      result = result.slice(1)
    }
    return result
  }

  private async sendTelemetry(payload: string): Promise<void> {
    // Backend does not have telemetry endpoint yet — disable sending to avoid 404 errors
    void payload
    return
  }

  private clearBatchOnPageHide(): void {
    // Backend does not have telemetry endpoint yet — discard queued telemetry on unload
    this.batch.splice(0, this.batch.length)
  }

  private emit(level: LogLevel, message: string, data?: unknown) {
    if (!this.isEnabled) return

    const deviceTag = this.context.deviceId ? ` [${this.context.deviceId}]` : ''
    const sanitize = typeof process !== 'undefined' && process.env.NODE_ENV === 'test'
      ? true
      : !import.meta.env.DEV

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      data: data ? (sanitize ? this.sanitizeData(data) : data) : undefined,
    }

    const ts = new Date(entry.timestamp).toLocaleTimeString('zh-CN')
    const prefix = `[${ts}] [${level.toUpperCase()}]${deviceTag}`
    // oxlint-disable-next-line no-console
    const cfn = level === 'error' ? console.error
      // oxlint-disable-next-line no-console
      : level === 'warn' ? console.warn
      // oxlint-disable-next-line no-console
      : level === 'debug' ? console.debug
      // oxlint-disable-next-line no-console
      : console.log
    cfn(prefix, message, data, this.context)

    this.persist(entry).catch(() => {})

    // Telemetry batch: info+ in prod, debug+ in dev
    const shouldTelemetry = import.meta.env.DEV
      ? true
      : level !== 'debug'
    if (shouldTelemetry) {
      this.batch.push({
        timestamp: entry.timestamp,
        level,
        message: this.sanitizeMessage(message),
        data: entry.data as Record<string, unknown> | undefined,
      })
    }
  }

  info(message: string, data?: unknown) { this.emit('info', message, data) }
  warn(message: string, data?: unknown) { this.emit('warn', message, data) }
  error(message: string, data?: unknown) { this.emit('error', message, data) }
  debug(message: string, data?: unknown) { this.emit('debug', message, data) }

  async getLogs(): Promise<LogEntry[]> {
    return await db.logs.orderBy('timestamp').toArray()
  }

  async exportLogs(): Promise<string> {
    return JSON.stringify(await this.getLogs(), null, 2)
  }

  async download(): Promise<void> {
    const all = await db.logs.orderBy('timestamp').toArray()
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `xihe-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async clearLogs() { await db.logs.clear() }
}

export const logger = new Logger()

export function useLogger() {
  return logger
}
