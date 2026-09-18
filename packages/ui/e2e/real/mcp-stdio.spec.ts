import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

const FIXTURE_SCRIPT = [
  "const readline=require('readline');",
  "const rl=readline.createInterface({input:process.stdin});",
  "rl.on('line',(l)=>{let m;try{m=JSON.parse(l)}catch{return}",
  "if(m.method==='initialize'){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'xihe-e2e',version:'0'}}}))}",
  "else if(m.method==='notifications/initialized'){}",
  "else if(m.method==='tools/list'){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'e2e_echo',description:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}}))}",
  "else if(m.method==='tools/call'){const t=(m.params&&m.params.arguments&&m.params.arguments.text)||'';console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'echo:'+t}]}}))}",
  "else{console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'method not found'}}))}});",
].join('')

test.describe('@host MCP — stdio session (PLAN-0347)', () => {
  test('stdio server tools/list + tools/call go through an exec-attach session', async ({ request }) => {
    const register = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `mcp-session-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: 'McpSession' },
    })
    expect(register.ok(), `register failed: ${register.status()} ${await register.text()}`).toBeTruthy()
    const auth = await register.json()
    const authToken: string = auth.accessToken
    const wsId: string = auth.workspaceId

    const userHeaders = { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }

    // 1) 配置 stdio server（generation 乐观锁；servers 为 name→config 映射）
    const current = await request.get(`${CP_URL}/api/v1/workspaces/${wsId}/stdio-servers`, { headers: userHeaders })
    expect(current.ok(), `stdio-servers read failed: ${current.status()}`).toBeTruthy()
    const { generation } = await current.json()
    const put = await request.put(`${CP_URL}/api/v1/workspaces/${wsId}/stdio-servers`, {
      headers: userHeaders,
      data: {
        generation,
        servers: { 'e2e-stdio': { command: 'node', args: ['-e', FIXTURE_SCRIPT] } },
      },
    })
    expect(put.ok(), `stdio-servers write failed: ${put.status()} ${await put.text()}`).toBeTruthy()

    // 2) 经 CP MCP 端点 tools/list（惰性建会话；轮询窗口内首次调用也成立）
    const mcpHeaders = {
      ...userHeaders,
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'X-Workspace-Id': wsId,
    }
    const init = await request.post(`${CP_URL}/api/v1/mcp`, {
      headers: mcpHeaders,
      data: {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'xihe-e2e', version: '0.1.0' } },
      },
    })
    expect(init.status(), `initialize failed: ${init.status()} ${await init.text()}`).toBe(200)
    const sessionId = init.headers()['mcp-session-id']
    const sessionHeaders = sessionId ? { ...mcpHeaders, 'mcp-session-id': sessionId } : mcpHeaders
    if (sessionId) {
      await request.post(`${CP_URL}/api/v1/mcp`, {
        headers: sessionHeaders,
        data: { jsonrpc: '2.0', method: 'notifications/initialized' },
      })
    }

    const list = await request.post(`${CP_URL}/api/v1/mcp`, {
      headers: sessionHeaders,
      data: { jsonrpc: '2.0', method: 'tools/list', id: 2, params: {} },
    })
    expect(list.status(), `tools/list failed: ${list.status()} ${await list.text()}`).toBe(200)
    const listed = await list.json()
    const tools = listed?.result?.tools ?? []
    expect(JSON.stringify(tools)).toContain('e2e_echo')

    // 3) tools/call 经同一会话往返；未分类工具由 CP 策略门禁（ASK）时，
    //    校验 409 审批信封（调用被策略前置拦截属预期，不属会话故障）。
    const call = await request.post(`${CP_URL}/api/v1/mcp`, {
      headers: sessionHeaders,
      data: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 3,
        params: { name: 'e2e_echo', arguments: { text: 'ping' } },
      },
    })
    if (call.status() === 200) {
      const called = await call.json()
      expect(JSON.stringify(called)).toContain('echo:ping')
    } else {
      expect(call.status(), `tools/call unexpected status: ${call.status()} ${await call.text()}`).toBe(409)
      const gatedText = await call.text()
      expect(gatedText).toContain('APPROVAL_REQUIRED')
    }
  })
})
