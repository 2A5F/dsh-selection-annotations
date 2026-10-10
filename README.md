# dsh-selection-annotations

DSH Web 滑词批注插件：**选中文字 → 批注 → 随消息以独立 JSON 数据块提交**。

关键约束（本插件的存在理由）：批注**不写进消息正文**。
不使用「把批注块拼进草稿、发送后再从气泡里藏掉」那类做法 —— 本插件让批注成为
消息里一个**真实存在、位置独立**的 content 块，正文与批注在协议层就是两件事。

## 能力

| 能力 | 说明 |
|---|---|
| 选中即批注 | 在任意会话（含更早的会话）的回复/消息，以及工作区文件预览里选中文字 → 浮动「批注」按钮 → 写批注（可留空，仅标记原文） |
| 原文高亮 + 编号角标 | 淡黄色叠加高亮 + 蓝色编号角标，按语义 `data-*` 锚点定位；滚动/换视图后按「字符区间 + 引用上下文」重建 |
| **点角标 = 改这条批注** | 角标可点击，直接打开该条批注的修改弹层（可改批注文字、可删除）；批注列表里也有「编辑」入口 |
| 位置精确到区间 | 每条批注记录 `charStart`/`charEnd`（半开区间，以锚点元素 `textContent` 为口径）；文件来源另记 1 基 `lineStart`/`lineEnd` 与 `path` |
| 触发按钮在发送按钮旁 | 注册进 `conversation.input.right`，只占一个紧凑控件位，**不影响输入框布局** |
| 批注面板悬浮 | 「批注 ×N」点开的面板是挂在 `body` 上的 `position: fixed` 原生 DOM，**完全脱离文档流**，不会把输入框顶上去 |
| 独立块随消息发送 | 批注集合包成一个 `File`（`批注.json`），交给运行时自己的 `createDrafts` + 输入外壳的 `addFiles`（拖拽/粘贴附件走的就是这条链路），等 `status === ready` 才挂上 |
| 模型侧独立消息 | 宿主半边在 `agent/pre-step` 把该附件块从模型可见内容里摘掉，紧随其后追加一条独立 user 消息，正文就是那份 JSON |
| 发送后自动消费 | 附件被消息消费（或用户手动摘掉）后，这批批注自动清空，不会黏到下一条消息 |

## 负载格式

一条独立消息，正文是一份自描述 JSON 数据块：

```json
{
  "kind": "dsh-selection-annotations",
  "version": 1,
  "instruction": "这是用户随上一条消息附加的批注数据块，与用户消息正文是相互独立的两部分……",
  "count": 2,
  "annotations": [
    {
      "index": 1,
      "quote": "设计要点",
      "note": "测试批注",
      "source": {
        "kind": "file",
        "path": "dsh-selection-annotations/client.js",
        "lineStart": 1,
        "lineEnd": 3,
        "charStart": 123,
        "charEnd": 127
      }
    },
    {
      "index": 2,
      "quote": "另一半职责是",
      "note": "",
      "source": {
        "kind": "message",
        "role": "assistant",
        "anchorKey": "assistant-step:12",
        "flowKind": "assistant-step",
        "charStart": 40,
        "charEnd": 46
      }
    }
  ]
}
```

要点：

- **用 JSON 而不是 Markdown**：位置是要被程序化使用的东西（行号、字符区间、锚点键），结构化字段才不会在自然语言里糊掉。
- `charStart`/`charEnd` 是**半开区间** `[charStart, charEnd)`，以该锚点元素正文的 `textContent` 为口径 —— 引文可能重复，字符区间不会。
- 宿主**按内容认领**：读出来的 JSON 必须带 `kind: "dsh-selection-annotations"`；文件名只用于快速预筛，改名也能正常工作。
- 多条批注附件会合并成一份，`index` 重新编号成 `1..N`。

## 数据流

```
选区 ──▶ 批注记录 {原文, 出处, 行号/字符区间, 批注}
                    │
                    ├─ 本地：淡黄高亮 + 编号角标 + 悬浮面板列表（点角标改这一条）
                    │
                    └─ 防抖 450ms ──▶ new File([JSON], '批注.json')
                                            │
                                            ▼
                    conversation.createDrafts(sessionId, [file])  ← 运行时登记草稿附件 + 后台上传
                                            │  等 fileUploads[id].status === "ready"
                                            ▼
                              shell.addFiles([], [draftId])
                                            │
用户正文 + 批注附件 = 一条消息的 content = [ {type:'text'}, {type:'file'} ]
                                            │
                                            ▼
            宿主 agent/pre-step：摘掉 file 块 ──▶ 追加独立 user 消息（正文 = 那份 JSON）
                                            │
                                            ▼
                        模型收到：用户正文（一条） + 批注 JSON（另一条），互不混杂
```

## 为什么这样接

DSH 的 `session.prompt` 请求 schema 是**封闭三元组** `text | image | file`
（`dsh-api-session-controller`），自定义 content 块进不去；而 `dsh-llm-deepseek`
对未知的用户块直接抛 `UNSUPPORTED_CONTENT`。所以「让模型看到自定义块」这条路必须绕开
content 块类型本身 —— 官方可用的 seam 是 `agent/pre-step` waterfall
（`@deepseek-ai/dsh-session-reference` 的跨会话 recall 用的正是它）。

于是本插件用 `file` 块做**客户端 → 宿主 → 模型**的载体：
UI 侧它天然渲染成独立卡片，宿主侧再把它换成一条独立消息。

