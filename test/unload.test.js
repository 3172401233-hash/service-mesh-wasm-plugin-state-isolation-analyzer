'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyRuntime, analyzeRuntime } = require('../src');

test('重复卸载是幂等的，不产生二次释放', () => {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  const instance = runtime.loadPlugin({
    moduleId: 'auth-filter',
    version: 'v1',
    tenant: 'tenant-1',
    listenerIds: ['listener-a'],
    sharedMemoryKeys: ['stats'],
  });

  assert.equal(runtime.unload(instance.instanceId), true);
  assert.equal(runtime.unload(instance.instanceId), false);
  assert.equal(runtime.unload(instance.instanceId), false);

  const skipped = runtime.events.filter((e) => e.type === 'plugin-unload-skipped');
  assert.equal(skipped.length, 2);
  const released = runtime.events.filter((e) => e.type === 'shared-memory-released');
  assert.equal(released.length, 1);

  const report = analyzeRuntime(runtime);
  assert.deepEqual(report.residualState, []);
});

test('同租户多实例时共享内存按引用计数释放', () => {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  const first = runtime.loadPlugin({
    moduleId: 'filter-a',
    version: 'v1',
    tenant: 'tenant-1',
    listenerIds: ['listener-a'],
    sharedMemoryKeys: ['stats'],
  });
  const second = runtime.loadPlugin({
    moduleId: 'filter-b',
    version: 'v1',
    tenant: 'tenant-1',
    listenerIds: ['listener-a'],
    sharedMemoryKeys: ['stats'],
  });

  runtime.unload(first.instanceId);
  assert.equal(runtime.sharedRegions.has('stats'), true);
  assert.equal(runtime.sharedRegions.get('stats').holders.size, 1);

  runtime.unload(second.instanceId);
  assert.equal(runtime.sharedRegions.has('stats'), false);

  const report = analyzeRuntime(runtime);
  assert.deepEqual(report.residualState, []);
});

test('失败后再卸载不会重复清理', () => {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  const instance = runtime.loadPlugin({
    moduleId: 'auth-filter',
    version: 'v1',
    tenant: 'tenant-1',
    listenerIds: ['listener-a'],
    sharedMemoryKeys: ['stats'],
  });

  runtime.fail(instance.instanceId, 'wasm trap');
  assert.equal(runtime.unload(instance.instanceId), true);
  assert.equal(runtime.unload(instance.instanceId), false);

  const cleaned = runtime.events.filter((e) => e.type === 'instance-cleaned');
  assert.equal(cleaned.length, 1);

  const report = analyzeRuntime(runtime);
  assert.deepEqual(report.residualState, []);
  assert.deepEqual(report.affectedListeners, ['listener-a']);
});
