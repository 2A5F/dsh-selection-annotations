/**
 * 客户端半边测试台：在 Node 里给 client.js 造一个够用的最小 DOM / React / Cordis 环境，
 * 把「批注集合 → 批注报告 → 运行时草稿附件 → 挂进输入态 → 发送后被消费清空」整条数据通路跑通。
 *
 * 它验证的是**逻辑**，不是渲染：真实的选区几何、高亮位置需要在浏览器里看。
 * 运行：node --import ./test/loader.mjs --test test/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 浏览器里点「移除」用的是 MouseEvent；测试台只需要它被构造出来（见 removeQuoteChip）。 */
if (typeof globalThis.MouseEvent !== 'function') {
  globalThis.MouseEvent = class MouseEvent {
    constructor(type, init = {}) {
      this.type = type
      this.bubbles = init.bubbles === true
      this.cancelable = init.cancelable === true
    }
  }
}

/** 测试用的「源文件」：第 3 行有引文，且引文外面包着 Markdown 强调标记。 */
const SOURCE_TEXT = [
  '# 标题',
  '',
  '聊天界面里做「选中 → 批注」最直觉的**做法是：提交**时把批注块拼进草稿。',
  '',
].join('\n')

/* ------------------------------------------------------------------ 最小 DOM */

const node = (text) => ({ nodeType: 3, nodeValue: text, parentElement: null, isConnected: true })

function element(tag, attrs = {}, children = []) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: [],
    parentElement: null,
    isConnected: true,
    style: {},
    dataset: {},
    attributes: new Map(Object.entries(attrs)),
    className: '',
    value: '',
    type: '',
    offsetWidth: 120,
    offsetHeight: 30,
    appendChild(child) {
      el.childNodes.push(child)
      child.parentElement = el
      return child
    },
    append(...items) {
      for (const item of items) el.appendChild(item)
    },
    remove() {
      const parent = el.parentElement
      if (parent !== null) parent.childNodes = parent.childNodes.filter((candidate) => candidate !== el)
    },
    setAttribute(key, value) {
      el.attributes.set(key, String(value))
    },
    getAttribute(key) {
      return el.attributes.has(key) ? el.attributes.get(key) : null
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event) {
      el.dispatched = [...(el.dispatched ?? []), event]
      return true
    },
    focus() {},
    contains(other) {
      if (other === el) return true
      return flatten(el).includes(other)
    },
    closest(selector) {
      let current = el
      while (current !== null && current !== undefined) {
        if (matches(current, selector)) return current
        current = current.parentElement
      }
      return null
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] ?? null
    },
    querySelectorAll(selector) {
      const found = []
      const visit = (node) => {
        for (const child of node.childNodes ?? []) {
          if (child.nodeType !== 1) continue
          if (matches(child, selector)) found.push(child)
          visit(child)
        }
      }
      visit(el)
      return found
    },
  }
  for (const child of children) el.appendChild(child)
  // textContent 必须是真的读写器：插件用读它做锚点匹配，用写它清空/填入节点。
  Object.defineProperty(el, 'textContent', {
    get: () => textOf(el),
    set: (value) => {
      el.childNodes = []
      const text = String(value)
      if (text !== '') el.appendChild({ nodeType: 3, nodeValue: text, parentElement: el, isConnected: true })
    },
  })
  return el
}

/** 只支持本插件实际用到的那几个选择器形状。 */
function matches(el, selector) {
  if (el === null || el.nodeType !== 1) return false
  for (const part of selector.split(',')) {
    const candidate = part.trim()
    const attrMatch = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(candidate)
    if (attrMatch !== null) {
      const value = el.getAttribute(attrMatch[1])
      if (value === null) continue
      if (attrMatch[2] === undefined || value === attrMatch[2]) return true
      continue
    }
    if (/^\.[A-Za-z0-9_-]+$/.test(candidate)) {
      if (String(el.className).split(/\s+/).includes(candidate.slice(1))) return true
      continue
    }
    if (/^(input|textarea)$/i.test(candidate) && el.tagName === candidate.toUpperCase()) return true
    if (/^[a-z]+$/i.test(candidate) && el.tagName === candidate.toUpperCase()) return true
  }
  return false
}

const flatten = (root, out = []) => {
  if (root.nodeType === 3) {
    out.push(root)
    return out
  }
  for (const child of root.childNodes ?? []) flatten(child, out)
  return out
}
const textOf = (root) => flatten(root).map((n) => n.nodeValue ?? '').join('')

/** 把 (node, offset) 折算成根内的一维字符位置。 */
function positionOf(root, target, offset) {
  if (target === null) return -1
  if (target.nodeType === 1) {
    const inner = flatten(target)
    return inner.length === 0 ? 0 : positionOf(root, inner[0], 0)
  }
  let position = 0
  for (const candidate of flatten(root)) {
    if (candidate === target) return position + offset
    position += (candidate.nodeValue ?? '').length
  }
  return -1
}

/** 轮询定时器不能撑住测试进程：unref 后仍会触发，但不阻止 node --test 退出。 */
const nodeSetInterval = setInterval

function makeEnvironment() {
  let rangeRoot = null

  class FakeRange {
    constructor() {
      this.startContainer = null
      this.endContainer = null
      this.startOffset = 0
      this.endOffset = 0
    }
    setStart(target, offset) {
      this.startContainer = target
      this.startOffset = offset
      return this
    }
    setEnd(target, offset) {
      this.endContainer = target
      this.endOffset = offset
      return this
    }
    cloneRange() {
      const copy = new FakeRange()
      return copy.setStart(this.startContainer, this.startOffset).setEnd(this.endContainer, this.endOffset)
    }
    toString() {
      if (rangeRoot === null) return ''
      const from = positionOf(rangeRoot, this.startContainer, this.startOffset)
      const to = positionOf(rangeRoot, this.endContainer, this.endOffset)
      if (from < 0 || to < 0 || to < from) return ''
      return textOf(rangeRoot).slice(from, to)
    }
    getClientRects() {
      return []
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 }
    }
  }

  const head = element('head')
  const body = element('body')
  const listeners = new Map()
  // 引用块 [data-composer-quote] 由用例挂进来：真实 DOM 里它们是 Lexical 装饰节点。
  let composerChips = []

  const document = {
    head,
    body,
    createElement: (tag) => element(tag),
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    createRange: () => new FakeRange(),
    createTreeWalker: (root) => {
      const nodes = flatten(root).filter((candidate) => candidate.nodeType === 3)
      let index = -1
      return {
        nextNode() {
          index += 1
          return index < nodes.length ? nodes[index] : null
        },
      }
    },
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === '[data-composer-quote]' ? composerChips : []),
  }

  const loaded = []
  const window = {
    __ModuleLoader__: { load: (mod) => loaded.push(mod) },
    setTimeout,
    clearTimeout,
    setInterval: (...args) => {
      const timer = nodeSetInterval(...args)
      if (typeof timer?.unref === 'function') timer.unref()
      return timer
    },
    clearInterval,
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1200,
    innerHeight: 800,
    getSelection: () => ({ rangeCount: 0, isCollapsed: true, getRangeAt: () => null, removeAllRanges() {} }),
  }

  const require = (name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        Fragment: 'Fragment',
      }
    }
    throw new Error(`unexpected require: ${name}`)
  }

  return {
    document,
    window,
    require,
    loaded,
    listeners,
    element,
    node,
    setRangeRoot(root) {
      rangeRoot = root
    },
    setComposerChips(chips) {
      composerChips = [...chips]
    },
  }
}

