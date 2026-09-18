import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import McpStdioServerList from '../settings/McpStdioServerList.vue'

const getStdioServers = vi.fn()
const getMcpServerStatus = vi.fn()
vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getStdioServers: (...args: unknown[]) => getStdioServers(...args),
      getMcpServerStatus: (...args: unknown[]) => getMcpServerStatus(...args),
    },
  }
})

const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  messages: {
    zh: {
      common: { loading: '加载中' },
      settings: {
        mcpServersTitle: 'stdio 服务器状态',
        mcpStatusRefresh: '刷新',
        mcpStatusStale: '状态可能过期',
        mcpStatusEmpty: '暂无 stdio MCP 服务器',
        mcpStatusEmptyHint: '添加服务器后，其健康状态会显示在这里',
        mcpStatusNoneHint: '已配置但尚无会话记录（尚未调用）',
        mcpStatus: {
          starting: '启动中',
          ready: '可用',
          restarting: '重启中',
          failed: '失败',
          stopped: '已停止',
          none: '无记录',
        },
      },
    },
  },
})

function snapshot(serverId: string, state: string, lastError: string | null = null) {
  return { serverId, state, attempt: 0, lastError, sinceMs: 1758182400000, epoch: 1 }
}

function mountList() {
  return mount(McpStdioServerList, {
    props: { workspaceId: 'ws-1' },
    global: { plugins: [i18n] },
  })
}

describe('McpStdioServerList (PLAN-0366 T2.1)', () => {
  beforeEach(() => {
    getStdioServers.mockReset()
    getMcpServerStatus.mockReset()
  })

  it('renders the five badge states plus the no-session row', async () => {
    getStdioServers.mockResolvedValue({
      servers: { fs: {}, search: {}, browser: {}, custom: {}, legacy: {}, idle: {} },
    })
    getMcpServerStatus.mockResolvedValue({
      servers: [
        snapshot('fs', 'ready'),
        snapshot('search', 'starting'),
        snapshot('browser', 'restarting'),
        snapshot('custom', 'failed', 'spawn ENOENT'),
        snapshot('legacy', 'stopped'),
      ],
      count: 5,
    })

    const wrapper = mountList()
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="mcp-server-row"]')
    expect(rows).toHaveLength(6)
    const badges = rows.map((row) => row.find('[data-testid="mcp-server-badge"]').text())
    expect(badges).toEqual(['重启中', '失败', '可用', '无记录', '已停止', '启动中'])

    // 失败态带原因；无记录行虚线边框、不展示原因
    const failedRow = rows.find((row) => row.text().includes('custom'))!
    expect(failedRow.find('[data-testid="mcp-server-reason"]').text()).toContain('spawn ENOENT')
    const noneRow = rows.find((row) => row.text().includes('idle'))!
    expect(noneRow.find('[data-testid="mcp-server-badge"]').classes()).toContain('border-dashed')
    expect(noneRow.find('[data-testid="mcp-server-reason"]').exists()).toBe(false)
  })

  it('shows the snapshot-only servers (config removed) as stopped', async () => {
    getStdioServers.mockResolvedValue({ servers: {} })
    getMcpServerStatus.mockResolvedValue({ servers: [snapshot('legacy', 'stopped')], count: 1 })

    const wrapper = mountList()
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="mcp-server-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('legacy')
    expect(rows[0].text()).toContain('已停止')
  })

  it('shows the empty state when there is no configuration and no snapshot', async () => {
    getStdioServers.mockResolvedValue({ servers: {} })
    getMcpServerStatus.mockResolvedValue({ servers: [], count: 0 })

    const wrapper = mountList()
    await flushPromises()

    expect(wrapper.find('[data-testid="mcp-status-empty"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="mcp-server-row"]')).toHaveLength(0)
  })

  it('keeps the last state and marks it stale when the status query fails', async () => {
    getStdioServers.mockResolvedValue({ servers: { fs: {} } })
    getMcpServerStatus.mockResolvedValue({ servers: [snapshot('fs', 'ready')], count: 1 })

    const wrapper = mountList()
    await flushPromises()
    expect(wrapper.find('[data-testid="mcp-status-stale"]').exists()).toBe(false)

    getMcpServerStatus.mockRejectedValue(new Error('runtime down'))
    await wrapper.find('[data-testid="mcp-status-refresh"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="mcp-status-stale"]').exists()).toBe(true)
    // 保留上次成功状态（ready），不清空为无记录
    expect(wrapper.find('[data-testid="mcp-server-badge"]').text()).toBe('可用')
  })

  it('does not disguise a first-load failure as a healthy list', async () => {
    getStdioServers.mockResolvedValue({ servers: { fs: {} } })
    getMcpServerStatus.mockRejectedValue(new Error('runtime down'))

    const wrapper = mountList()
    await flushPromises()

    const row = wrapper.find('[data-testid="mcp-server-row"]')
    expect(row.text()).toContain('fs')
    expect(row.find('[data-testid="mcp-server-badge"]').text()).toBe('无记录')
    expect(wrapper.find('[data-testid="mcp-status-stale"]').exists()).toBe(true)
  })
})
