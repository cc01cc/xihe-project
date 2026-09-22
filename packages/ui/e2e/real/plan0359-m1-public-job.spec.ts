import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../.local/evidence/plan0359-m1-public-job')

test.describe('@host PLAN-0359 M1 public Workspace Job', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  async function register(request: import('@playwright/test').APIRequestContext, tag: string) {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `plan0359-m1-${tag}-${Date.now()}@test.com`, password, name: `PLAN0359 ${tag}` },
    })
    expect([200, 201], `register failed: ${response.status()} ${await response.text()}`).toContain(response.status())
    const body = await response.json()
    return {
      accessToken: String(body.accessToken),
      refreshToken: String(body.refreshToken),
      defaultWorkspaceId: String(body.workspaceId),
    }
  }

  async function createBoundWorkspace(
    request: import('@playwright/test').APIRequestContext,
    tag: string,
    executionMode: 'windows-host' | 'windows-mxc',
  ) {
    const auth = await register(request, tag)
    const headers = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' }
    await request.delete(`${CP_URL}/api/v1/workspaces/${auth.defaultWorkspaceId}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    })

    const hostPath = path.join(
      process.env.XIHE_WORKSPACE_HOST_ROOT || os.tmpdir(),
      `xihe-e2e-0359-m1-${tag}-${Date.now()}`,
    )
    mkdirSync(hostPath, { recursive: true })
    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
      headers: { ...headers, 'Idempotency-Key': `plan0359-m1-${tag}-${Date.now()}` },
      data: {
        name: `PLAN0359 M1 ${tag}`,
        storageMode: 'direct_attach',
        hostPath,
        executionMode,
      },
    })
    expect(created.ok(), `workspace create failed: ${created.status()} ${await created.text()}`).toBeTruthy()
    const workspace = await created.json()
    const workspaceId = String(workspace.id)

    const refreshed = await request.post(`${CP_URL}/api/v1/auth/refresh`, {
      data: { refreshToken: auth.refreshToken },
    })
    expect(refreshed.ok(), `refresh failed: ${refreshed.status()} ${await refreshed.text()}`).toBeTruthy()
    const refreshedBody = await refreshed.json()
    expect(String(refreshedBody.workspaceId)).toBe(workspaceId)

    return { token: String(refreshedBody.accessToken), workspaceId, hostPath }
  }

  async function startJob(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    workspaceId: string,
    body: Record<string, unknown>,
    key: string,
  ) {
    return request.post(`${CP_URL}/api/v1/workspaces/${workspaceId}/jobs`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      data: body,
    })
  }

  async function listJobs(request: import('@playwright/test').APIRequestContext, token: string, workspaceId: string) {
    const response = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceId}/jobs`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.ok(), `list jobs failed: ${response.status()} ${await response.text()}`).toBeTruthy()
    return (await response.json()) as Array<Record<string, unknown>>
  }

  function seedPage(page: import('@playwright/test').Page, token: string, workspaceId: string, name: string) {
    page.addInitScript((value) => localStorage.setItem('xihe-token', value), token)
    page.addInitScript((value) => localStorage.setItem('xihe-user', value), JSON.stringify({ workspaceId }))
    page.addInitScript((value) => localStorage.setItem('xihe-workspace', value), JSON.stringify({ id: workspaceId, name }))
    page.addInitScript((value) => localStorage.setItem('xihe-workspace-id', value), workspaceId)
  }

  test.beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
  })

  test('windows-host public Job start, output, cancel, and UI projection', async ({ request, page }) => {
    const workspace = await createBoundWorkspace(request, 'host', 'windows-host')
    const running = await startJob(
      request,
      workspace.token,
      workspace.workspaceId,
      {
        command: 'cmd.exe',
        args: ['/c', 'ping', '127.0.0.1', '-n', '15'],
        timeoutSecs: 30,
        scope: 'workspace',
        source: 'ui',
        env: {},
      },
      `plan0359-host-job-${Date.now()}`,
    )
    expect([200, 202], `job start failed: ${running.status()} ${await running.text()}`).toContain(running.status())
    const projection = await running.json()
    const itemId = String(projection.operationItemId ?? projection.itemId ?? '')
    expect(itemId).toBeTruthy()

    await expect
      .poll(async () => {
        const jobs = await listJobs(request, workspace.token, workspace.workspaceId)
        return jobs.find((job) => String(job.operationItemId ?? job.itemId) === itemId)?.status
      }, { timeout: 30000 })
      .toMatch(/running|pending/)

    const cancel = await request.post(`${CP_URL}/api/v1/operations/items/${itemId}/cancel`, {
      headers: { Authorization: `Bearer ${workspace.token}` },
    })
    expect(cancel.ok(), `cancel failed: ${cancel.status()} ${await cancel.text()}`).toBeTruthy()
    const cancelBody = await cancel.json()
    expect(cancelBody.status).toMatch(/cancelled|cancelling/)

    await expect
      .poll(async () => {
        const jobs = await listJobs(request, workspace.token, workspace.workspaceId)
        return jobs.find((job) => String(job.operationItemId ?? job.itemId) === itemId)?.status
      }, { timeout: 30000 })
      .toBe('cancelled')

    seedPage(page, workspace.token, workspace.workspaceId, 'PLAN0359 Host')
    await page.goto(`/workspace/${workspace.workspaceId}/environment`)
    await expect(page.locator('[data-testid="workspace-job-status"]').first()).toContainText(/取消|cancel/i, { timeout: 20000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'host-job-cancelled.png'), fullPage: true })
  })

  test('windows-mxc public Job start returns a real result or an explicit fail-closed reason', async ({ request }) => {
    const workspace = await createBoundWorkspace(request, 'mxc', 'windows-mxc')
    const started = await startJob(
      request,
      workspace.token,
      workspace.workspaceId,
      {
        command: 'cmd.exe',
        args: ['/c', 'echo', 'PLAN0359_MXC'],
        timeoutSecs: 15,
        scope: 'workspace',
        source: 'ui',
        env: {},
      },
      `plan0359-mxc-job-${Date.now()}`,
    )

    if (started.status() === 202 || started.status() === 200) {
      const projection = await started.json()
      const itemId = String(projection.operationItemId ?? projection.itemId ?? '')
      let mxcStatus = ''
      await expect
        .poll(async () => {
          const jobs = await listJobs(request, workspace.token, workspace.workspaceId)
          mxcStatus = String(jobs.find((job) => String(job.operationItemId ?? job.itemId) === itemId)?.status ?? '')
          return mxcStatus
        }, { timeout: 30000 })
        .toMatch(/running|completed|failed|interrupted/)

      if (mxcStatus === 'running') {
        const cancel = await request.post(`${CP_URL}/api/v1/operations/items/${itemId}/cancel`, {
          headers: { Authorization: `Bearer ${workspace.token}` },
        })
        if (cancel.status() === 502) {
          const body = await cancel.json()
          expect(body.code).toBe('JOB_CANCEL_UNCONFIRMED')
        } else {
          expect(cancel.ok(), `MXC cancel failed: ${cancel.status()} ${await cancel.text()}`).toBeTruthy()
          await expect
            .poll(async () => {
              const jobs = await listJobs(request, workspace.token, workspace.workspaceId)
              return jobs.find((job) => String(job.operationItemId ?? job.itemId) === itemId)?.status
            }, { timeout: 30000 })
            .toBe('cancelled')
        }
      } else {
        const output = await request.get(`${CP_URL}/api/v1/operations/items/${itemId}/job-output?offset=0&limit=65536`, {
          headers: { Authorization: `Bearer ${workspace.token}` },
        })
        expect(output.ok(), `output failed: ${output.status()} ${await output.text()}`).toBeTruthy()
        expect(await output.text()).toContain('PLAN0359_MXC')
      }
    } else {
      expect([400, 409, 501, 502, 503]).toContain(started.status())
      const body = await started.json().catch(() => ({})) as Record<string, unknown>
      expect(String(body.code ?? '')).toMatch(/JOB_BACKEND_LAUNCH_PENDING|CAPABILITY|RUNTIME|UNMAPPED|PROCESS/i)
    }
  })

  test('windows-mxc public Job rejects an outside write and preserves the failure projection', async ({ request }) => {
    const workspace = await createBoundWorkspace(request, 'mxc-boundary', 'windows-mxc')
    const outside = path.join(path.dirname(workspace.hostPath), `xihe-e2e-0359-outside-${Date.now()}.txt`)
    const node = execFileSync('where.exe', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
    const script = `require('fs').writeFileSync(${JSON.stringify(outside)}, 'outside')`
    const started = await startJob(
      request,
      workspace.token,
      workspace.workspaceId,
      {
        command: node,
        args: ['-e', script],
        timeoutSecs: 15,
        scope: 'workspace',
        source: 'ui',
        env: {},
      },
      `plan0359-mxc-boundary-${Date.now()}`,
    )
    expect([200, 202], `boundary start failed: ${started.status()} ${await started.text()}`).toContain(started.status())
    const projection = await started.json()
    const itemId = String(projection.operationItemId ?? projection.itemId ?? '')
    expect(itemId).toBeTruthy()

    let finalStatus = ''
    await expect
      .poll(async () => {
        const jobs = await listJobs(request, workspace.token, workspace.workspaceId)
        finalStatus = String(jobs.find((job) => String(job.operationItemId ?? job.itemId) === itemId)?.status ?? '')
        return finalStatus
      }, { timeout: 30000 })
      .toMatch(/running|failed|interrupted|cancelled|orphaned/)
    if (finalStatus === 'running') {
      const cancel = await request.post(`${CP_URL}/api/v1/operations/items/${itemId}/cancel`, {
        headers: { Authorization: `Bearer ${workspace.token}` },
      })
      if (cancel.status() === 502) {
        const body = await cancel.json()
        expect(body.code).toBe('JOB_CANCEL_UNCONFIRMED')
      } else {
        expect(cancel.ok(), `boundary cancel failed: ${cancel.status()} ${await cancel.text()}`).toBeTruthy()
      }
    }
    expect(finalStatus).not.toBe('succeeded')
    expect(existsSync(outside)).toBe(false)
  })
})
