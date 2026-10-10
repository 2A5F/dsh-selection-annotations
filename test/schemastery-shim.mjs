/**
 * 测试期替身：`@deepseek-ai/schemastery` 的链式构造器。
 *
 * 真正的 schemastery 只在 DSH 宿主进程里可解析（随 dsh 安装分发），本地 `node --test`
 * 拿不到它。测试只关心「Config 声明形态是否合法、配置值如何被消费」，不关心校验器本身，
 * 所以这里给一个任意属性/调用都返回自身的最小替身。
 */
const chain = new Proxy(function schema() {}, {
  get(_target, property) {
    if (property === 'toString' || property === Symbol.toPrimitive) return () => 'schemastery-shim'
    if (property === 'inspect' || property === Symbol.for('nodejs.util.inspect.custom')) return () => 'schemastery-shim'
    return chain
  },
  apply() {
    return chain
  },
  construct() {
    return chain
  },
})

export default chain
