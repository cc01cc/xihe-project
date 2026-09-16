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

// Item policy snapshots mirror the exact wire shape of CP OperationPolicySummary
// (PLAN-0328 T1.15/T1.7): lower-case enums, nullable matchedRule/mode/allowedBy, and the
// nullable `reused` session-reuse annotation (null = not applicable).
const trace = {
  operation: completedOperation,
  items: [
    {
      id: 'item-auto',
      operationId: 'op-1',
      toolCallId: 'call-auto-1',
      sequence: 1,
      kind: 'tool_call',
      toolName: 'write_file',
      source: 'mcp',
      policyDecision: 'allow',
      status: 'completed',
      // An auto verdict is always an allow with a non-null allowedBy (PolicyVerdict
      // .allowedByMode); the underlying ask rule stays visible as matchedRule.
      policy: {
        effect: 'allow',
        sourceLayer: 'builtin',
        matchedRule: '{ write, "*", ask }',
        reason: 'requires approval for domain write',
        mode: 'auto',
        allowedBy: 'auto@session',
        actionClass: 'write',
        shape: 'structured',
        reused: null,
      },
    },
    {
      id: 'item-allow',
      operationId: 'op-1',
      toolCallId: 'call-allow-2',
      sequence: 2,
      kind: 'tool_call',
      toolName: 'read_file',
      source: 'mcp',
      policyDecision: 'allow',
      status: 'completed',
      policy: {
        effect: 'allow',
        sourceLayer: 'workspace',
        matchedRule: '{ read, "src/**", allow }',
        reason: 'workspace rule allows reads under src',
        mode: 'manual',
        allowedBy: null,
        actionClass: 'read',
        shape: 'structured',
        reused: null,
      },
    },
    {
      id: 'item-reuse',
      operationId: 'op-1',
      toolCallId: 'call-reuse-4',
      sequence: 3,
      kind: 'tool_call',
      toolName: 'write_file',
      source: 'mcp',
      policyDecision: 'allow',
      status: 'completed',
      // T1.7: the engine verdict stayed `ask`; the dispatch was then authorized by an exact
      // session fingerprint reuse, which the projection annotates with reused=true.
      policy: {
        effect: 'ask',
        sourceLayer: 'builtin',
        matchedRule: '{ write, "*", ask }',
        reason: 'write requires approval',
        mode: 'manual',
        allowedBy: null,
        actionClass: 'write',
        shape: 'structured',
        reused: true,
      },
    },
    {
      id: 'item-ask',
      operationId: 'op-1',
      toolCallId: 'call-ask-3',
      sequence: 4,
      kind: 'tool_call',
      toolName: 'execute_command',
      source: 'mcp',
      policyDecision: 'allow',
      status: 'completed',
      policy: {
        effect: 'ask',
        sourceLayer: 'builtin',
        matchedRule: '{ exec, "*", ask }',
        reason: 'exec requires approval',
        mode: 'manual',
        allowedBy: null,
        actionClass: 'exec',
        shape: 'structured',
        reused: null,
      },
    },
    {
      id: 'item-legacy',
      operationId: 'op-1',
      toolCallId: 'call-legacy-3',
      sequence: 5,
      kind: 'tool_call',
      toolName: 'list_directory',
      source: 'agent',
      policyDecision: 'allow',
      status: 'completed',
    },
  ],
  attempts: [{
    id: 'attempt-1',
    itemId: 'item-auto',
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

  test('shows per-toolCallId verdicts, the auto highlight and the legacy no-verdict state', async ({ page }) => {
    await installAuditRoutes(page, 'normal')
    await page.goto('/settings/audit')

    const traceResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/operations/op-1') && response.status() === 200)
    await page.getByTestId('settings-audit-operation-op-1').click()
    await traceResponse

    const autoItem = page.getByTestId('settings-audit-item-item-auto')
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1')).toBeVisible()
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-effect')).toHaveText('允许')
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-matched-rule')).toHaveText('{ write, "*", ask }')
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-source-layer')).toHaveText('内置层')
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-mode')).toHaveText('自动放行')
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-allowed-by')).toContainText('由 auto 放行')
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-allowed-by')).toContainText('auto@session')
    await expect(autoItem.getByText('工具调用: call-auto-1')).toBeVisible()

    const allowItem = page.getByTestId('settings-audit-item-item-allow')
    await expect(allowItem.getByTestId('settings-audit-policy-call-allow-2-effect')).toHaveText('允许')
    await expect(allowItem.getByTestId('settings-audit-policy-call-allow-2-matched-rule')).toHaveText('{ read, "src/**", allow }')
    await expect(allowItem.getByTestId('settings-audit-policy-call-allow-2-source-layer')).toHaveText('工作区层')
    await expect(allowItem.getByTestId('settings-audit-policy-call-allow-2-mode')).toHaveText('默认')
    await expect(allowItem.getByTestId('settings-audit-policy-call-allow-2-allowed-by')).toHaveCount(0)

    // A plain ask verdict has no allowedBy and must keep rendering the ask label.
    const askItem = page.getByTestId('settings-audit-item-item-ask')
    await expect(askItem.getByTestId('settings-audit-policy-call-ask-3-effect')).toHaveText('询问')
    await expect(askItem.getByTestId('settings-audit-policy-call-ask-3-matched-rule')).toHaveText('{ exec, "*", ask }')
    await expect(askItem.getByTestId('settings-audit-policy-call-ask-3-source-layer')).toHaveText('内置层')
    await expect(askItem.getByTestId('settings-audit-policy-call-ask-3-mode')).toHaveText('默认')
    await expect(askItem.getByTestId('settings-audit-policy-call-ask-3-allowed-by')).toHaveCount(0)

    const legacyItem = page.getByTestId('settings-audit-item-item-legacy')
    await expect(legacyItem.getByTestId('settings-audit-policy-absent-item-legacy')).toHaveText('无判定记录（旧记录或非 MCP 路径）')
    await expect(legacyItem.getByTestId('settings-audit-policy-call-legacy-3')).toHaveCount(0)

    await autoItem.getByText('判定详情').click()
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-reason')).toBeVisible()
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-reason')).toHaveText('requires approval for domain write')
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-action-class')).toHaveText('write')
    await expect(autoItem.getByTestId('settings-audit-policy-call-auto-1-shape')).toHaveText('结构化')

    // T1.7: only the reused=true row carries the reuse marker (icon + text); the null rows and
    // the legacy row must not have reuse invented for them.
    const reuseItem = page.getByTestId('settings-audit-item-item-reuse')
    await expect(reuseItem.getByTestId('settings-audit-policy-call-reuse-4-effect')).toHaveText('询问')
    await expect(reuseItem.getByTestId('settings-audit-policy-call-reuse-4-reused')).toHaveText('由复用放行')
    await expect(reuseItem.getByTestId('settings-audit-policy-call-reuse-4-reused').locator('svg')).toHaveCount(1)
    await expect(page.getByTestId('settings-audit-policy-call-auto-1-reused')).toHaveCount(0)
    await expect(page.getByTestId('settings-audit-policy-call-allow-2-reused')).toHaveCount(0)
    await expect(page.getByTestId('settings-audit-policy-call-ask-3-reused')).toHaveCount(0)
    await expect(page.getByTestId('settings-audit-policy-absent-item-legacy')).toBeVisible()

    // The answerer annotation stays unimplemented (T1.9): the view must not invent it.
    await expect(page.getByTestId('settings-audit-items').getByText(/回答者/)).toHaveCount(0)
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

test.describe('Operation audit policy verdict on mobile (PLAN-0328 T1.15)', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Audit Session' }] })
  })

  test('renders the verdict block, bypass highlight and legacy state at 390x844', async ({ page }, testInfo) => {
    await installAuditRoutes(page, 'normal')
    await page.goto('/settings/audit')

    const traceResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/operations/op-1') && response.status() === 200)
    await page.getByTestId('settings-audit-operation-op-1').click()
    await traceResponse

    await expect(page.getByTestId('settings-audit-policy-call-auto-1-effect')).toHaveText('允许')
    await expect(page.getByTestId('settings-audit-policy-call-auto-1-allowed-by')).toContainText('由 auto 放行')
    await expect(page.getByTestId('settings-audit-policy-call-reuse-4-reused')).toHaveText('由复用放行')
    await expect(page.getByTestId('settings-audit-policy-call-ask-3-effect')).toHaveText('询问')
    await expect(page.getByTestId('settings-audit-policy-absent-item-legacy')).toHaveText('无判定记录（旧记录或非 MCP 路径）')

    await page.getByText('判定详情').first().click()
    await expect(page.getByTestId('settings-audit-policy-call-auto-1-reason')).toBeVisible()

    await expect(page.getByTestId('settings-audit-policy-call-auto-1-allowed-by')).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('audit-policy-mobile-390x844.png'), fullPage: true })
  })
})
