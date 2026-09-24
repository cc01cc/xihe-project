import { test, expect } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

test('new Workspace Session is created only after selecting a bound Agent', async ({ page }) => {
  await setupMockAuth(page)
  await setupMockSessions(page, { sessions: [], createSession: true })

  await page.route('**/api/v1/workspaces/workspace-1/agents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        principalId: 'agent-1',
        name: 'Research Agent',
        templateId: null,
        templateName: 'Research',
        createdAt: new Date().toISOString(),
        permissions: [{ actionClass: 'read' }],
      }]),
    })
  })

  await page.goto('/workspace/workspace-1?newChat=1')
  const selector = page.getByTestId('workspace-agent-principal-select')
  await expect(selector).toBeVisible()
  await expect(page.getByTestId('workspace-create-agent-session')).toBeDisabled()

  await selector.selectOption('agent-1')
  const createRequestPromise = page.waitForRequest((request) =>
    request.url().endsWith('/api/v1/sessions') && request.method() === 'POST',
  )
  await page.getByTestId('workspace-create-agent-session').click()

  const createRequest = await createRequestPromise
  await expect(page).toHaveURL(/\/workspace\/workspace-1\/chat\/mock-session-/)
  await expect(page.getByTestId('modal-backdrop')).toHaveCount(0)
  await expect(page.getByTestId('workspace-active-agent')).toContainText('agent-1')
  if ((page.viewportSize()?.width ?? 1920) < 768) {
    await page.getByRole('button', { name: 'Open chat' }).click()
    const sheet = page.getByTestId('mobile-chat-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('mobile-session-agent')).toContainText('agent-1')
    await sheet.evaluate(async (element) => {
      await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
    })
  }
  const chatInput = page.getByTestId('chat-input')
  await expect(chatInput).toBeVisible()
  if ((page.viewportSize()?.width ?? 1920) < 768) {
    const hitTest = await chatInput.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return {
        targetIsInput: target === element || element.contains(target),
        sheetBackground: getComputedStyle(element.closest('[data-testid="mobile-chat-sheet"]')!).backgroundColor,
        sheetOpacity: getComputedStyle(element.closest('[data-testid="mobile-chat-sheet"]')!).opacity,
      }
    })
    expect(hitTest.targetIsInput, JSON.stringify(hitTest)).toBe(true)
    expect(hitTest.sheetOpacity, JSON.stringify(hitTest)).toBe('1')
  }
  expect(createRequest.postDataJSON()).toEqual({ title: 'New Chat', agentPrincipalId: 'agent-1' })
  await page.screenshot({
    path: test.info().outputPath(`session-agent-selected-${process.env.XIHE_E2E_VIEWPORT ?? '1920x1080'}.png`),
  })
})

test('creates a principal separately, binds an explicit cap, and confirms unbinding', async ({ page }) => {
  await setupMockAuth(page)
  await setupMockSessions(page, { sessions: [] })

  const bindings: Array<Record<string, unknown>> = []
  await page.route('**/api/v1/workspaces/workspace-1/agents**', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bindings) })
      return
    }
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { permissions: Array<{ actionClass: string; resource?: string }> }
      const updated = {
        principalId: 'agent-1', name: 'Research Agent', templateId: null, templateName: null,
        createdAt: new Date().toISOString(), permissions: body.permissions,
      }
      const existingIndex = bindings.findIndex((binding) => binding.principalId === 'agent-1')
      if (existingIndex < 0) bindings.push(updated)
      else bindings[existingIndex] = updated
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updated) })
      return
    }
    if (request.method() === 'DELETE') {
      bindings.splice(0, bindings.length)
      await route.fulfill({ status: 204 })
      return
    }
    await route.fallback()
  })

  let createBody: unknown
  await page.route('**/api/v1/agent-principals', async (route) => {
    createBody = route.request().postDataJSON()
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        principalId: 'agent-1', templateId: null, templateName: null, createdAt: new Date().toISOString(),
      }),
    })
  })

  await page.goto('/workspace/workspace-1')
  const agentManagementButton = (page.viewportSize()?.width ?? 1920) < 768
    ? page.getByTestId('workspace-toolbar-agents-mobile')
    : page.getByTestId('workspace-toolbar-agents')
  await agentManagementButton.click()
  const dialog = page.getByTestId('workspace-agent-management-dialog')
  await expect(dialog).toBeVisible()

  await page.getByTestId('agent-principal-name').fill('Research Agent')
  await page.getByTestId('agent-principal-create').click()
  await expect(page.getByTestId('unbound-agent-principal')).toContainText('agent-1')
  await page.getByTestId('agent-cap-read').check()
  const readResource = dialog.getByTestId('agent-resource-read')
  await readResource.fill('src/*')
  await page.getByTestId('agent-principal-bind').click()

  const binding = page.getByTestId('workspace-agent-agent-1')
  await expect(binding).toContainText('Research Agent')
  await expect(binding).toContainText('src/*')
  expect(createBody).toEqual({ name: 'Research Agent' })

  await binding.getByTestId('workspace-agent-edit-cap-agent-1').click()
  await page.getByTestId('agent-cap-write').check()
  await page.getByTestId('workspace-agent-save-cap-agent-1').click()
  await expect(binding).toContainText('写入')
  await expect(dialog.getByRole('status')).toContainText('权限上限已保存')
  await page.screenshot({
    path: test.info().outputPath(`agent-management-bound-${process.env.XIHE_E2E_VIEWPORT ?? '1920x1080'}.png`),
  })

  const unbind = page.getByTestId('workspace-agent-unbind-agent-1')
  await unbind.click()
  await expect(unbind).toHaveText('再次点击确认解绑')
  await unbind.click()
  await expect(page.getByText('此工作区尚未绑定 Agent')).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath(`agent-management-unbound-${process.env.XIHE_E2E_VIEWPORT ?? '1920x1080'}.png`),
  })
})

test('keeps a created principal visible when the caller lacks Workspace binding permission', async ({ page }) => {
  await setupMockAuth(page)
  await setupMockSessions(page, { sessions: [] })
  await page.route('**/api/v1/workspaces/workspace-1/agents**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      return
    }
    await route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank', title: 'Forbidden', status: 403,
        code: 'FORBIDDEN', detail: 'MANAGE_WORKSPACE_AGENTS permission is required',
      }),
    })
  })
  await page.route('**/api/v1/agent-principals', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        principalId: 'agent-created', templateId: null, templateName: null, createdAt: new Date().toISOString(),
      }),
    })
  })

  await page.goto('/workspace/workspace-1')
  const managementButton = (page.viewportSize()?.width ?? 1920) < 768
    ? page.getByTestId('workspace-toolbar-agents-mobile')
    : page.getByTestId('workspace-toolbar-agents')
  await managementButton.click()
  await page.getByTestId('agent-principal-name').fill('Created without manage grant')
  await page.getByTestId('agent-principal-create').click()
  await expect(page.getByTestId('unbound-agent-principal')).toContainText('agent-created')
  await page.getByTestId('agent-principal-bind').click()

  await expect(page.getByRole('alert')).toContainText('MANAGE_WORKSPACE_AGENTS permission is required')
  await expect(page.getByTestId('unbound-agent-principal')).toContainText('agent-created')
  await expect(page.getByTestId('workspace-agent-agent-created')).toHaveCount(0)
})
