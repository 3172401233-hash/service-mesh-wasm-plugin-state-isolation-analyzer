'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyRuntime, analyzeRuntime, EXPECTED_UPDATE_ORDER } = require('../src');

function setup() {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  runtime.registerListener('listener-b');
  const instance = runtime.loadPlugin({
    moduleId: 'auth-filter',
    version: 'v1',
    tenant: 'tenant-1',
    listenerIds: ['listener-a', 'listener-b'],
    sharedMemoryKeys: ['stats'],
    imports: ['proxy_log', 'proxy_get_shared_data'],
  });
  return { runtime, instance };
}

test('热更新后新模块读取到的是重置后的统计状态', () => {
  const { runtime, instance } = setup();
  runtime.dispatch('listener-a');
  runtime.dispatch('listener-b');
  assert.equal(runtime.readSharedStats(instance.instanceId, 'stats').requests, 2);

  const next = runtime.hotUpdate(instance.instanceId, 'v2');

  assert.equal(next.version, 'v2');
  assert.equal(next.status, 'active');
  assert.deepEqual(runtime.readSharedStats(next.instanceId, 'stats'), { requests: 0 });

  const report = analyzeRuntime(runtime);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.residualState, []);
});

test('热更新顺序：摘流 → 撤销回调 → 重置共享状态 → 激活新实例', () => {
  const { runtime, instance } = setup();
  runtime.hotUpdate(instance.instanceId, 'v2');

  const report = analyzeRuntime(runtime);
  assert.equal(report.updateOrder.conforms, true);
  assert.deepEqual(report.updateOrder.steps.map((s) => s.step), EXPECTED_UPDATE_ORDER);
});

test('热更新撤销旧实例的全部回调并影响其监听器', () => {
  const { runtime, instance } = setup();
  const oldCallbackCount = [...runtime.callbacks.values()].filter(
    (cb) => cb.instanceId === instance.instanceId,
  ).length;
  assert.equal(oldCallbackCount, 3); // 2 个 onRequest + 1 个 onTick

  const next = runtime.hotUpdate(instance.instanceId, 'v2');

  const leftover = [...runtime.callbacks.values()].filter(
    (cb) => cb.instanceId === instance.instanceId,
  );
  assert.equal(leftover.length, 0);
  assert.equal(runtime.listeners.get('listener-a').attached.has(instance.instanceId), false);
  assert.equal(runtime.listeners.get('listener-a').attached.has(next.instanceId), true);

  const report = analyzeRuntime(runtime);
  assert.deepEqual(report.affectedListeners, ['listener-a', 'listener-b']);
});

test('非活跃实例不允许热更新', () => {
  const { runtime, instance } = setup();
  runtime.fail(instance.instanceId, 'trap');
  assert.throws(() => runtime.hotUpdate(instance.instanceId, 'v2'), /cannot hot-update/);
});
