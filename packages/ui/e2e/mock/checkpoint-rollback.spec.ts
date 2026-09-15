import { test, expect, type Page } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

/**
 * PLAN-0328 M3 W4 (T3.5/T3.6/T3.8): checkpoint rollback + dual-diff mock E2E.
 *
 * Route registration follows the LIFO rule: the specific checkpoint/git-status routes are
 * registered AFTER `setupMockAuth`, so they win over its `**\/api/v1/**` catch-all.
 * No screenshot assertions: the checks are DOM/request assertions on server-provided values.
 */

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_DEGRADED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const RUN_EXPIRED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const RUN_NONE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const WORKSPACE_ID = 'workspace-1'

const CHECKPOINT_FILE_TEXT = 'const answer = 1\n'
const CURRENT_FILE_TEXT = 'const answer = 2\n'

interface MockState {
  projections: Record<string, Record<string, unknown>>
  preview: Record<string, unknown>
  result: Record<string, unknown>
  gitStatus: Record<string, unknown>
  messages: Record<string, Array<Record<string, unknown>>>
  gitCalls: number
  previewCalls: number
  executeBodies: Array<Record<string, unknown>>
  checkpointFileCalls: Array<{ path: string | null; ref: string | null }>
  retentionCalls: number
  gcCalls: number
}

function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    state: 'sealed',
    changedCount: 3,
    changedFiles: [
      { status: 'M', path: 'src/parser.ts' },
      { status: 'A', path: 'src/index.ts' },
      { status: 'D', path: 'src/legacy.ts' },
    ],
    sealedAt: '2026-09-15T10:00:00Z',
    revert: null,
    ...overrides,
  }
}

function preview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    state: 'sealed',
    counts: { restore: 2, delete: 1, skipConflicts: 1, noop: 1 },
    entries: [
      { path: 'src/parser.ts', action: 'restore' },
      { path: 'src/legacy.ts', action: 'delete' },
      { path: 'src/conflict.ts', action: 'restore', conflictReason: 'CONTENT_CHANGED' },
    ],
    headFingerprint: { recorded: 'abc', recordedAt: '2026-09-15T10:00:00Z', current: 'def', status: 'changed' },
    sealedWithLiveJobs: false,
    truncated: false,
    ...overrides,
  }
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    revertRef: 'refs/xihe/reverts/run-b',
    counts: { restored: 1, deleted: 1, skippedConflict: 1, failed: 0, noop: 0 },
    entries: [
      { path: 'src/parser.ts', result: 'restored' },
      { path: 'src/legacy.ts', result: 'deleted' },
      { path: 'src/conflict.ts', result: 'skippedConflict', reason: 'CONTENT_CHANGED' },
    ],
    durationMs: 1500,
    ...overrides,
  }
}

function createState(): MockState {
  return {
    projections: {
      [RUN_ID]: projection(),
      [RUN_DEGRADED]: projection({ runId: RUN_DEGRADED, state: 'degraded', unrollableReason: 'GIT_UNAVAILABLE', changedCount: 0, changedFiles: [] }),
      [RUN_EXPIRED]: projection({ runId: RUN_EXPIRED, state: 'expired', changedCount: 0, changedFiles: [] }),
      [RUN_NONE]: projection({ runId: RUN_NONE, state: 'none', changedCount: 0, changedFiles: [] }),
    },
    preview: preview(),
    result: result(),
    gitStatus: {
      isRepository: true,
      entries: [
        { status: 'M', path: 'README.md' },
        { status: '??', path: 'notes/draft.md' },
        { status: 'M', path: 'src/parser.ts' },
      ],
    },
    messages: messagesWithRun(),
    gitCalls: 0,
    previewCalls: 0,
    executeBodies: [],
    checkpointFileCalls: [],
    retentionCalls: 0,
    gcCalls: 0,
  }
}

/** Buffered SSE stream so checkpoint lifecycle annotations can be pushed at any time. */
async function installCheckpointSSE(page: Page) {
  await page.addInitScript(() => {
    const pending: unknown[] = []
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
    const encode = (value: string) => new TextEncoder().encode(value)
    const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    const drain = () => {
      if (!controllerRef) return
      while (pending.length > 0) {
        const item = pending.shift()
        controllerRef.enqueue(encode(sse('run_checkpoint', item)))
      }
    }
    ;(window as unknown as Record<string, unknown>).__pushCheckpointEvent = (payload: unknown) => {
      pending.push(payload)
      drain()
    }
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : input.url
      if (requestUrl.includes('/api/v1/events')) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller
            controller.enqueue(encode('retry: 1000\n\n'))
            queueMicrotask(drain)
          },
          cancel() {
            controllerRef = null
          },
        })
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return originalFetch(input, init)
    }
  })
}

