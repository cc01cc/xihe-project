import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

interface ImportUser {
  token: string
  wsId: string
}

test.describe('@host Workspace import', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  let sourceDir = ''
  const bulkDirs: string[] = []
  const users: ImportUser[] = []

  function hostRoot(): string {
    if (process.env.XIHE_WORKSPACE_HOST_ROOT) return path.resolve(process.env.XIHE_WORKSPACE_HOST_ROOT)
    const runId = process.env.XIHE_E2E_RUN_ID
    if (runId) return path.resolve(process.cwd(), '..', '..', '.tmp', 'e2e-host', runId)
    return path.resolve('..', '..', '.xihe-workspaces')
  }

  /**
   * Managed import targets must be empty, so every import test registers its own user:
   * the auto-created default workspace is fresh, and the access token's workspace context
   * matches the page the import dialog is opened from.
   */
  async function registerUser(request: import('@playwright/test').APIRequestContext, tag: string): Promise<ImportUser> {
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `workspace-import-${tag}-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: `Import ${tag}` },
    })
    expect([200, 201], `register ${tag} failed: ${response.status()} ${await response.text()}`).toContain(response.status())
    const body = await response.json()
    const user = { token: body.accessToken as string, wsId: String(body.workspaceId ?? '') }
    expect(user.wsId).toBeTruthy()
    users.push(user)
    return user
  }

  function seedPage(page: import('@playwright/test').Page, user: ImportUser) {
    page.addInitScript((token) => localStorage.setItem('xihe-token', token), user.token)
    page.addInitScript(
      (raw) => localStorage.setItem('xihe-user', raw),
      JSON.stringify({ id: 'e2e-import', email: 'import@test.com', name: 'Import UI', workspaceId: user.wsId }),
    )
    page.addInitScript((workspace) => localStorage.setItem('xihe-workspace', JSON.stringify(workspace)), {
      id: user.wsId,
      name: 'Import Workspace',
    })
    page.addInitScript((id) => localStorage.setItem('xihe-workspace-id', id), user.wsId)
  }

  async function startImportFrom(
    page: import('@playwright/test').Page,
    user: ImportUser,
    source: string,
    options: { read?: boolean } = {},
  ) {
    await page.goto(`/workspace/${user.wsId}`, { waitUntil: 'load' })
    await page.getByTestId('workspace-toolbar-import-source').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('Runtime 可访问的目录路径').fill(source)
    if (options.read !== false) await dialog.getByRole('button', { name: '读取' }).click()
    await dialog.getByRole('button', { name: '开始导入' }).click()
    return dialog
  }

  test.beforeAll(async () => {
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-import-'))
    fs.mkdirSync(path.join(sourceDir, 'src'))
    fs.writeFileSync(path.join(sourceDir, 'src', 'imported.md'), '# Imported\n')
    fs.mkdirSync(path.join(sourceDir, 'node_modules'))
    fs.writeFileSync(path.join(sourceDir, 'node_modules', 'ignored.js'), 'ignored\n')
  })

  test.afterAll(async ({ request }) => {
    // Workspace files live under the isolated host root, which the runner recycles at
    // teardown; only the test-created temp source trees need explicit removal here.
    test.setTimeout(180000)
    if (sourceDir) fs.rmSync(sourceDir, { recursive: true, force: true })
    for (const dir of bulkDirs) fs.rmSync(dir, { recursive: true, force: true })
    for (const user of users) {
      await request.delete(`${CP_URL}/api/v1/workspaces/${user.wsId}`, {
        headers: { Authorization: `Bearer ${user.token}` },
      }).catch(() => undefined)
    }
  })

  test('imports a Runtime-visible source directory without creating a Session', async ({ page, request }) => {
    const user = await registerUser(request, 'basic')
    seedPage(page, user)
    const dialog = await startImportFrom(page, user, sourceDir)
    await expect(dialog.getByRole('button', { name: /src/ })).toBeVisible({ timeout: 10000 })
    await expect(dialog).toBeHidden({ timeout: 60000 })
  })

  test('copies the source tree into the managed workspace', async ({ page, request }) => {
    const user = await registerUser(request, 'copy')
    seedPage(page, user)
    const dialog = await startImportFrom(page, user, sourceDir)
    await expect(dialog.getByRole('button', { name: /src/ })).toBeVisible({ timeout: 10000 })
    await expect(dialog).toBeHidden({ timeout: 60000 })

    // PLAN-0384 V5: durable completion must correspond to real copied files.
    const copied = path.join(hostRoot(), user.wsId, 'src', 'imported.md')
    await expect.poll(() => fs.existsSync(copied), { timeout: 30000 }).toBe(true)
    expect(fs.readFileSync(copied, 'utf8')).toContain('Imported')
    expect(fs.existsSync(path.join(hostRoot(), user.wsId, 'node_modules'))).toBe(false)
  })

  test('recovers an in-flight import after a reload', async ({ page, request }) => {
    const user = await registerUser(request, 'recover')
    seedPage(page, user)
    const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-import-bulk-'))
    bulkDirs.push(bulkDir)
    for (let index = 0; index < 8000; index += 1) {
      fs.writeFileSync(path.join(bulkDir, `file-${index}.txt`), `payload ${index}\n`)
    }

    await startImportFrom(page, user, bulkDir)
    await expect(page.getByTestId('workspace-import-status')).toContainText('进行中', { timeout: 30000 })

    // Disconnect (reload) mid-import; the durable record must restore the in-flight import.
    await page.reload({ waitUntil: 'load' })
    await page.getByTestId('workspace-toolbar-import-source').click()
    await expect(page.getByTestId('workspace-import-recovered')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('workspace-import-status')).toContainText('进行中')

    // The resumed import reaches durable completion (the dialog closes on completion).
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 120000 })
    await expect
      .poll(() => fs.existsSync(path.join(hostRoot(), user.wsId, 'file-0.txt')), { timeout: 30000 })
      .toBe(true)
  })

  test('cancels a running import from the dialog', async ({ page, request }) => {
    const user = await registerUser(request, 'cancel')
    seedPage(page, user)
    const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-import-cancel-'))
    bulkDirs.push(bulkDir)
    for (let index = 0; index < 8000; index += 1) {
      fs.writeFileSync(path.join(bulkDir, `file-${index}.txt`), `payload ${index}\n`)
    }

    await startImportFrom(page, user, bulkDir)
    await expect(page.getByTestId('workspace-import-cancel')).toBeVisible({ timeout: 15000 })
    await page.getByTestId('workspace-import-cancel').click()

    // PLAN-0384 V5: cancellation is reflected in the dialog and the durable record.
    await expect(page.getByTestId('workspace-import-status')).toContainText('已取消', { timeout: 30000 })
    await expect(page.getByTestId('workspace-import-cancel')).toBeHidden()
  })

  test('reports a failed import for a missing source directory', async ({ page, request }) => {
    const user = await registerUser(request, 'missing')
    seedPage(page, user)
    // Skip the source listing: the point is the import start path failing visibly.
    await startImportFrom(page, user, path.join(os.tmpdir(), `xihe-missing-${Date.now()}`), { read: false })

    // PLAN-0384 V5: the failure is visible in the UI (durable status carries the reason).
    await expect(page.getByTestId('workspace-import-status')).toContainText(/导入失败/, { timeout: 45000 })
  })
})
