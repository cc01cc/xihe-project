import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../.local/evidence/plan0390-workspace-job')

// PLAN-0390 M2 T2.2 / V10：Workspace Job 的真实 host 证据（无需 Chat 会话）。
// 链路：CP `POST /api/v1/workspaces/{ws}/jobs`（Idempotency-Key）→ Runtime internal
// `jobs/start` → 真实 Docker 后台 job → CP durable projection（scope/backendKind）→
// 重复 start 幂等 → 字节游标续看/游标单调 → 刷新后 projection 仍在 → 显式取消落终态
// → destroy 后输出显式 409 JOB_OUTPUT_LOST（不复活）。
//   node scripts/e2e-host-detached.mjs e2e/real/plan0390-workspace-job-start.spec.ts --llm-mode=mock
test.describe('@host PLAN-0390 workspace job start', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  let sharedAuth: string
  let sharedWs: string
  let sharedHeaders: Record<string, string>
  let firstItemId = ''
  let firstJobId = ''

  test.beforeAll(async ({ request }) => {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `plan0390-job-${Date.now()}@test.com`, password, name: 'Plan0390Job' },
    })
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(reg.status())
    const auth = await reg.json()
    sharedAuth = auth.accessToken
    sharedWs = auth.workspaceId
    sharedHeaders = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' }
    mkdirSync(EVIDENCE_DIR, { recursive: true })
  })

  function seedPage(page: import('@playwright/test').Page) {
    page.addInitScript((t) => localStorage.setItem('xihe-token', t), sharedAuth)
    page.addInitScript((raw) => localStorage.setItem('xihe-user', raw), JSON.stringify({ workspaceId: sharedWs }))
    page.addInitScript((ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)), {
      id: sharedWs,
      name: 'Default Workspace',
    })
  }

  async function listJobs(request: import('@playwright/test').APIRequestContext) {
    const res = await request.get(`${CP_URL}/api/v1/workspaces/${sharedWs}/jobs`, { headers: sharedHeaders })
    expect(res.ok(), `list jobs ${res.status()} ${await res.text()}`).toBeTruthy()
    return (await res.json()) as Array<Record<string, unknown>>
  }

  async function startJob(
    request: import('@playwright/test').APIRequestContext,
    command: string,
    key: string,
  ) {
    return request.post(`${CP_URL}/api/v1/workspaces/${sharedWs}/jobs`, {
      headers: { ...sharedHeaders, 'Idempotency-Key': key },
      data: { command, args: [], scope: 'workspace', source: 'ui' },
    })
  }

  async function readOutput(
    request: import('@playwright/test').APIRequestContext,
    itemId: string,
    offset = 0,
  ) {
    const res = await request.get(
      `${CP_URL}/api/v1/operations/items/${itemId}/job-output?stream=stdout&offset=${offset}&limit=65536`,
      { headers: sharedHeaders },
    )
    return { status: res.status(), body: (await res.json()) as Record<string, unknown> }
  }

  test('start is idempotent, runs a real container job, streams output, and cancels', async ({ page, request }) => {
    const marker = `xihe0390-${Date.now()}`
    // Runtime 的 background wrapper 用 `sh -c "$command" xihe-shell "$@"` 执行：
    // `command` 是 shell 命令字符串，不能传 `sh` 当命令（会立即退出、零输出）。
    const command = `echo ${marker}; sleep 8`
    const key = `plan0390-${Date.now()}`

    // 1) 首次 start → 202，durable Job 进入 running（真实 Docker 容器）
    const first = await startJob(request, command, key)
    expect(first.status(), `start failed: ${first.status()} ${await first.text()}`).toBe(202)
    const created = (await first.json()) as Record<string, unknown>
    const itemId = String(created.operationItemId)
    firstItemId = itemId
    firstJobId = String(created.jobId ?? '')
    expect(itemId, 'operationItemId is the canonical Job identity').toBeTruthy()
    expect(created.scope).toBe('workspace')
    expect(created.backendKind).toBe('docker')
    expect(created.status).toBe('running')
    expect(created.jobId, 'runtime jobId returned by jobs/start').toBeTruthy()
    expect(created.sessionId).toBeNull()

    // 2) 同 key 重复 start → 200 复用同一 Job，不产生第二个进程/档案
    const replay = await startJob(request, command, key)
    expect(replay.status(), 'idempotent replay must return 200').toBe(200)
    const replayed = (await replay.json()) as Record<string, unknown>
    expect(replayed.operationItemId).toBe(itemId)
    expect(replayed.jobId).toBe(created.jobId)

    const jobs = await listJobs(request)
    expect(jobs.filter((job) => job.operationItemId === itemId)).toHaveLength(1)
    expect(jobs).toHaveLength(1)

    // 3) 真实容器输出：按字节游标续看，拿到命令 stdout 标记
    let nextOffset = 0
    await expect
      .poll(
        async () => {
          const { status, body } = await readOutput(request, itemId)
          if (status !== 200) return `http-${status}`
          nextOffset = Number(body.nextOffset ?? 0)
          return String(body.data ?? '')
        },
        { timeout: 60000, message: 'container stdout must reach the byte cursor' },
      )
      .toContain(marker)

    // 4) 游标单调：从 nextOffset 续读不回退；重复读同一 offset 得到同一前缀
    const tail = await readOutput(request, itemId, nextOffset)
    expect(tail.status).toBe(200)
    expect(Number(tail.body.offset)).toBeGreaterThanOrEqual(nextOffset)
    expect(Number(tail.body.nextOffset)).toBeGreaterThanOrEqual(Number(tail.body.offset))
    const again = await readOutput(request, itemId, 0)
    expect(String(again.body.data ?? '')).toContain(marker)

    // 5) 浏览器消费：Environment 面板显示该 Job 的 scope/backendKind
    seedPage(page)
    await page.goto(`/workspace/${sharedWs}/environment`, { waitUntil: 'load' })
    const panel = page.locator('[data-testid="workspace-jobs-panel"]')
    await expect(panel).toBeVisible({ timeout: 30000 })
    const secondary = page.locator('[data-testid="workspace-job-secondary"]').first()
    await expect(secondary).toContainText('workspace', { timeout: 30000 })
    await expect(secondary).toContainText('docker')
    await expect(page.locator('[data-testid="workspace-job-start-hint"]')).toContainText('Docker')
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'workspace-job-list.png'), fullPage: false })

    // 6) 整页刷新后 projection 仍在（durable 与 SSE/页面生命周期无关）
    await page.reload({ waitUntil: 'load' })
    await expect(page.locator('[data-testid="workspace-jobs-panel"]')).toBeVisible({ timeout: 30000 })
    await expect(page.locator('[data-testid="workspace-job-secondary"]').first()).toContainText('workspace')

    // 7) 显式取消 → 真实四阶段终止 + durable 终态；刷新后仍是终态（不复活）
    const cancel = await request.post(`${CP_URL}/api/v1/operations/items/${itemId}/cancel`, {
      headers: sharedHeaders,
      data: {},
    })
    expect([200, 502], `cancel status ${cancel.status()}`).toContain(cancel.status())
    await expect
      .poll(
        async () => {
          const rows = await listJobs(request)
          return String(rows.find((job) => job.operationItemId === itemId)?.status ?? 'missing')
        },
        { timeout: 60000, message: 'durable Job must reach a terminal status' },
      )
      .toMatch(/cancelled|succeeded|failed/)

    const terminal = (await listJobs(request)).find((job) => job.operationItemId === itemId)
    await page.reload({ waitUntil: 'load' })
    const afterReload = (await listJobs(request)).find((job) => job.operationItemId === itemId)
    expect(afterReload?.status, 'terminal status must not resurrect after reload').toBe(terminal?.status)

    writeFileSync(
      path.join(EVIDENCE_DIR, 'workspace-job-start.json'),
      JSON.stringify({ itemId, created, replayed, terminal, nextOffset }, null, 2),
    )
  })

  test('reports explicit JOB_OUTPUT_LOST when the sandbox is gone, and 404 after destroy', async ({ request }) => {
    const marker = `xihe0390-destroy-${Date.now()}`
    const started = await startJob(request, `echo ${marker}; sleep 30`, `plan0390-destroy-${Date.now()}`)
    expect(started.status(), `start failed: ${started.status()} ${await started.text()}`).toBe(202)
    const job = (await started.json()) as Record<string, unknown>
    const itemId = String(job.operationItemId)

    await expect
      .poll(
        async () => {
          const { status, body } = await readOutput(request, itemId)
          return status === 200 ? String(body.data ?? '') : `http-${status}`
        },
        { timeout: 60000, message: 'job output must be readable before the sandbox is removed' },
      )
      .toContain(marker)

    // (a) 沙盒存活、job 目录缺失 → 续看必须显式 409 JOB_OUTPUT_LOST
    const jobId = String(job.jobId)
    const containerName = `xihe-workspace-ws_${sharedWs}`
    execFileSync('docker', ['exec', containerName, 'sh', '-c', `rm -rf /tmp/xihe-jobs/${jobId}`], {
      stdio: 'ignore',
    })

    await expect
      .poll(
        async () => {
          const { status, body } = await readOutput(request, itemId)
          return status === 409 ? String(body.code ?? '') : `http-${status}-${String(body.code ?? '')}`
        },
        { timeout: 90000, message: 'missing job dir must settle to an explicit LOST problem' },
      )
      .toBe('JOB_OUTPUT_LOST')

    // (b) 沙盒容器被移除 → 执行通道不可用，必须是显式失败（502），不得静默成功
    execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' })
    const removed = await expect
      .poll(
        async () => {
          const { status, body } = await readOutput(request, itemId)
          return status === 200 ? 'ok-200' : `http-${status}-${String(body.code ?? '')}`
        },
        { timeout: 90000, message: 'removed sandbox must surface an explicit failure' },
      )
      .toMatch(/^http-(409|502)-/)
    void removed

    const removedBody = await readOutput(request, itemId)
    expect(removedBody.status, 'removed sandbox must not report success').not.toBe(200)

    // Workspace 仍存活时 list 可用（access 边界未被破坏）
    const stillAlive = await listJobs(request)
    expect(stillAlive.some((row) => row.operationItemId === itemId)).toBe(true)

    // destroy 后按 Workspace access 先判存在性：404，且不出现任何“重启恢复”的 Job
    const del = await request.delete(`${CP_URL}/api/v1/workspaces/${sharedWs}`, { headers: sharedHeaders })
    expect([200, 202, 204], `destroy failed: ${del.status()} ${await del.text()}`).toContain(del.status())
    const listAfterDestroy = await request.get(`${CP_URL}/api/v1/workspaces/${sharedWs}/jobs`, {
      headers: sharedHeaders,
    })
    expect(listAfterDestroy.status(), 'destroyed workspace must not serve jobs anymore').toBe(404)

    writeFileSync(
      path.join(EVIDENCE_DIR, 'workspace-job-destroy.json'),
      JSON.stringify(
        {
          itemId,
          jobId,
          missingJobDir: 'JOB_OUTPUT_LOST (409)',
          removedSandbox: `${removedBody.status} ${String(removedBody.body.code ?? '')}`,
          destroyedStatus: del.status(),
          listStatus: listAfterDestroy.status(),
        },
        null,
        2,
      ),
    )
  })
})