async function pushCheckpointEvent(page: Page, payload: Record<string, unknown>) {
  await page.evaluate((data) => {
    ;(window as unknown as Record<string, unknown>).__pushCheckpointEvent!(data)
  }, payload)
}

async function installCheckpointRoutes(page: Page, state: MockState) {
  await page.route('**/api/v1/chat/runs/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path.endsWith('/checkpoint/revert/preview')) {
      state.previewCalls += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.preview) })
      return
    }
    if (path.endsWith('/checkpoint/revert')) {
      state.executeBodies.push((request.postDataJSON() as Record<string, unknown>) ?? {})
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.result) })
      return
    }
    if (path.endsWith('/checkpoint/file')) {
      state.checkpointFileCalls.push({ path: url.searchParams.get('path'), ref: url.searchParams.get('ref') })
      await route.fulfill({ status: 200, contentType: 'text/plain', body: CHECKPOINT_FILE_TEXT })
      return
    }
    if (path.endsWith('/checkpoint')) {
      const runId = path.split('/').filter(Boolean).at(-2) ?? ''
      const projectionPayload = state.projections[runId]
      if (!projectionPayload) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'RUN_NOT_FOUND' }) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projectionPayload) })
      return
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) })
  })

  await page.route('**/api/v1/workspaces/*/git-status', async (route) => {
    state.gitCalls += 1
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.gitStatus) })
  })

  await page.route('**/api/v1/workspaces/*/checkpoints/retention', async (route) => {
    state.retentionCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        maxRuns: 50,
        ttlDays: 30,
        unsealedNeverDeleted: true,
        currentRuns: 3,
        currentRefs: 11,
      }),
    })
  })

  await page.route('**/api/v1/workspaces/*/checkpoints/gc', async (route) => {
    state.gcCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ counts: { deletedRuns: 2, deletedRefs: 5 } }),
    })
  })

  // Workspace runtime tool channel for the "查看差异" fetch (read_file).
  await page.route('**/mcp', async (route) => {
    const body = route.request().postDataJSON() as {
      method?: string
      params?: { name?: string }
    } | null
    if (body?.method !== 'tools/call') {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: JSON.stringify(CURRENT_FILE_TEXT) }],
        },
      }),
    })
  })
}

function messagesWithRun() {
  return {
    [SESSION_ID]: [
      {
        id: 'msg-1',
        sessionId: SESSION_ID,
        role: 'user',
        content: '修复 parser 的边界情况',
        createdAt: '2026-09-15T09:59:00Z',
      },
      {
        id: 'msg-2',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: '已完成修改。',
        createdAt: '2026-09-15T10:00:00Z',
        runId: RUN_ID,
        runStatus: 'succeeded',
      },
    ],
  }
}

function messagesWithMarkerStates() {
  return {
    [SESSION_ID]: [
      {
        id: 'msg-degraded',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: 'degraded run',
        createdAt: '2026-09-15T10:00:00Z',
        runId: RUN_DEGRADED,
        runStatus: 'succeeded',
      },
      {
        id: 'msg-expired',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: 'expired run',
        createdAt: '2026-09-15T10:01:00Z',
        runId: RUN_EXPIRED,
        runStatus: 'succeeded',
      },
      {
        id: 'msg-none',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: 'read-only run',
        createdAt: '2026-09-15T10:02:00Z',
        runId: RUN_NONE,
        runStatus: 'succeeded',
      },
    ],
  }
}

async function openChatTimeline(page: Page) {
  await page.goto(`/chat/${SESSION_ID}`)
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 })
}

