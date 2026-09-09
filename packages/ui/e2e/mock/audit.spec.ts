import { expect, test, type Page } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

const completedOperation = {
  id: 'op-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  runId: 'run-1',
  kind: 'chat',
  source: 'ui',
  actorType: 'user',
  status: 'completed',
  summary: 'Read workspace status',
  startedAt: '2026-09-09T01:00:00.000Z',
  finishedAt: '2026-09-09T01:00:00.125Z',
  createdAt: '2026-09-09T01:00:00.000Z',
}

const trace = {
  operation: completedOperation,
  items: [{
    id: 'item-1',
    operationId: 'op-1',
    sequence: 1,
    kind: 'tool_call',
    toolName: 'read_file',
    source: 'agent',
    status: 'completed',
  }],
  attempts: [{
    id: 'attempt-1',
    itemId: 'item-1',
    stage: 'agent_dispatch',
    retryNo: 0,
    module: 'agent',
    status: 'succeeded',
    durationMs: 125,
  }],
  events: [],
}

async function installAuditRoutes(page: Page, mode: 'normal' | 'empty' | 'error') {
  const listRequests: string[] = []
  const traceRequests: string[] = []

  await page.route('**/api/v1/operations**', async (route) => {
    const url = new URL(route.request().url())
    const operationId = url.pathname.split('/').filter(Boolean).at(-1)
    if (operationId && operationId !== 'operations') {
      traceRequests.push(url.toString())
      if (operationId === 'op-1') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(trace) })
      } else {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'OPERATION_NOT_FOUND' }) })
      }
      return
    }

    listRequests.push(url.toString())
    if (mode === 'error') {
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({ code: 'AUDIT_UNAVAILABLE', detail: 'Audit backend unavailable', status: 503 }),
      })
      return
    }
    if (mode === 'empty') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ operations: [], page: 0, size: 20, totalElements: 0, totalPages: 0 }),
      })
      return
    }

    const status = url.searchParams.get('status')
    const pageNumber = Number(url.searchParams.get('page') ?? '0')
    const operations = status === 'failed'
      ? [{ ...completedOperation, id: pageNumber === 0 ? 'op-failed-1' : 'op-failed-2', status: 'failed', summary: `Failed operation page ${pageNumber + 1}` }]
      : [completedOperation, { ...completedOperation, id: 'op-2', status: 'ambiguous', summary: 'Unknown tool result' }]
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ operations, page: pageNumber, size: 20, totalElements: status === 'failed' ? 21 : 2, totalPages: status === 'failed' ? 2 : 1 }),
    })
  })

  return { listRequests, traceRequests }
}

test.describe('Operation audit (PLAN-281 N3)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Audit Session' }] })
  })

  test('lists operations, loads trace, filters status, paginates, and captures post-action view', async ({ page }, testInfo) => {
    const requests = await installAuditRoutes(page, 'normal')
    await page.goto('/settings/audit')

    await expect(page.getByTestId('settings-audit-heading')).toBeVisible()
    await expect(page.getByTestId('settings-audit-operation-op-1')).toBeVisible()
    expect(new URL(requests.listRequests[0]).searchParams.get('size')).toBe('20')

    const traceResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/operations/op-1') && response.status() === 200)
    await page.getByTestId('settings-audit-operation-op-1').click()
    await traceResponse
    await expect(page.getByText('read_file', { exact: true })).toBeVisible()
    await expect(page.getByText('agent_dispatch', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('audit-after-trace.png'), fullPage: true })

    await page.getByTestId('settings-audit-status').selectOption('failed')
    await expect(page.getByTestId('settings-audit-operation-op-failed-1')).toBeVisible()
    const filteredRequest = requests.listRequests.at(-1)
    expect(filteredRequest).toBeDefined()
    expect(new URL(filteredRequest!).searchParams.get('status')).toBe('failed')
    expect(new URL(filteredRequest!).searchParams.get('page')).toBe('0')

    await page.getByRole('button', { name: '下一页' }).click()
    await expect(page.getByTestId('settings-audit-operation-op-failed-2')).toBeVisible()
    const pagedRequest = requests.listRequests.at(-1)
    expect(pagedRequest).toBeDefined()
    expect(new URL(pagedRequest!).searchParams.get('page')).toBe('1')
    expect(requests.traceRequests).toHaveLength(1)
  })

  test('renders an explicit empty state', async ({ page }) => {
    await installAuditRoutes(page, 'empty')
    await page.goto('/settings/audit')

    await expect(page.getByTestId('settings-audit-empty')).toBeVisible()
    await expect(page.getByTestId('settings-audit-no-selection')).toBeVisible()
  })

  test('renders a recoverable API error', async ({ page }) => {
    await installAuditRoutes(page, 'error')
    await page.goto('/settings/audit')

    await expect(page.getByText('Audit backend unavailable')).toBeVisible()
    await expect(page.getByTestId('settings-audit-no-selection')).toBeVisible()
  })
})
