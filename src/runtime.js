'use strict';

class CrossTenantStateError extends Error {
  constructor(key, ownerTenant, tenant) {
    super(`shared memory "${key}" is owned by tenant "${ownerTenant}", denied to tenant "${tenant}"`);
    this.name = 'CrossTenantStateError';
    this.key = key;
    this.ownerTenant = ownerTenant;
    this.tenant = tenant;
  }
}

class UnknownListenerError extends Error {
  constructor(listenerId) {
    super(`listener "${listenerId}" is not registered on the proxy`);
    this.name = 'UnknownListenerError';
    this.listenerId = listenerId;
  }
}

class UnknownInstanceError extends Error {
  constructor(instanceId) {
    super(`plugin instance "${instanceId}" does not exist`);
    this.name = 'UnknownInstanceError';
    this.instanceId = instanceId;
  }
}

class LifecycleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LifecycleError';
  }
}

/**
 * ProxyRuntime 模拟服务网格代理（Envoy 风格）中 Wasm 插件的运行环境：
 * 监听器、按租户隔离的共享内存、回调注册表以及插件生命周期事件。
 * 它不执行真实 Wasm 字节码，只模拟宿主侧的生命周期语义。
 */
class ProxyRuntime {
  constructor() {
    this.listeners = new Map();
    this.sharedRegions = new Map();
    this.callbacks = new Map();
    this.instances = new Map();
    this.events = [];
    this._instanceSeq = 0;
    this._callbackSeq = 0;
  }