test.describe('PLAN-0328 M3 checkpoint rollback (desktop)', () => {
  let state: MockState

  test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })

  test.beforeEach(async ({ page }) => {
    state = createState()
    await setupMockAuth(page)
    await setupMockSessions(page, {
      sessions: [{ id: SESSION_ID, title: 'Checkpoint Rollback' }],
      messages: state.messages,
    })
    await page.addInitScript(() => {
      localStorage.setItem('xihe-mock-filetree', '[]')
    })
    await installCheckpointSSE(page)
    await installCheckpointRoutes(page, state)
  })

  test('sealed marker shows the changed count and the revert entry', async ({ page }) => {
    await openChatTimeline(page)

    const marker = page.locator('[data-testid="run-checkpoint-marker"]')
    await expect(marker).toBeVisible({ timeout: 10000 })
    await expect(marker).toHaveAttribute('data-checkpoint-kind', 'rollbackable')
    await expect(page.getByTestId('run-checkpoint-summary')).toContainText('3')
    const entry = page.getByTestId('run-checkpoint-revert-entry')
    await expect(entry).toBeVisible()
    await expect(entry).toBeEnabled()
  })

  test('preview dialog shows exact plan counts, paths, cancel default focus and ack gating', async ({ page }) => {
    await openChatTimeline(page)
    await page.getByTestId('run-checkpoint-revert-entry').click()

    const dialog = page.getByTestId('checkpoint-dialog')
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('revert-preview-restore-count')).toHaveText('2')
    await expect(page.getByTestId('revert-preview-delete-count')).toHaveText('1')
    await expect(page.getByTestId('revert-preview-skip-count')).toHaveText('1')
    await expect(page.getByTestId('revert-preview-noop-count')).toHaveText('1')
    const paths = page.getByTestId('revert-preview-paths')
    await expect(paths).toContainText('src/parser.ts')
    await expect(paths).toContainText('src/legacy.ts')
    await expect(paths).toContainText('src/conflict.ts')
    await expect(page.getByTestId('revert-preview-conflict')).toContainText('文件在本轮结束后被修改')
    await expect(page.getByTestId('revert-preview-head-warning')).toBeVisible()

    // U2: the conservative default holds focus, and both acknowledgements gate the submit.
    await expect(page.getByTestId('revert-preview-cancel')).toBeFocused()
    const confirm = page.getByTestId('revert-preview-confirm')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('revert-preview-conflict-ack').check()
    await expect(confirm).toBeDisabled()
    await page.getByTestId('revert-preview-head-ack').check()
    await expect(confirm).toBeEnabled()

    await confirm.click()
    await expect(page.getByTestId('revert-result-counts')).toBeVisible({ timeout: 10000 })
    expect(state.previewCalls).toBe(1)
    expect(state.executeBodies).toEqual([
      { acknowledgeHeadChange: true, acknowledgeConflicts: ['src/conflict.ts'] },
    ])
  })

  test('execute result groups outcomes, keeps conflict reasons and loads the inspect diff', async ({ page }) => {
    await openChatTimeline(page)
    await page.getByTestId('run-checkpoint-revert-entry').click()
    await expect(page.getByTestId('checkpoint-dialog')).toBeVisible({ timeout: 10000 })
    await page.getByTestId('revert-preview-conflict-ack').check()
    await page.getByTestId('revert-preview-head-ack').check()
    await page.getByTestId('revert-preview-confirm').click()

    const counts = page.getByTestId('revert-result-counts')
    await expect(counts).toBeVisible({ timeout: 10000 })
    await expect(counts).toContainText('1')
    await expect(page.getByTestId('revert-result-group-restored')).toContainText('src/parser.ts')
    await expect(page.getByTestId('revert-result-group-deleted')).toContainText('src/legacy.ts')
    const skipped = page.getByTestId('revert-result-group-skippedConflict')
    await expect(skipped).toContainText('src/conflict.ts')
    await expect(skipped).toContainText('文件在本轮结束后被修改')
    await expect(page.getByTestId('revert-result-partial')).toBeVisible()
    await expect(page.getByTestId('revert-result-ref')).toContainText('refs/xihe/reverts/run-b')

    await page.getByTestId('revert-result-diff-src/conflict.ts').click()
    const diff = page.getByTestId('revert-result-diff-panel')
    await expect(diff).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('revert-result-diff-rows')).toContainText('const answer = 2')
    await expect(page.getByTestId('revert-result-diff-rows')).toContainText('const answer = 1')
    expect(state.checkpointFileCalls).toEqual([{ path: 'src/conflict.ts', ref: 'end' }])
  })

  test('dual diff keeps this-run and pending-commit as separate tabs with differing contents', async ({ page }) => {
    await openChatTimeline(page)
    await expect(page.getByTestId('run-checkpoint-marker')).toBeVisible({ timeout: 10000 })
    await page.getByTestId('sidebar-workspace').click()
    await expect(page.getByTestId('workspace-conversation')).toBeVisible({ timeout: 10000 })

    await page.getByTestId('workspace-toolbar-changes').click()
    const panel = page.getByTestId('workspace-changes-panel')
    await expect(panel).toBeVisible()

    // This-run tab: authoritative checkpoint projection values only.
    await expect(panel.getByTestId('workspace-diff-run-count')).toContainText('3')
    const runList = panel.getByTestId('workspace-diff-run-list')
    await expect(runList).toContainText('src/parser.ts')
    await expect(runList).toContainText('src/index.ts')
    await expect(runList).toContainText('src/legacy.ts')
    await expect(runList).not.toContainText('README.md')
    await expect(panel.getByTestId('workspace-diff-difference-note')).toContainText('可能不一致')

    // Pending-commit tab: git status only (the lists are never merged).
    await panel.getByTestId('workspace-diff-tab-pending').click()
    const pendingList = panel.getByTestId('workspace-diff-pending-list')
    await expect(pendingList).toContainText('README.md')
    await expect(pendingList).toContainText('notes/draft.md')
    await expect(pendingList).not.toContainText('src/legacy.ts')
    await expect(panel.getByTestId('workspace-diff-pending-count')).toContainText('3')
    expect(state.gitCalls).toBeGreaterThanOrEqual(1)
  })

  test('non-git workspace shows an explicit no-pending-view state and the refresh refetches', async ({ page }) => {
    state.gitStatus = { isRepository: false, entries: [] }
    await openChatTimeline(page)
    await page.getByTestId('sidebar-workspace').click()
    await expect(page.getByTestId('workspace-conversation')).toBeVisible({ timeout: 10000 })
    await page.getByTestId('workspace-toolbar-changes').click()

    const panel = page.getByTestId('workspace-changes-panel')
    await panel.getByTestId('workspace-diff-tab-pending').click()
    await expect(panel.getByTestId('workspace-diff-pending-no-repo')).toContainText('无待提交视图')
    await expect(panel.getByTestId('workspace-diff-pending-list')).toHaveCount(0)
    const callsBefore = state.gitCalls

    state.gitStatus = {
      isRepository: true,
      entries: [{ status: 'M', path: 'README.md' }],
    }
    await panel.getByTestId('workspace-diff-refresh').click()
    await expect(panel.getByTestId('workspace-diff-pending-list')).toContainText('README.md')
    expect(state.gitCalls).toBeGreaterThan(callsBefore)
  })

  test('retention block requires a GC confirmation and reports the server counts', async ({ page }) => {
    await page.goto('/settings/data')
    const retention = page.getByTestId('settings-checkpoint-retention')
    await expect(retention).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('settings-checkpoint-max-runs')).toHaveText('50')
    await expect(page.getByTestId('settings-checkpoint-ttl-days')).toHaveText('30')
    await expect(page.getByTestId('settings-checkpoint-current-runs')).toHaveText('3')
    await expect(page.getByTestId('settings-checkpoint-current-refs')).toHaveText('11')

    await page.getByTestId('settings-checkpoint-gc').click()
    const confirmBox = page.getByTestId('settings-checkpoint-gc-confirm-box')
    await expect(confirmBox).toBeVisible()
    await expect(confirmBox).toContainText('更早的恢复点将不可用')
    expect(state.gcCalls).toBe(0)
    await page.getByTestId('settings-checkpoint-gc-confirm').click()
    await expect(page.getByTestId('settings-checkpoint-gc-result')).toContainText('7')
    expect(state.gcCalls).toBe(1)
    expect(state.retentionCalls).toBeGreaterThanOrEqual(2)
  })

  test('degraded, expired and none markers stay honest', async ({ page }) => {
    state.messages[SESSION_ID] = messagesWithMarkerStates()[SESSION_ID]
    await openChatTimeline(page)

    await expect(page.locator('[data-testid="run-checkpoint-marker"][data-checkpoint-kind="unavailable"]')).toHaveCount(2, { timeout: 10000 })
    await expect(page.locator('[data-testid="run-checkpoint-marker"][data-checkpoint-kind="none"]')).toHaveCount(1)
    await expect(page.getByTestId('run-checkpoint-unavailable').first()).toContainText('本轮不可回滚')
    await expect(page.getByTestId('run-checkpoint-unavailable').first()).toContainText('未检测到可用的 git')
    await expect(page.getByTestId('run-checkpoint-unavailable').nth(1)).toContainText('快照已过期')
    await expect(page.getByTestId('run-checkpoint-none')).toContainText('本轮无快照')
    await expect(page.getByTestId('run-checkpoint-revert-entry')).toHaveCount(0)
  })
})