/** 载入 client.js（它只调用 window.__ModuleLoader__.load，不会立刻执行副作用）。 */
function loadBundle(env) {
  const factory = new Function(
    'window',
    'document',
    'MutationObserver',
    'TextEncoder',
    'btoa',
    'console',
    'AbortController',
    'NodeFilter',
    SOURCE,
  )
  factory(
    env.window,
    env.document,
    class {
      observe() {}
      disconnect() {}
    },
    TextEncoder,
    btoa,
    { log() {}, warn() {}, error() {} },
    AbortController,
    { SHOW_TEXT: 4 },
  )
  assert.equal(env.loaded.length, 1, 'bundle 必须注册恰好一个模块')
  assert.equal(env.loaded[0].id, '@u2a5f/dsh-selection-annotations', 'bundle id 必须与包名逐字一致')
  return env.loaded[0].factory(env.require)
}

/** 极简 snapshot store，形状与 dsh-client-store 的 createSnapshotStore 一致。 */
function createStore(initial) {
  let value = initial
  const subscribers = new Set()
  return {
    getSnapshot: () => value,
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    set(next) {
      value = next
      for (const fn of [...subscribers]) fn()
    },
  }
}

/**
 * 组装最小 ctx + 可观测的 conversation 运行时。
 *
 * 关键：`createDrafts` / `addFiles` / `releaseDraftAttachment` / `fileUploads` 就是
 * dsh-client-ui-conversation 官方附件链路的形状（拖拽/粘贴附件走的那条）。
 */
