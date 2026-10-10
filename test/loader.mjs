/**
 * 测试期模块解析钩子：把 `@deepseek-ai/schemastery` 指到本地替身。
 *
 * 插件本身 `import z from '@deepseek-ai/schemastery'` 是对的（DSH 宿主能解析它，
 * 其它随包插件也这么写）；这里只是让本地 `node --test` 也能跑起来。
 * 用法见 package.json 的 test 脚本：`node --import ./test/loader.mjs --test ...`
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: new URL('./schemastery-shim.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