test.describe('PLAN-0328 M3 checkpoint rollback (mobile)', () => {
  let state: MockState

  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  test.beforeEach(async ({ page }) => {
    state = createState()
    await setupMockAuth(page)
    await setupMockSessions(page, {
      sessions: [{ id: SESSION_ID, title: 'Checkpoint Rollback' }],
      messages: state.messages,
    })
    await page.addInitScript(() => {
      localStorage.setItem('xihe-mock-filetree', '[]')
    })
    await installCheckpointSSE(page)
    await installCheckpointRoutes(page, state)
  })

  test('marker, preview sheet, focus and gating work at 390x844', async ({ page }) => {
    await openChatTimeline(page)

    const marker = page.locator('[data-testid="run-checkpoint-marker"]')
    await expect(marker).toBeVisible({ timeout: 10000 })
    await expect(marker).toHaveAttribute('data-checkpoint-kind', 'rollbackable')
    await page.getByTestId('run-checkpoint-revert-entry').click()

    // The dialog renders as the mobile bottom sheet (CheckpointDialogShell).
    const sheet = page.getByTestId('checkpoint-dialog-mobile')
    await expect(sheet).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('revert-preview-restore-count')).toHaveText('2')
    await expect(page.getByTestId('revert-preview-skip-count')).toHaveText('1')
    await expect(page.getByTestId('revert-preview-cancel')).toBeFocused()
    const confirm = page.getByTestId('revert-preview-confirm')
    await expect(confirm).toBeDisabled()
    await page.getByTestId('revert-preview-conflict-ack').check()
    await page.getByTestId('revert-preview-head-ack').check()
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(page.getByTestId('revert-result-counts')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('revert-result-group-skippedConflict')).toContainText('src/conflict.ts')
  })

  test('dual diff stays reachable through the mobile changes sheet', async ({ page }) => {
    await page.goto('/workspace/workspace-1')
    await pushCheckpointEvent(page, {
      runId: RUN_ID,
      sessionId: SESSION_ID,
      state: 'sealed',
      changedCount: 3,
    })

    // The workspace SSE connects with the chat sheet; the buffered annotation lands there.
    await page.getByRole('button', { name: 'Open chat' }).click()
    await expect(page.getByTestId('mobile-chat-sheet')).toBeVisible()
    await page.getByTestId('mobile-chat-sheet').getByRole('button', { name: /close/i }).click()
    await expect(page.getByTestId('mobile-chat-sheet')).toBeHidden()

    await page.getByTestId('workspace-toolbar-changes-mobile').click()
    const sheet = page.getByTestId('mobile-changes-sheet')
    await expect(sheet).toBeVisible()

    const panel = page.getByTestId('workspace-changes-panel')
    await expect(panel.getByTestId('workspace-diff-run-count')).toContainText('3')
    await expect(panel.getByTestId('workspace-diff-run-list')).toContainText('src/parser.ts')
    await expect(panel.getByTestId('workspace-diff-run-list')).not.toContainText('README.md')

    await panel.getByTestId('workspace-diff-tab-pending').click()
    await expect(panel.getByTestId('workspace-diff-pending-list')).toContainText('README.md')
    await expect(panel.getByTestId('workspace-diff-pending-list')).not.toContainText('src/legacy.ts')
  })

  test('retention block GC confirmation works at 390x844', async ({ page }) => {
    await page.goto('/settings/data')
    await expect(page.getByTestId('settings-checkpoint-retention')).toBeVisible({ timeout: 15000 })
    await page.getByTestId('settings-checkpoint-gc').click()
    await expect(page.getByTestId('settings-checkpoint-gc-confirm-box')).toBeVisible()
    await page.getByTestId('settings-checkpoint-gc-confirm').click()
    await expect(page.getByTestId('settings-checkpoint-gc-result')).toContainText('7')
    expect(state.gcCalls).toBe(1)
  })
})