function makeHarness(options = {}) {
  const env = makeEnvironment()
  const mod = loadBundle(env)

  const uploads = []
  const sourceReads = []
  const released = []
  const registrations = []
  const draftAttachments = new Map()
  let draftSeq = 0

  const fileUploads = createStore({})
  // 运行时外壳的「实时字段」：插件据此判断附件是否还在。
  let liveIds = []
  // 「已发布快照」：只有 publish() 之后才与实时字段一致（真实运行时也会滞后）。
  let inputSnapshot = { draft: '', attachmentIds: [] }
  const inputSubscribers = new Set()
  const publish = () => {
    for (const fn of [...inputSubscribers]) fn()
  }
  const syncSnapshot = () => {
    inputSnapshot = { ...inputSnapshot, attachmentIds: liveIds }
  }

  // 输入框里的引用投影（真实运行时由 Lexical 文档算出来；这里只要 text 序列就够）。
  let quoteTexts = Array.isArray(options.quotes) ? [...options.quotes] : []

  const shell = {
    get attachmentIds() {
      return liveIds
    },
    get projection() {
      return { quotes: quoteTexts.map((text) => ({ text })) }
    },
    state: {
      getSnapshot: () => inputSnapshot,
      subscribe(fn) {
        inputSubscribers.add(fn)
        return () => inputSubscribers.delete(fn)
      },
    },
    addFiles(references, ids) {
      liveIds = [...liveIds, ...ids]
      syncSnapshot()
      publish()
      return true
    },
    removeAttachment(id) {
      const next = liveIds.filter((x) => x !== id)
      if (next.length === liveIds.length) return false
      liveIds = next
      syncSnapshot()
      publish()
      return true
    },
  }

  const conversation = {
    input: { for: () => (options.noScope === true ? undefined : shell) },
    fileUploads,
    createDrafts(sessionId, files) {
      return files.map((file) => {
        draftSeq += 1
        const id = `d${draftSeq}`
        draftAttachments.set(id, { kind: 'file', id, file })
        uploads.push({ sessionId, file })
        fileUploads.set({ ...fileUploads.getSnapshot(), [id]: { status: 'uploading' } })
        setTimeout(() => {
          if (options.uploadFails === true) {
            fileUploads.set({ ...fileUploads.getSnapshot(), [id]: { status: 'error', message: '上传失败' } })
            return
          }
          fileUploads.set({
            ...fileUploads.getSnapshot(),
            [id]: { status: 'ready', receiptId: `r-${id}`, file: { attachmentId: `a-${id}`, name: file.name, bytes: file.size } },
          })
        }, options.uploadDelayMs ?? 0)
        return { kind: 'file', id }
      })
    },
    /** 运行时真正持有的草稿表 —— 拉取式消费检测读的就是它。 */
    resolveDraftAttachments(ids) {
      return ids.filter((id) => draftAttachments.has(id)).map((id) => draftAttachments.get(id))
    },
    releaseDraftAttachment(id) {
      released.push(id)
      draftAttachments.delete(id)
      const next = { ...fileUploads.getSnapshot() }
      delete next[id]
      fileUploads.set(next)
    },
  }

  if (options.noRuntime === true) delete conversation.createDrafts

  const releaseAllDrafts = () => {
    for (const id of [...draftAttachments.keys()]) conversation.releaseDraftAttachment(id)
  }

  /** 正常发送：输入态交出附件，运行时也退休它们。 */
  const send = () => {
    liveIds = []
    syncSnapshot()
    publish()
    releaseAllDrafts()
  }

  /**
   * 只发附件（无正文）：输入态交出附件，但运行时的草稿表**仍持有**条目
   * 直到 admission 结算 —— 这是实测到的真实行为。
   */
  const sendAttachmentOnly = () => {
    liveIds = []
    syncSnapshot()
    publish()
  }

  /** 实时字段变了，但一次通知都没发布（已发布快照滞后）。 */
  const sendWithoutPublish = () => {
    liveIds = []
  }

  /** 模拟「上一轮遗留」：输入态里挂着一个插件不认识的 批注.json。 */
  const plantOrphan = (id, name = '批注.json') => {
    draftAttachments.set(id, { kind: 'file', id, file: { name } })
    liveIds = [...liveIds, id]
    syncSnapshot()
    publish()
  }

  /** 模拟运行时的 settleDetachedFailure：把已发出的附件 restore 回输入态。 */
  const restoreStray = () => {
    liveIds = [...draftAttachments.keys(), ...liveIds]
    syncSnapshot()
    publish()
  }

  /** 模拟提交先移走附件、随后失败 restore 回来（运行时并未释放它们）。 */
  const sendThenRestore = async (delayMs = 100) => {
    const ids = [...liveIds]
    liveIds = []
    syncSnapshot()
    publish()
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    liveIds = ids
    syncSnapshot()
    publish()
  }

  const ctx = {
    get(name) {
      if (name === 'uiSession' && options.noSession !== true) {
        return { adapter: { current: { getSnapshot: () => ({ key: options.sessionId ?? 's1' }) } } }
      }
      if (name === 'remote') {
        if (options.remoteThrows === true) throw new Error('remote 不可用')
        return {
          workspaceFiles: {
            async read(sessionId, path, range) {
              sourceReads.push({ sessionId, path, range })
              if (options.sourceUnavailable === true) throw new Error('读不到源文件')
              const text = options.sourceText ?? SOURCE_TEXT
              return { offset: 0, text, lines: text.split('\n').length, eof: true, absolutePath: path, version: 'v1' }
            },
          },
        }
      }
      return undefined
    },
    effect(callback) {
      callback()
      return () => {}
    },
    on() {
      return () => {}
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(opts, Component) {
        registrations.push({ opts, Component })
        return () => {}
      },
    },
    sessions: {
      scope: () => (options.noScope === true ? undefined : {}),
      list: { getSnapshot: () => ({ current: options.sessionId ?? 's1' }) },
    },
    conversation,
  }

  mod.apply(ctx)

  return {
    env,
    mod,
    ctx,
    uploads,
    sourceReads,
    released,
    registrations,
    shell,
    conversation,
    fileUploads,
    inputState: () => inputSnapshot,
    send,
    sendAttachmentOnly,
    sendWithoutPublish,
    restoreStray,
    plantOrphan,
    sendThenRestore,
    setQuotes(texts) {
      quoteTexts = [...texts]
      syncSnapshot()
      publish()
    },
    /** 挂上「输入框里那条引用」的宿主元素（删除引用靠它里面的官方「移除」按钮）。 */
    setComposerChips(chips) {
      env.setComposerChips(chips)
    },
    debug: env.window.__dshSelectionAnnotations,
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => wait(700)
const payloadTextOf = (upload) => upload.file.text()
const payloadOf = async (upload) => JSON.parse(await payloadTextOf(upload))

/* ------------------------------------------------------------------ 用例 */

test('apply 之后：悬挂 UI 建成、批注按钮注册进发送按钮旁的槽位', () => {
  const harness = makeHarness()
  assert.equal(harness.registrations.length, 1)
  assert.equal(harness.registrations[0].opts.name, 'conversation.input.right', '必须在发送按钮旁的紧凑控件槽位')
  assert.equal(harness.registrations[0].opts.id, 'selection-annotations')
  assert.equal(typeof harness.registrations[0].Component, 'function')
  assert.ok(harness.mod.inject.includes('remote'), '声明 remote 才能拿到 ctx.remote 读工作区原文')
  assert.equal(harness.env.document.body.childNodes.length, 4, '覆盖层 / 工具条 / 批注弹层 / 悬浮面板都要挂上')

  const ui = harness.env.document.head.childNodes[0]
  assert.equal(ui.tagName, 'STYLE')
  assert.ok(ui.textContent.includes('--dsw-alias-brand-primary'), '样式必须使用主题 token')
  assert.ok(ui.textContent.includes('rgb(255 208 66'), '高亮必须是淡黄色叠加')
})

test('批注负载是自描述的 JSON 数据块，位置用行号 + 字符区间表达', () => {
  const harness = makeHarness()
  const { buildPayload } = harness.debug._internals

  const payload = JSON.parse(
    buildPayload([
      {
        number: 1,
        quote: '这里为什么用 `Arc`？',
        note: '觉得可以省掉',
        source: { kind: 'message', role: 'assistant', anchorKey: 'k1', flowKind: 'assistant-step', charStart: 40, charEnd: 52 },
      },
      {
        number: 2,
        quote: 'let x = 1;',
        note: '',
        source: { kind: 'file', path: 'src/a.ts', lineStart: 12, lineEnd: 18, charStart: 100, charEnd: 110 },
      },
    ]),
  )

  assert.equal(payload.kind, 'dsh-selection-annotations', 'kind 是宿主认领的依据')
  assert.equal(payload.version, 1)
  assert.equal(payload.count, 2)
  assert.equal(typeof payload.instruction, 'string', '数据块要自描述')
  assert.equal(payload.annotations.length, 2)

  const [first, second] = payload.annotations
  assert.equal(first.index, 1)
  assert.equal(first.quote, '这里为什么用 `Arc`？')
  assert.equal(first.note, '觉得可以省掉')
  assert.deepEqual(first.source, {
    kind: 'message',
    role: 'assistant',
    anchorKey: 'k1',
    flowKind: 'assistant-step',
    charStart: 40,
    charEnd: 52,
    textOrigin: 'rendered',
  })

  assert.equal(second.index, 2)
  assert.deepEqual(second.source, { kind: 'file', path: 'src/a.ts', lineStart: 12, lineEnd: 18, charStart: 100, charEnd: 110, textOrigin: 'rendered' })
})

test('位置字段缺省时不会往 JSON 里塞 null 噪声', () => {
  const harness = makeHarness()
  const { payloadSource } = harness.debug._internals
  assert.deepEqual(payloadSource({ kind: 'file', path: 'a.ts' }), { kind: 'file', path: 'a.ts', textOrigin: 'rendered' })
  assert.deepEqual(payloadSource({ kind: 'message', flowKind: 'user', charStart: 0, charEnd: 3 }), {
    kind: 'message',
    role: 'user',
    flowKind: 'user',
    charStart: 0,
    charEnd: 3,
    textOrigin: 'rendered',
  })
  assert.deepEqual(payloadSource(undefined), { kind: 'dom' })
})

test('负载按引用计数：4 条引用 3 个批注，index 就是界面编号', () => {
  const quotes = ['甲段原文', '乙段原文', '丙段原文', '丁段原文']
  const harness = makeHarness({ quotes })
  for (const text of ['甲段原文', '乙段原文', '丁段原文']) {
    harness.debug.add({ quote: text, note: '测试', source: { kind: 'quote', text, from: 'message', anchorKey: 'k1' } })
  }

  const payload = JSON.parse(harness.debug.payload())
  assert.equal(payload.count, 4, '负载条数必须与输入框里的引用条数一致')
  assert.equal(payload.described, 3, '有描述的条数单独给出')
  assert.deepEqual(payload.annotations.map((item) => item.index), [1, 2, 3, 4], 'index 是用户在角标上看到的编号')
  assert.deepEqual(payload.annotations.map((item) => item.note), ['测试', '测试', '', '测试'], '只引用没描述的条目 note 为空')
  assert.equal(payload.annotations[2].quote, '丙段原文', '没有批注的那条也要留在负载里，编号才不会错位')
  assert.equal(payload.annotations[3].source.kind, 'quote')
})

test('批注集合 → 运行时草稿附件 → 挂进输入态（官方 createDrafts/addFiles 链路）', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: '被引用的原文', note: '这条有问题', source: { kind: 'message', anchorKey: 'k1', flowKind: 'assistant-step' } })

  await settle()

  assert.equal(harness.uploads.length, 1, '应当只登记一次草稿附件')
  assert.equal(harness.uploads[0].sessionId, 's1')
  assert.equal(harness.uploads[0].file.name, '批注.json', '负载以 JSON 文件形式随消息提交')
  const payload = await payloadOf(harness.uploads[0])
  assert.equal(payload.annotations[0].quote, '被引用的原文')
  assert.equal(payload.annotations[0].note, '这条有问题')

  const drafts = harness.debug.drafts()
  assert.equal(drafts.length, 1, '必须让运行时登记草稿附件，而不是只塞 id')
  assert.deepEqual(harness.inputState().attachmentIds, drafts, '附件必须挂进输入态')
})

