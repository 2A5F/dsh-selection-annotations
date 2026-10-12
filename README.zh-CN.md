# dsh-selection-annotations

[English](README.md) · **简体中文**

> 在 DSH Web 界面里任意位置选中文字 —— 助手回复、工作区文件、更早会话里的消息 —— 写一句批注，
> 然后随下一条消息把整批批注作为**独立的、机器可读的 JSON 块**发出去。你的消息正文全程不被改动。

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件。零依赖，零核心改动。

## 为什么不直接把批注拼进提示词？

聊天界面里做「选中 → 批注」最直觉的做法是：提交时把批注块拼进草稿，发送后再在气泡里把它藏掉。
看起来对，但模型收到的仍然是**一个**文本块 —— 你的批注被粘进了正文；而你的气泡是被 DOM 脚本事后改写的。

本插件把批注放在消息上，作为**一个真实的 content 块**：

| | 拼正文 + 事后隐藏 | **本插件** |
|---|---|---|
| 消息 `content` | `[{type:'text'}]` | `[{type:'text'}, {type:'file'}]` |
| 模型收到 | 正文里夹着批注 | 你的正文，**外加一条独立的 JSON 消息** |
| 你自己的气泡 | 发送后被改写 | 原样不动 |
| 位置信息 | 自由文本 | `lineStart/lineEnd`、`charStart/charEnd`、`anchorKey` |

## 能力

| 能力 | 说明 |
|---|---|
| 选中即批注 | 助手回复、用户消息、工作区文件预览。批注可以留空 —— 那就只是标记原文。 |
| 高亮 + 编号角标 | 淡黄色叠加 + 蓝色编号角标，按语义 `data-*` 锚定；滚动或重渲染后按字符区间 + 引文上下文重建。 |
| **点角标即改这条** | 点编号角标直接打开**该条**批注进行修改（改批注文字或删除）。列表面板里有同样的入口。 |
| 位置精确到区间 | 每条批注记半开区间 `charStart`/`charEnd`；文件来源另记工作区相对 `path` 与 1 基 `lineStart`/`lineEnd`。**凡是能读到原文就按原文坐标算**（Markdown 预览的行号也由此得来），读不到才退回渲染坐标；由 `source.textOrigin` 标明。 |
| 触发按钮在发送按钮旁 | 注册进 `conversation.input.right`，只占一个紧凑控件位，绝不打乱输入框布局。 |
| 悬浮面板 | 「批注 ×N」面板是挂在 `body` 上的 `position: fixed` 原生 DOM —— 完全脱离文档流，永远不会把输入框顶走。 |
| 以独立块随消息发送 | 批注集合包成一个 `File`（`批注.json`），交给运行时自己的 `createDrafts` + 输入外壳的 `addFiles` —— 拖拽/粘贴附件走的正是同一条链路；且只在 `status === ready` 之后才挂上。 |
| 模型侧独立消息 | 宿主半边在 `agent/pre-step` 把该文件块从模型可见内容里摘掉，紧随其后追加一条独立的 user 消息，正文就是那份 JSON。 |
| 发送后自动消费 | 附件被消息消费（或手动摘掉）后，这批批注自动清空，不会黏到下一条消息。 |

## 负载格式

模型会多收到一条消息，正文是一份自描述的 JSON 块：

```json
{
  "kind": "dsh-selection-annotations",
  "version": 1,
  "instruction": "这是用户发来的批注数据块。它与用户消息正文相互独立：用户可能同时发了正文，也可能只发了这个批注块（此时它就是本条消息的全部内容）。annotations[].quote 是用户选中的原文；annotations[].source 给出它的位置……",
  "count": 2,
  "annotations": [
    {
      "index": 1,
      "quote": "设计要点",
      "note": "测试批注",
      "source": {
        "kind": "file",
        "path": "dsh-selection-annotations/client.js",
        "lineStart": 4,
        "lineEnd": 4,
        "charStart": 126,
        "charEnd": 130,
        "textOrigin": "source"
      }
    },
    {
      "index": 2,
      "quote": "另一半职责是",
      "note": "",
      "source": {
        "kind": "message",
        "role": "assistant",
        "anchorKey": "14:assistant-step6:12",
        "flowKind": "assistant-step",
        "charStart": 40,
        "charEnd": 46,
        "textOrigin": "rendered"
      }
    }
  ]
}
```

契约要点：

- **用 JSON 而不是散文**：位置是要被程序消费的东西 —— 行号、字符区间、锚点键。结构化字段不会在自然语言里糊掉。
- `charStart`/`charEnd` 是**半开区间** `[charStart, charEnd)`。它索引的是哪份文本由 `source.textOrigin` 标明：
  `"source"` = **文件原文**的字符偏移（可直接拿去比对文件）；`"rendered"` = 锚点元素渲染后正文的偏移。
  能命中原文的前提是插件读到了该文件并在里面找到引文，所以文件读不到、或引文跨了 Markdown 标记时会退回 `"rendered"`。
  引文可能重复，字符区间不会。
