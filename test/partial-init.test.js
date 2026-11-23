'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyRuntime, analyzeRuntime, UnknownListenerError, CrossTenantStateError } = require('../src');

test('部分初始化失败时回收已注册的回调与监听器挂载', () => {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  // listener-b 未注册，加载到一半必然失败
  let failedId;
  try {
    runtime.loadPlugin({
      moduleId: 'auth-filter',
      version: 'v1',
      tenant: 'tenant-1',
      listenerIds: ['listener-a', 'listener-b'],
      sharedMemoryKeys: ['stats'],
    });
    assert.unreachable('load should have failed');
  } catch (err) {
    assert.ok(err instanceof UnknownListenerError);
    failedId = [...runtime.instances.values()][0].instanceId;
  }

  const instance = runtime.instances.get(failedId);
  assert.equal(instance.status, 'failed');
  assert.equal(runtime.callbacks.size, 0);
  assert.equal(runtime.listeners.get('listener-a').attached.size, 0);
  assert.equal(runtime.sharedRegions.size, 0);

  const report = analyzeRuntime(runtime);
  assert.deepEqual(report.residualState, []);
  assert.deepEqual(report.affectedListeners, ['listener-a', 'listener-b']);
});

test('共享内存被其他租户占用导致部分初始化失败时释放已占用的区域', () => {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  runtime.loadPlugin({
    moduleId: 'filter-a',
    version: 'v1',
    tenant: 'tenant-1',
    listenerIds: ['listener-a'],
    sharedMemoryKeys: ['shared-key'],
  });

  assert.throws(
    () =>
      runtime.loadPlugin({
        moduleId: 'filter-b',
        version: 'v1',
        tenant: 'tenant-2',
        listenerIds: ['listener-a'],
        sharedMemoryKeys: ['own-key', 'shared-key'],
      }),
    CrossTenantStateError,
  );

  // own-key 被占用后必须随失败清理释放，不能残留
  assert.equal(runtime.sharedRegions.has('own-key'), false);
  assert.equal(runtime.sharedRegions.get('shared-key').ownerTenant, 'tenant-1');

  const report = analyzeRuntime(runtime);
  assert.deepEqual(report.residualState, []);
  assert.equal(report.violations[0].kind, 'cross-tenant-shared-state');
});

test('插件异常退出后回调不留存于代理注册表', () => {
  const runtime = new ProxyRuntime();
  runtime.registerListener('listener-a');
  runtime.registerListener('listener-b');
  const instance = runtime.loadPlugin({
    moduleId: 'auth-filter',
    version: 'v1',
    tenant: 'tenant-1',
    listenerIds: ['listener-a', 'listener-b'],
    sharedMemoryKeys: ['stats'],
  });
  assert.equal(runtime.callbacks.size, 3);

  runtime.fail(instance.instanceId, 'wasm trap: unreachable');

  assert.equal(runtime.callbacks.size, 0);
  assert.equal(runtime.listeners.get('listener-a').attached.size, 0);
  assert.equal(runtime.listeners.get('listener-b').attached.size, 0);
  assert.equal(runtime.sharedRegions.size, 0);

  const report = analyzeRuntime(runtime);
  assert.deepEqual(report.residualState, []);
  assert.deepEqual(report.affectedListeners, ['listener-a', 'listener-b']);
});