test('不在上传就绪前挂载：否则 sendSession 会整条消息抛错', async () => {
  const harness = makeHarness({ uploadDelayMs: 150 })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })

  // 防抖 450ms 之后才开始登记；上传还要 150ms 才 ready。
  await wait(520)
  assert.equal(harness.uploads.length, 1, '草稿附件应当已登记')
  assert.equal(harness.debug.drafts().length, 0, '还没 ready 就不该挂进输入态')

  await wait(400)
  assert.equal(harness.debug.drafts().length, 1, 'ready 之后才挂上')
})

test('上传失败时不挂载，也不留下半截状态', async () => {
  const harness = makeHarness({ uploadFails: true })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })

  await settle()

  assert.equal(harness.debug.drafts().length, 0)
  assert.deepEqual(harness.inputState().attachmentIds, [])
  assert.deepEqual(harness.released, ['d1'], '失败的草稿附件必须释放掉')
  assert.equal(harness.debug.list().length, 1, '批注本身仍留在插件里')
})

test('消息发出（附件被消费）后自动清空，不会黏到下一条消息', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1', flowKind: 'assistant-step' } })
  await settle()
  assert.equal(harness.debug.list().length, 1)

  harness.send()
  await wait(700)
  assert.equal(harness.debug.list().length, 0, '附件被消费后批注应视为已送达')
  assert.deepEqual(harness.debug.drafts(), [])
})

test('提交失败把附件 restore 回来时不得清空批注（否则批注与附件状态会对不上）', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  assert.equal(harness.debug.list().length, 1)

  await harness.sendThenRestore(100)
  await wait(700)

  assert.equal(harness.debug.list().length, 1, '附件还在，批注就不该被清掉')
  assert.equal(harness.debug.drafts().length, 1, '附件仍在草稿里')
})

test('插件重载后，输入框里遗留的孤儿批注附件会被认领摘掉', async () => {
  const harness = makeHarness()
  // 上一轮把 `批注.json` 留在了输入态，而这次插件是全新加载的（内存守卫为空）。
  harness.plantOrphan('d-orphan')
  assert.deepEqual(harness.inputState().attachmentIds, ['d-orphan'])

  await wait(2000)

  assert.deepEqual(harness.inputState().attachmentIds, [], '孤儿附件必须被摘掉')
})

test('发出后被运行时 restore 回来的孤儿附件会被摘掉，不在输入框里赖着', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()

  harness.sendAttachmentOnly()
  await wait(700)
  assert.equal(harness.debug.list().length, 0, '批注先清空')

  // 回合结束之后，运行时才把它 restore 回来（settleDetachedFailure）。
  harness.restoreStray()
  await wait(300)

  assert.deepEqual(harness.inputState().attachmentIds, [], '孤儿附件必须被摘掉')
})

test('还没确认挂上之前，输入态抖动不会误清批注', async () => {
  const harness = makeHarness({ uploadDelayMs: 200 })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })

  harness.send() // 此时附件还没挂上
  await settle()

  assert.equal(harness.debug.list().length, 1, '批注必须还在')
  assert.equal(harness.debug.drafts().length, 1, '随后仍应正常挂上')
})

test('只发附件（无正文）时也要清空：输入态交出附件，运行时仍持有草稿', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  assert.equal(harness.debug.list().length, 1)

  harness.sendAttachmentOnly()
  await wait(700)

  assert.equal(harness.debug.list().length, 0, '只发附件也必须清空')
  assert.deepEqual(harness.debug.drafts(), [])
})

test('输入态快照没发布时，轮询实时字段仍能清空', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()

  // 实时字段变了，但一次通知都没发布 —— 只有轮询实时字段才抓得到。
  harness.sendWithoutPublish()
  assert.equal(harness.debug.list().length, 1)

  await wait(1800)
  assert.equal(harness.debug.list().length, 0, '轮询实时字段应当兜住')
})

