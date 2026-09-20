import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('@host Workspace import', () => {
  let authToken = ''
  let wsId = ''
  let sourceDir = ''

  test.beforeAll(async ({ request }) => {
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-import-'))
    fs.mkdirSync(path.join(sourceDir, 'src'))
    fs.writeFileSync(path.join(sourceDir, 'src', 'imported.md'), '# Imported\n')
    fs.mkdirSync(path.join(sourceDir, 'node_modules'))
    fs.writeFileSync(path.join(sourceDir, 'node_modules', 'ignored.js'), 'ignored\n')

    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `workspace-import-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: 'Import UI' },
    })
    expect(response.status()).toBe(201)
    const auth = await response.json()
    authToken = auth.accessToken
    wsId = auth.workspaceId
  })

  test.afterAll(() => {
    if (sourceDir) fs.rmSync(sourceDir, { recursive: true, force: true })
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => localStorage.setItem('xihe-token', token), authToken)
    await page.addInitScript((raw) => localStorage.setItem('xihe-user', raw), JSON.stringify({ workspaceId: wsId }))
    await page.addInitScript((workspace) => localStorage.setItem('xihe-workspace', JSON.stringify(workspace)), { id: wsId, name: 'Import Workspace' })
  })

  test('imports a Runtime-visible source directory without creating a Session', async ({ page }) => {
    await page.goto(`/workspace/${wsId}`, { waitUntil: 'load' })
    await page.getByTestId('workspace-toolbar-import-source').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('Runtime 可访问的目录路径').fill(sourceDir)
    await dialog.getByRole('button', { name: '读取' }).click()
    await expect(dialog.getByRole('button', { name: /src/ })).toBeVisible({ timeout: 10000 })
    await dialog.getByRole('button', { name: '开始导入' }).click()
    await expect(dialog).toBeHidden({ timeout: 30000 })
  })
})
