'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyRuntime, analyzeRuntime, CrossTenantStateError } = require('../src');

test('不同租户插件不能共享可变状态', () => {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  runtime.loadPlugin({
    moduleId: 'filter-a',
    version: 'v1',
    tenant: 'tenant-1',
    listenerIds: ['listener-a'],
    sharedMemoryKeys: ['stats'],
  });

  assert.throws(
    () =>
      runtime.loadPlugin({
        moduleId: 'filter-b',
        version: 'v1',
        tenant: 'tenant-2',
        listenerIds: ['listener-a'],
        sharedMemoryKeys: ['stats'],
      }),
    CrossTenantStateError,
  );

  const report = analyzeRuntime(runtime);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].kind, 'cross-tenant-shared-state');
  assert.equal(report.violations[0].tenant, 'tenant-2');
  assert.deepEqual(report.residualState, []);
});

test('绕过热更新直接加载新版本会读到旧模块的统计状态并被判定为污染', () => {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  const v1 = runtime.loadPlugin({
    moduleId: 'auth-filter',
    version: 'v1',
    tenant: 'tenant-1',
    listenerIds: ['listener-a'],
    sharedMemoryKeys: ['stats'],
  });
  runtime.dispatch('listener-a');
  runtime.dispatch('listener-a');

  // 错误做法：不走 hotUpdate，直接加载 v2 并复用同一共享内存
  const v2 = runtime.loadPlugin({
    moduleId: 'auth-filter',
    version: 'v2',
    tenant: 'tenant-1',
    listenerIds: ['listener-a'],
    sharedMemoryKeys: ['stats'],
  });
  const stats = runtime.readSharedStats(v2.instanceId, 'stats');
  assert.equal(stats.requests, 2); // v2 读到了 v1 写入的统计

  const report = analyzeRuntime(runtime);
  const pollution = report.violations.filter((v) => v.kind === 'stale-stats-across-versions');
  assert.equal(pollution.length, 1);
  assert.equal(pollution[0].writer.version, 'v1');
  assert.equal(pollution[0].reader.version, 'v2');
  assert.equal(v1.status, 'active');
});

test('同租户多实例共享状态不算违规', () => {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  runtime.loadPlugin({
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
  runtime.dispatch('listener-a');
  runtime.readSharedStats(second.instanceId, 'stats');

  const report = analyzeRuntime(runtime);
  assert.deepEqual(report.violations, []);
});