test('追加减批注只保留一个附件：旧的会被摘掉', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'a', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  harness.debug.add({ quote: 'b', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()

  assert.equal(harness.uploads.length, 2)
  assert.deepEqual(harness.released, ['d1'], '旧附件必须摘掉，避免一条消息挂两份批注块')
  assert.deepEqual(harness.inputState().attachmentIds, ['d2'])
  const second = await payloadOf(harness.uploads[1])
  assert.equal(second.count, 2, '第二版负载应含两条批注')
  assert.equal(second.annotations[1].quote, 'b')
})

test('清空批注会把附件摘下来', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'a', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  harness.debug.clear()
  await settle()

  assert.deepEqual(harness.inputState().attachmentIds, [])
  assert.deepEqual(harness.released, ['d1'])
  assert.deepEqual(harness.debug.drafts(), [])
})

test('空选区空批注不会产生批注条目', () => {
  const harness = makeHarness()
  assert.equal(harness.debug.add({ quote: '', note: '', source: { kind: 'message' } }), undefined)
  assert.equal(harness.debug.add({ quote: '   ', note: '   ', source: { kind: 'dom' } }), undefined)
  assert.equal(harness.debug.list().length, 0)
})

test('删除批注后编号重新连续', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: 'a', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  harness.debug.add({ quote: 'b', note: '', source: { kind: 'message', anchorKey: 'k1' } })
  harness.debug.add({ quote: 'c', note: '', source: { kind: 'message', anchorKey: 'k1' } })

  harness.debug.remove(harness.debug.list()[1].id)
  await settle()

  assert.deepEqual(
    harness.debug.list().map((item) => [item.number, item.quote]),
    [
      [1, 'a'],
      [2, 'c'],
    ],
    '编号必须跟着顺序重排',
  )
})

test('修改批注：只改批注文字，原文与出处不变，并重新生成附件', async () => {
  const harness = makeHarness()
  harness.debug.add({ quote: '原文', note: '初稿', source: { kind: 'message', anchorKey: 'k1', flowKind: 'assistant-step' } })
  await settle()

  const id = harness.debug.list()[0].id
  harness.debug.update(id, '改过的批注')
  await settle()

  const item = harness.debug.list()[0]
  assert.equal(item.note, '改过的批注')
  assert.equal(item.quote, '原文', '原文不得被编辑改变')
  assert.equal(item.source.anchorKey, 'k1', '出处不得被编辑改变')
  assert.equal(harness.uploads.length, 2, '修改后必须重新生成附件')
  assert.equal((await payloadOf(harness.uploads[1])).annotations[0].note, '改过的批注')
  assert.deepEqual(harness.released, ['d1'], '旧附件要摘掉')
})

test('拿不到会话 scope 时安静降级，不登记也不抛错', async () => {
  const harness = makeHarness({ noScope: true })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  assert.equal(harness.uploads.length, 0, '没有输入外壳就不该登记草稿附件')
  assert.equal(harness.debug.list().length, 1, '批注本身仍要留在插件里')
})

test('运行时没有 createDrafts 时只告警、不抛错', async () => {
  const harness = makeHarness({ noRuntime: true })
  harness.debug.add({ quote: 'q', note: 'n', source: { kind: 'message', anchorKey: 'k1' } })
  await settle()
  assert.equal(harness.uploads.length, 0)
  assert.deepEqual(harness.debug.drafts(), [])
  assert.equal(harness.debug.list().length, 1)
})

test('锚点重建：按字符偏移在文本节点间切出准确的 Range', () => {
  const harness = makeHarness()
  const { rangeFromOffsets } = harness.debug._internals

  const first = harness.env.node('前缀 ')
  const middle = harness.env.node('目标原文')
  const last = harness.env.node(' 后缀')
  const root = harness.env.element('div', {}, [first, middle, last])
  harness.env.setRangeRoot(root)

  const range = rangeFromOffsets(root, 3, 4)
  assert.ok(range !== undefined, '应当能按偏移重建 Range')
  assert.equal(range.toString(), '目标原文')
})

test('锚点重建：重复片段按保存时的偏移择优', () => {
  const harness = makeHarness()
  const { rangeFromOffsets, matchInRoot } = harness.debug._internals

  const root = harness.env.element('div', {}, [harness.env.node('foo bar foo baz foo')])
  harness.env.setRangeRoot(root)

  assert.equal(matchInRoot(root, 'foo', 0).toString(), 'foo')
  assert.equal(matchInRoot(root, 'foo', 8).toString(), 'foo')
  assert.equal(rangeFromOffsets(root, 8, 3).toString(), 'foo')
  assert.equal(matchInRoot(root, '不存在的片段', 0), undefined)
})

test('出处捕获：代码预览没有行号属性，按 .line 序号推算行号', () => {
  const harness = makeHarness()
  const { captureSource } = harness.debug._internals

  const makeLine = (text) => {
    const line = harness.env.element('div', {}, [harness.env.node(text)])
    line.className = 'line'
    return line
  }
  const first = makeLine('line one')
  const second = makeLine('line two')
  const third = makeLine('line three')
  const pre = harness.env.element('pre', {}, [first, second, third])
  const code = harness.env.element('div', { 'data-code-preview': '' }, [pre])
  const text = third.childNodes[0]
  harness.env.setRangeRoot(code)
  const range = harness.env.document.createRange().setStart(text, 5).setEnd(text, 8)

  const source = captureSource(range)
  assert.equal(source.kind, 'file')
  assert.equal(source.lineStart, 3, '应当是第三条 .line')
  assert.equal(source.lineEnd, 3)
  assert.equal(source.charStart, 'line one'.length + 'line two'.length + 5)
  assert.equal(source.charEnd, 'line one'.length + 'line two'.length + 8)
})

