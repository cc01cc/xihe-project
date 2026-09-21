import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../.local/evidence/plan0396-job-capability')

// PLAN-0396 T3.1 / V6：direct-attach（windows-host）工作区的 Job 能力透出与 UI 渲染。
// 链路：CP POST /api/v1/workspaces（storageMode=direct_attach, executionMode=windows-host）
// → UI environment 页 → 断言「无隔离」提示与可用入口 → 截图。
// 该用例同时覆盖 0394 V1/V3 与 0395 V4/V5 的浏览器侧。
//   node scripts/e2e-host-detached.mjs e2e/real/plan0396-workspace-job-capability.spec.ts --llm-mode=mock
test.describe('@host PLAN-0396 workspace job capability', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  let sharedAuth: string
  let directWs = ''
  let hostPath = ''

  test.beforeAll(async ({ request }) => {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `plan0396-cap-${Date.now()}@test.com`, password, name: 'Plan0396Cap' },
    })
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(reg.status())
    const auth = await reg.json()
    sharedAuth = auth.accessToken
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    const hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT || os.tmpdir()
    hostPath = path.join(hostRoot, `xihe-e2e-0396-${Date.now()}`)
    mkdirSync(hostPath, { recursive: true })

    const headers = { Authorization: `Bearer ${sharedAuth}`, 'Content-Type': 'application/json' }
    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
      headers: { ...headers, 'Idempotency-Key': `plan0396-${Date.now()}` },
      data: {
        name: 'Plan0396 Direct',
        storageMode: 'direct_attach',
        hostPath,
        executionMode: 'windows-host',
      },
    })
    expect(
      created.ok(),
      `direct-attach workspace create failed: ${created.status()} ${await created.text()}`,
    ).toBeTruthy()
    const view = await created.json()
    directWs = String(view.id ?? '')
    expect(directWs, `create response missing id: ${JSON.stringify(view)}`).toBeTruthy()
  })

  function seedPage(page: import('@playwright/test').Page) {
    page.addInitScript((t) => localStorage.setItem('xihe-token', t), sharedAuth)
    page.addInitScript((raw) => localStorage.setItem('xihe-user', raw), JSON.stringify({ workspaceId: directWs }))
    page.addInitScript((ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)), {
      id: directWs,
      name: 'Plan0396 Direct',
    })
  }

  test('environment page marks the unrestricted backend and enables job start', async ({ page, request }) => {
    const envRes = await request.get(`${CP_URL}/api/v1/workspaces/${directWs}/environment`, {
      headers: { Authorization: `Bearer ${sharedAuth}` },
    })
    expect(envRes.ok(), `environment ${envRes.status()} ${await envRes.text()}`).toBeTruthy()
    const environment = await envRes.json()
    expect(environment.jobCapability?.available, JSON.stringify(environment.jobCapability)).toBe(true)
    expect(environment.jobCapability?.canStart).toBe(true)
    expect(environment.jobCapability?.canIsolateFilesystem).toBe(false)

    seedPage(page)
    await page.goto(`/workspace/${directWs}/environment`)
    const hint = page.locator('[data-testid="workspace-job-start-hint"]')
    await expect(hint).toBeVisible({ timeout: 20000 })
    await expect(hint).toHaveAttribute('aria-disabled', 'false')
    await expect(hint).toContainText('无隔离')
    await expect(hint).not.toContainText('尚无启动器')
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'unrestricted-job-hint.png'), fullPage: true })
  })
})