**踩过的坑（务必不要再走回头路）**：

1. 只调 `inputActions.addAttachments(ids)` 是不够的 —— 它只往输入态里塞 id，运行时私有的
   `draftAttachments` 里并没有对应条目，发送时 `resolveDraftAttachments` 解析不到，结果是
   批注根本进不了消息（或直接抛错）。必须让运行时自己登记草稿附件：
   `conversation.createDrafts(sessionId, [file])` → `shell.addFiles([], ids)`。
2. 上传没就绪就挂载，`sendSession` 会抛「one or more files have not finished uploading」而让
   **整条消息**发送失败。所以要等 `fileUploads[id].status === 'ready'`。
3. 自己摘旧附件时必须屏蔽消费检测，否则会被误判成「消息已发送」而清空批注。
4. **`link:` 安装的插件不能静态 import `@deepseek-ai/*`**：模块解析按插件的**真实路径**（工作区）
   进行，工作区没有 `node_modules`，这些包一律解析不到；静态导入会让宿主半边加载失败
   （`fiberPhase` 停在 `null`），而 UI 上表现为「功能整个消失」。需要宿主包时，要么把插件从 npm
   装进 profile（真实路径在 profile 下就能解析），要么别用那个包。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `maxPayloadBytes` | `524288` | 单个批注附件读取上限（字节）；超过视为无效负载，整条消息原样放行（绝不截半份数据给模型） |

本插件**没有** `export const Config`（因此 Plugins 页面里没有对应的 schema 表单）。原因见下：
它是以 `link:` 装进 profile 的，而 schema 需要 `@deepseek-ai/schemastery` —— 那个导入在 `link:` 场景下
解析不到，会让整个宿主半边加载失败。要在 profile patch 里改这项仍然可以写
`config: { maxPayloadBytes: … }`：`apply(ctx, config)` 照常收到它。

## 安装

由 DSH 的 `plugin_manager` 安装到当前 profile：`action: install_bundle`，`target` 为本目录绝对路径。
本插件以 `link:` 形式装进 profile，改动即时反映到文件。

## 开发期的重载语义（重要）

| 半边 | 改完怎么生效 |
|---|---|
| 客户端 `client.js` | `@deepseek-ai/dsh-client-hmr` 500ms 轮询热换，**刷新页面即生效**，不需重启 |
| 宿主 `lib/index.js`（已成功加载过） | **不会热重载**。disable→enable、`remove_bundle` + `install_bundle` 都换不掉（Node ESM 模块缓存），必须**重启宿主进程** |
| 宿主 `lib/index.js`（**加载失败过**，`fiberPhase` 为 `null`） | 修好后做一次 disable→enable 即可**立即生效** —— 从未启动成功的 fiber 会重新 import |

判断宿主半边到底在不在跑：`plugin_manager list_plugins` 看该条的 `fiberPhase` ——
`active` = 在跑；`null` = 加载失败（此时**客户端半边也会一起消失**，UI 上看就是功能没了）。

想在本地直接复现宿主的模块解析（不重启也能验），在 profile 目录里跑：

```powershell
cd $env:DSH_PROFILE_DIR
node --input-type=module -e "import('dsh-selection-annotations').then(m => console.log('OK', Object.keys(m))).catch(e => console.error('FAIL', e.message))"
```

## 测试

```powershell
npm test    # 等于：node --import ./test/loader.mjs --test test/*.test.mjs
```

- `test/host-pre-step.test.mjs`：宿主半边的摘块 / 追加 JSON 消息 / 按内容认领 / 合并 / 配置分支。
- `test/client-half.test.mjs`：在 Node 里给 `client.js` 造最小 DOM + React + Cordis 环境，
  跑通「批注 → JSON 负载 → 运行时草稿附件 → 挂进输入态 → 发送后被消费清空」整条数据通路、
  锚点重建与字符区间捕获。
- `test/loader.mjs` / `test/schemastery-shim.mjs`：把 `@deepseek-ai/schemastery`（只在宿主里可解析）
  指到本地替身，让本地 `node --test` 也能跑。

它验证的是**逻辑**；真实选区几何、高亮位置仍需在浏览器里看。

## 排障

浏览器控制台：

```js
window.__dshSelectionAnnotations.list()      // 当前批注集合
window.__dshSelectionAnnotations.payload()   // 即将提交的 JSON 数据块（字符串）
window.__dshSelectionAnnotations.drafts()    // 当前挂载的草稿附件 id（空数组 = 没挂上）
window.__dshSelectionAnnotations.receipt()   // 同上，取第一个
window.__dshSelectionAnnotations.session()   // 解析到的当前会话 id
window.__dshSelectionAnnotations.add({...})  // 手工加一条（调试用）
window.__dshSelectionAnnotations.update(id, note)  // 改一条（调试用）
```

## 已知限制（v1）

- 批注的**原文与出处**不能改（只能改批注文字或删掉重加）。
- 代码预览（`data-code-preview`）没有行号属性，行号按 `pre .line` 序号推算。
- 锚点依赖语义 `data-*`；DSH 若更换这些属性名，需要同步更新 `client.js` 的锚点层。
- 字符区间以锚点元素的 `textContent` 为口径，因此 DSH 若改变消息行的渲染范围，旧批注的区间会随之失效（此时回退到「引文 + 上下文」定位）。