test('源文件定位：空白折叠后仍能命中，并把区间折算回原文坐标', () => {
  const harness = makeHarness()
  const { locateInSource, lineOfOffset } = harness.debug._internals

  const hit = locateInSource(SOURCE_TEXT, '做法是：提交')
  assert.ok(hit !== undefined, '应当能在源文里找到引文')
  assert.equal(SOURCE_TEXT.slice(hit.start, hit.end), '做法是：提交', '区间必须落在原文上（标记在引文之外）')
  assert.equal(lineOfOffset(SOURCE_TEXT, hit.start), 3, '引文在第 3 行')
  assert.equal(lineOfOffset(SOURCE_TEXT, hit.end - 1), 3)

  // 引文里的换行/多余空白会被折叠掉
  assert.ok(locateInSource('alpha   beta\ngamma', 'alpha beta gamma') !== undefined)
  assert.equal(locateInSource(SOURCE_TEXT, '完全不在原文里的句子'), undefined)
  assert.equal(locateInSource(SOURCE_TEXT, '   '), undefined)
})

test('定位到源文件时给出行号与原文坐标，拿不到就退回渲染坐标', async () => {
  const harness = makeHarness()
  const { resolveSourcePosition } = harness.debug._internals

  const precise = await resolveSourcePosition({ kind: 'file', path: 'a.md' }, '做法是：提交')
  assert.equal(precise.textOrigin, 'source')
  assert.equal(precise.lineStart, 3)
  assert.equal(precise.lineEnd, 3)
  assert.equal(SOURCE_TEXT.slice(precise.charStart, precise.charEnd), '做法是：提交')
  assert.equal(harness.sourceReads.length, 1, '应当读了一次源文件')

  assert.equal(await resolveSourcePosition({ kind: 'message' }, 'x'), undefined, '只有文件来源才查原文')
  assert.equal(await resolveSourcePosition({ kind: 'file' }, 'x'), undefined, '没有路径就不查')
  assert.equal(await resolveSourcePosition({ kind: 'file', path: 'a.md' }, '不在原文里'), undefined)
})

test('文件引用来路补正：插入后把渲染坐标折算成原文坐标，重复原文按行号择优', async () => {
  const sourceText = ['alpha', 'name: a-selection-annotations', 'name: b-selection-annotations', ''].join('\n')
  const harness = makeHarness({ sourceText })
  const body = '【a.md:3】\non-annot'
  const origin = {
    kind: 'file',
    path: 'a.md',
    sourceUrl: 'dsh://a.md',
    lineStart: 3,
    lineEnd: 3,
    charStart: 100,
    charEnd: 108,
    textOrigin: 'rendered',
  }

  harness.debug.rememberQuoteOrigin(body, origin)
  await new Promise((resolve) => setTimeout(resolve, 60))

  const refined = harness.debug.quoteOrigin(body)
  assert.equal(refined.textOrigin, 'source', '读得到原文就该记成 source 口径')
  assert.equal(refined.lineStart, 3, '同一段原文出现两次时，按捕获的行号择优')
  assert.equal(sourceText.slice(refined.charStart, refined.charEnd), 'on-annot')
  assert.ok(harness.sourceReads.length >= 1, '应当读了一次源文件')
})

test('读不到源文件时，引用来路安静留在渲染坐标', async () => {
  const harness = makeHarness({ sourceUnavailable: true })
  const body = '【a.md:1】\nalpha'
  const origin = { kind: 'file', path: 'a.md', lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 5, textOrigin: 'rendered' }

  harness.debug.rememberQuoteOrigin(body, origin)
  await new Promise((resolve) => setTimeout(resolve, 60))

  const kept = harness.debug.quoteOrigin(body)
  assert.equal(kept.textOrigin, 'rendered', '精修失败不得改写口径')
  assert.equal(kept.charStart, 0, '坐标保持原样')
})

test('remote 拿不到时，位置精修安静失败而不是把异常抛给创建流程', async () => {
  const harness = makeHarness({ remoteThrows: true })
  const { resolveSourcePosition } = harness.debug._internals
  assert.equal(await resolveSourcePosition({ kind: 'file', path: 'a.md' }, '做法是：提交'), undefined)
})

test('位置精修只补位置：原文与批注文字不变，负载随之更新', async () => {
  const harness = makeHarness()
  const created = harness.debug.add({
    quote: '做法是：提交',
    note: '原批注',
    source: { kind: 'file', path: 'README.zh-CN.md', charStart: 1, charEnd: 7, textOrigin: 'rendered' },
  })
  await settle()
  const before = await payloadOf(harness.uploads[0])
  assert.equal(before.annotations[0].source.textOrigin, 'rendered', '创建瞬间还是渲染坐标')

  await harness.debug._internals.refineSourcePosition(created.id, created.source, created.quote)
  await settle()

  const item = harness.debug.list()[0]
  assert.equal(item.quote, '做法是：提交', '原文不变')
  assert.equal(item.note, '原批注', '批注文字不变')
  assert.equal(item.source.textOrigin, 'source')
  assert.equal(item.source.lineStart, 3)

  const after = await payloadOf(harness.uploads[harness.uploads.length - 1])
  assert.equal(after.annotations[0].source.textOrigin, 'source', '精修后的负载要跟着更新')
  assert.equal(after.annotations[0].source.lineStart, 3)
})

test('读不到源文件时安静退回渲染坐标', async () => {
  const harness = makeHarness({ sourceUnavailable: true })
  const { resolveSourcePosition } = harness.debug._internals
  assert.equal(await resolveSourcePosition({ kind: 'file', path: 'a.md' }, '做法是：提交'), undefined)
})

test('负载里带上坐标口径：能读到原文用 source，否则 rendered', () => {
  const harness = makeHarness()
  const { payloadSource } = harness.debug._internals
  assert.equal(payloadSource({ kind: 'file', path: 'a.md', textOrigin: 'source' }).textOrigin, 'source')
  assert.equal(payloadSource({ kind: 'file', path: 'a.md' }).textOrigin, 'rendered')
  assert.equal(payloadSource({ kind: 'message', role: 'assistant' }).textOrigin, 'rendered')
  assert.equal(payloadSource({ kind: 'dom' }).textOrigin, undefined, '非文件/消息来源不带口径')
})

