// task-76 自测（node --test scripts/lib/stack-adopt.test.mjs）：
//   T1 与 start 同形：acquire 落盘的 pid 记录必须是 status 认得的那一种格式；
//   T2 重复 acquire 幂等：同 listeners + 同 previous ⇒ 深相等，不产生重复/漂移条目；
//   T3 死条目被丢弃、活条目被保留（否则 factsOk 永远 false）；
//   T4 deadRecordedServices 能把「记录里写着但进程已死」点出来（status 文案依赖它）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAdoptedRecord, deadRecordedServices } from './stack-adopt.mjs';

const PORTS = { ui: 12630, cp: 12631, agent: 12632, runtime: 12633 };
const SERVICES = ['cp', 'runtime', 'agent', 'ui'];
const LISTENERS = [
  { service: 'cp', port: 12631, pid: 80520, startedAt: '2026-11-09T16:26:22.000Z' },
  { service: 'runtime', port: 12633, pid: 88468, startedAt: '2026-11-09T19:20:56.000Z' },
  { service: 'agent', port: 12632, pid: 71828, startedAt: '2026-11-09T19:20:58.000Z' },
  { service: 'ui', port: 12630, pid: 61848, startedAt: '2026-11-09T16:40:28.000Z' },
];
const NOW = new Date('2026-11-10T03:30:00.000Z');

test('T1 acquire 合成的记录与 start 写出的结构同形', () => {
  const record = buildAdoptedRecord({
    stackId: 'stack-1', projectRoot: 'H:/repo', listeners: LISTENERS, ports: PORTS, services: SERVICES, now: NOW,
  });
  assert.deepEqual(Object.keys(record).sort(), ['pgStarted', 'projectRoot', 'services', 'stackId', 'startedAt']);
  assert.equal(record.stackId, 'stack-1');
  assert.equal(record.projectRoot, 'H:/repo');
  assert.equal(record.startedAt, NOW.toISOString());
  assert.equal(record.pgStarted, false);
  for (const service of SERVICES) {
    const entry = record.services[service];
    assert.deepEqual(Object.keys(entry).sort(), ['pid', 'port', 'startedAt'], service);
    assert.equal(entry.port, PORTS[service]);
    assert.equal(entry.pid, LISTENERS.find((l) => l.service === service).pid);
    // startedAt 用进程真实启动时刻，不是认领时刻
    assert.equal(entry.startedAt, LISTENERS.find((l) => l.service === service).startedAt);
  }
});

test('T2 重复 acquire 幂等：同一 listeners 不产生重复/漂移条目', () => {
  const first = buildAdoptedRecord({ stackId: 'stack-1', projectRoot: 'H:/repo', listeners: LISTENERS, ports: PORTS, services: SERVICES, now: NOW });
  const second = buildAdoptedRecord({
    stackId: 'stack-1', projectRoot: 'H:/repo', listeners: LISTENERS, ports: PORTS, services: SERVICES,
    previous: first, now: new Date('2026-11-10T03:35:00.000Z'), isAlive: () => true,
  });
  assert.deepEqual(second, first);
  assert.equal(Object.keys(second.services).length, SERVICES.length);
});

test('T3 旧记录里的死 pid 被丢弃、活着的保留', () => {
  const previous = {
    stackId: 'stack-1', projectRoot: 'H:/repo', startedAt: '2026-11-09T16:26:22.000Z', pgStarted: true,
    services: {
      cp: { pid: 80520, port: 12631, startedAt: '2026-11-09T16:26:22.000Z' },
      runtime: { pid: 11111, port: 12633, startedAt: '2026-11-08T10:00:00.000Z' }, // 死 pid
    },
  };
  const record = buildAdoptedRecord({
    stackId: 'stack-1', projectRoot: 'H:/repo', ports: PORTS, services: SERVICES, previous, now: NOW,
    listeners: [{ service: 'agent', port: 12632, pid: 71828, startedAt: '2026-11-09T19:20:58.000Z' }],
    isAlive: (pid) => pid === 80520,
  });
  assert.equal(record.startedAt, previous.startedAt, '已认领的时刻不该被覆盖');
  assert.equal(record.pgStarted, true, 'pgStarted 是历史事实，不能被清掉');
  assert.equal(record.services.cp.pid, 80520, '活着的旧条目保留');
  assert.equal(record.services.runtime, undefined, '死 pid 条目必须丢弃');
  assert.equal(record.services.agent.pid, 71828, '本次观测者写入');
  assert.equal(record.services.ui, undefined, '没观测到的服务不伪造条目');
});

test('T4 deadRecordedServices 点出记录中已死的进程', () => {
  const record = { services: { cp: { pid: 80520 }, runtime: { pid: 22222 }, agent: { pid: null }, ui: {} } };
  const dead = deadRecordedServices({ record, services: SERVICES, isAlive: (pid) => pid === 80520 });
  assert.deepEqual(dead, [{ service: 'runtime', pid: 22222 }]);
  assert.deepEqual(deadRecordedServices({ record: null, services: SERVICES }), []);
});
