# 双侧轨迹对账（`task-50`，D-1085 的「共同运行体」）

同一串请求在**两个车道**各跑一遍，逐条比 `method` + 归一化 path + `status` + **响应顶层键集合**；
diff 非空 ⇒ 用例红。它把「两侧」放进同一个脚本、同一次执行，回答的是 `D-1085` 那句
**「两侧各自绿 ≠ 两侧一致」**。

## 1. 判据（三条，逐条有夹具）

| # | 判据 | 报错前缀 | 例子 |
|---|---|---|---|
| ① | 请求集合一致 | `REQ-MISSING-IN-<SIDE>` | mock 打了 `/instance/agent-principals`、契约没有这条 |
| ② | 同一请求 `status` 一致 | `STATUS` | `mock=200 contract=404` |
| ③ | **响应顶层键集合**一致 | `KEYS` | `mock=[agents] contract=[principals]` |

顶层键集合口径：对象 ⇒ 排序后的属性名；数组 ⇒ `["<array>"]`（元素键另存 `itemKeys`，默认**不参与**
判据）；非 JSON / 空 body ⇒ `null`（与「空对象 `[]`」严格区分 —— 否则「没读到」会被当成「形状一致」）。

归一化：路径里 uuid / 纯数字 / `workspace-1` 这类夹具 id 一律换成 `{id}`；query 丢 `locale`/`_`/`t`/`ts`
等易变键、**只**把 `*id`/`*Id` 参数的值归一成 `{id}`（否则 `?page=2` 会被写成 `{id}`，门就看不见分页差异）、
按键排序。

## 2. 怎么跑

```bash
cd A03-xihe/packages/ui
node e2e/dual-lane/selftest.mjs                          # 纯函数自测，24 例，秒级
node e2e/dual-lane/run.mjs --case resources-agents        # 绿路径：mock ↔ 契约，diff 空 ⇒ exit 0
node e2e/dual-lane/run.mjs --case resources-agents --mutate principals=agents   # 反例：exit 1

# 真栈车道（要一栈 + 一个 token；本轮已跑过一次，见 §4.1）
node e2e/dual-lane/run.mjs --case resources-agents \
  --real-base-url http://127.0.0.1:12631 --workspace-id <真栈 workspace uuid>
```

真栈车道的 token 从环境变量 `XIHE_E2E_TOKEN` 读（也可 `--token`；**不要写进命令行**，会进 shell history）。
`--workspace-id` 把用例里的夹具 id `workspace-1` 换成真 uuid —— 不换的话真栈只会回 404/400，那是
**输入不同**而不是形状不同（`D-1085`：输入不同必须显式登记，不许当成形状一致）。

产物默认落 `A03-xihe/.tmp/xh/dual-lane/`（gitignored）：`mock-<case>.json` / `contract-<case>.json` /
`diff-<case>.txt`。目录可用 `--out-dir` 改。

## 3. 反例（`D-1074`：没有反例的闸等于没门）

把 mock 侧「用户层 / 实例层」两个响应的顶层键 `principals` 改名成 `agents` 跑一次，实测输出：

```text
# 双侧轨迹对账（task-50）
- 用例: resources-agents
- 左侧: .../.tmp/xh/dual-lane/mock-resources-agents.json (3 行)
- 右侧: .../.tmp/xh/dual-lane/contract-resources-agents.json (3 行)
- 结论: 不一致（2 条）

KEYS      GET /api/v1/agent-principals  mock=[agents] contract=[principals]
KEYS      GET /api/v1/instance/agent-principals  mock=[agents] contract=[principals]
```

⇒ `exit 1`。改回（不带 `--mutate`）⇒ 「一致（diff 为空）」`exit 0`。两条读数都在
`internal/A03-xihe/evidence/2026-11-13-dual-lane-trace-diff/` 的证据包里。

反例开关为什么长在**录制侧**而不是比对侧：比对面（契约 / 真栈）是权威，改它等于改判据；要证明
「闸会红」，必须让**被测的一侧**出错。`--mutate from=to` 只改该响应**顶层**键（正是判据 ③ 的粒度）。

## 4. 本轮的边界（诚实清单）

1. **真栈车道已跑过一次（2026-11-13，`stack-1`，CP `:12631`）**，读数见证据包 `real-lane/run.txt`：
   绿 ⇒ 3 条 GET 全 200、`{principals}` / `{agents}` / `{principals}` 两侧一致、diff 空、exit 0；
   红 ⇒ `--mutate principals=agents` 给出 2 条 `KEYS`（`mock=[agents] real=[principals]`）、exit 1。
   **但它还不是常规门**：要登录态、要一栈、要真 uuid，所以按需跑，不进任何自动化流水线。
   仍未做的：把「取 token / 取 workspaceId」也脚本化（现在这两步在证据包 `real-lane/run.txt` 里是
   手工命令），以及把真栈读数接进日常（需要先定谁在什么时机跑）。
2. **mock 车道是本地桩服务，不是浏览器**：判据是 HTTP 形状（method/path/status/键集），浏览器只
   多一层不确定性；桩体与 `e2e/mock/*.spec.ts` 的 `route.fulfill` 同源。要验「页面真的那样调」属于
   更上一层的 E2E，不在本闸口径内。
3. **只落了 1 条用例**（`resources-agents`，覆盖用户/工作区/实例三层）。卡面建议 2–3 条，剩下面
   建议：资源区凭据三层、设置域页「个人覆盖」徽标。加一条 = 在 `cases.mjs` 里加 `calls` + `stubs`。
4. **没有接进门**：不进门是有意的 —— 接 `mise`/`validate` 属于门集分档裁定（`mise-gate-tier-proposal.md`），
   而且这条闸在拿到真栈读数之前只会证明「桩 ≈ 契约」，价值有限。建议：真栈车道跑通一轮绿+一轮红之后
   再议入门与分档。

## 5. 文件

| 文件 | 作用 |
|---|---|
| `normalize.mjs` | 归一化（path / query / 顶层键集合），两条车道共用 |
| `cases.mjs` | 用例注册表：`calls`（要打什么）+ `stubs`（mock 回什么）+ `compare`（判哪些） |
| `lanes.mjs` | mock 桩服务 + **共用录波器** `recordHttpLane` + 反例开关 |
| `contract.mjs` + `openapi-shape.py` | 契约车道：从 `docs/api/openapi.yaml` 推 status + 顶层键（PyYAML，禁止手写 parser） |
| `diff.mjs` | 三条判据的比对器（纯函数 + CLI，可单独比对任意两份轨迹） |
| `run.mjs` | 编排：录 mock → 录契约 → diff → 写报告 → 退出码 |
| `selftest.mjs` | 24 例夹具：归一化 / 键集合 / 三条判据各自会红 / 卡片原例 `{agents,count}` vs `{principals}` |

## 6. 与既有门的关系（别混用）

- `check:openapi` / `RouteContractParityTest` / `check:openapi:lint` / `check:api-docs` 管的是**契约自身**
  与「契约 ↔ 路由表」——它们不看响应体形状，也不看 mock。
- `mock-test` 的 `pageFailures` 门管的是「mock 车道的 console/pageerror/非预期 4xx」——它不比对形状。
  **本轮 MCP 实例层 404（`task-43`）就是从这个缝里漏过去的**：mock 有夹具、真栈 404、`PLANNED_APIS`
  登记为「待建」，而没有任何一条门把这两侧放在一起看。