test('出处捕获：助手消息锚点 + 文件路径与行号', () => {
  const harness = makeHarness()
  const { captureSource } = harness.debug._internals

  const text = harness.env.node('hello world')
  const row = harness.env.element('div', { 'data-chat-anchor-key': 'k7', 'data-chat-flow-kind': 'assistant-step' }, [text])
  harness.env.setRangeRoot(row)
  const range = harness.env.document.createRange().setStart(text, 0).setEnd(text, 5)

  const source = captureSource(range)
  assert.equal(source.kind, 'message')
  assert.equal(source.anchorKey, 'k7')
  assert.equal(source.flowKind, 'assistant-step')
  assert.equal(source.charStart, 0)
  assert.equal(source.charEnd, 5)

  const line = harness.env.element('div', { 'data-textpreview-line': '12' }, [harness.env.node('let x = 1;')])
  const pre = harness.env.element('div', { 'data-textpreview-url': 'dsh-resource://file/session/s1/src%2Fa.ts' }, [line])
  const lineText = line.childNodes[0]
  harness.env.setRangeRoot(pre)
  const fileRange = harness.env.document.createRange().setStart(lineText, 4).setEnd(lineText, 9)

  const fileSource = captureSource(fileRange)
  assert.equal(fileSource.kind, 'file')
  assert.equal(fileSource.path, 'src/a.ts', '路径必须从 data-textpreview-url 解出来')
  assert.equal(fileSource.lineStart, 12)
  assert.equal(fileSource.charStart, 4)
  assert.equal(fileSource.charEnd, 9)
})

test('引用正文：文件选区带上路径与行号，模型才知道出处', () => {
  const harness = makeHarness()
  const { quoteBody, quoteOriginLine } = harness.debug._internals

  assert.equal(quoteBody({ kind: 'dom' }, '普通选区'), '普通选区', '没有出处就只给原文')

  assert.equal(quoteOriginLine({ kind: 'file', path: 'src/a.ts', lineStart: 12 }), '【src/a.ts:12】', '单行只写一个行号')
  assert.equal(
    quoteBody({ kind: 'file', path: 'src/a.ts', lineStart: 12, lineEnd: 18 }, 'let x = 1'),
    '【src/a.ts:12–18】\nlet x = 1',
    '多行写成区间，来路单独占一行',
  )
  assert.equal(quoteOriginLine({ kind: 'file', lineStart: 3, lineEnd: 5 }), '【第 3–5 行】', '代码预览没有路径时只给行号')
  assert.equal(quoteOriginLine({ kind: 'message', anchorKey: 'k1' }), '', '对话消息没有行号可写')
  assert.equal(quoteBody({ kind: 'file', path: 'a.md' }, ''), '', '空引用不产生正文')
})

test('点引用块写批注：引用原文与来路一起进 source', () => {
  const harness = makeHarness()
  const { quoteAnnotationSource } = harness.debug._internals

  assert.deepEqual(quoteAnnotationSource('一段原文', undefined), { kind: 'quote', text: '一段原文' }, '没有来路时只留原文')

  const fromFile = quoteAnnotationSource('一段原文', {
    kind: 'file',
    path: 'src/a.ts',
    lineStart: 12,
    lineEnd: 18,
    textOrigin: 'rendered',
  })
  assert.equal(fromFile.kind, 'quote')
  assert.equal(fromFile.path, 'src/a.ts')
  assert.equal(fromFile.lineStart, 12)
  assert.equal(fromFile.lineEnd, 18)
  assert.equal(fromFile.from, 'file')
  assert.equal(fromFile.textOrigin, 'rendered')
})

test('引用批注的负载：source.kind 是 quote，出处字段原样带上', () => {
  const harness = makeHarness()
  const { payloadSource, buildPayload, describeSource } = harness.debug._internals

  const source = payloadSource({
    kind: 'quote',
    text: '一段原文',
    path: 'src/a.ts',
    lineStart: 12,
    lineEnd: 18,
    from: 'file',
    textOrigin: 'source',
  })
  assert.equal(source.kind, 'quote')
  assert.equal(source.text, '一段原文')
  assert.equal(source.path, 'src/a.ts')
  assert.equal(source.lineStart, 12)
  assert.equal(source.from, 'file')
  assert.equal(source.textOrigin, 'source')
  assert.equal(payloadSource({ kind: 'quote', text: '一段原文' }).textOrigin, undefined, '没有口径就不写')

  const payload = JSON.parse(
    buildPayload([
      {
        number: 1,
        quote: '一段原文',
        note: '改这里',
        source: { kind: 'quote', text: '一段原文', path: 'src/a.ts', lineStart: 12 },
      },
    ]),
  )
  assert.equal(payload.annotations[0].source.kind, 'quote')
  assert.match(payload.instruction, /"quote"/, '指令要说明 quote 是什么意思')
  assert.match(describeSource({ kind: 'quote', path: 'src/a.ts', lineStart: 12 }), /src\/a\.ts:12/)
})

test('引用批注也要回到原文：有来路就按来路定位，没来路就安静放弃', () => {
  const harness = makeHarness()
  const { quoteSourceAnchor, quoteSourceFor } = harness.debug._internals

  assert.deepEqual(
    quoteSourceAnchor({ quote: '还有问题', source: { kind: 'quote', text: '还有问题', anchorKey: 'k1', charStart: 3, charEnd: 7 } }),
    { kind: 'message', anchorKey: 'k1', role: undefined, flowKind: undefined, charStart: 3, charEnd: 7 },
    '带锚点的引用：回到那条消息的字符区间',
  )
  const fromFile = quoteSourceAnchor({
    quote: '【src/a.ts:12】\nlet x = 1',
    source: { kind: 'quote', text: '【src/a.ts:12】\nlet x = 1', sourceUrl: 'dsh-resource://file/session/s/a.ts', path: 'src/a.ts' },
  })
  assert.equal(fromFile.kind, 'file', '带预览 url 的引用：回到文件那一处')
  assert.equal(fromFile.path, 'src/a.ts')
  assert.equal(fromFile.charStart, undefined, '没有字符区间就不编一个出来')

  assert.equal(quoteSourceAnchor({ quote: '找不到的原话', source: { kind: 'quote', text: '找不到的原话' } }), undefined, '页面里也找不到就放弃，不要乱标')

  const carried = { kind: 'quote', text: '还有问题', anchorKey: 'k1' }
  assert.equal(quoteSourceFor('还有问题', carried), carried, '已经带着来路就原样保留，不做多余推断')
  assert.equal(quoteSourceFor('还有问题', { kind: 'message', anchorKey: 'k2' }).kind, 'message', '非 quote 来源不参与推断')
})

