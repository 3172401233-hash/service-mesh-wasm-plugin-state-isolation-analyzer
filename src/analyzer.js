'use strict';

const LIFECYCLE_EVENT_TYPES = new Set([
  'plugin-init-failed',
  'plugin-failed',
  'plugin-replaced',
  'plugin-unloaded',
  'update-drain-listeners',
]);

const EXPECTED_UPDATE_ORDER = [
  'drain-listeners',
  'revoke-callbacks',
  'reset-shared-state',
  'activate-new',
];

/**
 * 分析运行时的生命周期事件与当前状态，输出：
 * - affectedListeners：被失败 / 卸载 / 热更新波及的监听器
 * - residualState：清理后仍残留的回调、监听器挂载和共享内存
 * - updateOrder：热更新步骤的实际顺序及其是否符合预期
 * - violations：跨租户共享、跨版本统计污染等隔离违规
 */
function analyzeRuntime(runtime) {
  const affectedListeners = collectAffectedListeners(runtime);
  const residualState = collectResidualState(runtime);
  const updateOrder = collectUpdateOrder(runtime);
  const violations = collectViolations(runtime);
  return { affectedListeners, residualState, updateOrder, violations };
}

function collectAffectedListeners(runtime) {
  const affected = new Set();
  for (const event of runtime.events) {
    if (!LIFECYCLE_EVENT_TYPES.has(event.type)) continue;
    for (const listenerId of event.listenerIds ?? []) {
      affected.add(listenerId);
    }
  }
  return [...affected].sort();
}

function collectResidualState(runtime) {
  const residual = [];
  for (const cb of runtime.callbacks.values()) {
    const instance = runtime.instances.get(cb.instanceId);
    if (!instance || instance.status !== 'active') {
      residual.push({
        kind: 'callback',
        id: cb.id,
        instanceId: cb.instanceId,
        listenerId: cb.listenerId,
        event: cb.event,
      });
    }
  }
  for (const listener of runtime.listeners.values()) {
    for (const instanceId of listener.attached) {
      const instance = runtime.instances.get(instanceId);
      if (!instance || instance.status !== 'active') {
        residual.push({ kind: 'listener-attachment', listenerId: listener.id, instanceId });
      }
    }
  }
  for (const region of runtime.sharedRegions.values()) {
    if (region.holders.size === 0) {
      residual.push({ kind: 'shared-memory', key: region.name, ownerTenant: region.ownerTenant });
    }
  }
  return residual;
}

function collectUpdateOrder(runtime) {
  const steps = runtime.events
    .filter((event) => event.type.startsWith('update-'))
    .map((event) => ({
      seq: event.seq,
      step: event.type.slice('update-'.length),
      from: event.from ?? null,
      to: event.to ?? null,
      version: event.version ?? null,
    }));
  const actual = steps.map((s) => s.step);
  const conforms =
    actual.length === EXPECTED_UPDATE_ORDER.length &&
    EXPECTED_UPDATE_ORDER.every((step, i) => actual[i] === step);
  return { expected: [...EXPECTED_UPDATE_ORDER], steps, conforms };
}

function collectViolations(runtime) {
  const violations = [];
  for (const event of runtime.events) {
    if (event.type === 'cross-tenant-denied') {
      violations.push({
        kind: 'cross-tenant-shared-state',
        key: event.key,
        ownerTenant: event.ownerTenant,
        tenant: event.tenant,
        instanceId: event.instanceId,
      });
    }
    if (event.type === 'shared-read' && event.writer) {
      const { writer } = event;
      if (writer.tenant !== event.tenant) {
        violations.push({
          kind: 'cross-tenant-shared-state',
          key: event.key,
          reader: event.instanceId,
          writer: writer.instanceId,
        });
      } else if (
        writer.moduleId === event.moduleId &&
        writer.version !== event.version &&
        writer.generation === event.generation
      ) {
        violations.push({
          kind: 'stale-stats-across-versions',
          key: event.key,
          reader: { instanceId: event.instanceId, version: event.version },
          writer: { instanceId: writer.instanceId, version: writer.version },
        });
      }
    }
  }
  return violations;
}

module.exports = { analyzeRuntime, EXPECTED_UPDATE_ORDER };
