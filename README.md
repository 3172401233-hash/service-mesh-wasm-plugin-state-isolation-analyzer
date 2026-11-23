# service-mesh-wasm-plugin-state-isolation-analyzer

分析服务网格中 Wasm 插件生命周期的状态隔离、热更新顺序与失败回收范围。

> **注意：本项目不执行真实 Wasm。** 运行时环境为 Node.js 24，`ProxyRuntime`
> 只模拟代理宿主侧（Envoy 风格）的生命周期语义——监听器挂载、按租户隔离的
> 共享内存、回调注册表与事件日志——用于分析和验证隔离与清理规则，不加载、
> 不实例化、不运行任何 `.wasm` 字节码。

## 模型

输入：模块（`moduleId` + `version` + `tenant`）、实例、监听器、共享内存键、
导入函数、回调、热更新与失败事件。

- **状态隔离**：共享内存按租户归属，不同租户的插件不能共享可变状态；
  跨租户占用会被拒绝并记录违规。
- **热更新顺序**：`drain-listeners` → `revoke-callbacks` →
  `reset-shared-state` → `activate-new`。新版本模块激活前共享统计状态
  必须重置，新模块绝不允许读到旧版本写入的统计。
- **失败回收**：插件异常退出（trap）后，必须撤销其在代理注册表中的全部
  回调、从所有监听器摘除、释放持有的共享内存；部分初始化失败同样要回收
  已注册的部分；卸载幂等，重复卸载不产生二次释放。

## 分析输出

`analyzeRuntime(runtime)` 返回：

- `affectedListeners`：被失败 / 卸载 / 热更新波及的监听器；
- `residualState`：清理后仍残留的回调、监听器挂载、共享内存（应为空）；
- `updateOrder`：热更新步骤的实际顺序及是否符合预期顺序；
- `violations`：`cross-tenant-shared-state`（跨租户共享）与
  `stale-stats-across-versions`（新版本读到旧版本统计）等违规。

## 用法

```js
const { ProxyRuntime, analyzeRuntime } = require('./src');

const runtime = new ProxyRuntime();
runtime.registerListener('listener-a');
const v1 = runtime.loadPlugin({
  moduleId: 'auth-filter',
  version: 'v1',
  tenant: 'tenant-1',
  listenerIds: ['listener-a'],
  sharedMemoryKeys: ['stats'],
  imports: ['proxy_log'],
});
runtime.dispatch('listener-a');
const v2 = runtime.hotUpdate(v1.instanceId, 'v2');

const report = analyzeRuntime(runtime);
console.log(report.affectedListeners, report.residualState, report.updateOrder);
```

## 测试

```sh
node --test
```

覆盖：热更新（顺序、统计重置、旧回调撤销）、共享状态污染（跨租户拒绝、
跨版本脏读判定）、部分初始化回收、重复卸载幂等。