test('引用补正成原文坐标后，页面里仍按渲染坐标挑重复原文', () => {
  const harness = makeHarness()
  const { quoteSourceAnchor, matchInRoot, payloadSource } = harness.debug._internals

  const firstText = '- id: selection-annotations\n'
  const secondText = '  u2a5f/dsh-selection-annotations\n'
  const lineA = harness.env.element('div', { 'data-textpreview-line': '2' }, [harness.env.node(firstText)])
  const lineB = harness.env.element('div', { 'data-textpreview-line': '3' }, [harness.env.node(secondText)])
  const pre = harness.env.element('div', { 'data-textpreview-url': 'dsh-resource://file/session/s1/a.yml' }, [lineA, lineB])
  harness.env.setRangeRoot(pre)

  const renderedStart = firstText.length + secondText.indexOf('on-annotations')
  const anchor = quoteSourceAnchor({
    quote: '【a.yml:3】\non-annotations',
    source: {
      kind: 'quote',
      text: '【a.yml:3】\non-annotations',
      sourceUrl: 'dsh-resource://file/session/s1/a.yml',
      path: 'a.yml',
      lineStart: 3,
      textOrigin: 'source',
      // 补正写进来的原文坐标：在渲染正文里比第二处还大得多
      charStart: 120,
      renderedCharStart: renderedStart,
    },
  })
  assert.equal(anchor.renderedCharStart, renderedStart, '渲染坐标必须跟着定位源走，否则择优就没了依据')

  const range = matchInRoot(pre, 'on-annotations', anchor.renderedCharStart)
  assert.equal(range.startContainer, lineB.childNodes[0], '必须落在第二处，而不是退回首处')
  assert.equal(matchInRoot(pre, 'on-annotations', 0).startContainer, lineA.childNodes[0], '反过来拿一个不在此坐标系的偏移去择优，就会漂回首处')

  assert.equal(payloadSource(anchor).renderedCharStart, undefined, '渲染坐标只是页面定位用的，不进负载')
})

test('引用原文口径：剥掉来路行，同一句原文才算同一条批注', () => {
  const harness = makeHarness()
  const { quoteExcerptOf, annotationOnQuote } = harness.debug._internals

  assert.equal(quoteExcerptOf('【src/a.ts:12–18】\nlet x = 1'), 'let x = 1', '来路行不算原文')
  assert.equal(quoteExcerptOf('普通选区'), '普通选区', '没有来路行就原样返回')
  assert.equal(quoteExcerptOf(''), '', '空串不炸')

  harness.debug.add({
    quote: '还有问题',
    note: '改成陈述句',
    source: { kind: 'message', anchorKey: 'k1', flowKind: 'user' },
  })
  assert.equal(annotationOnQuote('还有问题')?.note, '改成陈述句', '从消息里引用过来时对得上同一条')
  assert.equal(
    annotationOnQuote('【src/a.ts:3】\n还有问题', { kind: 'file', path: 'src/a.ts', lineStart: 3 }),
    undefined,
    '来路对不上就不是同一条（消息里的那句 vs 文件里的一句）',
  )

  harness.debug.add({
    quote: 'let x = 1',
    note: '这里改成 const',
    source: { kind: 'file', path: 'src/a.ts', lineStart: 12, lineEnd: 18 },
  })
  assert.equal(
    annotationOnQuote('【src/a.ts:12–18】\nlet x = 1', { kind: 'file', path: 'src/a.ts', lineStart: 12, lineEnd: 18 })?.note,
    '这里改成 const',
    '同一文件同一行的引用就是同一条',
  )
  assert.equal(
    annotationOnQuote('【src/other.ts:12–18】\nlet x = 1', { kind: 'file', path: 'src/other.ts', lineStart: 12, lineEnd: 18 }),
    undefined,
    '别的文件里的同一句是另一条批注',
  )
})

test('输入态没有引用能力时安静降级：读写引用都不抛错', () => {
  const harness = makeHarness()
  assert.deepEqual(harness.debug.quotes(), [], '拿不到投影就当没有引用')
  assert.equal(harness.debug.insertQuote('一段原文'), false, '没有 inputActions 时插引用直接放弃')
})

/** 造一个引用块：span[data-composer-quote] > button（官方「移除」）。 */
function makeQuoteChip(harness) {
  const chip = harness.env.element('span', { 'data-composer-quote': '' })
  chip.appendChild(harness.env.element('button', { class: 'x' }))
  return chip
}

test('删除记录：连输入框里那条引用一起删，靠的是官方「移除」按钮', () => {
  const harness = makeHarness({ quotes: ['甲段原文'] })
  const { removeQuoteRecord } = harness.debug._internals
  const chip = makeQuoteChip(harness)
  harness.setComposerChips([chip])
  harness.debug.add({ quote: '甲段原文', note: '改一下', source: { kind: 'quote', text: '甲段原文' } })
  assert.equal(harness.debug.list().length, 1)

  removeQuoteRecord(harness.debug.list()[0])
  assert.deepEqual(harness.debug.list(), [], '引用没了，批注也不能留在正文里')
  const button = chip.querySelector('button')
  assert.equal(button.dispatched.length, 1, '引用要靠官方「移除」按钮删：插件拿不到 Lexical 的 nodeKey')
  assert.equal(button.dispatched[0].type, 'click')
  assert.equal(button.dispatched[0].bubbles, true, '必须冒泡，官方在编辑器里接这次点击')
})

test('纯引用没有批注也能删：删掉的是输入框里那条引用', () => {
  const harness = makeHarness({ quotes: ['乙段原文'] })
  const { removeQuoteChip } = harness.debug._internals
  const chip = makeQuoteChip(harness)
  harness.setComposerChips([chip])

  assert.equal(removeQuoteChip(chip), true, '点得到官方按钮就算发出去了')
  assert.equal(chip.querySelector('button').dispatched.length, 1)
  assert.deepEqual(harness.debug.list(), [], '纯引用本来就没有批注，删完不该多出记录')
})

test('找不到引用块时，删除只删批注（消息已发出或引用早被移除）', () => {
  const harness = makeHarness()
  const { removeQuoteRecord } = harness.debug._internals
  harness.debug.add({ quote: '丙段原文', note: 'x', source: { kind: 'message', anchorKey: 'k1' } })

  removeQuoteRecord(harness.debug.list()[0])
  assert.deepEqual(harness.debug.list(), [], '没有引用块可删，就只删这一条批注')
})