  #record(type, detail = {}) {
    this.events.push({ seq: this.events.length, type, ...detail });
  }

  #requireInstance(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new UnknownInstanceError(instanceId);
    return instance;
  }

  registerListener(listenerId) {
    if (!this.listeners.has(listenerId)) {
      this.listeners.set(listenerId, { id: listenerId, attached: new Set() });
      this.#record('listener-registered', { listenerId });
    }
    return this.listeners.get(listenerId);
  }

  loadPlugin(spec) {
    const {
      moduleId,
      version,
      tenant,
      listenerIds = [],
      sharedMemoryKeys = [],
      imports = [],
    } = spec;
    if (!moduleId || !version || !tenant) {
      throw new LifecycleError('moduleId, version and tenant are required');
    }
    const instanceId = `${moduleId}@${version}#${++this._instanceSeq}`;
    const instance = {
      instanceId,
      moduleId,
      version,
      tenant,
      status: 'initializing',
      listenerIds: [...listenerIds],
      sharedKeys: [...sharedMemoryKeys],
      imports: [...imports],
      stats: { requests: 0, errors: 0 },
      failureReason: null,
    };
    this.instances.set(instanceId, instance);
    this.#record('plugin-load-start', { instanceId, moduleId, version, tenant });

    try {
      for (const key of sharedMemoryKeys) {
        this.#claimSharedMemory(instance, key);
      }
      for (const listenerId of listenerIds) {
        this.#attachListener(instance, listenerId);
      }
      this.#registerCallback(instance, null, 'onTick');
      instance.status = 'active';
      this.#record('plugin-active', { instanceId });
    } catch (err) {
      instance.status = 'failed';
      instance.failureReason = err.message;
      this.#record('plugin-init-failed', {
        instanceId,
        listenerIds: [...instance.listenerIds],
        reason: err.message,
      });
      this.#cleanupInstance(instance, 'partial-init');
      throw err;
    }
    return instance;
  }

  #claimSharedMemory(instance, key) {
    let region = this.sharedRegions.get(key);
    if (region && region.ownerTenant !== instance.tenant) {
      this.#record('cross-tenant-denied', {
        instanceId: instance.instanceId,
        key,
        ownerTenant: region.ownerTenant,
        tenant: instance.tenant,
      });
      throw new CrossTenantStateError(key, region.ownerTenant, instance.tenant);
    }
    if (!region) {
      region = {
        name: key,
        ownerTenant: instance.tenant,
        data: { requests: 0 },
        generation: 0,
        holders: new Set(),
        lastWrite: null,
      };
      this.sharedRegions.set(key, region);
      this.#record('shared-memory-created', { key, tenant: instance.tenant });
    }
    region.holders.add(instance.instanceId);
  }

  #attachListener(instance, listenerId) {
    const listener = this.listeners.get(listenerId);
    if (!listener) throw new UnknownListenerError(listenerId);
    listener.attached.add(instance.instanceId);
    this.#registerCallback(instance, listenerId, 'onRequest');
  }

  #registerCallback(instance, listenerId, event) {
    const id = `cb-${++this._callbackSeq}`;
    this.callbacks.set(id, {
      id,
      instanceId: instance.instanceId,
      listenerId,
      event,
    });
    return id;
  }

  #detachListener(instance, listenerId) {
    const listener = this.listeners.get(listenerId);
    if (listener) listener.attached.delete(instance.instanceId);
  }

  #revokeCallbacks(instance) {
    let revoked = 0;
    for (const [id, cb] of this.callbacks) {
      if (cb.instanceId === instance.instanceId) {
        this.callbacks.delete(id);
        revoked += 1;
      }
    }
    return revoked;
  }

  #releaseSharedMemory(instance) {
    for (const key of instance.sharedKeys) {
      const region = this.sharedRegions.get(key);
      if (!region) continue;
      region.holders.delete(instance.instanceId);
      if (region.holders.size === 0) {
        this.sharedRegions.delete(key);
        this.#record('shared-memory-released', { key, tenant: region.ownerTenant });
      }
    }
  }

  #cleanupInstance(instance, cause) {
    const revoked = this.#revokeCallbacks(instance);
    for (const listenerId of instance.listenerIds) {
      this.#detachListener(instance, listenerId);
    }
    this.#releaseSharedMemory(instance);
    this.#record('instance-cleaned', {
      instanceId: instance.instanceId,
      cause,
      revokedCallbacks: revoked,
    });
  }

  /**
   * 热更新：先摘流、再撤销回调、再重置共享统计状态，最后激活新实例。
   * 新模块版本绝不允许读到旧版本写入的统计状态。
   */
  hotUpdate(instanceId, newVersion) {
    const old = this.#requireInstance(instanceId);
    if (old.status !== 'active') {
      throw new LifecycleError(`cannot hot-update instance in status "${old.status}"`);
    }
    const { moduleId, tenant, listenerIds, sharedKeys, imports } = old;

    for (const listenerId of listenerIds) {
      this.#detachListener(old, listenerId);
    }
    this.#record('update-drain-listeners', { from: instanceId, listenerIds: [...listenerIds] });

    this.#revokeCallbacks(old);
    this.#record('update-revoke-callbacks', { from: instanceId });

    for (const key of sharedKeys) {
      const region = this.sharedRegions.get(key);
      if (region) {
        region.data = { requests: 0 };
        region.generation += 1;
        region.lastWrite = null;
      }
    }
    this.#record('update-reset-shared-state', { moduleId, keys: [...sharedKeys] });

    old.status = 'replaced';
    this.#releaseSharedMemory(old);
    this.#record('plugin-replaced', {
      instanceId,
      listenerIds: [...listenerIds],
      version: newVersion,
    });

    const next = this.loadPlugin({
      moduleId,
      version: newVersion,
      tenant,
      listenerIds,
      sharedMemoryKeys: sharedKeys,
      imports,
    });
    this.#record('update-activate-new', { from: instanceId, to: next.instanceId, version: newVersion });
    return next;
  }

  /**
   * 插件异常退出：必须撤销它在代理注册表中的全部回调，
   * 从所有监听器摘除，并释放其持有的共享内存。
   */
  fail(instanceId, reason = 'plugin crashed') {
    const instance = this.#requireInstance(instanceId);
    if (instance.status !== 'active') {
      throw new LifecycleError(`cannot fail instance in status "${instance.status}"`);
    }
    instance.status = 'failed';
    instance.failureReason = reason;
    this.#record('plugin-failed', {
      instanceId,
      listenerIds: [...instance.listenerIds],
      reason,
    });
    this.#cleanupInstance(instance, 'failure');
    return instance;
  }

  /** 幂等卸载：重复卸载只记录一次跳过事件，不产生二次释放。 */
  unload(instanceId) {
    const instance = this.#requireInstance(instanceId);
    if (instance.status === 'unloaded') {
      this.#record('plugin-unload-skipped', { instanceId, reason: 'already-unloaded' });
      return false;
    }
    if (instance.status === 'active') {
      this.#cleanupInstance(instance, 'unload');
    }
    instance.status = 'unloaded';
    this.#record('plugin-unloaded', {
      instanceId,
      listenerIds: [...instance.listenerIds],
    });
    return true;
  }

  /** 模拟一次请求经过监听器，触发活跃实例的回调并累计统计。 */
  dispatch(listenerId) {
    const listener = this.listeners.get(listenerId);
    if (!listener) throw new UnknownListenerError(listenerId);
    for (const instanceId of listener.attached) {
      const instance = this.instances.get(instanceId);
      if (!instance || instance.status !== 'active') continue;
      instance.stats.requests += 1;
      for (const key of instance.sharedKeys) {
        const region = this.sharedRegions.get(key);
        if (!region) continue;
        region.data.requests += 1;
        region.lastWrite = {
          instanceId: instance.instanceId,
          moduleId: instance.moduleId,
          version: instance.version,
          tenant: instance.tenant,
          generation: region.generation,
        };
      }
    }
  }

  /** 读取实例持有的共享统计状态，并记录读取事件供分析器判定污染。 */
  readSharedStats(instanceId, key) {
    const instance = this.#requireInstance(instanceId);
    if (!instance.sharedKeys.includes(key)) {
      throw new LifecycleError(`instance "${instanceId}" does not hold shared key "${key}"`);
    }
    const region = this.sharedRegions.get(key);
    if (!region) throw new LifecycleError(`shared memory "${key}" has been released`);
    this.#record('shared-read', {
      instanceId,
      key,
      tenant: instance.tenant,
      moduleId: instance.moduleId,
      version: instance.version,
      generation: region.generation,
      writer: region.lastWrite ? { ...region.lastWrite } : null,
    });
    return { ...region.data };
  }
}

module.exports = {
  ProxyRuntime,
  CrossTenantStateError,
  UnknownListenerError,
  UnknownInstanceError,
  LifecycleError,
};