- `lineStart`/`lineEnd` 是 **1 基**行号，且只对工作区文件来源出现。
- 宿主**按内容认领**：解析出的 JSON 必须带 `kind: "dsh-selection-annotations"`。文件名只作便宜的预筛，改名照样工作。
- 多份批注附件会合并成一份，`index` 重新编号成 `1..N`。

## 安装

```sh
dsh plugin --profile <profile> add @u2a5f/dsh-selection-annotations
```

或者用 DSH 的插件管理器直接装目录：

```
plugin_manager  action: install_bundle  target: <本目录绝对路径>
```

以 `link:` 方式从源码目录安装，是本插件自身的开发方式 —— 见[开发](#开发)。

## 工作原理

```
选区 ──▶ 批注 { 原文, 出处, 批注文字 }
                    │
                    ├─ 本地：高亮 + 编号角标 + 悬浮面板
                    │
                    └─ 防抖 450ms ──▶ new File([JSON], '批注.json')
                                                │
                                                ▼
                        conversation.createDrafts(sessionId, [file])
                                                │  等 fileUploads[id].status === "ready"
                                                ▼
                                  shell.addFiles([], [draftId])
                                                │
   用户正文 + 批注附件 = 一条消息，content = [ {type:'text'}, {type:'file'} ]
                                                │
                                                ▼
        宿主 `agent/pre-step`：摘掉文件块 ──▶ 追加一条独立 user 消息（正文 = 那份 JSON）
                                                │
                                                ▼
              模型收到：你的正文（一条） + 批注 JSON（另一条），互不混杂
```

### 为什么是这个 seam

DSH 的 `session.prompt` 请求 schema 是 **`text | image | file` 的封闭联合**
（`dsh-api-session-controller`），插件无法引入自定义 content 块；而 `dsh-llm-deepseek`
遇到未知的用户块直接抛 `UNSUPPORTED_CONTENT`。官方可用的、能让插件内容进入模型视野的
seam 是 `agent/pre-step` waterfall —— `@deepseek-ai/dsh-session-reference` 的跨会话 recall
用的正是它。

于是本插件用 `file` 块作载体：UI 侧它天然渲染成独立卡片，宿主侧再把它换成一条独立消息。

### 值得记住的几个坑

1. **只调 `addAttachments(ids)` 不够。** 它只往输入态追加 id，运行时私有的 `draftAttachments`
   里没有对应条目，发送时 `resolveDraftAttachments` 会失败，批注根本到不了消息里。
   要让运行时自己登记草稿：`conversation.createDrafts(sessionId, [file])` → `shell.addFiles([], ids)`。
2. **上传没就绪就挂载，会把整条发送弄失败。** `sendSession` 会抛
   「one or more files have not finished uploading」。必须等 `fileUploads[id].status === 'ready'`。
3. **摘自己的附件时必须屏蔽消费检测**，否则这次移除会被误判成「消息已发送」，批注被清空。
4. **不要凭通知判断「附件已被消费」，也不要用运行时的私有草稿表。** 提交路径会先把附件 id 从输入态移走、
   之后才真正退休它们；只发附件（无正文）时，运行时的草稿条目会一直留到 admission 结算，于是
   `resolveDraftAttachments` 始终返回它 —— 用那个判据就永远等不到「已消费」。反过来，结果不算成功时
   composer 会调 `restoreAttachments` 把 id 还回来。可行的判据是：读输入外壳的**实时** `attachmentIds`
   字段（不是已发布快照 —— 没人 publish 时它会滞后），隔一小段时间确认它仍不持有你的 id，再清空。
   这次 restore 还可能落在回合结束很久之后，所以要留一段守卫时间：id 一旦回来就把它摘掉 ——
   批注其实已经发出，留一张背后什么都没有的卡片只会误导人。
5. **渲染坐标不是原文坐标。** 多行选区光换行符就差出去了；Markdown 渲染还会丢掉 `#`、`**` 与链接 URL。
   要让偏移能直接用在文件上，就得读原文再定位（`ctx.remote.workspaceFiles.read`）—— `textOrigin: "source"`
   标的就是这个。注意：**要拿到这个 API，客户端模块的 `inject` 里必须写 `'remote'`** —— 受限客户端上下文
   只把已声明的服务挂成属性，不声明就是 `ctx.remote` 不存在，于是定位会安静退回渲染坐标、不报任何错。
6. **客户端沙箱只有 `console.log` 与 `console.error`，没有 `console.warn`。** 调用一个不存在的方法会抛错，
   而抛在 `catch` 里就把「已处理的失败」变成「未处理的拒绝」，并静默跳过它后面的一切。所以日志调用一律要包成
   不会外抛的形式；另外，在没有控制台的界面上，失败路径**不能只留日志** —— 证据必须跟着数据一起走。
7. **`link:` 安装的插件不能静态 import `@deepseek-ai/*`。** 模块解析按插件的真实路径（你的源码目录）
   进行，那里没有 `node_modules`，这些 specifier 解析不到；静态导入会让整个宿主半边加载失败
   （`fiberPhase` 停在 `null`），UI 上功能静默消失。所以本插件什么都不 import。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `maxPayloadBytes` | `524288` | 单个批注附件的读取上限。超过则视为无效负载，消息原样放行（绝不截半份数据给模型）。 |

插件刻意**不**导出 `Config` schema —— 那需要 import `@deepseek-ai/schemastery`，会打断
`link:` 安装（见上面第 4 条）。仍然可以从 profile patch 里设置这项，`apply(ctx, config)` 照常收到：

```yaml
- id: selection-annotations
  config:
    maxPayloadBytes: 1048576
```

## 排障

浏览器控制台：

```js
window.__dshSelectionAnnotations.list()      // 当前批注集合
window.__dshSelectionAnnotations.payload()   // 即将提交的 JSON 块（字符串）
window.__dshSelectionAnnotations.drafts()    // 已挂载的草稿附件 id —— [] 表示什么都没挂上
window.__dshSelectionAnnotations.receipt()   // 同上，只取第一个
window.__dshSelectionAnnotations.session()   // 解析到的当前会话 id
window.__dshSelectionAnnotations.add({...})  // 手工加一条（调试用）
window.__dshSelectionAnnotations.update(id, note)  // 手工改一条（调试用）
```

`drafts()` 是硬指标：返回空数组就意味着批注**不会**随下一条消息发出，无论界面看起来如何。

插件的告警都以 `[selection-annotations]` 开头。

## 已知限制

- 批注的**原文与出处不能改** —— 只能改批注文字，或删掉重批。
- **引文跨了行内 Markdown 标记时可能没有行号。** Markdown 的行号来自「读原文件 + 在原文里找引文」；
  引文若跨过 `**粗体**`、链接或行内代码，定位就会落空，那条批注只保留渲染坐标。
- 锚定依赖语义 `data-*`（`data-chat-anchor-key`、`data-chat-flow-kind`、`data-textpreview-url`、
  `data-code-preview`）。DSH 若改名，需要同步更新 `client.js` 的锚点层。
- 字符区间以锚点元素的 `textContent` 为口径。DSH 若改变某个消息行的渲染范围，旧区间会失效，
  此时退回「引文 + 上下文」定位。
- 对话消息只带字符区间、不带行号：Markdown 渲染后的视觉行号不是稳定坐标。
- 负载里的 `instruction` 与插件自己的 UI 文案目前是**中文硬编码**，还没有接到 DSH 的 locale 服务上。

## 开发

```sh
npm test
```

测试在纯 Node 里跑 —— 不需要浏览器，也不需要装 DSH：

- `test/host-pre-step.test.mjs` —— 宿主半边：摘块、追加 JSON 消息、按内容认领、合并、配置分支。
- `test/client-half.test.mjs` —— 给 `client.js` 造最小 DOM + React + Cordis 环境，跑通整条数据通路
  （批注 → JSON 负载 → 运行时草稿附件 → 输入态 → 发送后清空），以及锚点重建与字符区间捕获。
- `test/loader.mjs` / `test/schemastery-shim.mjs` —— 把 `@deepseek-ai/schemastery` 指到本地替身，
  好让测试能在宿主之外运行。目前是惰性的（插件不 import 任何东西），保留是为了将来若重新引入
  宿主侧 schema，本地测试不会因此挂掉。

开发期的重载行为：

| 半边 | 改动如何生效 |
|---|---|
| 客户端 `client.js` | 由 `@deepseek-ai/dsh-client-hmr` 热换（约 500ms 轮询）。**刷新页面**即可。 |
| 宿主 `lib/index.js`，已经成功加载过一次 | **不会热重载。** disable→enable 不行，`remove_bundle` + `install_bundle` 也不行（Node ESM 模块缓存）。**必须重启宿主进程。** |
| 宿主 `lib/index.js`，之前加载失败过（`fiberPhase: null`） | 做一次 disable→enable 就会重新 import —— **立即生效** |

**不要**用 `remove_bundle` 给 `link:` 安装的插件强制重载：实测它会移除 profile 里的依赖与
`bundles` 条目 —— 插件变成未安装、两个半边都不注册 —— 而它自己仍报 `application: failed` /
`not-removable`。要恢复就用 `install_bundle` 指向目录。想重新 materialize 客户端半边，
重跑一次 `install_bundle` 就够了。

想确认插件到底在不在跑，看 `plugin_manager list_plugins` 里它的 `fiberPhase`：
`active` = 在跑，`null` = 模块加载失败（此时客户端半边也会一起消失）。

想在本地复现宿主的模块解析，在 profile 目录里跑：

```sh
cd "$DSH_PROFILE_DIR"
node --input-type=module -e "import('@u2a5f/dsh-selection-annotations').then(m => console.log('OK', Object.keys(m))).catch(e => console.error('FAIL', e.message))"
```

## 许可证

MIT
