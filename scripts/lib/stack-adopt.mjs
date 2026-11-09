// task-76（issue: dev-stack acquire 只写租约不写 pidFile）：
// 「认领」必须把**两份**状态一起落盘——租约（声明）与 pid 记录（佐证）。少了后者，
// status 的 alive/factsOk 恒为 false（它只读 pidFile），于是刚认领完的栈仍然报
// stack is not fully up —— 全绿却 exit 1 的假红，会训练人忽略 status。
//
// 本模块只做**纯函数**（无 fs、无进程探测），便于 node --test 秒级钉住：
//   - buildAdoptedRecord：从 CURRENT facts（监听者）合成与 start 同形的 pid 记录；
//   - deadRecordedServices：status 文案用——哪些「记录里写着」的 pid 已经死了。
// 不在这里读/写文件：落盘仍是 dev-stack.mjs 的 writeJson（唯一出口）。

const ensureObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isPid = (value) => Number.isInteger(value) && value > 0;
const nonEmpty = (value) => typeof value === 'string' && value !== '';

/**
 * 合成 pid 记录。结构与 start() 写出的完全一致（stackId/projectRoot/startedAt/pgStarted/
 * services{svc:{pid,port,startedAt}}），**不发明第二种格式**——status 只认这一种。
 *
 * 合并规则：
 *  - 上一份记录里**仍然活着**的条目原样保留（重复 acquire 幂等，不会丢别的服务）；
 *  - 死 pid 的条目**丢弃**：留在 pidFile 里会让 alive 永远 false ⇒ 又是那类假红；
 *  - 当前监听者覆盖同名条目（pid/port 以事实为准，startedAt 优先用进程真实启动时刻）。
 *
 * @param {object} input
 * @param {string} input.stackId
 * @param {string} input.projectRoot
 * @param {Array<{service:string|null,pid:number,port:number,startedAt?:string}>} input.listeners
 * @param {Object<string,number>} input.ports  service → port
 * @param {string[]} input.services            写记录的 service 顺序（SERVICES 常量）
 * @param {object|null} [input.previous]       现有 pidFile 内容
 * @param {Date} [input.now]
 * @param {(pid:number)=>boolean} [input.isAlive]
 */
export function buildAdoptedRecord({
  stackId,
  projectRoot,
  listeners = [],
  ports = {},
  services = [],
  previous = null,
  now = new Date(),
  isAlive = () => true,
} = {}) {
  const prev = ensureObject(previous);
  const record = {
    stackId,
    projectRoot,
    startedAt: nonEmpty(prev.startedAt) ? prev.startedAt : now.toISOString(),
    pgStarted: Boolean(prev.pgStarted),
    services: {},
  };
  // 1) 保留上一份记录里还活着的服务（本次观测到的条目会在第 2 步覆盖）。
  for (const [service, entry] of Object.entries(ensureObject(prev.services))) {
    if (!services.includes(service)) continue;
    if (!isPid(entry?.pid) || !isAlive(entry.pid)) continue;
    record.services[service] = { ...entry };
  }
  // 2) 本次观测到的监听者覆盖同名条目。
  for (const service of services) {
    const listener =
      listeners.find((entry) => entry?.service === service) ??
      listeners.find((entry) => entry?.port === ports[service]);
    if (!isPid(listener?.pid)) continue;
    record.services[service] = {
      pid: listener.pid,
      port: Number.isInteger(listener.port) ? listener.port : ports[service],
      startedAt: nonEmpty(listener.startedAt) ? listener.startedAt : now.toISOString(),
    };
  }
  return record;
}

/**
 * 记录里写着、但进程已经不在了的服务。status 用它把「租约还在但进程已死」说清楚，
 * 而不是笼统一句 stack is not fully up（那种文案无法归因）。
 *
 * @returns {Array<{service:string,pid:number}>}
 */
export function deadRecordedServices({ record = null, services = [], isAlive = () => true } = {}) {
  const dead = [];
  for (const service of services) {
    const pid = record?.services?.[service]?.pid ?? null;
    if (!isPid(pid)) continue;
    if (!isAlive(pid)) dead.push({ service, pid });
  }
  return dead;
}
